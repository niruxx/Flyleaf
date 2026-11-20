"""Native streaming transfers to and from a connected Flyleaf server."""
from pathlib import Path
from urllib.parse import urlencode

from PySide6.QtWidgets import (QComboBox, QFileDialog, QHBoxLayout, QInputDialog,
                               QListWidget, QMessageBox, QProgressBar)

from .personal_workspace import PersonalPanel, button, current, fill
from .widgets import label, text


BOOK_FILES = {
    ".cbz", ".cbr", ".cb7", ".cbt", ".zip", ".rar", ".7z", ".tar", ".epub", ".kepub",
    ".pdf", ".fb2", ".mobi", ".azw3", ".txt", ".docx", ".rtf", ".m4b", ".m4a",
    ".mp3", ".ogg", ".opus", ".flac", ".aac", ".wav", ".jpg", ".jpeg", ".png",
    ".webp", ".avif", ".gif", ".bmp", ".tiff", ".tif",
}


class UploadPanel(PersonalPanel):
    def __init__(self, api, settings, account_scope):
        super().__init__(api)
        self.settings = settings
        self.account_scope = account_scope
        self.reply = None
        self.pending = []
        self.uploaded = []
        self.remote = ""
        self.batch = None
        self.maximum = None
        self.layout.addWidget(label("Upload to a server library", heading=True))
        row = QHBoxLayout()
        self.library = QComboBox()
        self.library.setAccessibleName("Destination server library")
        self.library.currentIndexChanged.connect(self.change_library)
        row.addWidget(self.library, 1)
        button(row, "Refresh libraries", self.reload)
        self.layout.addLayout(row)
        self.folder = label("Server folder: /", wrap=True)
        self.layout.addWidget(self.folder)
        self.folders = QListWidget()
        self.folders.setAccessibleName("Folders on the server")
        self.folders.itemActivated.connect(self.open_folder)
        self.layout.addWidget(self.folders, 1)
        row = QHBoxLayout()
        button(row, "Parent folder", self.parent_folder)
        button(row, "Create server folder", self.create_folder)
        self.layout.addLayout(row)
        row = QHBoxLayout()
        button(row, "Choose local files…", self.choose_files)
        button(row, "Choose local folder…", self.choose_folder)
        self.layout.addLayout(row)
        row = QHBoxLayout()
        button(row, "Start / retry remaining", self.start)
        button(row, "Cancel transfer", self.cancel)
        button(row, "Skip file…", self.skip)
        button(row, "Scan successful uploads", self.finish)
        self.layout.addLayout(row)
        self.progress = QProgressBar()
        self.layout.addWidget(self.progress)

    def checkpoint_key(self):
        scope = self.account_scope()
        return "uploads/scanPending/" + scope if scope else None

    def start_session(self, user):
        super().start_session(user)
        key = self.checkpoint_key()
        checkpoint = self.settings.value(key) if key else None
        if isinstance(checkpoint, dict) and type(checkpoint.get("library")) is int:
            self.uploaded = [path for path in checkpoint.get("files", []) if isinstance(path, str)]
            self.batch = (checkpoint["library"], text(checkpoint.get("folder"))) if self.uploaded else None

    def checkpoint(self):
        key = self.checkpoint_key()
        if not key:
            return
        if self.uploaded and self.batch:
            self.settings.setValue(key, {"library": self.batch[0], "folder": self.batch[1], "files": list(self.uploaded)})
        else:
            self.settings.remove(key)
        self.settings.sync()

    def clear_session(self):
        reply, self.reply = self.reply, None
        super().clear_session()
        self.pending.clear()
        self.uploaded.clear()
        self.batch = None
        self.maximum = None
        self.remote = ""
        self.library.clear()
        self.folder.setText("Server folder: /")
        self.progress.reset()
        if reply:
            reply.abort()

    def reload(self):
        if self.reply:
            return
        def loaded(rows):
            if not isinstance(rows, list):
                return
            previous = self.library.currentData()
            self.library.blockSignals(True)
            self.library.clear()
            for row in rows:
                if isinstance(row, dict) and row.get("writable") and type(row.get("id")) is int:
                    self.library.addItem(text(row.get("name"), "Library"), row["id"])
            index = self.library.findData(previous)
            self.library.setCurrentIndex(max(0, index))
            self.library.blockSignals(False)
            self.change_library()
            if self.uploaded and not self.pending:
                self.notice.setText(f"{len(self.uploaded)} acknowledged uploads still need a server scan.")
        self.request("GET", "/api/libraries", loaded, key="libraries")
        self.request("GET", "/api/uploads/limits", self.limits, key="limits")

    def limits(self, data):
        if isinstance(data, dict) and isinstance(data.get("maxBytes"), int):
            self.maximum = data["maxBytes"]

    def change_library(self, *_):
        self.remote = ""
        self.load_folders()

    def load_folders(self):
        self.folder.setText("Server folder: /" + self.remote)
        self.folders.clear()
        library_id = self.library.currentData()
        if library_id is None:
            return
        path = self.remote
        def loaded(data):
            if isinstance(data, dict) and self.library.currentData() == library_id and path == self.remote:
                self.folders.addItems([item for item in data.get("folders", []) if isinstance(item, str) and "/" not in item and "\\" not in item and item not in (".", "..")])
        self.request("GET", "/api/uploads/folders", loaded, params={"library": library_id, "path": path}, key="folders")

    def open_folder(self, item):
        self.remote = "/".join(filter(None, (self.remote, item.text())))
        self.load_folders()

    def parent_folder(self):
        self.remote = self.remote.rpartition("/")[0]
        self.load_folders()

    def create_folder(self):
        library_id = self.library.currentData()
        if library_id is None or self.reply:
            return
        epoch = self.epoch
        name, ok = QInputDialog.getText(self, "Create server folder", "Folder name")
        if ok and name.strip() and epoch == self.epoch:
            self.request("POST", "/api/uploads/folders", lambda _data: self.load_folders(),
                         {"libraryId": library_id, "path": self.remote, "name": name.strip()})

    def choose_files(self):
        paths, _ = QFileDialog.getOpenFileNames(self, "Choose local files")
        if paths:
            self.queue_files([(Path(path), Path(path).name) for path in paths])

    def choose_folder(self):
        path = QFileDialog.getExistingDirectory(self, "Choose local folder")
        if not path:
            return
        root = Path(path)
        resolved_root = root.resolve()
        files = []
        for source in root.rglob("*"):
            if not source.is_symlink() and source.suffix.lower() in BOOK_FILES and source.is_file() and source.resolve().is_relative_to(resolved_root):
                files.append((source, (Path(root.name) / source.relative_to(root)).as_posix()))
                if len(files) > 5000:
                    self.notice.setText("Choose a folder with at most 5,000 supported files.")
                    return
        self.queue_files(files)

    def queue_files(self, files):
        if len(files) > 5000:
            self.notice.setText("Choose at most 5,000 files per batch.")
            return
        if self.reply or self.uploaded:
            self.notice.setText("Finish or scan the current batch before choosing more files.")
            return
        self.pending = [(path, name) for path, name in files if path.suffix.lower() in BOOK_FILES and not path.is_symlink()]
        self.batch = None
        omitted = len(files) - len(self.pending)
        self.notice.setText(f"{len(self.pending)} files selected." + (f" Skipped {omitted} unsupported files." if omitted else ""))

    def start(self):
        if not self.user or self.reply or self.busy:
            return
        if not self.pending:
            self.notice.setText("Choose local files first.")
            return
        if not self.batch and self.library.currentData() is not None:
            self.batch = (self.library.currentData(), self.remote)
        if not self.batch:
            self.notice.setText("Choose a writable server library.")
            return
        self.send_next()

    def send_next(self):
        if not self.pending:
            self.finish()
            return
        source, name = self.pending[0]
        try:
            size = source.stat().st_size
        except OSError as error:
            self.notice.setText(str(error))
            return
        if self.maximum and size > self.maximum:
            self.notice.setText(f"{source.name} exceeds the server’s file size limit. Choose a smaller batch or scan the files already uploaded.")
            return
        library_id, remote = self.batch
        epoch = self.epoch
        self.notice.setText(f"Uploading {source.name} to server folder /{remote}")
        self.progress.setRange(0, 100)
        self.progress.setValue(0)
        def progress(done, total):
            if epoch == self.epoch and total > 0:
                self.progress.setValue(min(100, int(done * 100 / total)))
        def failed(error):
            if epoch == self.epoch:
                self.reply = None
                self.notice.setText(error.message + " Acknowledged files are saved. Check the server before retrying an interrupted file whose result is unknown.")
        def loaded(data):
            if epoch != self.epoch:
                return
            self.reply = None
            if not isinstance(data, dict) or not isinstance(data.get("path"), str):
                self.notice.setText("Upload outcome could not be verified. Check the server before retrying this file.")
                return
            self.uploaded.append(data["path"])
            self.checkpoint()
            self.pending.pop(0)
            self.send_next()
        query = urlencode({"library": library_id, "folder": remote, "name": name})
        self.reply = self.api.upload_file("/api/uploads/file?" + query, source, loaded, failed, progress)

    def cancel(self):
        if self.reply:
            self.reply.abort()

    def skip(self):
        epoch = self.epoch
        if self.reply or self.busy or not self.pending:
            return
        if QMessageBox.question(self, "Skip upload", f"Skip {self.pending[0][0].name} and keep the rest of this batch?") != QMessageBox.StandardButton.Yes or epoch != self.epoch:
            return
        self.pending.pop(0)
        self.notice.setText(f"{len(self.pending)} files remain. Start the remaining uploads or scan successful files.")

    def finish(self):
        if self.reply or not self.uploaded or not self.batch:
            return
        count = len(self.uploaded)
        def done(_data):
            self.uploaded.clear()
            self.checkpoint()
            if not self.pending:
                self.batch = None
            self.notice.setText(f"{count} uploaded files handed to the server scanner.")
        self.request("POST", "/api/uploads/done", done, {"libraryId": self.batch[0], "files": list(self.uploaded)})


