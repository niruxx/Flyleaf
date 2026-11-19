"""Native server-side transfers, followed series and chapter updates."""
from PySide6.QtCore import Qt, QTimer
from PySide6.QtWidgets import (QWidget, QVBoxLayout, QHBoxLayout, QTabWidget,
    QListWidget, QListWidgetItem, QPushButton, QComboBox, QCheckBox, QMessageBox)
from .widgets import label, text

ROLE = Qt.ItemDataRole.UserRole


class FinderActivity(QWidget):
    def __init__(self, api):
        super().__init__()
        self.api = api
        self.user = None
        self.epoch = 0
        self.generation = 0
        self.loading = False
        self.mutating = False
        self.libraries = []
        outer = QVBoxLayout(self)
        header = QHBoxLayout()
        header.addWidget(label("Your server activity", heading=True), 1)
        self.refresh_button = QPushButton("Refresh")
        self.refresh_button.clicked.connect(self.refresh)
        header.addWidget(self.refresh_button)
        outer.addLayout(header)
        self.notice = label("", wrap=True)
        outer.addWidget(self.notice)
        self.tabs = QTabWidget()
        outer.addWidget(self.tabs, 1)
        self.lists = []
        for title in ("Downloads", "Following", "Chapter updates"):
            panel = QWidget(); body = QVBoxLayout(panel)
            listing = QListWidget(); listing.setAccessibleName(title)
            listing.currentItemChanged.connect(self._selection)
            body.addWidget(listing, 1)
            self.lists.append(listing)
            self.tabs.addTab(panel, title)
        self.downloads, self.follows, self.updates = self.lists
        buttons = QHBoxLayout()
        self.retry = QPushButton("Retry failed download")
        self.remove = QPushButton("Cancel / remove download")
        self.retry.clicked.connect(self.retry_download)
        self.remove.clicked.connect(self.remove_download)
        buttons.addWidget(self.retry); buttons.addWidget(self.remove)
        self.tabs.widget(0).layout().addLayout(buttons)
        options = QHBoxLayout()
        self.target = QComboBox(); self.target.setAccessibleName("Followed series destination library")
        self.auto = QCheckBox("Download new chapters automatically")
        options.addWidget(self.target, 1); options.addWidget(self.auto)
        self.tabs.widget(1).layout().addLayout(options)
        buttons = QHBoxLayout()
        self.save = QPushButton("Save follow settings")
        self.check = QPushButton("Check for chapters")
        self.unfollow = QPushButton("Unfollow")
        self.save.clicked.connect(self.save_follow)
        self.check.clicked.connect(self.check_follow)
        self.unfollow.clicked.connect(self.remove_follow)
        for button in (self.save, self.check, self.unfollow): buttons.addWidget(button)
        self.tabs.widget(1).layout().addLayout(buttons)
        self.get_update = QPushButton("Download selected chapter")
        self.get_update.clicked.connect(self.download_update)
        self.tabs.widget(2).layout().addWidget(self.get_update)
        self.tabs.currentChanged.connect(self.refresh)
        self.timer = QTimer(self); self.timer.setInterval(5000)
        # Preserve unsaved follow settings; only the transfer queue auto-refreshes.
        self.timer.timeout.connect(lambda: self.refresh() if self.tabs.currentIndex() == 0 else None)
        self._selection()

    def start_session(self, user):
        self.clear_session()
        self.user = user
        if self.isVisible(): self.refresh(); self.timer.start()

    def clear_session(self):
        self.epoch += 1; self.generation += 1
        self.user = None; self.loading = self.mutating = False
        self.timer.stop()
        for listing in self.lists: listing.clear()
        self.target.clear(); self.libraries = []; self.auto.setChecked(False)
        self.notice.clear(); self._selection()

    def set_libraries(self, libraries):
        self.libraries = libraries
        selected = self.target.currentData()
        self.target.clear()
        for library in libraries:
            self.target.addItem(text(library.get("name"), "Library"), library.get("id"))
        index = self.target.findData(selected)
        if index >= 0: self.target.setCurrentIndex(index)
        self._selection()

    def showEvent(self, event):
        super().showEvent(event)
        if self.user: self.refresh(); self.timer.start()

    def hideEvent(self, event):
        self.timer.stop()
        super().hideEvent(event)

    def _current(self, listing):
        item = listing.currentItem()
        return item.data(ROLE) if item else None

    def _selection(self, *_args):
        active = bool(self.user) and not self.mutating
        download = self._current(self.downloads) or {}
        self.retry.setEnabled(active and download.get("status") == "failed")
        self.remove.setEnabled(active and bool(download))
        follow = self._current(self.follows)
        for button in (self.save, self.check, self.unfollow):
            button.setEnabled(active and bool(follow))
        self.save.setEnabled(self.save.isEnabled() and self.target.count() > 0)
        if follow:
            self.target.setCurrentIndex(self.target.findData(follow.get("libraryId")))
            self.auto.setChecked(bool(follow.get("autoDownload")))
        update = self._current(self.updates) or {}
        self.get_update.setEnabled(active and update.get("status") == "new")

    def refresh(self, *_args):
        if not self.user or self.loading or self.mutating: return
        index = self.tabs.currentIndex()
        listing = self.lists[index]
        suffix = ("downloads/list", "follows", "updates")[index]
        self.generation += 1
        token, epoch = self.generation, self.epoch
        self.loading = True
        def failed(error):
            if token != self.generation or epoch != self.epoch: return
            self.loading = False
            self.notice.setText(error.message)
            if index != self.tabs.currentIndex(): self.refresh()
        def loaded(data):
            if token != self.generation or epoch != self.epoch: return
            self.loading = False
            rows = data.get("follows") if index == 1 and isinstance(data, dict) else data
            if not isinstance(rows, list):
                self.notice.setText("The server returned invalid activity data."); return
            previous = self._current(listing)
            listing.blockSignals(True); listing.clear()
            selected = None
            for row in rows:
                if not isinstance(row, dict) or type(row.get("id")) is not int: continue
                title = text(row.get("title"), "Untitled")
                if index == 0:
                    received, total = row.get("received"), row.get("total")
                    percent = f" · {max(0, min(100, int(received / total * 100)))}%" if isinstance(received, (int, float)) and isinstance(total, (int, float)) and total > 0 else ""
                    detail = f"{text(row.get('status'))}{percent} · {text(row.get('library'))}"
                    title += " · " + text(row.get("fileTitle")) if row.get("fileTitle") else ""
                    error = row.get("error")
                elif index == 1:
                    detail = f"{row.get('updates', 0)} updates · {text(row.get('library'), 'Choose a library')}"
                    error = row.get("lastError")
                else:
                    file = row.get("file") if isinstance(row.get("file"), dict) else {}
                    detail = f"{text(file.get('label'), text(file.get('title')))} · {text(row.get('status'))}"
                    error = row.get("error")
                item = QListWidgetItem(title + "\n" + detail + ("\n" + text(error) if error else ""))
                item.setData(ROLE, row); listing.addItem(item)
                if previous and previous.get("id") == row["id"]: selected = item
            if selected: listing.setCurrentItem(selected)
            listing.blockSignals(False); self._selection()
            self.notice.setText(f"{listing.count()} items on your server." if listing.count() else ("No downloads yet. Select files in Browse sources to add a book.", "No followed series yet. Open a title in Browse sources to follow it.", "No new chapters found. Check a followed series for updates.")[index])
            if index != self.tabs.currentIndex(): self.refresh()
        self.api.json("GET", "/api/finder/" + suffix, loaded, failed)

    def _act(self, method, path, body=None):
        if not self.user or self.mutating: return
        epoch = self.epoch
        self.mutating = True
        self.generation += 1; self.loading = False
        self._selection()
        def done(_data):
            if epoch != self.epoch: return
            self.mutating = False; self._selection(); self.refresh()
        def failed(error):
            if epoch != self.epoch: return
            self.mutating = False; self._selection(); self.notice.setText(error.message)
        self.api.json(method, "/api/finder/" + path, done, failed, body)

    def retry_download(self):
        row = self._current(self.downloads)
        if row and row.get("status") == "failed": self._act("POST", f"downloads/{row['id']}/retry")

    def remove_download(self):
        row = self._current(self.downloads)
        if not row: return
        active = row.get("status") in ("queued", "downloading")
        prompt = "Cancel this server download?" if active else "Remove this download from server history? The downloaded book stays in its library."
        if QMessageBox.question(self, "Server download", prompt) == QMessageBox.StandardButton.Yes:
            self._act("DELETE", f"downloads/{row['id']}")

    def save_follow(self):
        row = self._current(self.follows)
        if row and self.target.currentData() is not None:
            self._act("PATCH", f"follows/{row['id']}", {"libraryId": self.target.currentData(), "autoDownload": self.auto.isChecked()})

    def check_follow(self):
        row = self._current(self.follows)
        if row: self._act("POST", f"follows/{row['id']}/check")

    def remove_follow(self):
        row = self._current(self.follows)
        if row and QMessageBox.question(self, "Unfollow series", "Stop checking this series for new chapters? Existing books stay in your library.") == QMessageBox.StandardButton.Yes:
            self._act("DELETE", f"follows/{row['id']}")

    def download_update(self):
        row = self._current(self.updates)
        if row and row.get("status") == "new": self._act("POST", f"updates/{row['id']}/download")
