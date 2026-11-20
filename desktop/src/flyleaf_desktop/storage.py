"""Personal storage settings and server-wide migration progress."""

import time

from PySide6.QtCore import QObject, QTimer
from PySide6.QtWidgets import (
    QApplication, QComboBox, QDialog, QDialogButtonBox, QFormLayout, QHBoxLayout, QInputDialog, QLineEdit,
    QProgressBar, QPushButton, QVBoxLayout, QWidget,
)

from .widgets import label, text


STAGES = {
    "waiting": "Waiting for storage operations to finish",
    "preparing": "Checking folders and available space",
    "copying": "Copying files",
    "verifying": "Checking copied files",
    "switching": "Updating personal library paths",
    "cleaning": "Removing the original folder",
}


def migration_message(migration: dict) -> str:
    return {
        "running": STAGES.get(migration.get("phase"), "Moving personal folder"),
        "done": "Personal folder migration completed",
        "failed": "Personal folder migration failed",
    }.get(migration.get("status"), "")


class PersonalStorage(QObject):
    def __init__(self, window, api):
        super().__init__(window)
        self.window = window
        self.api = api
        self.user = None
        self.data = {}
        self.pending = False
        self.dialog = None

        self.indicator = QWidget(window)
        layout = QHBoxLayout(self.indicator)
        layout.setContentsMargins(0, 0, 8, 0)
        self.message = label()
        self.progress = QProgressBar()
        self.progress.setAccessibleName("Personal folder migration progress")
        self.progress.setFixedWidth(100)
        layout.addWidget(self.message)
        layout.addWidget(self.progress)
        window.statusBar().addPermanentWidget(self.indicator)
        self.indicator.hide()

        self.timer = QTimer(self)
        self.timer.setInterval(3000)
        self.timer.timeout.connect(self.poll)

    def set_user(self, user):
        self.timer.stop()
        if self.dialog:
            self.dialog.reject()
        self.user = user
        self.pending = False
        self.data = {}
        self.indicator.hide()
        if user:
            self.timer.start()
            self.poll()

    def poll(self):
        if not self.user or self.pending:
            return
        self.pending = True

        def received(data):
            self.pending = False
            if not isinstance(data, dict):
                return
            before = self.data.get("migration") or {}
            self.data = data
            self.user["homeDir"] = data.get("homeDir")
            migration = data.get("migration") or {}
            running = migration.get("status") == "running"
            finished = migration.get("finishedAt")
            recent = isinstance(finished, (int, float)) and 0 <= time.time() * 1000 - finished < 30_000
            message = migration_message(migration)
            if message and (running or recent):
                self.message.setText(message)
                self.progress.setValue(migration.get("percent", 0))
                self.indicator.show()
            else:
                self.indicator.hide()
            if self.dialog:
                self.dialog.update_status(data)
                if recent and migration.get("status") == "done" and before != migration:
                    self.dialog.load_users()

        def failed(error):
            self.pending = False
            if error.status == 404:
                self.timer.stop()
            if self.dialog:
                self.dialog.error.setText(error.message)

        self.api.json("GET", "/api/storage-migration", received, failed)

    def open_settings(self):
        if not self.user or self.dialog:
            return
        self.dialog = StorageDialog(self)
        self.dialog.finished.connect(self.close_settings)
        self.dialog.update_status(self.data)
        self.dialog.load_users()
        self.dialog.open()
        self.poll()

    def close_settings(self):
        dialog, self.dialog = self.dialog, None
        dialog.deleteLater()


