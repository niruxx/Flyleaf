"""Native annotation search/export and revision-guarded reading history."""
import json
from datetime import datetime
from urllib.parse import urlencode
from PySide6.QtCore import Qt, QSaveFile, QIODevice
from PySide6.QtWidgets import (QDialog, QVBoxLayout, QHBoxLayout, QLineEdit, QComboBox,
    QPushButton, QListWidget, QListWidgetItem, QPlainTextEdit, QFileDialog, QMessageBox)
from .widgets import label

ROLE = Qt.ItemDataRole.UserRole


def save_export(parent, raw, suffix):
    target, _ = QFileDialog.getSaveFileName(parent, "Export reading notes", "Flyleaf notes." + suffix, "Export (*." + suffix + ")")
    if not target:
        return False
    file = QSaveFile(target)
    if not file.open(QIODevice.OpenModeFlag.WriteOnly) or file.write(raw) != len(raw) or not file.commit():
        raise OSError("The export could not be written. Choose a writable destination.")
    return True


class AnnotationsDialog(QDialog):
    def __init__(self, api, parent):
        super().__init__(parent)
        self.api, self.records, self.visible_records = api, [], []
        self.setWindowTitle("Highlights, bookmarks & notes")
        self.resize(800, 650)
        outer = QVBoxLayout(self)
        outer.addWidget(label("Your reading notebook", heading=True))
        row = QHBoxLayout()
        self.search = QLineEdit(); self.search.setPlaceholderText("Search passages, notes and book titles"); self.search.setAccessibleName("Search annotations")
        self.search.textChanged.connect(self.filter); row.addWidget(self.search, 1)
        self.books = QComboBox(); self.books.setMinimumContentsLength(12); self.books.setSizeAdjustPolicy(QComboBox.SizeAdjustPolicy.AdjustToMinimumContentsLengthWithIcon); self.books.setAccessibleName("Annotation book filter"); self.books.currentIndexChanged.connect(self.filter); row.addWidget(self.books)
        self.kind = QComboBox(); self.kind.addItem("All notes", ""); self.kind.addItem("Highlights", "highlight"); self.kind.addItem("Bookmarks", "bookmark"); self.kind.currentIndexChanged.connect(self.filter); row.addWidget(self.kind)
        outer.addLayout(row)
        self.items = QListWidget(); self.items.setAccessibleName("Matching annotations"); self.items.currentItemChanged.connect(self.select); outer.addWidget(self.items, 1)
        self.preview = QPlainTextEdit(); self.preview.setReadOnly(True); self.preview.setAccessibleName("Selected passage and note"); outer.addWidget(self.preview, 1)
        exports = QHBoxLayout()
        self.format = QComboBox()
        for caption, value in (("Markdown", "markdown"), ("CSV", "csv"), ("Readwise import CSV", "readwise"), ("Obsidian notes ZIP", "obsidian")):
            self.format.addItem(caption, value)
        exports.addWidget(self.format)
        self.export_button = QPushButton("Export selected book / all books"); self.export_button.clicked.connect(self.export); exports.addWidget(self.export_button)
        refresh = QPushButton("Refresh"); refresh.clicked.connect(self.load); exports.addWidget(refresh)
        outer.addLayout(exports)
        integration = QHBoxLayout()
        self.token = QLineEdit(); self.token.setEchoMode(QLineEdit.EchoMode.Password); self.token.setPlaceholderText("Readwise access token — used once, never saved"); self.token.setAccessibleName("Readwise access token"); integration.addWidget(self.token, 1)
        send = QPushButton("Send highlights to Readwise…"); send.clicked.connect(self.send_readwise); integration.addWidget(send)
        outer.addLayout(integration)
        self.notice = label("", wrap=True); outer.addWidget(self.notice)

    def clear(self):
        self.records = []; self.items.clear(); self.preview.clear(); self.token.clear(); self.books.clear(); self.search.clear(); self.notice.clear()

    def load(self):
        self.format.setEnabled(not self.api.offline)
        self.export_button.setText("Export cached notes (JSON)" if self.api.offline else "Export selected book / all books")
        service = getattr(self.api, "reliability", None)
        epoch = service.epoch if service else None
        def loaded(data):
            if service and epoch != service.epoch:
                return
            if not isinstance(data, list):
                self.notice.setText("The annotation response was invalid."); return
            self.records = [value for value in data if isinstance(value, dict)]
            self.books.blockSignals(True); self.books.clear(); self.books.addItem("All books", None)
            books = {a["book"]["id"]: a["book"].get("title", "Book") for a in self.records if isinstance(a.get("book"), dict)}
            for book, title in sorted(books.items(), key=lambda pair: pair[1].casefold()):
                self.books.addItem(title, book)
            self.books.blockSignals(False); self.filter()
            self.notice.setText(f"{len(self.records)} annotations. Export uses the book filter; text/type filters apply to this view.")
        if self.api.offline and service and service.scope:
            records = []
            for row in service.store.books(service.scope, complete=True):
                data = json.loads(row["data"])
                records += [{**annotation, "book": data["book"]} for annotation in data.get("annotations", [])]
            loaded(records)
        else:
            self.api.json("GET", "/api/annotations", loaded, lambda error: self.notice.setText(error.message))

    def filter(self):
        query = self.search.text().strip().casefold()
        book, kind = self.books.currentData(), self.kind.currentData()
        self.items.clear(); self.preview.clear()
        self.visible_records = [a for a in self.records if (book is None or (a.get("book") or {}).get("id") == book) and (not kind or a.get("kind") == kind) and (not query or query in " ".join(str(a.get(k) or "") for k in ("text", "note", "chapter")) .casefold() + " " + str((a.get("book") or {}).get("title", "")).casefold())]
        for annotation in self.visible_records:
            item = QListWidgetItem(str((annotation.get("book") or {}).get("title", "Book")) + " · " + str(annotation.get("note") or annotation.get("text") or "Bookmark")[:180])
            item.setData(ROLE, annotation); self.items.addItem(item)

    def select(self, item, _previous=None):
        if item:
            annotation = item.data(ROLE)
            self.preview.setPlainText(str(annotation.get("text") or "") + "\n\n" + str(annotation.get("note") or "") + "\n\nPosition: " + str(annotation.get("locator") or ""))

    def export(self):
        format = self.format.currentData()
        suffix = {"markdown": "md", "csv": "csv", "readwise": "csv", "obsidian": "zip"}[format]
        params = {"format": format}
        if self.books.currentData() is not None:
            params["book"] = self.books.currentData()
        def exported(raw):
            try:
                if save_export(self, raw, suffix):
                    self.notice.setText("Export saved.")
            except OSError as error:
                self.notice.setText(str(error))
        if self.api.offline:
            # Portable offline JSON preserves every stored locator and private note.
            records = [a for a in self.records if self.books.currentData() is None or (a.get("book") or {}).get("id") == self.books.currentData()]
            try:
                save_export(self, json.dumps(records, ensure_ascii=False, indent=2).encode(), "json")
            except OSError as error:
                self.notice.setText(str(error))
            return
        self.api.binary("/api/annotations/export?" + urlencode(params), exported, lambda error: self.notice.setText(error.message))

    def send_readwise(self):
        if self.api.offline:
            self.notice.setText("Reconnect to send highlights through your server."); return
        if not self.token.text().strip():
            self.notice.setText("Enter your Readwise access token first."); return
        if QMessageBox.question(self, "Send to Readwise", "Send this book filter's highlights and private notes to Readwise through your Flyleaf server?") != QMessageBox.StandardButton.Yes:
            return
        body = {"token": self.token.text().strip(), "book": self.books.currentData()}
        self.token.clear()
        self.api.json("POST", "/api/annotations/readwise", lambda value: self.notice.setText("Readwise export completed: " + str(value.get("sent", 0)) + " highlights."), lambda error: self.notice.setText(error.message), body)

    def hideEvent(self, event):
        self.token.clear(); super().hideEvent(event)


