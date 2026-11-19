"""Native Finder workflows and request/session boundaries."""
import unittest
from unittest.mock import patch
from PySide6.QtCore import Qt
from PySide6.QtWidgets import QMessageBox
from test_client import APP
from test_reader_features import PendingApi
from flyleaf_desktop.finder import FinderPage
from flyleaf_desktop.finder_activity import FinderActivity
from flyleaf_desktop.api import ApiError


class FinderWorkflowTests(unittest.TestCase):
    def setUp(self):
        self.api = PendingApi()
        self.page = FinderPage(self.api)
        self.page.start_session({"id": 7})
        self.api.reply("/libraries", [{"id": 2, "name": "My library"}])
        self.api.reply("/sources", [{"id": "test", "name": "Sample", "canBrowse": True}])
        self.page.sources.setCurrentRow(0)

    def tearDown(self):
        self.page.clear_session(); self.page.close(); self.page.deleteLater(); APP.processEvents()

    def test_folder_navigation_pagination_failure_and_root_return(self):
        self.api.reply("/latest", {"items": [{"id": "folder/one", "title": "Authors", "folder": True}], "hasMore": False})
        self.page.results.setCurrentRow(0)
        self.assertNotEqual(self.api.calls[-1][1].split("/")[-1], "details")
        self.page._activate_result(self.page.results.item(0))
        call = self.api.calls[-1]
        self.assertEqual(call[1], "/api/finder/test/browse")
        self.assertEqual(call[5]["params"]["id"], "folder/one")
        self.api.reply("/browse", {"items": [{"id": "book", "title": "A garden"}], "hasMore": True})
        self.page.search(False)
        self.assertEqual(self.api.calls[-1][5]["params"]["page"], 2)
        self.api.calls[-1][3](ApiError("Unavailable"))
        self.page.search(False)
        self.assertEqual(self.api.calls[-1][5]["params"]["page"], 2)
        stale = self.api.calls[-1]
        self.page.parent_folder()
        self.assertTrue(self.api.calls[-1][1].endswith("/latest"))
        stale[2]({"items": [{"id": "private", "title": "Stale folder"}], "hasMore": False})
        self.assertEqual(self.page.results.count(), 0)

    def test_follow_uses_all_known_files_and_queue_prevents_duplicate_inflight_submit(self):
        self.api.reply("/latest", {"items": [{"id": "series", "title": "Garden"}], "hasMore": False})
        self.page.results.setCurrentRow(0)
        self.api.reply("/details", {"id": "series", "title": "Garden", "files": [{"id": "f1"}, {"id": "f2"}]})
        self.page.follow_title()
        follow = self.api.calls[-1]
        self.assertEqual(follow[1], "/api/finder/follows")
        self.assertEqual(follow[4]["files"], ["f1", "f2"])
        self.assertFalse(follow[4]["autoDownload"])
        follow[2]({"id": 3})
        self.page.select_files(Qt.CheckState.Checked)
        self.page.queue_download()
        queue = self.api.calls[-1]
        count = len(self.api.calls)
        self.page.queue_download()
        self.assertEqual(len(self.api.calls), count)
        queue[2]({"ids": [10, 11]})
        self.assertEqual(self.page.files.item(0).checkState(), Qt.CheckState.Unchecked)
        self.page.clear_session()
        follow[2]({"id": 3}); queue[3](ApiError("Old request"))
        self.assertEqual(self.page.notice.text(), "")
        self.assertEqual(self.page.activity.target.count(), 0)


class FinderActivityTests(unittest.TestCase):
    def setUp(self):
        self.api = PendingApi(); self.page = FinderActivity(self.api)
        self.page.start_session({"id": 7})
        self.page.set_libraries([{"id": 2, "name": "Library"}])

    def tearDown(self):
        self.page.clear_session(); self.page.close(); self.page.deleteLater(); APP.processEvents()

    def test_queue_retry_cancel_and_stale_account_callbacks(self):
        self.page.refresh()
        self.api.reply("downloads/list", [{"id": 8, "title": "Garden", "status": "failed", "error": "Disconnected"}])
        self.page.downloads.setCurrentRow(0)
        self.assertTrue(self.page.retry.isEnabled())
        self.page.retry_download()
        call = self.api.calls[-1]
        self.assertEqual(call[:2], ("POST", "/api/finder/downloads/8/retry"))
        call[2]({"retried": 1})
        self.api.reply("downloads/list", [{"id": 8, "status": "downloading", "received": 5, "total": 10}])
        self.assertIn("50%", self.page.downloads.item(0).text())
        self.page.downloads.setCurrentRow(0)
        with patch.object(QMessageBox, "question", return_value=QMessageBox.StandardButton.Yes):
            self.page.remove_download()
        pending = self.api.calls[-1]
        self.assertEqual(pending[:2], ("DELETE", "/api/finder/downloads/8"))
        self.page.clear_session()
        pending[2]({"ok": True})
        self.assertEqual(self.page.downloads.count(), 0)
        self.assertEqual(self.page.notice.text(), "")

    def test_follow_settings_check_and_manual_chapter_download(self):
        self.page.tabs.setCurrentIndex(1)
        self.api.reply("/follows", {"follows": [{"id": 4, "title": "Garden", "libraryId": 2, "autoDownload": False}]})
        self.page.follows.setCurrentRow(0)
        self.page.auto.setChecked(True)
        self.page.save_follow()
        call = self.api.calls[-1]
        self.assertEqual(call[:2], ("PATCH", "/api/finder/follows/4"))
        self.assertEqual(call[4], {"libraryId": 2, "autoDownload": True})
        call[2]({"id": 4})
        self.api.reply("/follows", {"follows": [{"id": 4, "libraryId": 2, "autoDownload": True}]})
        self.page.check_follow()
        self.assertTrue(self.api.calls[-1][1].endswith("/follows/4/check"))
        self.api.calls[-1][2]({"found": 1})
        self.api.reply("/follows", {"follows": []})
        self.page.tabs.setCurrentIndex(2)
        self.api.reply("/updates", [{"id": 9, "title": "Garden", "file": {"label": "Chapter 2"}, "status": "new"}])
        self.page.updates.setCurrentRow(0)
        self.assertTrue(self.page.get_update.isEnabled())
        self.page.download_update()
        self.assertEqual(self.api.calls[-1][:2], ("POST", "/api/finder/updates/9/download"))

    def test_tab_switch_during_request_fetches_current_tab_and_stops_hidden_polling(self):
        self.page.refresh()
        self.page.tabs.setCurrentIndex(1)
        self.api.reply("downloads/list", [])
        self.assertEqual(self.api.calls[-1][1], "/api/finder/follows")
        self.api.reply("/follows", {"follows": []})
        self.page.show(); APP.processEvents()
        self.assertTrue(self.page.timer.isActive())
        self.page.hide(); APP.processEvents()
        self.assertFalse(self.page.timer.isActive())
