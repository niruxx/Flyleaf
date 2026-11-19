"""Native desktop shell. No HTML application shell, WebView, or direct SQLite access."""

import argparse
from pathlib import Path
import sys

from PySide6.QtCore import QEvent, QSettings, QUrl, Qt
from PySide6.QtGui import QActionGroup, QDesktopServices, QIcon, QImageReader, QKeySequence, QShortcut
from PySide6.QtWidgets import QApplication, QMainWindow, QMenu, QMessageBox

from . import __version__
from .api import ApiError, FlyleafApi
from .connection import ConnectionPage, LoginPage
from .appearance import Appearance, AnimatedStack
from .chrome import TitleBar
from .onboarding import WelcomePage, PersonalizePage
from .motion import MotionFeedback
from .image_reader import IMAGE_FORMATS, ImageReader
from .library import LibraryPage
from .widgets import text


class MainWindow(QMainWindow):
    def __init__(self, settings: QSettings | None = None, api: FlyleafApi | None = None):
        super().__init__()
        self.setWindowTitle("Flyleaf Desktop")
        self.resize(1200, 820)
        self.setMinimumSize(820, 600)
        self.settings = settings if settings is not None else QSettings("Flyleaf", "Flyleaf Desktop")
        self.appearance = Appearance(self.settings, self)
        self.api = api if api is not None else FlyleafApi(self)
        self.user: dict | None = None
        self.reader: ImageReader | None = None
        self._open_generation = 0
        self.stack = AnimatedStack(self.appearance)
        self.setCentralWidget(self.stack)
        self.welcome = WelcomePage(self.appearance)
        self.personalize = PersonalizePage(self.appearance)
        self.connection = ConnectionPage(self.settings)
        self.login = LoginPage()
        self.library = LibraryPage(self.api)
        for page in (self.welcome, self.connection, self.login, self.personalize, self.library):
            self.stack.addWidget(page)
        if self.settings.value("onboarding/completed", False, type=bool):
            self.stack.setCurrentWidget(self.connection)
        self.welcome.continue_requested.connect(self._begin_setup)
        self.personalize.finished.connect(self.finish_onboarding)
        self.connection.connect_requested.connect(self.connect_server)
        self.login.login_requested.connect(self.sign_in)
        self.login.change_server_requested.connect(self.change_server)
        self.library.book_requested.connect(self.open_book)
        self.api.session_expired.connect(self._session_expired)
        self.app_menu = QMenu(self)
        file_menu = self.app_menu.addMenu("&File")
        self.change_action = file_menu.addAction("Change &server…", self.change_server)
        self.sign_out_action = file_menu.addAction("Sign &out", self.sign_out)
        self.sign_out_action.setEnabled(False)
        file_menu.addSeparator()
        quit_action = file_menu.addAction("&Quit", self.close)
        quit_action.setShortcut(QKeySequence.StandardKey.Quit)
        view_menu = self.app_menu.addMenu("&View")
        refresh = view_menu.addAction("&Refresh library", self.library.refresh)
        refresh.setShortcut(QKeySequence.StandardKey.Refresh)
        fullscreen = view_menu.addAction("&Fullscreen", self.toggle_fullscreen)
        fullscreen.setShortcut(QKeySequence("F11"))
        view_menu.addSeparator()
        themes = view_menu.addMenu("Color theme")
        theme_group = QActionGroup(self)
        for title, value in [("Midnight (dark)", "dark"), ("Paper (light)", "light"), ("Follow system", "system")]:
            action = themes.addAction(title)
            action.setCheckable(True)
            action.setChecked(self.appearance.theme == value)
            theme_group.addAction(action)
            action.triggered.connect(lambda checked=False, theme=value: self.appearance.configure(theme=theme))
            self.appearance.changed.connect(lambda a=action, theme=value: a.setChecked(self.appearance.theme == theme))
        self.motion_action = view_menu.addAction("Reduce motion")
        self.motion_action.setCheckable(True)
        self.motion_action.setChecked(self.appearance.reduce_motion)
        self.motion_action.triggered.connect(lambda value: self.appearance.configure(reduce_motion=value))
        self.appearance.changed.connect(lambda: self.motion_action.setChecked(self.appearance.reduce_motion))
        self.frame_action = view_menu.addAction("Use system window frame")
        self.frame_action.setCheckable(True)
        self.frame_action.setChecked(self.settings.value("appearance/systemFrame", False, type=bool))
        self.frame_action.triggered.connect(self.set_system_frame)
        help_menu = self.app_menu.addMenu("&Help")
        help_menu.addAction("About Flyleaf Desktop", self.about)
        find = QShortcut(QKeySequence.StandardKey.Find, self)
        find.activated.connect(lambda: self.library.search.setFocus() if self.stack.currentWidget() == self.library else None)
        self.statusBar().showMessage("Connect to your Flyleaf server to begin")
        icon = Path(__file__).with_name("resources") / "icon.svg"
        if icon.exists():
            self.setWindowIcon(QIcon(str(icon)))
        self.chrome = TitleBar(self, self.app_menu)
        self.setMenuWidget(self.chrome)
        self.chrome.use_system_frame(self.frame_action.isChecked())
        self.motion_feedback = MotionFeedback(self, self.appearance)
        # Menu actions also belong to the window so shortcuts work while closed.
        self.addActions([quit_action, refresh, fullscreen])
        menu_shortcut = QShortcut(QKeySequence("Alt+M"), self)
        menu_shortcut.activated.connect(self.chrome.menu_button.showMenu)
        close_shortcut = QShortcut(QKeySequence("Alt+F4"), self)
        close_shortcut.activated.connect(self.close)

    def set_system_frame(self, enabled):
        self.settings.setValue("appearance/systemFrame", enabled)
        self.settings.sync()
        self.chrome.use_system_frame(enabled)

    def changeEvent(self, event):
        super().changeEvent(event)
        if event.type() == QEvent.Type.WindowStateChange and hasattr(self, "welcome"):
            self.welcome.art.sync_motion()

    def _begin_setup(self):
        self.stack.setCurrentWidget(self.connection)
        self.connection.address.setFocus()

    def finish_onboarding(self):
        if self.user is None:
            return
        self.settings.setValue("onboarding/completed", True)
        self.settings.sync()
        self.stack.setCurrentWidget(self.library)
        self.library.search.setFocus()

    def connect_server(self, address: str) -> None:
        try:
            self.api.connect_server(address)
        except ValueError as error:
            self.connection.set_busy(False, str(error))
            return
        self.connection.set_busy(True, "Checking the Flyleaf server…")

        def connected(data: object) -> None:
            if not isinstance(data, dict) or not isinstance(data.get("needsSetup"), bool) or "user" not in data:
                self.connection.set_busy(False, "This address is not a compatible Flyleaf server. Enter the server's base address, not an API or reader URL.")
                return
            self.connection.set_busy(False)
            if data["needsSetup"]:
                self.connection.notice.setText("This server needs its initial administrator account. Finish setup in the server's web interface, then connect again.")
                return
            self.settings.setValue("connection/server", self.api.base)
            self.settings.sync()
            self.login.server.setText("Connected to " + self.api.base)
            self.login.password.clear()
            message = "HTTP is unencrypted. Use HTTPS outside a trusted local network." if self.api.base.startswith("http://") else ""
            self.login.set_busy(False, message)
            self.stack.setCurrentWidget(self.login)
            self.login.username.setFocus()
            self.statusBar().showMessage(self.api.base)
        self.api.json("GET", "/api/status", connected,
                      lambda error: self.connection.set_busy(False, error.message))

    def sign_in(self, username: str, password: str) -> None:
        self.login.set_busy(True, "Signing in…")

        def signed_in(data: object) -> None:
            self.login.password.clear()
            self.login.set_busy(False)
            if not isinstance(data, dict) or not isinstance(data.get("user"), dict) or not isinstance(data["user"].get("id"), int):
                self.login.notice.setText("The server returned an invalid sign-in response.")
                return
            self.user = data["user"]
            self.sign_out_action.setEnabled(True)
            self.setWindowTitle(f"Flyleaf Desktop — {text(self.user.get('displayName'), username)}")
            self.library.start_session(self.user)
            if self.settings.value("onboarding/completed", False, type=bool):
                self.stack.setCurrentWidget(self.library)
            else:
                self.stack.setCurrentWidget(self.personalize)
                self.personalize.finish_button.setFocus()
            self.statusBar().showMessage(f"{text(self.user.get('displayName'), username)} · {self.api.base}")
        def failed(error: ApiError) -> None:
            self.login.set_busy(False, error.message)
            self.login.password.selectAll()
            self.login.password.setFocus()
        self.api.json("POST", "/api/login", signed_in, failed, {"username": username, "password": password})

    def _clear_session(self) -> None:
        self.stack.finish_transition()
        self._open_generation += 1
        if self.reader:
            reader, self.reader = self.reader, None
            reader.dispose()
            self.stack.removeWidget(reader)
            reader.deleteLater()
        self.api.reset()
        self.library.clear_session()
        self.user = None
        self.sign_out_action.setEnabled(False)
        self.setWindowTitle("Flyleaf Desktop")
        self.login.password.clear()

    def change_server(self) -> None:
        if self.reader and self.reader.has_unsaved_changes:
            self.reader.request_leave(self._change_server_now)
        else:
            self._change_server_now()

    def _change_server_now(self) -> None:
        self._clear_session()
        self.connection.set_busy(False)
        self.stack.setCurrentWidget(self.connection)
        self.connection.address.setFocus()
        self.statusBar().showMessage("Connect to your Flyleaf server")

    def sign_out(self) -> None:
        if self.reader and self.reader.has_unsaved_changes:
            self.reader.request_leave(self._sign_out_now)
        else:
            self._sign_out_now()

    def _sign_out_now(self) -> None:
        if not self.user:
            return
        self.sign_out_action.setEnabled(False)
        def signed_out(_data: object) -> None:
            self._clear_session()
            self.login.set_busy(False, "Signed out. Enter your account details to sign in again.")
            self.stack.setCurrentWidget(self.login)
            self.login.password.setFocus()
        def failed(error: ApiError) -> None:
            self.sign_out_action.setEnabled(True)
            self.statusBar().showMessage("Sign-out failed: " + error.message)
        self.api.json("POST", "/api/logout", signed_out, failed)

    def _session_expired(self) -> None:
        self._clear_session()
        self.login.set_busy(False, "Your session expired. Sign in again. Unsaved reading progress is not replayed under another account.")
        self.stack.setCurrentWidget(self.login)

    def open_book(self, book: dict) -> None:
        if not isinstance(book.get("id"), int):
            return
        self._open_generation += 1
        generation = self._open_generation
        self.statusBar().showMessage("Opening book…")

        def loaded(data: object) -> None:
            if generation != self._open_generation:
                return
            if not isinstance(data, dict) or not isinstance(data.get("book"), dict):
                self.statusBar().showMessage("The server returned invalid reader data.")
                return
            actual = data["book"]
            if actual.get("format") not in IMAGE_FORMATS:
                self.statusBar().showMessage("This format's native reader is scheduled in the desktop roadmap.")
                dialog = QMessageBox(self)
                dialog.setWindowTitle("Native reader not available yet")
                dialog.setTextFormat(Qt.TextFormat.PlainText)
                dialog.setText(f"{text(actual.get('format'), 'This format').upper()} reading is not implemented in this initial build.")
                dialog.setInformativeText("The native reader currently supports comic/image books. EPUB, PDF and audiobooks have explicit parity phases; no embedded browser is used.")
                open_web = dialog.addButton("Open in system browser", QMessageBox.ButtonRole.ActionRole)
                dialog.addButton(QMessageBox.StandardButton.Close)
                dialog.exec()
                if dialog.clickedButton() == open_web:
                    QDesktopServices.openUrl(QUrl(self.api.base + f"/#/read/{actual['id']}"))
                return
            if self.reader:
                self.reader.dispose()
                self.stack.removeWidget(self.reader)
                self.reader.deleteLater()
            self.reader = ImageReader(self.api, data, self._return_to_library)
            self.stack.addWidget(self.reader)
            self.stack.setCurrentWidget(self.reader)
            self.reader.setFocus()
            self.statusBar().showMessage(text(actual.get("title"), "Reading"))
        self.api.json("GET", f"/api/books/{book['id']}/reader", loaded,
                      lambda error: self.statusBar().showMessage(error.message) if generation == self._open_generation else None)

    def _return_to_library(self) -> None:
        if self.reader:
            reader, self.reader = self.reader, None
            reader.dispose()
            self.stack.removeWidget(reader)
            reader.deleteLater()
        self.stack.setCurrentWidget(self.library)
        self.library.refresh()
        self.library.search.setFocus()

    def toggle_fullscreen(self) -> None:
        self.showNormal() if self.isFullScreen() else self.showFullScreen()

    def about(self) -> None:
        QMessageBox.about(self, "About Flyleaf Desktop", f"Flyleaf Desktop {__version__}\n\nNative Qt 6 Widgets through PySide6 Essentials.\nNo Chromium, Qt WebEngine, embedded WebView, or direct server-database access.\n\nInitial build: server setup, sign-in, library browsing and native comic/image reading. See desktop/roadmap.md for feature parity.")

    def closeEvent(self, event) -> None:
        if self.reader and self.reader.has_unsaved_changes:
            event.ignore()
            self.reader.request_leave(self._close_after_save)
            return
        self._clear_session()
        event.accept()

    def _close_after_save(self) -> None:
        self._clear_session()
        self.close()


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Flyleaf's native desktop client")
    parser.add_argument("--server", help="Prefill the server address; you still choose Connect")
    options = parser.parse_args(argv)
    application = QApplication.instance() or QApplication([sys.argv[0]])
    application.setApplicationName("Flyleaf Desktop")
    application.setOrganizationName("Flyleaf")
    application.setApplicationVersion(__version__)
    QImageReader.setAllocationLimit(128)
    window = MainWindow()
    if options.server:
        window.connection.address.setText(options.server)
    window.show()
    return application.exec()


if __name__ == "__main__":
    raise SystemExit(main())
