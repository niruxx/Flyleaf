import ast
import json
import os
from pathlib import Path
import sys
import shutil
import time
import unittest
import uuid

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from PySide6.QtCore import QSettings, Qt, QUrl
from PySide6.QtTest import QTest
from PySide6.QtWidgets import QApplication, QPushButton
from PySide6.QtGui import QPalette
from flyleaf_desktop.motion import ButtonHalo

from flyleaf_desktop.address import normalize_server, server_url
from flyleaf_desktop.api import FlyleafApi
from flyleaf_desktop.app import MainWindow
from support import Fixture, FakeVault

APP = QApplication.instance() or QApplication([])


def wait_for(condition, timeout=4000):
    deadline = time.monotonic() + timeout / 1000
    while not condition() and time.monotonic() < deadline:
        APP.processEvents()
        QTest.qWait(10)
    if not condition():
        raise AssertionError("Timed out waiting for the native application")


class AddressTests(unittest.TestCase):
    def test_addresses_and_proxy_base_paths(self):
        for value, expected in [
            ("192.168.1.25", "http://192.168.1.25:7878"), ("localhost:9000", "http://localhost:9000"),
            (" https://BOOKS.example.com/ ", "https://books.example.com"),
            ("[::1]", "http://[::1]:7878"), ("https://books.example.com/flyleaf/", "https://books.example.com/flyleaf"),
        ]:
            self.assertEqual(normalize_server(value), expected)
        self.assertEqual(server_url("https://books.example.com/flyleaf", "/api/status"), "https://books.example.com/flyleaf/api/status")

    def test_credentials_and_unsafe_urls_are_rejected(self):
        for value in ["", "ftp://server", "http://user:secret@server", "http://server?token=secret", "http://server/#/library", "http://server:99999", "http://server/api/status", "http://server/../admin", "http://server/%2e%2e", "http://server\\else"]:
            with self.subTest(value=value), self.assertRaises(ValueError):
                normalize_server(value)
        for path in ["https://outside.example/api/page", "//outside.example/api/page", "file:///etc/passwd", "https://user:secret@books.example.com/api/page", "https://books.example.com/elsewhere", "/api/../../private", "/api/%252e%252e/private", "/api/status#secret"]:
            with self.subTest(path=path), self.assertRaises(ValueError):
                server_url("https://books.example.com", path)