class StorageDialog(QDialog):
    def __init__(self, storage):
        super().__init__(storage.window)
        self.storage = storage
        self.admin = storage.user.get("role") == "admin"
        self.submitting = False
        self.running = False
        self.can_move = False
        self.checked_path = None
        self.result = {}
        self.setWindowTitle("Personal storage")
        self.setMinimumWidth(480)

        layout = QVBoxLayout(self)
        form = QFormLayout()
        self.accounts = QComboBox()
        if self.admin:
            form.addRow("&Account", self.accounts)
            self.accounts.currentIndexChanged.connect(self.select_account)
        self.home = label(wrap=True)
        form.addRow("Current folder", self.home)
        self.destination = QLineEdit()
        self.destination.setPlaceholderText("Full path of a new folder on the server")
        self.destination.textChanged.connect(self.invalidate_preview)
        form.addRow("&Destination", self.destination)
        layout.addLayout(form)
        self.roots = label(wrap=True)
        layout.addWidget(self.roots)
        layout.addWidget(label("The destination’s parent folder must already exist. Flyleaf copies the full personal folder before updating the library paths and removing the original.", wrap=True))
        utilities = QHBoxLayout()
        self.browse_button = QPushButton("Browse server folders…")
        self.browse_button.clicked.connect(lambda: self.browse())
        self.preview_button = QPushButton("Check destination")
        self.preview_button.clicked.connect(self.preview_move)
        self.retry_button = QPushButton("Retry move")
        self.retry_button.clicked.connect(self.retry_move)
        self.copy_button = QPushButton("Copy destination path")
        self.copy_button.clicked.connect(lambda: QApplication.clipboard().setText(self.result.get("destination", "")))
        for control in [self.browse_button, self.preview_button, self.retry_button, self.copy_button]:
            utilities.addWidget(control)
        layout.addLayout(utilities)
        self.preview = label(wrap=True)
        layout.addWidget(self.preview)
        self.status = label(wrap=True)
        self.progress = QProgressBar()
        self.progress.setAccessibleName("Personal folder migration progress")
        self.error = label(wrap=True)
        layout.addWidget(self.status)
        layout.addWidget(self.progress)
        layout.addWidget(self.error)
        buttons = QDialogButtonBox(QDialogButtonBox.StandardButton.Close)
        self.move = buttons.addButton("Start move", QDialogButtonBox.ButtonRole.ActionRole)
        self.move.clicked.connect(self.submit)
        buttons.rejected.connect(self.reject)
        layout.addWidget(buttons)

    def load_users(self):
        if not self.admin:
            return

        def loaded(users):
            if self.storage.dialog is not self or not isinstance(users, list):
                return
            selected = (self.accounts.currentData() or {}).get("id")
            self.accounts.blockSignals(True)
            self.accounts.clear()
            for user in users:
                if user.get("role") != "admin" and user.get("homeDir"):
                    self.accounts.addItem(text(user.get("displayName"), text(user.get("username"))), user)
                    if user.get("id") == selected:
                        self.accounts.setCurrentIndex(self.accounts.count() - 1)
            self.accounts.blockSignals(False)
            self.select_account()

        def failed(error):
            if self.storage.dialog is self:
                self.error.setText(error.message)

        self.storage.api.json("GET", "/api/users", loaded, failed)

    def select_account(self):
        account = self.accounts.currentData() or {}
        self.home.setText(text(account.get("homeDir"), "No personal folder assigned"))
        self.can_move = bool(account.get("homeDir"))
        self.invalidate_preview()

    def account_params(self):
        return {"userId": (self.accounts.currentData() or {}).get("id")} if self.admin else {}

    def invalidate_preview(self):
        self.checked_path = None
        self.preview.clear()
        self.update_button()

    def update_button(self):
        enabled = self.can_move and not self.running and not self.submitting
        destination = self.destination.text().strip()
        self.move.setEnabled(enabled and bool(destination) and self.checked_path == destination)
        self.browse_button.setEnabled(enabled)
        self.preview_button.setEnabled(enabled and bool(destination))

    def browse(self, folder=None):
        params = {**self.account_params(), "path": folder}

        def loaded(data):
            if self.storage.dialog is not self:
                return
            options = {name: name for name in data.get("roots", [])} if not folder else {
                entry["name"]: entry["path"] for entry in data.get("folders", [])}
            actions = ["Use this folder as parent", "Up one level"] if folder else []
            value, accepted = QInputDialog.getItem(self, "Browse storage", data.get("path") or "Storage location",
                                                   actions + list(options), 0, False)
            if not accepted:
                return
            if value == "Use this folder as parent":
                sep = data["separator"]
                name = self.home.text().replace("\\", "/").rstrip("/").rsplit("/", 1)[-1]
                self.destination.setText(data["path"].rstrip("/\\") + sep + name)
            elif value == "Up one level":
                self.browse(data.get("parent"))
            elif value in options:
                self.browse(options[value])

        self.storage.api.json("GET", "/api/storage-migration/folders", loaded, self.show_error, params=params)

    def preview_move(self):
        destination = self.destination.text().strip()
        params = {**self.account_params(), "destination": destination}
        self.checked_path = None
        self.error.clear()
        self.update_button()
        self.preview.setText("Checking the destination…")
        account = self.account_params()

        def loaded(data):
            if self.storage.dialog is not self or destination != self.destination.text().strip() or account != self.account_params():
                return
            if data.get("fits") is not False:
                self.checked_path = destination
            size = data.get("bytes", 0) / 1048576
            free = data.get("free")
            space = f"{free / 1048576:,.1f} MiB free" if free is not None else "Free space is unknown"
            if data.get("reserve"):
                space += f" · {data['reserve'] / 1048576:,.1f} MiB reserved"
            warning = "\nThe destination does not have enough space." if data.get("fits") is False else ""
            self.preview.setText(f"{data.get('destination')}\n{data.get('files')} files · {size:,.1f} MiB · {space}{warning}")
            self.update_button()

        def failed(error):
            if self.storage.dialog is self and destination == self.destination.text().strip() and account == self.account_params():
                self.preview.clear()
                self.show_error(error)

        self.storage.api.json("GET", "/api/storage-migration/preview", loaded, failed, params=params)

    def show_error(self, error):
        if self.storage.dialog is self:
            self.error.setText(error.message)

    def retry_move(self):
        if self.admin:
            for index in range(self.accounts.count()):
                if self.accounts.itemData(index).get("id") == self.result.get("userId"):
                    self.accounts.setCurrentIndex(index)
                    break
        self.destination.setText(self.result.get("destination", ""))
        self.destination.setFocus()

    def update_status(self, data):
        latest = data.get("migration") or {}
        own = data.get("ownMigration") or {}
        self.running = latest.get("status") == "running"
        if not self.admin:
            self.home.setText(text(data.get("homeDir"), "No personal folder assigned"))
            self.can_move = bool(data.get("canMove"))
            roots = [root for root in data.get("roots", []) if isinstance(root, str)]
            self.roots.setText("Available storage locations\n" + "\n".join(roots) if roots else "")
        migration = latest if self.running or self.admin else own
        self.result = migration
        message = migration_message(migration)
        detail = text(migration.get("detail"))
        percent = migration.get("percent", 0)
        self.status.setText(f"{message} · {percent}%" + (f"\n{detail}" if detail else "") if message else "")
        self.progress.setVisible(self.running)
        if self.running:
            self.progress.setValue(percent)
        has_destination = bool(migration.get("destination"))
        self.copy_button.setVisible(has_destination)
        self.retry_button.setVisible(has_destination and migration.get("status") == "failed")
        self.update_button()

    def submit(self):
        path = "/api/storage-migration"
        if self.admin:
            user_id = (self.accounts.currentData() or {}).get("id")
            if not isinstance(user_id, int):
                return
            path = f"/api/users/{user_id}/storage-migration"
        self.submitting = True
        self.error.clear()
        self.update_button()

        def started(_data):
            if self.storage.dialog is self:
                self.submitting = False
                self.running = True
                self.destination.clear()
                self.status.setText("Personal folder migration started")
            self.storage.poll()

        def failed(error):
            if self.storage.dialog is self:
                self.submitting = False
                self.error.setText(error.message)
                self.update_button()

        self.storage.api.json("POST", path, started, failed, {"destination": self.destination.text().strip()})
