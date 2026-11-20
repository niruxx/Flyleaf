import ast
import os
from pathlib import Path
import sys
import shutil
import time
import unittest
import uuid

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from PySide6.QtCore import QSettings, Qt
from PySide6.QtTest import QTest
from PySide6.QtWidgets import QApplication, QPushButton
from PySide6.QtGui import QPalette
from flyleaf_desktop.motion import ButtonHalo

from flyleaf_desktop.address import normalize_server, server_url
from flyleaf_desktop.api import FlyleafApi
from flyleaf_desktop.app import MainWindow
from support import Fixture

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
        self.window = MainWindow(QSettings(str(self.settings_path), QSettings.Format.IniFormat))
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

    def sign_in(self):
        if self.window.stack.currentWidget() is self.window.welcome:
            QTest.mouseClick(self.window.welcome.start_button, Qt.MouseButton.LeftButton)
        connection = self.window.connection
        connection.address.setText(self.fixture.url)
        QTest.mouseClick(connection.connect_button, Qt.MouseButton.LeftButton)
        wait_for(lambda: self.window.stack.currentWidget() is self.window.login)
        login = self.window.login
        login.username.setText("reader")
        login.password.setText("test-only-password")
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

    def test_native_connection_login_browsing_reading_and_logout(self):
        self.assertIs(self.window.stack.currentWidget(), self.window.welcome)
        reader = self.open_reader()
        reader.show_page(1)
        wait_for(lambda: reader._image is not None and reader.page == 1)
        reader.flush_progress()
        wait_for(lambda: bool(self.fixture.saves) and self.fixture.saves[-1]["page"] == 1 and not reader.has_unsaved_changes)
        self.assertAlmostEqual(self.fixture.saves[-1]["percent"], 2 / 3)
        self.assertNotIn("seconds", self.fixture.saves[-1], "position retries must not fabricate or duplicate active reading time")
        selected_series = self.window.library.grid.currentItem()
        self.window.library.search.blockSignals(True)
        self.window.library.search.setText("Night Garden")
        self.window.library.search.blockSignals(False)
        reader.request_leave(self.window._return_to_library)
        wait_for(lambda: self.window.reader is None and self.window.library.books.count() == 1)
        self.assertIs(self.window.library.grid.currentItem(), selected_series)
        self.assertEqual(self.window.library.books.currentRow(), 0)
        self.assertEqual(self.window.library.search.text(), "Night Garden")
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

    def test_catalog_preferences_apply_and_follow_the_account_after_sign_in(self):
        self.fixture.user["prefs"] = {"catalog": {"startPage": "library", "cardSize": "compact", "sort": "author", "showCovers": False}}
        self.sign_in()
        library = self.window.library
        self.assertEqual(library.sidebar.currentRow(), 1)
        self.assertEqual(library.sort.currentData(), "author")
        self.assertEqual(library.grid.gridSize().width(), 126)
        self.assertFalse(any(path.endswith("/cover") for _, path, _ in self.fixture.requests))

        self.window.catalog_action.trigger()
        dialog = self.window.catalog_dialog
        dialog.choices["cardSize"].setCurrentIndex(dialog.choices["cardSize"].findData("large"))
        dialog.choices["startPage"].setCurrentIndex(dialog.choices["startPage"].findData("want"))
        dialog.covers.setChecked(True)
        dialog.save()
        wait_for(lambda: self.window.catalog_dialog is None)
        self.assertEqual(library.grid.gridSize().width(), 208)
        self.assertEqual(library.sidebar.currentRow(), 1)
        wait_for(lambda: any(path.endswith("/cover") for _, path, _ in self.fixture.requests))
        self.assertEqual(self.fixture.user["prefs"]["catalog"], {"startPage": "want", "cardSize": "large", "sort": "author", "showCovers": True})

        self.window.sign_out()
        wait_for(lambda: self.window.user is None)
        self.window.sign_in("reader", "test-only-password")
        wait_for(lambda: self.window.user is not None and library.sidebar.currentRow() == 2)
        self.assertEqual(library.grid.gridSize().width(), 208)

    def test_personal_storage_move_and_live_progress(self):
        source = "/data/content/reader"
        destination = "/mnt/ssd/reader"
        self.fixture.storage = {"homeDir": source, "canMove": True, "roots": ["/mnt/ssd"],
                                "migration": None, "ownMigration": None}
        self.sign_in()
        self.window.storage_action.trigger()
        settings = self.window.storage.dialog
        wait_for(lambda: settings.home.text() == source)
        settings.destination.setText(destination)
        self.assertFalse(settings.move.isEnabled())
        settings.preview_button.click()
        wait_for(lambda: settings.move.isEnabled())
        self.assertIn("3 files", settings.preview.text())
        settings.move.click()
        wait_for(lambda: self.fixture.moves == [{"destination": destination}])
        running = {"id": 1, "status": "running", "phase": "copying", "percent": 42}
        self.fixture.storage.update(migration=running, ownMigration=running)
        wait_for(lambda: not self.window.storage.pending and not settings.submitting)
        self.window.storage.poll()
        wait_for(lambda: self.window.storage.indicator.isVisible() and settings.progress.value() == 42)
        self.assertIn("Copying files", settings.status.text())
        self.assertFalse(settings.move.isEnabled())
        finished = {"id": 1, "status": "done", "percent": 100, "finishedAt": int(time.time() * 1000)}
        self.fixture.storage.update(homeDir=destination, migration=finished, ownMigration=finished)
        self.window.storage.poll()
        wait_for(lambda: settings.home.text() == destination)
        self.assertEqual(self.window.user["homeDir"], destination)
        self.assertIn("100%", settings.status.text())
        settings.close()
        self.window.sign_out()
        wait_for(lambda: self.window.user is None)
        self.assertFalse(self.window.storage.indicator.isVisible())

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
        self.window.personalize.reduce_motion.setChecked(True)
        self.window.personalize.finish_button.click()
        self.assertIs(self.window.stack.currentWidget(), self.window.library)
        returning = MainWindow(QSettings(str(self.settings_path), QSettings.Format.IniFormat))
        try:
            self.assertIs(returning.stack.currentWidget(), returning.connection)
            self.assertEqual(returning.appearance.theme, "light")
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
        self.assertEqual(APP.palette().color(QPalette.ColorRole.Window).name(), "#f4f3fa")
        self.assertEqual(self.window.chrome.palette().color(QPalette.ColorRole.Window).name(), "#ffffff")
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
                self.assertTrue(page.rect().contains(button.mapTo(page, button.rect().bottomRight())))

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
        self.assertEqual(reader.canvas.pixmap().width(), 900)
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
