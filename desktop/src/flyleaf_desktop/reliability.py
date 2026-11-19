"""Durable progress delivery and bounded active-time sampling."""
from datetime import date
import json
import re
import time
import sqlite3
from PySide6.QtCore import QObject, QTimer, Signal, QEvent
from PySide6.QtWidgets import QApplication
from .api import ApiError


class Reliability(QObject):
    changed = Signal()
    book_revoked = Signal(int)

    def __init__(self, api, store, parent=None):
        super().__init__(parent)
        self.api, self.store = api, store
        self.scope = None
        self.enabled = False
        self.server_supported = False
        self.user = None
        self.epoch = 0
        self.busy = False
        self.timer = QTimer(self)
        self.timer.setInterval(1000)
        self.timer.timeout.connect(self.pump)
        self.timer.start()
        api.reliability = self

    def start(self, user, capabilities, secret=None):
        self.stop()
        self.user = user
        scope = self.store.scope(self.api.base, user["id"])
        pending = self.store.db.execute("SELECT 1 FROM events WHERE scope=? UNION ALL SELECT 1 FROM drafts WHERE scope=? UNION ALL SELECT 1 FROM clocks WHERE scope=? AND seconds>0 LIMIT 1", (scope, scope, scope)).fetchone()
        self.server_supported = capabilities.get("durableProgress") == 1
        self.enabled = self.server_supported or bool(pending)
        self.scope = self.store.account(self.api.base, {**user, "desktopDurableProgress": self.enabled}, secret)
        self.store.collect_garbage(self.scope)
        if self.enabled:
            for row in self.store.db.execute("SELECT book,body FROM drafts WHERE scope=?", (self.scope,)).fetchall():
                self.store.enqueue(self.scope, row["book"], json.loads(row["body"]))
            for row in self.store.db.execute("SELECT DISTINCT book FROM clocks WHERE scope=? AND seconds>0", (self.scope,)).fetchall():
                if self.store.book(self.scope, row["book"]):
                    self.store.enqueue(self.scope, row["book"], {})
        self.changed.emit()

    def stop(self):
        self.epoch += 1
        self.scope = None
        self.enabled = False
        self.server_supported = False
        self.user = None
        self.busy = False

    def submit(self, book, body, success, failure):
        try:
            self.store.enqueue(self.scope, book, body)
        except (OSError, ValueError, RuntimeError, sqlite3.Error) as error:
            failure(ApiError("Progress could not be saved on this device: " + str(error)))
            return
        epoch = self.epoch
        QTimer.singleShot(0, lambda: success({"ok": True, "queued": True}) if epoch == self.epoch else None)
        self.changed.emit()
        self.pump()

    def observed(self, path, data):
        if not self.scope:
            return
        match = re.fullmatch(r"/api/books/(\d+)/reader", path)
        if match and isinstance(data, dict) and isinstance(data.get("book"), dict):
            if "accountId" in data and data["accountId"] != self.user["id"]:
                self.api.session_expired.emit()
                raise ValueError("The authenticated account changed. Sign in again.")
            self.store.remember_book(self.scope, data)
            self.store.db.execute("UPDATE events SET conflict=NULL,retry_at=0 WHERE scope=? AND book=? AND json_extract(conflict,'$.reason')='access'", (self.scope, int(match[1])))

    def capture(self, reader):
        if not self.enabled or not self.scope:
            return
        draft = self.store.db.execute("SELECT body FROM drafts WHERE scope=? AND book=?", (self.scope, reader.book["id"])).fetchone()
        if draft:
            self.store.enqueue(self.scope, reader.book["id"], json.loads(draft["body"]))
            reader._pending = None
            self.changed.emit()
            return
        clocks = self.store.db.execute("SELECT 1 FROM clocks WHERE scope=? AND book=? AND seconds>0", (self.scope, reader.book["id"])).fetchone()
        if reader._pending is None and not clocks:
            return
        if reader.book.get("format") == "audio":
            reader.queue_position()
            body = reader._pending
        elif getattr(reader, "_reflowable", False):
            locator = reader.current_locator()
            if not locator or not reader._writes_enabled:
                return
            body = {"position": locator, "percent": (reader.page + 1) / reader.total}
        else:
            if reader._image is None or not reader.total:
                return
            body = reader.progress_body(reader._pending if reader._pending is not None else reader.page)
        if body:
            self.store.enqueue(self.scope, reader.book["id"], body)
            reader._pending = None
            self.changed.emit()

    def cached(self, path, json_response):
        if not self.scope:
            return None
        path = path.split("?", 1)[0]
        match = re.fullmatch(r"/api/books/(\d+)/(.*)", path)
        if not match:
            return None
        book, suffix = int(match[1]), match[2]
        row = self.store.book(self.scope, book)
        if not row or not row["complete"]:
            return None
        if suffix == "reader":
            data = json.loads(row["data"])
            bodies = [json.loads(e["body"]) for e in self.store.events(self.scope) if e["book"] == book]
            draft = self.store.db.execute("SELECT body FROM drafts WHERE scope=? AND book=?", (self.scope, book)).fetchone()
            if draft:
                bodies.append(json.loads(draft["body"]))
            latest = next((body for body in reversed(bodies) if any(k in body for k in ("position", "page", "percent"))), None)
            if latest:
                data["book"]["progress"] = {k: latest[k] for k in ("position", "page", "percent") if k in latest}
            return data
        raw = self.store.get_asset(self.scope, book, path)
        return json.loads(raw) if raw is not None and json_response else raw

    def denied(self, path, status):
        match = re.match(r"/api/books/(\d+)/(reader|file|pages|tracks|progress)(?:[/?]|$)", path)
        if self.scope and status in (403, 404) and match:
            book = int(match[1])
            row = self.store.book(self.scope, book)
            if row:
                draft = self.store.db.execute("SELECT body FROM drafts WHERE scope=? AND book=?", (self.scope, book)).fetchone()
                clocks = self.store.db.execute("SELECT 1 FROM clocks WHERE scope=? AND book=? AND seconds>0", (self.scope, book)).fetchone()
                if draft or clocks:
                    self.store.enqueue(self.scope, book, json.loads(draft["body"]) if draft else {})
            self.store.db.execute("UPDATE events SET conflict=?,error=? WHERE scope=? AND book=?", (json.dumps({"reason": "access"}), "Server access was revoked or this book is unavailable.", self.scope, book))
            if row:
                data = json.loads(row["data"])
                quarantine = {"book": {"id": book, "version": data["book"].get("version"), "progress": data["book"].get("progress")}, "revoked": True}
                self.store.db.execute("UPDATE books SET complete=0,data=? WHERE scope=? AND book=?", (json.dumps(quarantine), self.scope, book))
            self.store.db.execute("DELETE FROM assets WHERE scope=? AND book=?", (self.scope, book))
            self.store.db.execute("DELETE FROM drafts WHERE scope=? AND book=?", (self.scope, book))
            self.store.collect_garbage(self.scope)
            self.changed.emit()
            self.book_revoked.emit(book)

    def pump(self):
        if not self.enabled or not self.server_supported or not self.scope or self.busy or getattr(self.api, "offline", False):
            return
        events = self.store.events(self.scope)
        # A conflict blocks only its book, not another book's independent progress.
        blocked = set()
        event = None
        for candidate in events:
            if candidate["book"] in blocked:
                continue
            if candidate["conflict"] or candidate["retry_at"] > time.time():
                blocked.add(candidate["book"]); continue
            event = candidate; break
        if event is None:
            return
        body = self.store.prepare(event)
        epoch = self.epoch
        self.busy = True
        def saved(result):
            if epoch != self.epoch:
                return
            self.busy = False
            if not isinstance(result, dict) or not isinstance(result.get("progress"), dict) or not isinstance(result["progress"].get("updatedAt"), int):
                self.store.fail(event, "The server did not acknowledge a durable progress revision.", {"reason": "unsupported"})
            else:
                self.store.acknowledge(event, result)
            self.changed.emit()
            QTimer.singleShot(0, self.pump)
        def failed(error):
            if epoch != self.epoch:
                return
            self.busy = False
            if error.details and error.details.get("reason") == "accountIdentityRequired" and "accountId" not in body:
                migrated = {**body, "accountId": self.user["id"]}
                self.store.db.execute("UPDATE events SET body=?,prepared=1,retry_at=0,error=NULL,conflict=NULL WHERE id=? AND scope=?", (json.dumps(migrated), event["id"], self.scope))
                self.changed.emit(); QTimer.singleShot(0, self.pump); return
            terminal = error.status in (400, 403, 404, 409)
            if error.details and error.details.get("reason") == "sourceChanged":
                self.store.db.execute("UPDATE books SET complete=0 WHERE scope=? AND book=?", (self.scope, event["book"]))
            self.store.fail(event, error.message, error.details or {"reason": "access"} if terminal else None)
            self.changed.emit()
        self.api.json("PUT", f"/api/books/{event['book']}/progress", saved, failed, body, durable=False)

    def retry(self):
        if self.scope:
            self.store.db.execute("UPDATE events SET retry_at=0 WHERE scope=? AND conflict IS NULL", (self.scope,))
            self.pump()