class NativeClientTests(unittest.TestCase):
    def setUp(self):
        self.fixture = Fixture()
        self.build = (Path(__file__).resolve().parents[1] / "build").resolve()
        self.temp_path = self.build / ("test-" + uuid.uuid4().hex)
        self.temp_path.mkdir(parents=True)
        self.settings_path = self.temp_path / "settings.ini"
        self.vault = FakeVault()
        self.window = MainWindow(QSettings(str(self.settings_path), QSettings.Format.IniFormat), vault=self.vault)
        self.window.show()

    def tearDown(self):
        if self.window.reader:
            self.window.reader.dispose()
            self.window.reader._pending = None
            self.window.reader._saving = False
        self.window.close()
        self.window.deleteLater()
        APP.processEvents()
        self.fixture.close()
        if not self.temp_path.resolve().is_relative_to(self.build):
            raise AssertionError("Unexpected test cleanup path")
        shutil.rmtree(self.temp_path)

    def sign_in(self, remember=False):
        if self.window.stack.currentWidget() is self.window.welcome:
            QTest.mouseClick(self.window.welcome.start_button, Qt.MouseButton.LeftButton)
        connection = self.window.connection
        connection.address.setText(self.fixture.url)
        QTest.mouseClick(connection.connect_button, Qt.MouseButton.LeftButton)
        wait_for(lambda: self.window.stack.currentWidget() is self.window.login)
        login = self.window.login
        login.username.setText("reader")
        login.password.setText("test-only-password")
        login.remember.setChecked(remember)
        QTest.mouseClick(login.login_button, Qt.MouseButton.LeftButton)
        wait_for(lambda: self.window.user is not None and self.window.library.grid.count() == 1)
        if self.window.stack.currentWidget() is self.window.personalize:
            QTest.mouseClick(self.window.personalize.finish_button, Qt.MouseButton.LeftButton)

    def open_reader(self):
        self.sign_in()
        self.window.library.grid.setCurrentRow(0)
        wait_for(lambda: self.window.library.books.count() == 1)
        QTest.mouseClick(self.window.library.read_button, Qt.MouseButton.LeftButton)
        wait_for(lambda: self.window.reader is not None and self.window.reader._image is not None)
        return self.window.reader

    def test_durable_progress_recovers_lost_ack_without_duplicate_time(self):
        self.fixture.capabilities["durableProgress"] = 1
        reader = self.open_reader()
        reader.active_clock.timer.stop()
        service = self.window.reliability
        self.window.local_store.add_seconds(service.scope, 1, "2026-11-18", 30)
        self.fixture.lose_save_ack_once = True
        reader.flush_progress()
        wait_for(lambda: bool(self.window.local_store.events(service.scope)) and self.window.local_store.events(service.scope)[0]["error"] is not None)
        event = self.window.local_store.events(service.scope)[0]
        self.assertEqual(len(self.fixture.saves), 1)
        self.assertEqual(self.fixture.saves[0]["seconds"], 30)
        service.retry()
        wait_for(lambda: not self.window.local_store.events(service.scope))
        self.assertEqual(len(self.fixture.saves), 1)
        self.assertEqual(self.fixture.saves[0]["eventId"], event["event_id"])

    def test_verified_offline_book_and_pending_position_survive_restart_and_vault_unlock(self):
        self.fixture.capabilities["durableProgress"] = 1
        self.sign_in(remember=True)
        wait_for(lambda: bool(self.vault.entries) and not self.window.vault_tasks.pending)
        self.window.library.grid.setCurrentRow(0)
        wait_for(lambda: self.window.library.books.count() == 1)
        self.window.open_book(self.fixture.book)
        wait_for(lambda: self.window.reader is not None and self.window.reader._image is not None)
        self.window.reader.active_clock.timer.stop()
        self.window.reader.flush_progress()
        scope = self.window.reliability.scope
        wait_for(lambda: not self.window.local_store.events(scope))
        self.window.download_current()
        wait_for(lambda: not self.window.downloads.active, timeout=10000)
        self.assertEqual(len(self.window.local_store.books(scope, complete=True)), 1, self.window.offline_dialog.notice.text())
        self.window.api.offline = True
        previous_reader = self.window.reader
        self.window.open_book(self.fixture.book)
        wait_for(lambda: self.window.reader is not None and self.window.reader is not previous_reader and self.window.reader._image is not None)
        self.window.reader.active_clock.timer.stop()
        self.window.reader.show_page(2)
        wait_for(lambda: self.window.reader._image is not None and self.window.reader.page == 2)
        self.window.close()
        wait_for(lambda: not self.window.isVisible())
        self.window.deleteLater(); APP.processEvents()
        self.window = MainWindow(QSettings(str(self.settings_path), QSettings.Format.IniFormat), vault=self.vault)
        self.window.show()
        self.window.show_offline()
        wait_for(lambda: self.window.user is not None and self.window.api.offline)
        self.assertEqual(self.window.reliability.scope, scope)
        self.window.open_book(self.fixture.book)
        wait_for(lambda: self.window.reader is not None and self.window.reader._image is not None)
        self.window.reader.active_clock.timer.stop()
        self.assertEqual(self.window.reader.page, 2)
        self.window.reader.flush_progress()
        self.window.reconnect_reading()
        wait_for(lambda: not self.window.local_store.events(scope), timeout=10000)
        self.assertEqual(self.fixture.saves[-1]["page"], 2)

    def test_revoked_access_closes_reader_and_purges_offline_and_note_surfaces(self):
        self.fixture.capabilities["durableProgress"] = 1
        self.fixture.annotations = [{"id": 1, "kind": "bookmark", "page": 0, "locator": "0", "note": "private fixture note"}]
        reader = self.open_reader()
        reader.active_clock.timer.stop()
        reader.flush_progress()
        scope = self.window.reliability.scope
        wait_for(lambda: not self.window.local_store.events(scope))
        self.window.download_current()
        wait_for(lambda: not self.window.downloads.active, timeout=10000)
        self.assertTrue(self.window.local_store.books(scope, complete=True))
        self.window.show_annotations()
        wait_for(lambda: self.window.annotations_dialog.items.count() == 1)
        self.window.local_store.stage(scope, 1, {"page": 0, "percent": 1 / 3, "version": 1})
        self.window.local_store.add_seconds(scope, 1, "2026-11-18", 10)
        self.fixture.deny_book = True
        reader.show_page(1)
        wait_for(lambda: self.window.reader is None and self.window.library.grid.count() == 0)
        self.assertEqual(self.window.local_store.books(scope), [])
        self.assertEqual(self.window.annotations_dialog.records, [])
        self.assertNotIn("private fixture note", self.window.local_store.book(scope, 1)["data"])
        event = self.window.local_store.events(scope)[0]
        self.assertEqual(json.loads(event["body"])["seconds"], 10)
        self.assertEqual(json.loads(event["body"])["page"], 0)

    def test_interface_size_scales_logical_controls_and_persists_without_changing_dpr(self):
        ratio = self.window.devicePixelRatioF()
        try:
            self.window.appearance.configure(ui_scale=1.25)
            APP.processEvents()
            self.assertAlmostEqual(APP.font().pointSizeF(), 15)
            self.assertEqual(self.window.library.grid.gridSize().width(), 230)
            self.assertEqual(self.window.chrome.height(), 65)
            self.assertEqual(self.window.devicePixelRatioF(), ratio)
            self.assertEqual(self.window.settings.value("appearance/uiScale", type=float), 1.25)
        finally:
            self.window.appearance.configure(ui_scale=1.0)

    def test_content_finder_sidebar_browses_sources_and_clears_private_data_on_logout(self):
        self.fixture.user["permissions"]["contentFinder"] = True
        self.fixture.finder_sources = [{"id": "sample", "name": "Sample source", "canBrowse": True}]
        self.sign_in()
        self.window.library.sidebar.setCurrentRow(3)
        finder = self.window.library.finder
        wait_for(lambda: finder.sources.count() == 1)
        finder.sources.setCurrentRow(0)
        wait_for(lambda: finder.results.count() == 2)
        finder.results.setCurrentRow(0)
        wait_for(lambda: finder.files.count() == 2)
        finder.follow_title()
        wait_for(lambda: bool(self.fixture.finder_follows))
        self.assertFalse(self.fixture.finder_follows[0]["autoDownload"])
        self.fixture.finder_downloads = [{"id": 3, "title": "The Night Garden", "status": "downloading", "received": 1, "total": 2}]
        finder.tabs.setCurrentIndex(1)
        wait_for(lambda: finder.activity.downloads.count() == 1)
        self.assertIn("50%", finder.activity.downloads.item(0).text())
        finder.activity.tabs.setCurrentIndex(1)
        wait_for(lambda: finder.activity.follows.count() == 1)
        self.window.sign_out()
        wait_for(lambda: self.window.user is None)
        self.assertEqual(finder.results.count(), 0)
        self.assertEqual(finder.files.count(), 0)
        self.assertIsNone(finder.details)
        self.assertEqual(finder.activity.downloads.count(), 0)
        self.assertEqual(finder.activity.follows.count(), 0)
        self.assertFalse(finder.activity.timer.isActive())

    def test_native_connection_login_browsing_reading_and_logout(self):
        self.assertIs(self.window.stack.currentWidget(), self.window.welcome)
        reader = self.open_reader()
        reader.show_page(1)
        wait_for(lambda: reader._image is not None and reader.page == 1)
        reader.flush_progress()
        wait_for(lambda: bool(self.fixture.saves) and self.fixture.saves[-1]["page"] == 1 and not reader.has_unsaved_changes)
        self.assertAlmostEqual(self.fixture.saves[-1]["percent"], 2 / 3)
        self.assertNotIn("seconds", self.fixture.saves[-1], "position retries must not fabricate or duplicate active reading time")
        reader.request_leave(self.window._return_to_library)
        wait_for(lambda: self.window.reader is None)
        self.window.sign_out()
        wait_for(lambda: self.window.user is None)
        self.assertEqual(self.window.library.grid.count(), 0)
        self.assertEqual(self.window.login.password.text(), "")
        self.window.settings.sync()
        saved = self.settings_path.read_text()
        self.assertNotIn("test-only-password", saved)
        self.assertNotIn("fixture-session", saved)
        self.assertTrue(any("flyleaf_session=fixture-session" in headers.get("Cookie", "") for method, path, headers in self.fixture.requests if path == "/api/home"))

    def test_bad_password_is_inline_and_does_not_open_library(self):
        self.window.connect_server(self.fixture.url)
        wait_for(lambda: self.window.stack.currentWidget() is self.window.login)
        self.window.sign_in("reader", "wrong")
        wait_for(lambda: "Incorrect" in self.window.login.notice.text())
        self.assertIsNone(self.window.user)
        self.assertTrue(self.window.login.login_button.isEnabled())

    def test_named_profiles_normalize_addresses_and_keep_server_identities_separate(self):
        page = self.window.connection
        page.profile_name.setText("Home")
        page.address.setText("192.168.1.5")
        page.reconnect.setChecked(True)
        self.window.save_connection_profile()
        first = dict(self.window.current_profile)
        self.assertEqual(first["address"], "http://192.168.1.5:7878")
        page.profile_name.setText("Travel")
        page.address.setText("https://books.example.com/flyleaf")
        self.window.save_connection_profile()
        second = self.window.current_profile
        self.assertNotEqual(first["id"], second["id"])
        self.assertEqual(len(self.window.profiles.items), 2)
        self.window.select_connection_profile(first["id"])
        self.assertEqual(page.address.text(), first["address"])
        self.window.remove_connection_profile()
        self.assertEqual(len(self.window.profiles.items), 1)
        self.assertEqual(self.window.connection.profiles.currentData(), "")

    def test_remembered_session_restores_without_replaying_password_and_logout_forgets_it(self):
        self.sign_in(remember=True)
        wait_for(lambda: bool(self.vault.entries))
        saved = self.settings_path.read_text()
        self.assertNotIn("fixture-session", saved)
        self.assertNotIn("test-only-password", saved)
        logins = sum(path == "/api/login" for _, path, _ in self.fixture.requests)
        self.window.change_server()
        self.window.connect_server(self.fixture.url)
        wait_for(lambda: self.window.user is not None)
        self.assertEqual(sum(path == "/api/login" for _, path, _ in self.fixture.requests), logins)
        self.window.sign_out()
        wait_for(lambda: self.window.user is None and not self.vault.entries)
        self.assertFalse(self.window.current_profile["remember"])

    def test_locked_vault_uses_memory_only_and_saved_session_retry_is_available(self):
        self.vault.fail = "write"
        self.sign_in(remember=True)
        wait_for(lambda: not self.window.vault_tasks.pending)
        self.assertFalse(self.window.current_profile["remember"])
        self.assertFalse(self.vault.entries)
        self.assertIn("locked", self.window.statusBar().currentMessage())
        self.assertNotIn("fixture-session", self.settings_path.read_text())
        self.vault.fail = None
        self.window.login.remember.setChecked(True)
        self.window._remember_session()
        wait_for(lambda: bool(self.vault.entries))
        self.window.change_server()
        self.vault.fail = "read"
        self.window.connect_server(self.fixture.url)
        wait_for(lambda: "locked" in self.window.login.notice.text())
        self.assertIsNone(self.window.user)
        self.assertTrue(self.window.login.restore_button.isVisible())
        self.vault.fail = None
        self.window.login.restore_button.click()
        wait_for(lambda: self.window.user is not None)

    def test_saved_session_account_mismatch_is_rejected(self):
        self.sign_in(remember=True)
        wait_for(lambda: bool(self.vault.entries))
        self.window.change_server()
        self.fixture.user = {**self.fixture.user, "id": 99, "displayName": "Another reader"}
        self.window.connect_server(self.fixture.url)
        wait_for(lambda: "changed account" in self.window.login.notice.text())
        self.assertIsNone(self.window.user)
        self.assertEqual(self.window.library.grid.count(), 0)
        self.assertFalse(self.window.api.manager.cookieJar().cookiesForUrl(QUrl(self.fixture.url)))

    def test_opt_in_startup_reconnect_checks_the_selected_profile_once(self):
        self.sign_in(remember=True)
        wait_for(lambda: bool(self.vault.entries))
        self.window.current_profile["reconnect"] = True
        self.window.profiles.persist()
        logins = sum(path == "/api/login" for _, path, _ in self.fixture.requests)
        returning = MainWindow(QSettings(str(self.settings_path), QSettings.Format.IniFormat), vault=self.vault)
        returning.show()
        try:
            wait_for(lambda: returning.user is not None)
            self.assertEqual(returning.current_profile["id"], self.window.current_profile["id"])
            self.assertEqual(sum(path == "/api/login" for _, path, _ in self.fixture.requests), logins)
        finally:
            returning.close()
            returning.deleteLater()
            APP.processEvents()

    def test_first_administrator_creation_is_explicit_and_validated(self):
        self.fixture.needs_setup = True
        self.window.connect_server(self.fixture.url)
        page = self.window.create_account
        wait_for(lambda: self.window.stack.currentWidget() is page)
        self.assertFalse(any(path == "/api/setup" for _, path, _ in self.fixture.requests))
        page.username.setText("newadmin")
        page.password.setText("a-test-password")
        page.confirm.setText("different")
        page.submit()
        self.assertIn("do not match", page.notice.text())
        page.confirm.setText("a-test-password")
        page.submit()
        wait_for(lambda: self.window.user is not None)
        self.assertEqual(self.window.user["role"], "admin")
        self.assertEqual(page.password.text(), "")

    def test_registration_invite_errors_and_success_are_native(self):
        self.fixture.registration = {"inviteRequired": True}
        self.window.connect_server(self.fixture.url)
        wait_for(lambda: self.window.stack.currentWidget() is self.window.login)
        self.assertTrue(self.window.login.register_button.isVisible())
        self.window.login.register_button.click()
        page = self.window.create_account
        page.username.setText("newreader")
        page.password.setText("a-test-password")
        page.confirm.setText("a-test-password")
        page.invite.setText("wrong")
        page.submit()
        wait_for(lambda: "invite" in page.notice.text())
        self.assertIsNone(self.window.user)
        page.invite.setText("test-invite")
        page.submit()
        wait_for(lambda: self.window.user is not None)
        self.assertEqual(self.window.user["role"], "guest")
        self.assertEqual(page.invite.text(), "")

    def test_profile_and_password_changes_clear_secret_fields(self):
        self.sign_in()
        self.window.show_account()
        page = self.window.account
        self.assertTrue(page.username.isReadOnly())
        page.display_name.setText("A new display name")
        page.email.setText("reader@example.com")
        page.save_profile.click()
        wait_for(lambda: self.window.user.get("displayName") == "A new display name")
        self.assertIn("A new display name", self.window.windowTitle())
        page.current.setText("wrong")
        page.next.setText("changed-test-password")
        page.confirm.setText("changed-test-password")
        page.save_password.click()
        wait_for(lambda: "incorrect" in page.notice.text())
        page.current.setText("test-only-password")
        page.save_password.click()
        wait_for(lambda: "Password changed" in page.notice.text())
        self.assertEqual(page.current.text() + page.next.text() + page.confirm.text(), "")
        self.assertNotIn("changed-test-password", self.settings_path.read_text())

    def test_filters_fulltext_saved_queries_and_safe_metadata_links(self):
        from urllib.parse import urlsplit, parse_qs
        self.fixture.series["links"] = [{"url": "https://example.com/book", "label": "Publisher"}, {"url": "file:///private/file"}, {"url": "https://user:secret@example.com/book"}]
        self.sign_in()
        library = self.window.library
        library.tools.fields["genre"].setText("Fantasy; Adventure")
        library.tools.fields["tag"].setText("Favorite")
        library.tools.fields["person"].setText("Elena Rowe")
        library.tools.fields["language"].setText("en")
        library.tools.format.setCurrentIndex(library.tools.format.findData("cbz"))
        library.tools.apply()
        wait_for(lambda: any("language=en" in path for _, path, _ in self.fixture.requests))
        query = parse_qs(urlsplit(next(path for _, path, _ in reversed(self.fixture.requests) if path.startswith("/api/series?"))).query)
        self.assertEqual(query["genre"], ["Fantasy", "Adventure"])
        self.assertEqual(query["format"], ["cbz"])
        library.tools.name.setText("Tonight")
        library.tools.save_query(library.query_params())
        wait_for(lambda: library.tools.saved.count() == 2)
        self.assertEqual(self.fixture.filters[0]["filter"]["language"], "en")
        library.tools.name.setText("Renamed tonight")
        library.tools.save_query(library.query_params())
        wait_for(lambda: self.fixture.filters[0]["name"] == "Renamed tonight")
        library.tools.delete_saved()
        wait_for(lambda: library.tools.saved.count() == 1)
        library.search.setText("garden")
        library.scope.setCurrentIndex(1)
        wait_for(lambda: library.grid.count() == 1 and library.grid.item(0).data(Qt.ItemDataRole.UserRole).get("hits"))
        library.grid.setCurrentRow(0)
        wait_for(lambda: "Matching passages" in library.summary.toPlainText())
        self.assertIn("<quiet>", library.summary.toPlainText())
        self.assertNotIn("\x01", library.summary.toPlainText())
        self.assertEqual(len(library.metadata_links.menu().actions()), 1)

    def test_older_servers_do_not_silently_ignore_language_and_format_filters(self):
        self.fixture.capabilities = {}
        self.sign_in()
        self.assertFalse(self.window.library.tools.fields["language"].isEnabled())
        self.assertFalse(self.window.library.tools.format.isEnabled())

    def test_return_from_reader_preserves_paging_selection_volume_layout_and_scroll(self):
        self.fixture.series["books"] = [self.fixture.book, {**self.fixture.book, "id": 2, "label": "Volume 2"}]
        self.fixture.series["nextBookId"] = 2
        self.fixture.catalog = [{**self.fixture.series, "id": i, "name": f"Series {i:03}"} for i in range(1, 81)]
        self.window.connect_server(self.fixture.url)
        wait_for(lambda: self.window.stack.currentWidget() is self.window.login)
        self.window.sign_in("reader", "test-only-password")
        wait_for(lambda: self.window.user is not None)
        self.window.finish_onboarding()
        library = self.window.library
        library.sidebar.setCurrentRow(1)
        wait_for(lambda: library.grid.count() == 48)
        library.more_button.click()
        wait_for(lambda: library.grid.count() == 80)
        library.grid.setCurrentRow(60)
        wait_for(lambda: library.books.count() == 2)
        library.books.setCurrentRow(0)
        library.grid.verticalScrollBar().setValue(library.grid.verticalScrollBar().maximum())
        state = library.capture_state()
        library._read_selected()
        wait_for(lambda: self.window.reader is not None and self.window.reader._image is not None)
        self.window.reader.request_leave(self.window._return_to_library)
        wait_for(lambda: self.window.reader is None and library._restore is None and library.books.count() == 2)
        self.assertEqual(library.grid.currentRow(), 60)
        self.assertEqual(library.books.currentItem().data(Qt.ItemDataRole.UserRole)["id"], 1)
        self.assertEqual(library.grid.verticalScrollBar().value(), state["gridScroll"])
        self.assertEqual(library.splitter.sizes(), state["splitter"])

    def test_expired_session_prompts_before_replaying_unsaved_progress(self):
        reader = self.open_reader()
        reader.show_page(1)
        wait_for(lambda: reader._image is not None and reader.page == 1)
        self.fixture.authorized = False
        reader.flush_progress()
        wait_for(lambda: self.window.user is None and self.window.stack.currentWidget() is self.window.login)
        self.assertEqual(self.window._recovery["page"], 1)
        before = len(self.fixture.saves)
        self.window.sign_in("reader", "test-only-password")
        wait_for(lambda: self.window.stack.currentWidget() is self.window.recovery)
        QTest.qWait(550)
        self.assertEqual(len(self.fixture.saves), before)
        self.window.resume_recovery(True)
        wait_for(lambda: self.window.reader is not None and self.window.reader._image is not None)
        self.assertEqual(self.window.reader.page, 1)

    def test_expired_account_recovery_is_hidden_from_another_account(self):
        reader = self.open_reader()
        self.fixture.authorized = False
        reader.flush_progress()
        wait_for(lambda: self.window.user is None)
        self.fixture.user = {**self.fixture.user, "id": 99}
        self.window.sign_in("reader", "test-only-password")
        wait_for(lambda: self.window.user is not None)
        self.assertIs(self.window.stack.currentWidget(), self.window.library)
        self.assertEqual(self.window.recovery.message.text(), "")
        self.assertIsNone(self.window.reader)

    def test_recovery_rejects_an_unsaved_page_after_the_book_file_changes(self):
        reader = self.open_reader()
        self.fixture.authorized = False
        reader.flush_progress()
        wait_for(lambda: self.window.user is None)
        self.fixture.book["version"] = 2
        self.window.sign_in("reader", "test-only-password")
        wait_for(lambda: self.window.stack.currentWidget() is self.window.recovery)
        self.window.resume_recovery(True)
        wait_for(lambda: "version cannot" in self.window.recovery.message.text())
        self.assertIsNone(self.window.reader)
        self.assertFalse(self.window.recovery.resume_pending.isVisible())
        self.window.resume_recovery(False)
        wait_for(lambda: self.window.reader is not None and self.window.reader._image is not None)

    def test_first_run_personalization_is_saved_and_returning_launch_skips_welcome(self):
        self.assertIs(self.window.stack.currentWidget(), self.window.welcome)
        self.window.welcome.start_button.click()
        self.assertIs(self.window.stack.currentWidget(), self.window.connection)
        self.window.connect_server(self.fixture.url)
        wait_for(lambda: self.window.stack.currentWidget() is self.window.login)
        self.window.sign_in("reader", "test-only-password")
        wait_for(lambda: self.window.stack.currentWidget() is self.window.personalize)
        self.assertFalse(self.window.settings.value("onboarding/completed", False, type=bool))
        self.window.personalize.theme.setCurrentIndex(self.window.personalize.theme.findData("light"))
        self.window.personalize.palette.setCurrentIndex(self.window.personalize.palette.findData("forest"))
        self.window.personalize.reduce_motion.setChecked(True)
        self.window.personalize.finish_button.click()
        self.assertIs(self.window.stack.currentWidget(), self.window.library)
        returning = MainWindow(QSettings(str(self.settings_path), QSettings.Format.IniFormat))
        try:
            self.assertIs(returning.stack.currentWidget(), returning.connection)
            self.assertEqual(returning.appearance.theme, "light")
            self.assertEqual(returning.appearance.preset, "forest")
            self.assertFalse(returning.appearance.motion_enabled)
        finally:
            returning.close()
            returning.deleteLater()
            APP.processEvents()

    def test_reduced_motion_stops_ambient_hover_and_page_animations(self):
        if self.window.appearance.motion_enabled:
            self.assertTrue(self.window.welcome.art.timer.isActive())
        self.window.welcome.start_button.setFocus()
        APP.processEvents()
        self.window.appearance.configure(reduce_motion=True)
        self.assertFalse(self.window.welcome.art.timer.isActive())
        for halo in self.window.findChildren(ButtonHalo):
            self.assertEqual(halo.level, 0)
            self.assertEqual(halo.animation.state(), halo.animation.State.Stopped)
            self.assertEqual(halo.ripple_animation.state(), halo.ripple_animation.State.Stopped)
        self.window._begin_setup()
        self.assertIsNone(self.window.stack.animation)
        self.assertIsNone(self.window.connection.graphicsEffect())

    def test_quick_navigation_and_theme_changes_restore_page_opacity(self):
        self.window._begin_setup()
        self.window.stack.setCurrentWidget(self.window.login)
        self.window.appearance.configure(theme="light")
        self.assertIsNone(self.window.stack.animation)
        self.assertIsNone(self.window.connection.graphicsEffect())
        self.assertIsNone(self.window.login.graphicsEffect())
        self.assertEqual(APP.palette().color(QPalette.ColorRole.Window).name(), "#f1f3f9")
        self.assertEqual(self.window.chrome.palette().color(QPalette.ColorRole.Window).name(), "#f1f3f9")
        self.assertFalse(self.window.welcome.art.timer.isActive())

    def test_window_controls_restore_and_system_frame_preference_persists(self):
        self.assertTrue(self.window.windowFlags() & Qt.WindowType.FramelessWindowHint)
        self.window.chrome.toggle_maximized()
        self.assertTrue(self.window.isMaximized())
        self.window.chrome.toggle_maximized()
        self.assertFalse(self.window.isMaximized())
        self.window.set_system_frame(True)
        self.assertFalse(self.window.windowFlags() & Qt.WindowType.FramelessWindowHint)
        self.assertTrue(self.window.settings.value("appearance/systemFrame", False, type=bool))
        self.assertTrue(all(button.isHidden() for button in self.window.chrome.controls))

    def test_title_bar_close_waits_for_failed_progress_save(self):
        self.fixture.fail_save = True
        reader = self.open_reader()
        self.window.chrome.controls[-1].click()
        wait_for(lambda: reader.discard_save.isVisible())
        self.assertTrue(self.window.isVisible())
        self.assertIs(self.window.reader, reader)
        self.assertTrue(reader.has_unsaved_changes)
        self.fixture.fail_save = False
        reader.retry_save.click()
        wait_for(lambda: not self.window.isVisible())

    def test_removing_reader_during_transition_releases_its_effect(self):
        reader = self.open_reader()
        self.window._return_to_library()
        self.assertIsNot(self.window.stack.effect_page, reader)
        wait_for(lambda: self.window.stack.animation is None)
        self.assertIsNone(self.window.stack.effect_page)
        self.assertIsNone(self.window.stack.animation)
        APP.processEvents()

    def test_first_run_screens_fit_small_window(self):
        self.window.appearance.configure(reduce_motion=True)
        self.window.resize(820, 640)
        for page in (self.window.welcome, self.window.connection, self.window.login, self.window.personalize):
            self.window.stack.setCurrentWidget(page)
            APP.processEvents()
            self.assertLessEqual(self.window.width(), 820)
            self.assertLessEqual(self.window.height(), 640)
            for button in page.findChildren(QPushButton):
                self.assertTrue(page.rect().contains(button.mapTo(page, button.rect().bottomRight())), f"{type(page).__name__}: {button.text()} ends at {button.mapTo(page, button.rect().bottomRight())}; page={page.rect()}; status={self.window.statusBar().height()}")

    def test_failed_progress_stays_pending_and_failed_page_does_not_save(self):
        reader = self.open_reader()
        reader.flush_progress()
        wait_for(lambda: not reader.has_unsaved_changes)
        self.fixture.fail_save = True
        reader.show_page(1)
        wait_for(lambda: reader._image is not None and reader.page == 1)
        reader.flush_progress()
        wait_for(lambda: reader.retry_save.isVisible())
        self.assertTrue(reader.has_unsaved_changes)
        self.assertEqual(reader._pending, 1)
        self.fixture.fail_save = False
        reader.flush_progress()
        wait_for(lambda: not reader.has_unsaved_changes)
        self.fixture.fail_page = 2
        reader.show_page(2)
        wait_for(lambda: reader.retry_page.isVisible())
        self.assertEqual(self.fixture.saves[-1]["page"], 1)
        self.assertFalse(reader.has_unsaved_changes)

    def test_page_list_failure_can_be_retried(self):
        self.fixture.fail_page_list = True
        self.sign_in()
        self.window.open_book(self.fixture.book)
        wait_for(lambda: self.window.reader is not None and self.window.reader.retry_page.isVisible())
        self.fixture.fail_page_list = False
        self.window.reader.retry_loading()
        wait_for(lambda: self.window.reader._image is not None)

    def test_native_rtl_keyboard_navigation_and_zoom(self):
        reader = self.open_reader()
        reader.direction.setCurrentIndex(1)
        QTest.keyClick(reader, Qt.Key.Key_Left)
        wait_for(lambda: reader.page == 1 and reader._image is not None)
        reader.zoom.setCurrentIndex(3)
        self.assertEqual(reader.canvas.pixmap().deviceIndependentSize().width(), 900)
        self.assertEqual(reader.canvas.pixmap().devicePixelRatio(), reader.devicePixelRatioF())
        reader.zoom.setCurrentIndex(0)
        self.assertLessEqual(reader.canvas.pixmap().width(), reader.scroll.viewport().width())
        reader.flush_progress()
        wait_for(lambda: not reader.has_unsaved_changes)

    def test_blurred_artwork_and_future_titles_are_not_exposed_in_browsing(self):
        self.fixture.series["blur"] = True
        self.fixture.user["prefs"]["spoilerSafe"] = True
        self.fixture.series["books"].append({**self.fixture.book, "id": 2, "title": "A future twist", "label": "A future twist", "progress": None})
        self.sign_in()
        self.window.library.grid.setCurrentRow(0)
        wait_for(lambda: self.window.library.books.count() == 2)
        self.assertNotIn("A future twist", self.window.library.books.item(1).text())
        self.assertFalse(any(path.endswith("/cover") for _method, path, _headers in self.fixture.requests))

    def test_switching_server_clears_account_data_and_cookies(self):
        self.sign_in()
        self.window.change_server()
        self.assertIsNone(self.window.user)
        self.assertEqual(self.window.library.grid.count(), 0)
        from PySide6.QtCore import QUrl
        self.assertEqual(self.window.api.manager.cookieJar().cookiesForUrl(QUrl(self.fixture.url)), [])

    def test_no_browser_runtime_is_imported(self):
        self.assertFalse(any("WebEngine" in name or "WebKit" in name for name in sys.modules))
        for file in (Path(__file__).resolve().parents[1] / "src").rglob("*.py"):
            tree = ast.parse(file.read_text(encoding="utf-8"))
            for node in ast.walk(tree):
                if isinstance(node, ast.ImportFrom):
                    self.assertNotIn("WebEngine", node.module or "")


class NetworkTests(unittest.TestCase):
    def test_reset_discards_callbacks_from_the_previous_session(self):
        fixture = Fixture()
        try:
            api = FlyleafApi()
            api.connect_server(fixture.url)
            results, errors = [], []
            api.json("GET", "/api/status", results.append, errors.append)
            api.reset()
            QTest.qWait(150)
            self.assertFalse(results)
            self.assertFalse(errors)
        finally:
            fixture.close()

    def test_redirect_and_wrong_server_responses_fail_without_following(self):
        fixture = Fixture()
        try:
            api = FlyleafApi()
            api.connect_server(fixture.url)
            for path in ["/api/redirect", "/api/not-json"]:
                results, errors = [], []
                api.json("GET", path, results.append, errors.append)
                wait_for(lambda: bool(results or errors))
                self.assertFalse(results)
                self.assertTrue(errors)
            self.assertFalse(any("different.invalid" in path for _method, path, _headers in fixture.requests))
            api.reset()
        finally:
            fixture.close()


if __name__ == "__main__":
    unittest.main()
