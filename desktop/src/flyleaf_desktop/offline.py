"""Explicit offline downloads, storage controls and progress-conflict review."""
import json
from datetime import datetime
from PySide6.QtCore import QObject, Signal, Qt
from PySide6.QtWidgets import (QDialog, QVBoxLayout, QHBoxLayout, QPushButton, QListWidget,
    QListWidgetItem, QPlainTextEdit, QFileDialog, QSpinBox, QLabel, QMessageBox, QGridLayout, QScrollArea, QWidget, QTabWidget)
from .widgets import label

ROLE = Qt.ItemDataRole.UserRole


class Downloads(QObject):
    changed = Signal(str)

    def __init__(self, service, settings, parent):
        super().__init__(parent)
        self.service, self.api, self.store, self.settings = service, service.api, service.store, settings
        self.generation = 0
        self.reply = None
        self.active = False

    def cancel(self):
        self.generation += 1
        self.active = False
        if self.reply:
            try:
                self.reply.abort()
            except RuntimeError:
                pass  # Qt already released a completed reply.
            self.reply = None
        self.changed.emit("Download cancelled. Partial files can be removed from storage.")

    def start(self, book):
        if not self.service.enabled:
            self.changed.emit("Update the Flyleaf server to enable durable progress before downloading offline books."); return
        if self.api.offline or not self.service.scope:
            self.changed.emit("Reconnect before downloading a book."); return
        self.cancel()
        self.active = True
        token, epoch, scope = self.generation, self.service.epoch, self.service.scope
        book_id = book["id"]
        self.paths, self.pending = [], []
        def valid():
            return token == self.generation and epoch == self.service.epoch and scope == self.service.scope
        def failed(error):
            if valid():
                self.active = False
                self.changed.emit(error.message if hasattr(error, "message") else str(error))
        def add_json(path, value):
            self.store.put_asset(scope, book_id, path, json.dumps(value).encode())
            self.paths.append(path)
        def downloaded(raw):
            if not valid():
                return
            path = self.pending.pop(0)
            budget = self.settings.value("offline/budgetMiB", 2048, type=int) * 1024 * 1024
            used = sum(row["bytes"] for row in self.store.books(scope))
            old = self.store.db.execute("SELECT size FROM assets WHERE scope=? AND book=? AND path=?", (scope, book_id, path)).fetchone()
            if used - (old[0] if old else 0) + len(raw) > budget:
                failed("The storage budget would be exceeded. Review removable books or increase the budget, then retry."); return
            try:
                self.store.put_asset(scope, book_id, path, raw)
                self.paths.append(path)
                advance()
            except Exception as error:
                failed(error)
        def advance():
            if not valid():
                return
            if not self.pending:
                def verified(data):
                    if not valid():
                        return
                    try:
                        if data["book"].get("version") != self.version:
                            raise ValueError("The source changed during this download. Download the new revision again.")
                        self.store.finish_download(scope, book_id, self.paths)
                    except Exception as error:
                        failed(error); return
                    self.active = False
                    self.changed.emit("Offline copy verified and ready to read.")
                    self.service.changed.emit()
                self.reply = self.api.json("GET", f"/api/books/{book_id}/reader", verified, failed)
                return
            self.changed.emit(f"Downloading {len(self.paths) + 1} of {len(self.paths) + len(self.pending)} reader assets…")
            path = self.pending[0]
            raw = self.store.get_asset(scope, book_id, path)
            if raw is not None:
                from PySide6.QtCore import QTimer
                QTimer.singleShot(0, lambda: downloaded(raw))
            else:
                request_path = path + "?native=epub" if path.endswith("/file") and self.format in ("fb2", "mobi", "azw3") else path
                def load_failed(error):
                    if valid() and path.endswith("/cover") and error.status == 404:
                        self.pending.pop(0); advance()
                    else:
                        failed(error)
                self.reply = self.api.binary(request_path, downloaded, load_failed)
        def planned(data, suffix):
            if not valid():
                return
            try:
                path = f"/api/books/{book_id}/{suffix}"
                add_json(path, data)
                if suffix == "pages":
                    count = data.get("count")
                    if type(count) is not int or not 0 < count <= 20000:
                        raise ValueError("Invalid offline page count.")
                    self.pending += [f"/api/books/{book_id}/pages/{n}" for n in range(count)]
                else:
                    records = data.get("tracks")
                    if not isinstance(records, list) or not 0 < len(records) <= 10000:
                        raise ValueError("Invalid offline audio track list.")
                    self.pending += [f"/api/books/{book_id}/tracks/{n}" for n in range(len(records))]
                advance()
            except Exception as error:
                failed(error)
        def opened(data):
            if not valid():
                return
            try:
                actual = data["book"]
                self.format = actual["format"]
                self.version = actual.get("version")
                if actual.get("version") is None:
                    raise ValueError("This server does not provide a verifiable source revision.")
                self.store.remember_book(scope, data)
                if self.store.book(scope, book_id)["version"] != json.dumps(actual["version"]):
                    raise ValueError("Resolve pending work from the previous file revision before downloading its replacement.")
                self.store.db.execute("UPDATE books SET complete=0 WHERE scope=? AND book=?", (scope, book_id))
                if actual.get("coverUrl"):
                    cover = actual["coverUrl"].split("?", 1)[0]
                    if cover.startswith(f"/api/books/{book_id}/"):
                        self.pending.append(cover)
                from .image_reader import IMAGE_FORMATS
                if actual["format"] in IMAGE_FORMATS:
                    self.reply = self.api.json("GET", f"/api/books/{book_id}/pages", lambda result: planned(result, "pages"), failed)
                elif actual["format"] == "audio":
                    self.reply = self.api.json("GET", f"/api/books/{book_id}/tracks", lambda result: planned(result, "tracks"), failed)
                else:
                    self.pending.append(f"/api/books/{book_id}/file")
                    advance()
            except Exception as error:
                failed(error)
        def authorised(data):
            if not valid():
                return
            user = data.get("user") if isinstance(data, dict) else None
            if not user or not self.service.user or user.get("id") != self.service.user.get("id"):
                self.api.session_expired.emit(); return
            if (user.get("permissions") or {}).get("download") is False:
                failed("Downloading offline copies is disabled for this account."); return
            self.reply = self.api.json("GET", f"/api/books/{book_id}/reader", opened, failed)
        self.reply = self.api.json("GET", "/api/status", authorised, failed)