class DevicesPanel(PersonalPanel):
    def __init__(self, api):
        super().__init__(api)
        self.email_configured = False
        self.layout.addWidget(label("Send to a device", heading=True))
        self.items = QListWidget()
        self.items.setAccessibleName("Your registered reading devices")
        self.layout.addWidget(self.items, 1)
        row = QHBoxLayout()
        button(row, "Add email device…", self.add)
        button(row, "Remove device…", self.remove)
        button(row, "Send selected book…", self.send)
        button(row, "Send selected series…", lambda: self.send(whole_series=True))
        self.layout.addLayout(row)

    def clear_session(self):
        super().clear_session()
        self.email_configured = False

    def reload(self):
        def loaded(data):
            if not isinstance(data, dict):
                return
            self.email_configured = bool(data.get("emailConfigured"))
            fill(self.items, data.get("devices", []), lambda row: text(row.get("name")) + " · " + text(row.get("email")))
            if not self.email_configured:
                self.notice.setText("The Flyleaf server needs an email configuration before it can send books.")
        self.request("GET", "/api/devices", loaded)

    def add(self):
        epoch = self.epoch
        name, ok = QInputDialog.getText(self, "New device", "Device name")
        if not ok or not name.strip() or epoch != self.epoch:
            return
        email, ok = QInputDialog.getText(self, "New device", "Delivery email address")
        if not ok or not email.strip() or epoch != self.epoch:
            return
        platform, ok = QInputDialog.getItem(self, "New device", "Device type", ["Kindle", "Kobo", "PocketBook", "Other"], editable=False)
        if ok and epoch == self.epoch:
            self.request("POST", "/api/devices", lambda _data: self.reload(),
                         {"name": name.strip(), "email": email.strip(), "platform": platform.lower()})

    def remove(self):
        row = current(self.items)
        epoch = self.epoch
        if row and QMessageBox.question(self, "Remove device", "Remove this delivery address?") == QMessageBox.StandardButton.Yes and epoch == self.epoch:
            self.request("DELETE", f"/api/devices/{row['id']}", lambda _data: self.reload())

    def send(self, whole_series=False):
        device = current(self.items)
        epoch = self.epoch
        target = self.series if whole_series else self.book
        if not self.email_configured or not target.get("id") or not device:
            self.notice.setText("Select a book and a delivery device on a server with email enabled.")
            return
        kind = "series" if whole_series else "book"
        if QMessageBox.question(self, "Send to device", f"Send the selected {kind} to this device through the Flyleaf server?") != QMessageBox.StandardButton.Yes or epoch != self.epoch:
            return
        route = "series" if whole_series else "books"
        self.request("POST", f"/api/{route}/{target['id']}/send",
                     lambda data: self.notice.setText(f"Server reports {data.get('sent', 0)} sent."), {"deviceId": device["id"]})