class HistoryDialog(QDialog):
    def __init__(self, reader):
        super().__init__(reader)
        self.reader, self.api = reader, reader.api
        self.updated_at = None
        self.setWindowTitle("Reading-position history")
        self.resize(650, 500)
        outer = QVBoxLayout(self)
        outer.addWidget(label("Return to a reading moment", heading=True))
        self.notice = label("", wrap=True); outer.addWidget(self.notice)
        self.items = QListWidget(); self.items.setAccessibleName("Saved reading positions"); outer.addWidget(self.items, 1)
        self.preview = QPlainTextEdit(); self.preview.setReadOnly(True); self.preview.setMaximumHeight(100); outer.addWidget(self.preview)
        self.items.currentItemChanged.connect(lambda item: self.preview.setPlainText(json.dumps(item.data(ROLE), indent=2)) if item else self.preview.clear())
        refresh = QPushButton("Refresh history"); refresh.clicked.connect(self.load); outer.addWidget(refresh)
        restore = QPushButton("Restore selected position…"); restore.clicked.connect(self.restore); outer.addWidget(restore)

    def load(self):
        def loaded(data):
            if self.reader._disposed:
                return
            self.updated_at = data.get("updatedAt")
            self.items.clear()
            for value in data.get("items", []):
                stamp = datetime.fromtimestamp(value["at"] / 1000).strftime("%Y-%m-%d %H:%M")
                item = QListWidgetItem(f"{stamp} · {value['percent']:.0%}" + (" · current" if value.get("current") else "") + (" · file changed" if not value.get("compatible") else ""))
                item.setData(ROLE, value); self.items.addItem(item)
            self.notice.setText("Recent device sync: " + (", ".join(d["client"] for d in data.get("devices", [])) or "none recorded") + ". Restore checks the source revision and current server position.")
        self.api.json("GET", f"/api/books/{self.reader.book['id']}/positions", loaded, lambda error: self.notice.setText(error.message) if not self.reader._disposed else None)

    def restore(self):
        item = self.items.currentItem()
        if not item or not item.data(ROLE).get("compatible"):
            self.notice.setText("Select a position from this file revision."); return
        service = getattr(self.api, "reliability", None)
        if self.reader.has_unsaved_changes or service and service.scope and service.store.pending_book(service.scope, self.reader.book["id"]):
            self.notice.setText("Sync this book's pending reading work before restoring history."); return
        value = item.data(ROLE)
        if QMessageBox.question(self, "Restore reading position", f"Restore the selected {value['percent']:.0%} position? The server keeps the current position in history.") != QMessageBox.StandardButton.Yes:
            return
        def restored(_result):
            if self.reader._disposed:
                return
            def opened(data):
                if self.reader._disposed:
                    return
                self.reader.book = data["book"]
                progress = data["book"].get("progress") or {}
                if self.reader.book.get("format") == "audio":
                    self.reader.go_to_locator(progress.get("position"))
                elif getattr(self.reader, "_reflowable", False):
                    self.reader.engine.request("resolve", self.reader.show_page, self.notice.setText, cfi=progress.get("position"))
                else:
                    self.reader.show_page(progress.get("page") or 0)
                self.load()
            self.api.json("GET", f"/api/books/{self.reader.book['id']}/reader", opened, lambda error: self.notice.setText(error.message))
        self.api.json("POST", f"/api/books/{self.reader.book['id']}/positions/{value['id']}/restore", restored, lambda error: self.notice.setText(error.message) if not self.reader._disposed else None, {"expectedUpdatedAt": self.updated_at})
