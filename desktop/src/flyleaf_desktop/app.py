"""Native desktop shell. No HTML application shell, WebView, or direct SQLite access."""

import argparse
import json
import sqlite3
from pathlib import Path
import re
import sys

from PySide6.QtCore import QEvent, QSettings, QTimer, QUrl, Qt, QStandardPaths
from PySide6.QtGui import QActionGroup, QDesktopServices, QIcon, QImageReader, QKeySequence, QShortcut
from PySide6.QtWidgets import QApplication, QDialog, QFileDialog, QMainWindow, QMenu, QMessageBox, QPushButton, QTabWidget, QVBoxLayout

from . import __version__
from .api import ApiError, FlyleafApi
from .connection import ConnectionPage, LoginPage
from .appearance import Appearance, AnimatedStack
from .chrome import TitleBar
from .onboarding import WelcomePage, PersonalizePage
from .motion import MotionFeedback
from .material import PRESETS, ui_px
from .image_reader import IMAGE_FORMATS, ImageReader
from .document_reader import DocumentReader, TEXT_FORMATS
from .comic_reader import ComicReader
from .audio_reader import AudioReader
from .library import LibraryPage
from .profiles import Profiles
from .vault import VaultTasks
from .accounts import AccountPage, CreateAccountPage, RecoveryPage
from .widgets import text
from .local_store import LocalStore
from .reliability import Reliability, ActiveClock
from .offline import Downloads, OfflineDialog
from .personal_data import AnnotationsDialog
from .personal_workspace import PersonalWorkspace
from .transfers import DevicesPanel, UploadPanel
from .integrations import KeysPanel, SourcesPanel, TrackingPanel, WebhooksPanel
from .home_layout import HomeLayoutPanel