class OfflineDialog(QDialog):
    open_requested = Signal(dict)
    reconnect_requested = Signal()

    def __init__(self, service, downloads, settings, parent):
        super().__init__(parent)
        self.service, self.downloads, self.store, self.settings = service, downloads, service.store, settings
        self.setWindowTitle("Offline library & sync")
        self.resize(820, 700)
        shell = QVBoxLayout(self)
        scroll = QScrollArea(); scroll.setWidgetResizable(True)
        body = QWidget(); outer = QVBoxLayout(body); scroll.setWidget(body); shell.addWidget(scroll)
        outer.addWidget(label("Your reading stays with you", heading=True))
        outer.addWidget(label("Offline copies and pending progress belong to this server and account. Sign in or unlock the remembered session to view them.", wrap=True))
        self.summary = label("", wrap=True); outer.addWidget(self.summary)
        row = QHBoxLayout()
        self.budget = QSpinBox(); self.budget.setRange(256, 16384); self.budget.setSuffix(" MiB storage budget")
        self.budget.setValue(settings.value("offline/budgetMiB", 2048, type=int))
        self.budget.valueChanged.connect(lambda value: settings.setValue("offline/budgetMiB", value)); row.addWidget(self.budget)
        reconnect = QPushButton("Reconnect and sync"); reconnect.clicked.connect(self.reconnect_requested); row.addWidget(reconnect)
        outer.addLayout(row)
        self.tabs = QTabWidget()
        offline_body, sync_body = QWidget(), QWidget()
        offline_layout, sync_layout = QVBoxLayout(offline_body), QVBoxLayout(sync_body)
        self.tabs.addTab(offline_body, "Offline library")
        self.tabs.addTab(sync_body, "Sync and conflicts")
        outer.addWidget(self.tabs, 1)
        self.books = QListWidget(); self.books.setMinimumHeight(120); self.books.setAccessibleName("Downloaded and partially downloaded books"); offline_layout.addWidget(self.books, 1)
        buttons = QGridLayout()
        for index, (caption, callback) in enumerate([("Read offline", self.open_book), ("Pin / unpin", self.pin), ("Remove selected copy", self.remove), ("Preview cleanup", self.cleanup), ("Cancel download", downloads.cancel)]):
            button = QPushButton(caption); button.clicked.connect(callback); buttons.addWidget(button, index // 3, index % 3)
        offline_layout.addLayout(buttons)
        self.sync_empty = label("Everything is up to date. Your reading work is safely synced.", wrap=True)
        sync_layout.addWidget(self.sync_empty)
        self.events = QListWidget(); self.events.setMinimumHeight(100); self.events.setAccessibleName("Durable progress queue"); sync_layout.addWidget(self.events, 1)
        self.events.currentItemChanged.connect(self.preview)
        self.detail = QPlainTextEdit(); self.detail.setReadOnly(True); self.detail.setMaximumHeight(150); self.detail.setAccessibleName("Local and server position comparison"); sync_layout.addWidget(self.detail)
        actions = QGridLayout()
        self.sync_buttons = []
        for index, (caption, callback) in enumerate([("Retry", service.retry), ("Compare server", self.compare), ("Keep local position", lambda: self.resolve(True)), ("Keep server position", lambda: self.resolve(False)), ("Export pending work", self.export)]):
            button = QPushButton(caption); button.clicked.connect(callback); actions.addWidget(button, index // 3, index % 3)
            self.sync_buttons.append(button)
        sync_layout.addLayout(actions)
        self.notice = label("", wrap=True); outer.addWidget(self.notice)
        self.remote = None
        service.changed.connect(self.refresh)
        downloads.changed.connect(self.notice.setText)
        downloads.changed.connect(lambda _message: self.refresh())

    def refresh(self):
        scope = self.service.scope
        same = scope is not None and scope == getattr(self, "_view_scope", None)
        selected_book = self.books.currentItem().data(ROLE)["book"] if same and self.books.currentItem() else None
        selected_event = self.events.currentItem().data(ROLE)["id"] if same and self.events.currentItem() else None
        previous_remote, previous_detail = (self.remote, self.detail.toPlainText()) if same else (None, "")
        self._view_scope = scope
        self.books.clear(); self.events.clear(); self.detail.clear(); self.remote = None
        if not scope:
            self.summary.setText("Sign in to view this account's offline library."); return
        books, events = self.store.books(scope), self.store.events(scope)
        drafts = self.store.db.execute("SELECT COUNT(*) FROM drafts WHERE scope=?", (scope,)).fetchone()[0]
        seconds = self.store.db.execute("SELECT COALESCE(SUM(seconds),0) FROM clocks WHERE scope=?", (scope,)).fetchone()[0]
        self.sync_empty.setText("Reading work is checkpointed on this device. It will join the queue at the next save." if drafts or seconds else "Everything is up to date. Your reading work is safely synced.")
        self.sync_empty.setVisible(not events)
        self.events.setVisible(bool(events)); self.detail.setVisible(bool(events))
        for button in self.sync_buttons:
            button.setEnabled(bool(events))
        self.sync_buttons[-1].setEnabled(bool(events or drafts or seconds))
        used = sum(book["bytes"] for book in books)
        self.summary.setText(f"{used / 1048576:.1f} MiB used · {len(events)} pending updates · " + ("Offline" if self.service.api.offline else "Connected session"))
        for book in books:
            data = json.loads(book["data"])
            item = QListWidgetItem(f"{'Pinned · ' if book['pinned'] else ''}{data['book'].get('title', 'Book')} · {'Ready' if book['complete'] else 'Not downloaded / partial'} · {book['bytes'] / 1048576:.1f} MiB")
            item.setData(ROLE, dict(book)); self.books.addItem(item)
            if book["book"] == selected_book:
                self.books.setCurrentItem(item)
        for event in events:
            body = json.loads(event["body"])
            position = f"{body['percent']:.0%}" if "percent" in body else "Time only"
            item = QListWidgetItem(f"Book {event['book']} · {position} · {body.get('seconds', 0)}s · {event['error'] or 'Waiting to sync'}")
            item.setData(ROLE, dict(event)); self.events.addItem(item)
            if event["id"] == selected_event:
                self.events.setCurrentItem(item)
        if previous_remote and self.events.currentItem() and self.events.currentItem().data(ROLE)["id"] == previous_remote[0]["id"]:
            self.remote = previous_remote
            self.detail.setPlainText(previous_detail)

    def selected(self):
        item = self.books.currentItem()
        return item.data(ROLE) if item else None

    def open_book(self):
        row = self.selected()
        if row and row["complete"]:
            self.service.api.offline = True
            self.open_requested.emit(json.loads(row["data"])["book"])
            self.hide()

    def pin(self):
        row = self.selected()
        if row:
            self.store.pin(self.service.scope, row["book"], not row["pinned"]); self.refresh()

    def remove(self):
        row = self.selected()
        if row:
            try:
                self.store.remove_book(self.service.scope, row["book"]); self.refresh()
            except ValueError as error:
                self.notice.setText(str(error))

    def cleanup(self):
        if not self.service.scope:
            return
        candidates = self.store.cleanup_preview(self.service.scope)
        message = "\n".join(json.loads(row["data"])["book"].get("title", "Book") for row in candidates)
        if not candidates:
            self.notice.setText("No removable copies. Pinned books and pending work are protected."); return
        if QMessageBox.question(self, "Review offline cleanup", f"Remove these {len(candidates)} offline copies ({sum(r['bytes'] for r in candidates) / 1048576:.1f} MiB)?\n\n{message[:4000]}") == QMessageBox.StandardButton.Yes:
            for row in candidates:
                self.store.remove_book(self.service.scope, row["book"])
            self.refresh()

    def preview(self, item, _previous=None):
        self.remote = None
        self.detail.setPlainText(json.dumps(json.loads(item.data(ROLE)["body"]), indent=2) if item else "")

    def compare(self):
        item = self.events.currentItem()
        if not item or self.service.api.offline:
            self.notice.setText("Reconnect before comparing server positions."); return
        event = item.data(ROLE)
        epoch = self.service.epoch
        def loaded(data):
            if epoch != self.service.epoch or not self.events.currentItem() or self.events.currentItem().data(ROLE)["id"] != event["id"]:
                return
            local = self.store.pending_position(self.service.scope, event["book"])
            self.remote = (event, data, local)
            self.detail.setPlainText("LOCAL\n" + (json.dumps(local, indent=2) if local else "Sampled time only") + "\nSERVER\n" + json.dumps(data["book"].get("progress"), indent=2) + "\nSource revision: " + str(data["book"].get("version")))
        self.service.api.json("GET", f"/api/books/{event['book']}/reader", loaded, lambda error: self.notice.setText(error.message))

    def resolve(self, keep_local):
        if not self.remote:
            self.notice.setText("Compare the current server position before choosing a resolution."); return
        event, remote, local = self.remote
        reader = self.parent().reader
        if reader and reader.book["id"] == event["book"]:
            self.notice.setText("Return to the library to finish checkpointing this book, then compare positions and resolve the conflict."); return
        current = next((e for e in self.store.events(self.service.scope) if e["id"] == event["id"]), None)
        if not current or not current["conflict"] or self.service.busy:
            self.notice.setText("Only a server-rejected conflict can be replaced. Retry uncertain saves first to avoid duplicate time."); return
        if json.loads(current["conflict"]).get("reason") not in ("positionChanged", "sourceChanged"):
            self.notice.setText("This save cannot be replaced safely. Restore access and retry its existing receipt, or export pending work for review."); return
        try:
            self.store.resolve(self.service.scope, event["book"], remote, keep_local, expected_local=local)
            self.refresh(); self.service.pump()
        except ValueError as error:
            self.notice.setText(str(error))

    def export(self):
        if not self.service.scope:
            return
        target, _ = QFileDialog.getSaveFileName(self, "Export pending reading work", "flyleaf-pending.json", "JSON (*.json)")
        if target:
            from pathlib import Path
            rows = [{**dict(row), "body": json.loads(row["body"])} for row in self.store.events(self.service.scope)]
            clocks = [dict(row) for row in self.store.db.execute("SELECT book,day,seconds FROM clocks WHERE scope=?", (self.service.scope,))]
            drafts = [{"book": row["book"], "body": json.loads(row["body"])} for row in self.store.db.execute("SELECT book,body FROM drafts WHERE scope=?", (self.service.scope,))]
            Path(target).write_text(json.dumps({"events": rows, "activeTime": clocks, "checkpoints": drafts}, indent=2), encoding="utf-8")