class ActiveClock(QObject):
    def __init__(self, reader):
        super().__init__(reader)
        self.reader = reader
        self.service = getattr(reader.api, "reliability", None)
        self.scope = self.service.scope if self.service else None
        self.last = time.monotonic()
        self.input_at = self.last
        self.carry = 0.0
        self.day = date.today().isoformat()
        self.timer = QTimer(self)
        self.timer.setInterval(1000)
        self.timer.timeout.connect(self.tick)
        if self.service and self.service.enabled:
            QApplication.instance().installEventFilter(self)
            self.timer.start()

    def eventFilter(self, watched, event):
        if event.type() in (QEvent.Type.KeyPress, QEvent.Type.MouseButtonPress, QEvent.Type.Wheel, QEvent.Type.TouchBegin):
            self.input_at = time.monotonic()
        return False

    def active(self, now):
        reader = self.reader
        if reader._disposed:
            return False
        if reader.book.get("format") == "audio":
            return bool(reader._ready and reader.player and reader.player.is_playing())
        if getattr(reader, "_speech_active", False) and getattr(reader, "_speech_playing", False):
            return True
        return reader._image is not None and reader.isVisible() and not reader.window().isMinimized() and reader.window().isActiveWindow() and now - self.input_at <= 120

    def tick(self):
        now = time.monotonic()
        elapsed, self.last = now - self.last, now
        today = date.today().isoformat()
        if today != self.day:
            self.carry = 0
            self.day = today
        if not self.service or self.scope != self.service.scope or not 0 < elapsed <= 2.5 or not self.active(now):
            return  # No suspend interval, idle time or another account's time.
        self.carry += elapsed
        seconds = int(self.carry)
        if seconds:
            self.service.store.add_seconds(self.scope, self.reader.book["id"], self.day, seconds)
            self.carry -= seconds
        if self.service and int(now) % 15 == 0:
            reader = self.reader
            if reader.book.get("format") == "audio":
                reader.queue_position()
            elif not getattr(reader, "_reflowable", False) or getattr(reader, "_writes_enabled", False) and reader.current_locator():
                reader._pending = reader.page
            reader.flush_progress()

    def stop(self):
        self.tick()
        self.timer.stop()
        QApplication.instance().removeEventFilter(self)