class MainWindow(QMainWindow):
    def __init__(self, settings: QSettings | None = None, api: FlyleafApi | None = None, vault=None):
        super().__init__()
        self.setWindowTitle("Flyleaf Desktop")
        self.resize(1200, 820)
        self.setMinimumSize(820, 600)
        self.settings = settings if settings is not None else QSettings("Flyleaf", "Flyleaf Desktop")
        self.appearance = Appearance(self.settings, self)
        self.api = api if api is not None else FlyleafApi(self)
        local_root = Path(self.settings.fileName()).parent / "local" if self.settings.format() == QSettings.Format.IniFormat else Path(QStandardPaths.writableLocation(QStandardPaths.StandardLocation.AppLocalDataLocation)) / "reading"
        self.local_store = LocalStore(local_root)
        self.reliability = Reliability(self.api, self.local_store, self)
        self.reliability.book_revoked.connect(self._book_revoked)
        self.downloads = Downloads(self.reliability, self.settings, self)
        self.offline_dialog = OfflineDialog(self.reliability, self.downloads, self.settings, self)
        self.offline_dialog.open_requested.connect(self.open_book)
        self.offline_dialog.reconnect_requested.connect(self.reconnect_reading)
        self._store_closed = False
        self.profiles = Profiles(self.settings)
        self.vault_tasks = VaultTasks(self, vault)
        self.current_profile = None
        self._connection_epoch = 0
        self._recovery = None
        self._browse_state = None
        self._registration = None
        self._capabilities = {}
        self.user: dict | None = None
        self.reader: ImageReader | None = None
        self._open_generation = 0
        self.stack = AnimatedStack(self.appearance)
        self.setCentralWidget(self.stack)
        self.welcome = WelcomePage(self.appearance)
        self.personalize = PersonalizePage(self.appearance)
        self.connection = ConnectionPage(self.settings)
        self.login = LoginPage()
        self.library = LibraryPage(self.api, self.appearance, self.home_layout_value)
        self.annotations_dialog = AnnotationsDialog(self.api, self)
        self.personal_dialog = QDialog(self)
        self.personal_dialog.setWindowTitle("My reading")
        self.personal_dialog.resize(930, 730)
        self.personal = PersonalWorkspace(self.api)
        QVBoxLayout(self.personal_dialog).addWidget(self.personal)
        self.personal.book_requested.connect(self._open_personal_book)
        self.personal.series_requested.connect(self._open_personal_series)
        self.personal.sync_requested.connect(self.show_offline)
        self.library.personal_requested.connect(lambda: self.show_personal("series"))
        self.transfer_dialog = QDialog(self)
        self.transfer_dialog.resize(780, 580)
        self.upload_panel = UploadPanel(self.api, self.settings, lambda: self.reliability.scope)
        self.devices_panel = DevicesPanel(self.api)
        layout = QVBoxLayout(self.transfer_dialog)
        layout.addWidget(self.upload_panel)
        layout.addWidget(self.devices_panel)
        self.original_download = None
        self.integrations_dialog = QDialog(self)
        self.integrations_dialog.setWindowTitle("Connections and integrations")
        self.integrations_dialog.resize(810, 560)
        self.integration_tabs = QTabWidget()
        QVBoxLayout(self.integrations_dialog).addWidget(self.integration_tabs)
        self.integration_panels = (TrackingPanel(self.api), KeysPanel(self.api), SourcesPanel(self.api), WebhooksPanel(self.api))
        for caption, panel in zip(("Tracking", "OPDS & devices", "Sources & Mihon", "Webhooks"), self.integration_panels):
            self.integration_tabs.addTab(panel, caption)
        self.integration_tabs.currentChanged.connect(self._reload_integration)
        self.home_dialog = QDialog(self)
        self.home_dialog.setWindowTitle("Home and reading preferences")
        self.home_dialog.resize(700, 620)
        self.home_panel = HomeLayoutPanel(self.api, self.settings, self.home_layout_key)
        QVBoxLayout(self.home_dialog).addWidget(self.home_panel)
        self.home_panel.preferences_changed.connect(self.apply_personal_preferences)
        self.create_account = CreateAccountPage()
        self.account = AccountPage()
        self.recovery = RecoveryPage()
        for page in (self.welcome, self.connection, self.login, self.personalize, self.library, self.create_account, self.account, self.recovery):
            self.stack.addWidget(page)
        if self.settings.value("onboarding/completed", False, type=bool):
            self.stack.setCurrentWidget(self.connection)
        self.welcome.continue_requested.connect(self._begin_setup)
        self.personalize.finished.connect(self.finish_onboarding)
        self.connection.connect_requested.connect(self.connect_server)
        self.connection.save_profile_requested.connect(self.save_connection_profile)
        self.connection.remove_profile_requested.connect(self.remove_connection_profile)
        self.connection.profile_selected.connect(self.select_connection_profile)
        self.reload_connection_profiles(self.profiles.active)
        self.login.login_requested.connect(self.sign_in)
        self.login.change_server_requested.connect(self.change_server)
        self.login.register_requested.connect(self.show_registration)
        self.login.restore_requested.connect(self.restore_saved_session)
        self.create_account.submitted.connect(self.submit_account_creation)
        self.create_account.back_requested.connect(self._leave_creation)
        self.account.back_requested.connect(self._leave_account)
        self.account.profile_requested.connect(self.update_profile)
        self.account.password_requested.connect(self.update_password)
        self.recovery.resume_requested.connect(self.resume_recovery)
        self.recovery.dismiss_requested.connect(self.dismiss_recovery)
        self.library.book_requested.connect(self.open_book)
        self.library.account_requested.connect(self.show_account)
        self.api.session_expired.connect(self._session_expired)
        self.app_menu = QMenu(self)
        file_menu = self.app_menu.addMenu("&File")
        self.change_action = file_menu.addAction("Change &server…", self.change_server)
        self.sign_out_action = file_menu.addAction("Sign &out", self.sign_out)
        self.sign_out_action.setEnabled(False)
        self.account_action = file_menu.addAction("My &account…", self.show_account)
        self.account_action.setEnabled(False)
        file_menu.addSeparator()
        file_menu.addAction("Offline library & sync…", self.show_offline)
        file_menu.addAction("Download current book for offline…", self.download_current)
        file_menu.addAction("Highlights, bookmarks & notes…", self.show_annotations)
        self.personal_action = file_menu.addAction("My reading…", self.show_personal)
        self.personal_action.setEnabled(False)
        self.upload_action = file_menu.addAction("Upload files and folders…", lambda: self.show_transfer(self.upload_panel))
        self.original_action = file_menu.addAction("Save original book…", self.save_original)
        self.cancel_original_action = file_menu.addAction("Cancel original download", self.cancel_original)
        self.devices_action = file_menu.addAction("Send to device…", lambda: self.show_transfer(self.devices_panel))
        self.integrations_action = file_menu.addAction("Connections and integrations…", self.show_integrations)
        self.home_action = file_menu.addAction("Home and reading preferences…", self.show_home_preferences)
        self._transfer_actions()
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
        for title, value in [("Dark", "dark"), ("Light", "light"), ("Follow system", "system")]:
            action = themes.addAction(title)
            action.setCheckable(True)
            action.setChecked(self.appearance.theme == value)
            theme_group.addAction(action)
            action.triggered.connect(lambda checked=False, theme=value: self.appearance.configure(theme=theme))
            self.appearance.changed.connect(lambda a=action, theme=value: a.setChecked(self.appearance.theme == theme))
        palettes = view_menu.addMenu("Color palette")
        palette_group = QActionGroup(self)
        for value in PRESETS:
            action = palettes.addAction(value.title())
            action.setCheckable(True)
            action.setChecked(self.appearance.preset == value)
            palette_group.addAction(action)
            action.triggered.connect(lambda checked=False, preset=value: self.appearance.configure(preset=preset))
            self.appearance.changed.connect(lambda a=action, preset=value: a.setChecked(self.appearance.preset == preset))
        scale_menu = view_menu.addMenu("Interface size")
        scale_group = QActionGroup(self)
        for percent in (100, 110, 125, 150, 175, 200):
            action = scale_menu.addAction(f"{percent}%")
            action.setCheckable(True)
            scale_group.addAction(action)
            action.setChecked(round(self.appearance.ui_scale * 100) == percent)
            action.triggered.connect(lambda checked=False, value=percent: self.appearance.configure(ui_scale=value / 100))
            self.appearance.changed.connect(lambda a=action, value=percent: a.setChecked(round(self.appearance.ui_scale * 100) == value))
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
        self.sync_button = QPushButton("Reading sync")
        self.sync_button.setAccessibleName("Offline library and reading sync status")
        self.sync_button.setProperty("kind", "text")
        self.sync_button.setStyleSheet("padding: 2px 10px;")
        self.sync_button.clicked.connect(self.show_offline)
        self.statusBar().addPermanentWidget(self.sync_button)
        self.reliability.changed.connect(self._sync_status)
        self.appearance.changed.connect(self._sync_status)
        self.sync_status_timer = QTimer(self)
        self.sync_status_timer.setInterval(2000)
        self.sync_status_timer.timeout.connect(self._sync_status)
        self.sync_status_timer.start()
        self._sync_status()
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
        profile = self.current_profile
        if profile and profile.get("reconnect") and self.settings.value("onboarding/completed", False, type=bool):
            QTimer.singleShot(0, lambda: self.connect_server(profile["address"]))

    def reload_connection_profiles(self, identity=""):
        combo = self.connection.profiles
        combo.blockSignals(True)
        combo.clear()
        combo.addItem("New connection", "")
        for profile in self.profiles.items:
            combo.addItem(profile["name"], profile["id"])
        combo.setCurrentIndex(max(0, combo.findData(identity)))
        combo.blockSignals(False)
        self.select_connection_profile(combo.currentData())

    def _sync_status(self):
        self.sync_button.setFixedHeight(ui_px(30))
        self.sync_button.setEnabled(bool(self.user))
        self.sync_button.setVisible(bool(self.user))
        self.statusBar().setFixedHeight(ui_px(36 if self.user else 22))
        scope = self.reliability.scope
        if not scope or self._store_closed:
            self.sync_button.setText("Reading sync"); return
        events = self.local_store.events(scope)
        pending = len(events) + self.local_store.db.execute("SELECT COUNT(*) FROM drafts WHERE scope=?", (scope,)).fetchone()[0]
        needs_review = sum(bool(row["conflict"]) for row in events)
        if needs_review:
            text = f"Sync: {needs_review} need review"
        elif self.reliability.enabled and not self.reliability.server_supported:
            text = "Sync needs server update"
        elif pending:
            text = f"Sync: {pending} pending"
        elif self.api.offline:
            text = "Reading offline"
        else:
            text = "Reading sync"
        self.sync_button.setText(text)
        self.sync_button.setToolTip("Open offline books, pending updates and conflict review.")

    def select_connection_profile(self, identity):
        self.current_profile = self.profiles.get(identity)
        profile = self.current_profile
        self.connection.profile_name.setText(profile["name"] if profile else "")
        self.connection.reconnect.setChecked(bool(profile and profile["reconnect"]))
        if profile:
            self.connection.address.setText(profile["address"])
        self.login.remember.setChecked(bool(profile and profile["remember"]))
        self.connection.remove_profile.setEnabled(profile is not None)

    def save_connection_profile(self):
        try:
            profile = self.profiles.save(self.connection.profile_name.text(), self.connection.address.text(),
                                         self.current_profile["id"] if self.current_profile else None,
                                         remember=bool(self.current_profile and self.current_profile["remember"]),
                                         reconnect=self.connection.reconnect.isChecked())
        except ValueError as error:
            self.connection.notice.setText(str(error))
            return
        self.reload_connection_profiles(profile["id"])
        self.connection.notice.setText("Server profile saved.")

    def remove_connection_profile(self):
        profile = self.current_profile
        if not profile:
            return
        def removed(_result, error):
            if error:
                self.connection.notice.setText("Profile kept because its vault entry could not be removed. " + error)
                return
            self.profiles.remove(profile["id"])
            self.reload_connection_profiles()
            self.connection.notice.setText("Server profile and remembered session removed.")
        if profile["remember"]:
            self.vault_tasks.submit("delete", profile, removed)
        else:
            removed(None, "")

    def _forget_session(self):
        profile = self.current_profile
        if not profile or not profile["remember"]:
            return
        profile["remember"] = False
        self.profiles.persist()
        self.login.remember.setChecked(False)
        self.login.restore_button.hide()
        self.vault_tasks.submit("delete", profile, lambda _result, error: self.statusBar().showMessage("Saved session could not be removed from the system vault. " + error) if error else None)

    def _remember_session(self):
        profile = self.current_profile
        if not profile or not self.user:
            return
        if not self.login.remember.isChecked():
            self._forget_session()
            return
        secret = self.api.export_session(self.user["id"])
        if not secret:
            self.statusBar().showMessage("The server did not provide a reusable session. Sign in again next time.")
            return
        epoch = self._connection_epoch
        profile["remember"] = True
        self.profiles.persist()
        def saved(_result, error):
            if error:
                profile["remember"] = False
                self.profiles.persist()
                if epoch == self._connection_epoch:
                    self.login.remember.setChecked(False)
                    self.statusBar().showMessage(error)
            elif epoch == self._connection_epoch and self.reliability.scope:
                self.local_store.bind_vault(self.reliability.scope, secret)
        self.vault_tasks.submit("write", profile, saved, secret)

    def restore_saved_session(self):
        profile = self.current_profile
        if not profile:
            return
        epoch = self._connection_epoch
        self.login.set_busy(True, "Checking the system password vault…")
        def read(secret, error):
            if epoch != self._connection_epoch:
                return
            if error or not secret:
                self.login.set_busy(False, error or "No saved session was found. Sign in to continue.")
                return
            try:
                expected_user = self.api.restore_session(secret)
            except (ValueError, TypeError, KeyError, AttributeError, UnicodeError):
                self.api.reset()
                self.login.set_busy(False, "The saved session is invalid or expired. Sign in again.")
                return
            def checked(data):
                user = data.get("user") if isinstance(data, dict) else None
                if not isinstance(user, dict) or type(user.get("id")) is not int or user.get("id") != expected_user:
                    self.api.reset()
                    self.login.set_busy(False, "The saved session expired or changed account. Sign in again.")
                    return
                self.login.set_busy(False)
                self._authenticated(user)
                self.local_store.bind_vault(self.reliability.scope, secret)
            self.api.json("GET", "/api/status", checked, lambda problem: self.login.set_busy(False, problem.message))
        self.vault_tasks.submit("read", profile, read)

    def show_registration(self):
        if self._registration is None:
            return
        self.create_account.configure(invite=bool(self._registration.get("inviteRequired")))
        self.stack.setCurrentWidget(self.create_account)

    def _leave_creation(self):
        self.create_account.clear_secrets()
        self.stack.setCurrentWidget(self.connection if self.create_account.setup else self.login)

    def submit_account_creation(self, body):
        page = self.create_account
        page.set_busy(True, "Creating your account…")
        def created(data):
            page.clear_secrets()
            page.set_busy(False)
            if not isinstance(data, dict) or not isinstance(data.get("user"), dict) or type(data["user"].get("id")) is not int:
                page.notice.setText("The server returned an invalid account response.")
                return
            self._authenticated(data["user"])
            self._remember_session()
        self.api.json("POST", "/api/setup" if page.setup else "/api/register", created,
                      lambda error: page.set_busy(False, error.message), body)

    def show_account(self):
        if not self.user:
            return
        if self.reader:
            self.reader.request_leave(self._account_from_reader)
            return
        self.account.populate(self.user)
        self.stack.setCurrentWidget(self.account)

    def _account_from_reader(self):
        self._return_to_library()
        self.show_account()

    def _leave_account(self):
        self.account.clear_secrets()
        self.stack.setCurrentWidget(self.library)

    def update_profile(self, body):
        self.account.set_busy(True, "Saving profile…")
        def saved(user):
            if not isinstance(user, dict) or not self.user or user.get("id") != self.user["id"]:
                self.account.set_busy(False, "The server returned an invalid profile.")
                return
            self.user = user
            self.library.user = user
            self.account.populate(user)
            self.account.notice.setText("Profile saved.")
            self.setWindowTitle("Flyleaf Desktop — " + text(user.get("displayName"), text(user.get("username"))))
        self.api.json("PATCH", "/api/me", saved, lambda error: self.account.set_busy(False, error.message), body)

    def update_password(self, body):
        self.account.set_busy(True, "Changing password…")
        def saved(_data):
            self.account.clear_secrets()
            self.account.set_busy(False, "Password changed. Your password was not saved on this computer.")
        self.api.json("POST", "/api/me/password", saved, lambda error: self.account.set_busy(False, error.message), body)

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
        self._connection_epoch += 1
        self.connection.set_busy(True, "Checking the Flyleaf server…")

        def connected(data: object) -> None:
            if not isinstance(data, dict) or not isinstance(data.get("needsSetup"), bool) or "user" not in data:
                self.connection.set_busy(False, "This address is not a compatible Flyleaf server. Enter the server's base address, not an API or reader URL.")
                return
            self.connection.set_busy(False)
            self.settings.setValue("connection/server", self.api.base)
            self.settings.sync()
            profile = self.current_profile
            if not profile or profile["address"] != self.api.base:
                profile = self.profiles.save(self.connection.profile_name.text().strip() or QUrl(self.api.base).host(), self.api.base,
                                             reconnect=self.connection.reconnect.isChecked())
            else:
                profile["reconnect"] = self.connection.reconnect.isChecked()
                self.profiles.active = profile["id"]
                self.profiles.persist()
            self.reload_connection_profiles(profile["id"])
            self._registration = data.get("registration") if isinstance(data.get("registration"), dict) else None
            self._capabilities = data.get("capabilities", {})
            self.login.register_button.setVisible(self._registration is not None)
            self.login.restore_button.setVisible(profile["remember"])
            if data["needsSetup"]:
                self.create_account.configure(setup=True)
                self.stack.setCurrentWidget(self.create_account)
                return
            self.login.server.setText("Connected to " + self.api.base)
            self.login.password.clear()
            message = "HTTP is unencrypted. Use HTTPS outside a trusted local network." if self.api.base.startswith("http://") else ""
            self.login.set_busy(False, message)
            self.stack.setCurrentWidget(self.login)
            self.login.username.setFocus()
            self.statusBar().showMessage(self.api.base)
            if profile["remember"]:
                self.restore_saved_session()
        self.api.json("GET", "/api/status", connected,
                      lambda error: self.connection.set_busy(False, error.message))

    def sign_in(self, username: str, password: str) -> None:
        self.login.set_busy(True, "Signing in…")

        def signed_in(data: object) -> None:
            self.login.password.clear()
            self.login.set_busy(False)
            if not isinstance(data, dict) or not isinstance(data.get("user"), dict) or type(data["user"].get("id")) is not int:
                self.login.notice.setText("The server returned an invalid sign-in response.")
                return
            self._authenticated(data["user"])
            self._remember_session()
        def failed(error: ApiError) -> None:
            self.login.set_busy(False, error.message)
            self.login.password.selectAll()
            self.login.password.setFocus()
        self.api.json("POST", "/api/login", signed_in, failed, {"username": username, "password": password})

    def _authenticated(self, user):
        self.user = user
        self.api.capabilities = self._capabilities
        try:
            self.reliability.start(user, self._capabilities)
        except (OSError, sqlite3.Error, ValueError) as error:
            self.reliability.stop(); self.api.reset(); self.user = None
            self.login.set_busy(False, "Local reading data could not be opened. Nothing was reset: " + str(error))
            self.stack.setCurrentWidget(self.login)
            return
        self.sign_out_action.setEnabled(True)
        self.account_action.setEnabled(True)
        name = text(user.get("displayName"), text(user.get("username"), "Reader"))
        self.setWindowTitle("Flyleaf Desktop — " + name)
        self.library.start_session(user, self._capabilities)
        self.appearance.set_eink((user.get("prefs") or {}).get("einkMode"))
        self.home_panel.start_session(user)
        self.personal.start_session(user)
        self.personal_action.setEnabled(True)
        self.upload_panel.start_session(user)
        self.devices_panel.start_session(user)
        for panel in self.integration_panels:
            panel.start_session(user)
        self._transfer_actions()
        self.statusBar().showMessage(f"{name} · {self.api.base}")
        same = self._recovery and self._recovery["identity"] == (self.api.base, user["id"])
        if same:
            self.recovery.populate(self._recovery)
            self.stack.setCurrentWidget(self.recovery)
        elif self.settings.value("onboarding/completed", False, type=bool):
            self.stack.setCurrentWidget(self.library)
        else:
            self.stack.setCurrentWidget(self.personalize)
            self.personalize.finish_button.setFocus()

    def dismiss_recovery(self):
        self._recovery = None
        self.recovery.clear()
        self.stack.setCurrentWidget(self.library)

    def resume_recovery(self, use_pending):
        recovery = self._recovery
        if not recovery or not self.user or recovery["identity"] != (self.api.base, self.user["id"]):
            return
        self.open_book(recovery["book"], recovery if use_pending else None)

    def _clear_session(self) -> None:
        self._connection_epoch += 1
        self.stack.finish_transition()
        self._open_generation += 1
        if self.reader:
            reader, self.reader = self.reader, None
            reader.dispose()
            self.stack.removeWidget(reader)
            reader.deleteLater()
        self.downloads.cancel()
        self.offline_dialog.hide()
        self.reliability.stop()
        self.offline_dialog.refresh()
        self.annotations_dialog.hide()
        self.annotations_dialog.clear()
        self.personal_dialog.hide()
        self.personal.clear_session()
        self.personal_action.setEnabled(False)
        self.transfer_dialog.hide()
        self.upload_panel.clear_session()
        self.devices_panel.clear_session()
        self.cancel_original()
        self.integrations_dialog.hide()
        for panel in self.integration_panels:
            panel.clear_session()
        self.home_dialog.hide()
        self.home_panel.clear_session()
        self.api.reset()
        self.library.clear_session()
        self._browse_state = None
        self.account.clear()
        self.create_account.clear()
        self.recovery.clear()
        self.user = None
        self.appearance.set_eink(False)
        self._transfer_actions()
        self.sign_out_action.setEnabled(False)
        self.account_action.setEnabled(False)
        self.setWindowTitle("Flyleaf Desktop")
        self.statusBar().showMessage("Sign in to your Flyleaf server")
        self.login.password.clear()
        self._sync_status()

    def change_server(self) -> None:
        if self.reader and self.reader.has_unsaved_changes:
            self.reader.request_leave(self._change_server_now)
        else:
            self._change_server_now()

    def _change_server_now(self) -> None:
        self._recovery = None
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
            if self.reliability.scope:
                self.local_store.lock_offline(self.reliability.scope)
            self._forget_session()
            self._recovery = None
            self._clear_session()
            self.login.set_busy(False, "Signed out. Enter your account details to sign in again.")
            self.stack.setCurrentWidget(self.login)
            self.login.password.setFocus()
        def failed(error: ApiError) -> None:
            self.sign_out_action.setEnabled(True)
            self.statusBar().showMessage("Sign-out failed: " + error.message)
        if self.api.offline:
            signed_out({})
        else:
            self.api.json("POST", "/api/logout", signed_out, failed)

    def _session_expired(self) -> None:
        if self.reliability.scope:
            self.local_store.lock_offline(self.reliability.scope)
        if self.user and self.reader:
            reader = self.reader
            # Never capture an attempted/failed page as recoverable reading progress.
            pending = reader._pending if reader._pending is not None else reader._saving_page
            if isinstance(pending, dict):
                pending = reader.page
            self._recovery = {"identity": (self.api.base, self.user["id"]), "book": dict(reader.book),
                              "page": pending if pending is not None else reader._last_saved or 0,
                              "pending": pending is not None,
                              "position": reader.current_locator() if hasattr(reader, "current_locator") else None}
        self._clear_session()
        self.login.set_busy(False, "Your session expired. Sign in again. A recovery prompt is available only to the same account on this server; nothing is replayed automatically.")
        self.stack.setCurrentWidget(self.login)

    def open_book(self, book: dict, recovery: dict | None = None) -> None:
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
            if self.reliability.enabled and self.reliability.scope:
                row = self.local_store.book(self.reliability.scope, actual["id"])
                if row and row["version"] != json.dumps(actual.get("version")) and self.local_store.pending_book(self.reliability.scope, actual["id"]):
                    draft = self.local_store.db.execute("SELECT body FROM drafts WHERE scope=? AND book=?", (self.reliability.scope, actual["id"])).fetchone()
                    if draft:
                        self.local_store.enqueue(self.reliability.scope, actual["id"], json.loads(draft["body"]))
                    elif not any(e["book"] == actual["id"] for e in self.local_store.events(self.reliability.scope)):
                        self.local_store.enqueue(self.reliability.scope, actual["id"], {})
                    self.reliability.pump()
                    self.offline_dialog.refresh(); self.offline_dialog.show()
                    self.offline_dialog.notice.setText("This book changed. Compare and resolve pending work from its previous revision before opening the replacement.")
                    return
            if recovery and (recovery["book"].get("version") is None or recovery["book"].get("version") != actual.get("version")):
                self.recovery.message.setText("This book's file changed, or its version cannot be verified. Use the server's latest position instead.")
                self.recovery.resume_pending.hide()
                return
            if recovery:
                data = {**data, "book": {**actual, "progress": {"page": recovery["page"], "position": recovery.get("position")}}}
            if actual.get("format") not in IMAGE_FORMATS | TEXT_FORMATS | {"pdf", "audio"}:
                self.statusBar().showMessage("This format's native reader is scheduled in the desktop roadmap.")
                dialog = QMessageBox(self)
                dialog.setWindowTitle("Native reader not available yet")
                dialog.setTextFormat(Qt.TextFormat.PlainText)
                dialog.setText(f"{text(actual.get('format'), 'This format').upper()} reading is not implemented in this initial build.")
                dialog.setInformativeText("Native readers cover image books, PDF, EPUB and supported server-converted ebooks, plus audiobooks with VLC installed. This format has no native reader yet.")
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
            if self.stack.currentWidget() is self.library:
                self._browse_state = self.library.capture_state()
            reader_type = ComicReader if actual.get("format") in IMAGE_FORMATS else AudioReader if actual.get("format") == "audio" else DocumentReader
            self.reader = reader_type(self.api, data, self._return_to_library)
            self.reader.active_clock = ActiveClock(self.reader)
            self._recovery = None
            self.recovery.clear()
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
        self.library.refresh_preserving(self._browse_state)
        self._browse_state = None
        self.library.search.setFocus()

    def _book_revoked(self, book_id):
        if not self.user:
            return
        self.annotations_dialog.hide(); self.annotations_dialog.clear()
        if self.reader and self.reader.book["id"] == book_id:
            reader, self.reader = self.reader, None
            reader._disposed = True
            reader._pending = None
            if hasattr(reader, "active_clock"):
                reader.active_clock.stop()
            reader.dispose()
            self.stack.removeWidget(reader); reader.deleteLater()
            self.stack.setCurrentWidget(self.library)
        self._browse_state = None
        self.library.start_session(self.user, self._capabilities)
        self.statusBar().showMessage("This book is no longer available to this account. Offline content was removed; pending reading work is retained for review.")

    def show_annotations(self):
        if not self.user:
            return
        self.annotations_dialog.load(); self.annotations_dialog.show()

    def show_personal(self, tab=None):
        if not self.user:
            return
        volume = self.library.books.currentItem()
        book = self.reader.book if self.reader else volume.data(Qt.ItemDataRole.UserRole) if volume else None
        series = self.library.selected_series
        if book and book.get("seriesId") != series.get("id"):
            series = {"id": book.get("seriesId"), "name": book.get("series") or book.get("title")}
        self.personal.set_context(series, book)
        index = {"series": 1, "activity": 6}.get(tab, self.personal.tabs.currentIndex())
        if index == self.personal.tabs.currentIndex():
            self.personal.activate()
        else:
            self.personal.tabs.setCurrentIndex(index)
        self.personal_dialog.show()
        self.personal_dialog.raise_()

    def _transfer_actions(self):
        user = self.user or {}
        permissions = user.get("permissions") or {}
        admin = user.get("role") == "admin"
        self.upload_action.setEnabled(admin or bool(permissions.get("upload")))
        download = admin or bool(permissions.get("download"))
        self.original_action.setEnabled(download and self.original_download is None)
        self.cancel_original_action.setEnabled(self.original_download is not None)
        self.devices_action.setEnabled(download)
        self.integrations_action.setEnabled(bool(self.user))
        self.home_action.setEnabled(bool(self.user))

    def home_layout_key(self):
        scope = self.reliability.scope
        return "homeLayouts/" + scope if scope else None

    def home_layout_value(self):
        key = self.home_layout_key()
        value = self.settings.value(key) if key else None
        if not isinstance(value, dict):
            value = ((self.user or {}).get("prefs") or {}).get("home")
        return value if isinstance(value, dict) else {}

    def show_home_preferences(self):
        if self.user:
            self.home_panel.reload()
            self.home_dialog.show()

    def apply_personal_preferences(self, prefs):
        if not self.user or not isinstance(prefs, dict):
            return
        if prefs:
            self.user["prefs"] = prefs
            self.library.user = self.user
            self.appearance.set_eink(prefs.get("einkMode"))
        self.library.refresh_preserving(self.library.capture_state())

    def show_integrations(self):
        if not self.user:
            return
        admin = self.user.get("role") == "admin"
        self.integration_tabs.setTabVisible(1, admin or bool((self.user.get("permissions") or {}).get("apiAccess")))
        for index in (2, 3):
            self.integration_tabs.setTabVisible(index, admin)
        self._reload_integration(self.integration_tabs.currentIndex())
        self.integrations_dialog.show()

    def _reload_integration(self, index):
        if not self.user or not 0 <= index < len(self.integration_panels):
            return
        admin = self.user.get("role") == "admin"
        if index == 0 or admin or (index == 1 and (self.user.get("permissions") or {}).get("apiAccess")):
            self.integration_panels[index].reload()

    def selected_book(self):
        volume = self.library.books.currentItem()
        return self.reader.book if self.reader else volume.data(Qt.ItemDataRole.UserRole) if volume else None

    def show_transfer(self, panel):
        action = self.upload_action if panel is self.upload_panel else self.devices_action
        if not action.isEnabled():
            return
        self.upload_panel.setVisible(panel is self.upload_panel)
        self.devices_panel.setVisible(panel is self.devices_panel)
        panel.context(self.library.selected_series, self.selected_book())
        self.transfer_dialog.setWindowTitle("Upload to Flyleaf" if panel is self.upload_panel else "Send to device")
        panel.reload()
        self.transfer_dialog.show()

    def cancel_original(self):
        reply, self.original_download = self.original_download, None
        if reply:
            reply.abort()
        self._transfer_actions()

    def save_original(self):
        book = self.selected_book()
        if not self.original_action.isEnabled() or not book:
            self.statusBar().showMessage("Choose a book you can download.")
            return
        volume = self.library.books.currentItem()
        title = "Book" if not self.reader and volume and volume.data(int(Qt.ItemDataRole.UserRole) + 1) else text(book.get("title"), "Book")
        filename = re.sub(r'[<>:"/\\|?*\x00-\x1f]', "_", title).strip(" .")[:140] or "Book"
        extension = {"folder": "cbz", "audio": ""}.get(book.get("format"), book.get("format"))
        if extension and re.fullmatch(r"[a-z0-9]{1,8}", extension):
            filename += "." + extension
        epoch = self._connection_epoch
        target, _ = QFileDialog.getSaveFileName(self, "Save the original book", filename)
        if not target or epoch != self._connection_epoch:
            return
        def report(message):
            if epoch != self._connection_epoch:
                return
            self.original_download = None
            self._transfer_actions()
            self.statusBar().showMessage(message)
        def progress(done, total):
            if epoch == self._connection_epoch and total > 0:
                self.statusBar().showMessage(f"Saving original book · {done * 100 // total}%")
        self.original_download = self.api.download_file(
            f"/api/books/{book['id']}/download", target,
            lambda _path: report("Original book saved."), lambda error: report(error.message), progress)
        self._transfer_actions()

    def _open_personal_book(self, book):
        self.personal_dialog.hide()
        if self.reader and self.reader.has_unsaved_changes:
            self.reader.request_leave(lambda: self.open_book(book))
        else:
            self.open_book(book)

    def _open_personal_series(self, series):
        self.personal_dialog.hide()
        def show():
            if self.reader:
                self._return_to_library()
            self.stack.setCurrentWidget(self.library)
            self.library.inspect_series(series)
        if self.reader and self.reader.has_unsaved_changes:
            self.reader.request_leave(show)
        else:
            show()

    def download_current(self):
        book = self.reader.book if self.reader else self.library.books.currentItem().data(Qt.ItemDataRole.UserRole) if self.library.books.currentItem() else None
        if not self.user or not book:
            self.statusBar().showMessage("Choose a volume or open a reader before downloading it."); return
        self.offline_dialog.refresh()
        self.offline_dialog.show()
        self.downloads.start(book)

    def show_offline(self):
        if self.user:
            self.offline_dialog.refresh(); self.offline_dialog.show(); return
        profile = self.current_profile
        if not profile or not profile.get("remember"):
            self.statusBar().showMessage("Sign in first. Offline reopening after restart requires a remembered session in the OS vault."); return
        epoch = self._connection_epoch
        def unlocked(secret, error):
            if epoch != self._connection_epoch:
                return
            if error or not secret:
                self.statusBar().showMessage(error or "No remembered session is available."); return
            try:
                self.api.connect_server(profile["address"])
                user_id = self.api.restore_session(secret)
                user = self.local_store.unlock(self.api.base, user_id, secret)
            except (ValueError, TypeError, KeyError):
                user = None
            if not user or not user.get("desktopDurableProgress"):
                self.api.reset()
                self.statusBar().showMessage("No verified offline account is available for this vault session. Sign in online first."); return
            self.api.offline = True
            self._capabilities = {"durableProgress": 1}
            self._authenticated(user)
            if not self.user:
                return
            self.local_store.bind_vault(self.reliability.scope, secret)
            self.offline_dialog.refresh(); self.offline_dialog.show()
        self.vault_tasks.submit("read", profile, unlocked)

    def reconnect_reading(self):
        if not self.user:
            return
        was_offline, was_supported = self.api.offline, self.reliability.server_supported
        self.reliability.server_supported = False
        self.api.offline = False
        expected, epoch = self.user["id"], self._connection_epoch
        def checked(data):
            if epoch != self._connection_epoch:
                return
            user = data.get("user") if isinstance(data, dict) else None
            if not user or user.get("id") != expected:
                self._session_expired(); return
            self._capabilities = data.get("capabilities") or {}
            self.api.capabilities = self._capabilities
            self.reliability.server_supported = self._capabilities.get("durableProgress") == 1
            if self.reliability.server_supported:
                self.reliability.enabled = True
            self.user = user
            self.reliability.user = user
            self.offline_dialog.notice.setText("Server identity verified. Pending positions are checked for conflicts before syncing." if self.reliability.server_supported else "Update the server to restore durable sync. Pending work remains on this device.")
            self.reliability.retry(); self.offline_dialog.refresh()
        def failed(error):
            if epoch == self._connection_epoch:
                self.api.offline = was_offline
                self.reliability.server_supported = was_supported
                self.offline_dialog.notice.setText(error.message)
        self.api.json("GET", "/api/status", checked, failed)

    def toggle_fullscreen(self) -> None:
        self.showNormal() if self.isFullScreen() else self.showFullScreen()

    def about(self) -> None:
        QMessageBox.about(self, "About Flyleaf Desktop", f"Flyleaf Desktop {__version__}\n\nNative Qt 6 Widgets through PySide6 Essentials.\nNo Chromium, Qt WebEngine, embedded WebView, or direct server-database access.\n\nImage, PDF, EPUB and server-converted document readers; optional native VLC audio. MuPDF is AGPL/commercial licensed. See desktop/roadmap.md and desktop/docs/dependencies.md for support levels and third-party terms.")

    def closeEvent(self, event) -> None:
        if self.reader and self.reader.has_unsaved_changes:
            event.ignore()
            self.reader.request_leave(self._close_after_save)
            return
        self._clear_session()
        self.reliability.timer.stop()
        self.sync_status_timer.stop()
        if not self._store_closed:
            self.local_store.close()
            self._store_closed = True
        event.accept()

    def _close_after_save(self) -> None:
        self._clear_session()
        self.close()


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Flyleaf's native desktop client")
    parser.add_argument("--server", help="Prefill the server address; you still choose Connect")
    options = parser.parse_args(argv)
    if QApplication.instance() is None:
        QApplication.setHighDpiScaleFactorRoundingPolicy(Qt.HighDpiScaleFactorRoundingPolicy.PassThrough)
    application = QApplication.instance() or QApplication([sys.argv[0]])
    application.setApplicationName("Flyleaf Desktop")
    application.setOrganizationName("Flyleaf")
    application.setApplicationVersion(__version__)
    QImageReader.setAllocationLimit(128)
    try:
        window = MainWindow()
    except (OSError, sqlite3.Error, ValueError) as error:
        QMessageBox.critical(None, "Local reading data unavailable", str(error) + "\n\nExisting local data was not reset. Use a compatible client and a writable application-data directory.")
        return 1
    if options.server:
        window.connection.address.setText(options.server)
    window.show()
    return application.exec()


if __name__ == "__main__":
    raise SystemExit(main())
