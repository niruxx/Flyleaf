"""Account-scoped SQLite outbox and integrity-checked offline reader assets.

This is a client cache, never the server database. No cookies/passwords are stored.
"""
from contextlib import contextmanager
from datetime import date
import hashlib
import json
import os
from pathlib import Path
import sqlite3
import time
import uuid


class LocalStore:
    def __init__(self, root):
        self.root = Path(root).resolve()
        self.root.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.db = sqlite3.connect(self.root / "state.sqlite", isolation_level=None)
        self.db.row_factory = sqlite3.Row
        version = self.db.execute("PRAGMA user_version").fetchone()[0]
        if version > 2:
            self.db.close()
            raise ValueError("This local store was created by a newer Flyleaf Desktop. Upgrade to open it.")
        self.db.execute("PRAGMA foreign_keys=ON")
        self.db.execute("PRAGMA journal_mode=WAL")
        self.db.execute("PRAGMA synchronous=FULL")
        self.db.executescript("""
          CREATE TABLE IF NOT EXISTS accounts(scope TEXT PRIMARY KEY, server TEXT NOT NULL, user_id INTEGER NOT NULL, user TEXT NOT NULL, vault_hash TEXT);
          CREATE TABLE IF NOT EXISTS books(scope TEXT NOT NULL, book INTEGER NOT NULL, version TEXT NOT NULL, data TEXT NOT NULL, complete INTEGER NOT NULL DEFAULT 0, pinned INTEGER NOT NULL DEFAULT 0, accessed REAL NOT NULL, PRIMARY KEY(scope,book));
          CREATE TABLE IF NOT EXISTS assets(scope TEXT NOT NULL, book INTEGER NOT NULL, path TEXT NOT NULL, digest TEXT NOT NULL, size INTEGER NOT NULL, PRIMARY KEY(scope,book,path), FOREIGN KEY(scope,book) REFERENCES books(scope,book) ON DELETE CASCADE);
          CREATE TABLE IF NOT EXISTS events(id INTEGER PRIMARY KEY AUTOINCREMENT, scope TEXT NOT NULL, book INTEGER NOT NULL, event_id TEXT NOT NULL UNIQUE, body TEXT NOT NULL, prepared INTEGER NOT NULL DEFAULT 0, attempts INTEGER NOT NULL DEFAULT 0, retry_at REAL NOT NULL DEFAULT 0, error TEXT, conflict TEXT);
          CREATE INDEX IF NOT EXISTS events_scope ON events(scope,id);
          CREATE TABLE IF NOT EXISTS clocks(scope TEXT NOT NULL, book INTEGER NOT NULL, day TEXT NOT NULL, seconds INTEGER NOT NULL, PRIMARY KEY(scope,book,day));
          CREATE TABLE IF NOT EXISTS drafts(scope TEXT NOT NULL, book INTEGER NOT NULL, body TEXT NOT NULL, PRIMARY KEY(scope,book));
          PRAGMA user_version=2;
        """)
        if os.name != "nt":
            os.chmod(self.root, 0o700)
            os.chmod(self.root / "state.sqlite", 0o600)

    @contextmanager
    def transaction(self):
        self.db.execute("BEGIN IMMEDIATE")
        try:
            yield
            self.db.execute("COMMIT")
        except BaseException:
            self.db.execute("ROLLBACK")
            raise

    @staticmethod
    def scope(server, user_id):
        if type(user_id) is not int:
            raise ValueError("An authenticated account is required.")
        return hashlib.sha256(json.dumps([server, user_id], separators=(",", ":")).encode()).hexdigest()

    def account(self, server, user, vault_secret=None):
        scope = self.scope(server, user["id"])
        clean = {k: user[k] for k in ("id", "username", "displayName", "role", "permissions", "prefs", "desktopDurableProgress") if k in user}
        digest = hashlib.sha256(vault_secret.encode()).hexdigest() if vault_secret else None
        self.db.execute("INSERT INTO accounts VALUES(?,?,?,?,?) ON CONFLICT(scope) DO UPDATE SET user=excluded.user, vault_hash=excluded.vault_hash", (scope, server, user["id"], json.dumps(clean), digest))
        return scope

    def unlock(self, server, user_id, vault_secret):
        import hmac
        row = self.db.execute("SELECT * FROM accounts WHERE scope=?", (self.scope(server, user_id),)).fetchone()
        digest = hashlib.sha256(vault_secret.encode()).hexdigest()
        return json.loads(row["user"]) if row and row["vault_hash"] and hmac.compare_digest(row["vault_hash"], digest) else None

    def lock_offline(self, scope):
        self.db.execute("UPDATE accounts SET vault_hash=NULL WHERE scope=?", (scope,))

    def bind_vault(self, scope, secret):
        self.db.execute("UPDATE accounts SET vault_hash=? WHERE scope=?", (hashlib.sha256(secret.encode()).hexdigest(), scope))

    def remember_book(self, scope, data):
        book = data["book"]
        version = json.dumps(book.get("version"))
        previous = self.book(scope, book["id"])
        pending = self.pending_book(scope, book["id"])
        if previous and pending:
            if previous["version"] != version:
                self.db.execute("UPDATE books SET complete=0 WHERE scope=? AND book=?", (scope, book["id"]))
                return  # Keep the old revision for an explicit conflict review.
            data = {**data, "book": {**book, "progress": json.loads(previous["data"])["book"].get("progress")}}
        if previous and previous["version"] != version:
            self.db.execute("DELETE FROM assets WHERE scope=? AND book=?", (scope, book["id"]))
            self.db.execute("UPDATE books SET complete=0 WHERE scope=? AND book=?", (scope, book["id"]))
        self.db.execute("INSERT INTO books(scope,book,version,data,accessed) VALUES(?,?,?,?,?) ON CONFLICT(scope,book) DO UPDATE SET version=excluded.version,data=excluded.data,accessed=excluded.accessed", (scope, book["id"], version, json.dumps(data), time.time()))
        if previous and previous["version"] != version:
            self.collect_garbage(scope)

    def book(self, scope, book):
        return self.db.execute("SELECT * FROM books WHERE scope=? AND book=?", (scope, book)).fetchone()

    def books(self, scope, complete=False):
        return self.db.execute("SELECT b.*,COALESCE((SELECT SUM(size) FROM assets a WHERE a.scope=b.scope AND a.book=b.book),0) AS bytes FROM books b WHERE scope=? AND COALESCE(json_extract(data,'$.revoked'),0)=0 " + ("AND complete=1 " if complete else "") + "ORDER BY accessed DESC", (scope,)).fetchall()

    def asset_file(self, scope, digest):
        if len(scope) != 64 or len(digest) != 64 or any(c not in "0123456789abcdef" for c in scope + digest):
            raise ValueError("Invalid cache key")
        target = self.root / "assets" / scope / digest
        if not target.resolve().is_relative_to(self.root):
            raise ValueError("The asset directory points outside the local store.")
        return target

    def put_asset(self, scope, book, path, raw):
        digest = hashlib.sha256(raw).hexdigest()
        target = self.asset_file(scope, digest)
        target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        temporary = target.with_name(digest + "." + uuid.uuid4().hex + ".part")
        try:
            with self.transaction():
                with temporary.open("xb") as stream:
                    stream.write(raw); stream.flush(); os.fsync(stream.fileno())
                os.replace(temporary, target)
                self.db.execute("INSERT OR REPLACE INTO assets VALUES(?,?,?,?,?)", (scope, book, path, digest, len(raw)))
        finally:
            temporary.unlink(missing_ok=True)

    def get_asset(self, scope, book, path):
        row = self.db.execute("SELECT * FROM assets WHERE scope=? AND book=? AND path=?", (scope, book, path)).fetchone()
        if not row:
            return None
        try:
            raw = self.asset_file(scope, row["digest"]).read_bytes()
        except OSError:
            raw = None
        if raw is None or len(raw) != row["size"] or hashlib.sha256(raw).hexdigest() != row["digest"]:
            self.db.execute("DELETE FROM assets WHERE scope=? AND book=? AND path=?", (scope, book, path))
            self.db.execute("UPDATE books SET complete=0 WHERE scope=? AND book=?", (scope, book))
            return None
        self.db.execute("UPDATE books SET accessed=? WHERE scope=? AND book=?", (time.time(), scope, book))
        return raw

    def finish_download(self, scope, book, paths):
        if not paths or any(self.get_asset(scope, book, path) is None for path in paths):
            raise ValueError("The offline download is incomplete or failed integrity verification.")
        self.db.execute("UPDATE books SET complete=1 WHERE scope=? AND book=?", (scope, book))

    def pin(self, scope, book, pinned):
        self.db.execute("UPDATE books SET pinned=? WHERE scope=? AND book=?", (int(pinned), scope, book))

    def cleanup_preview(self, scope):
        return [row for row in reversed(self.books(scope)) if not row["pinned"] and not self.pending_book(scope, row["book"])]

    def pending_book(self, scope, book):
        return self.db.execute("SELECT 1 FROM events WHERE scope=? AND book=? UNION ALL SELECT 1 FROM drafts WHERE scope=? AND book=? UNION ALL SELECT 1 FROM clocks WHERE scope=? AND book=? AND seconds>0", (scope, book, scope, book, scope, book)).fetchone() is not None

    def remove_book(self, scope, book):
        if self.pending_book(scope, book):
            raise ValueError("Sync or resolve this book's pending work before removing its offline copy.")
        self.db.execute("DELETE FROM books WHERE scope=? AND book=?", (scope, book))
        self.collect_garbage(scope)

    def collect_garbage(self, scope):
        directory = self.asset_file(scope, "0" * 64).parent
        if not directory.is_dir():
            return
        with self.transaction():
            used = {row[0] for row in self.db.execute("SELECT DISTINCT digest FROM assets WHERE scope=?", (scope,))}
            for entry in directory.iterdir():
                if entry.is_file() and entry.name not in used:
                    entry.unlink()

    def add_seconds(self, scope, book, day, seconds):
        if seconds > 0:
            self.db.execute("INSERT INTO clocks VALUES(?,?,?,?) ON CONFLICT(scope,book,day) DO UPDATE SET seconds=seconds+excluded.seconds", (scope, book, day, int(seconds)))

    def stage(self, scope, book, body):
        row = self.book(scope, book)
        if not row or "version" in body and body["version"] != json.loads(row["version"]):
            raise ValueError("Resolve the source revision before saving a position from its replacement.")
        self.db.execute("INSERT INTO drafts VALUES(?,?,?) ON CONFLICT(scope,book) DO UPDATE SET body=excluded.body", (scope, book, json.dumps(body)))

    def enqueue(self, scope, book, body):
        row = self.book(scope, book)
        if not row or json.loads(row["version"]) is None:
            raise ValueError("A verified source revision is required before saving offline progress.")
        if "version" in body and body["version"] != json.loads(row["version"]):
            raise ValueError("The displayed file revision differs from pending reading work. Resolve it in Offline library & sync.")
        with self.transaction():
            clocks = self.db.execute("SELECT day,seconds FROM clocks WHERE scope=? AND book=? AND seconds>0 ORDER BY day", (scope, book)).fetchall()
            if not clocks:
                clocks = [{"day": body.get("day", date.today().isoformat()), "seconds": 0}]
            for clock in clocks:
                remaining = clock["seconds"]
                while True:
                    seconds = min(600, remaining)
                    event = {**body, "eventId": str(uuid.uuid4()), "version": json.loads(row["version"]), "day": clock["day"], "accountId": self.db.execute("SELECT user_id FROM accounts WHERE scope=?", (scope,)).fetchone()[0]}
                    if seconds:
                        event["seconds"] = seconds
                    self.db.execute("INSERT INTO events(scope,book,event_id,body) VALUES(?,?,?,?)", (scope, book, event["eventId"], json.dumps(event)))
                    remaining -= seconds
                    if remaining <= 0:
                        break
            self.db.execute("DELETE FROM clocks WHERE scope=? AND book=?", (scope, book))
            self.db.execute("DELETE FROM drafts WHERE scope=? AND book=?", (scope, book))

    def events(self, scope):
        return self.db.execute("SELECT * FROM events WHERE scope=? ORDER BY id", (scope,)).fetchall()

    def prepare(self, event):
        body = json.loads(event["body"])
        if not event["prepared"]:
            row = self.book(event["scope"], event["book"])
            progress = json.loads(row["data"])["book"].get("progress") or {}
            body["baseUpdatedAt"] = progress.get("updatedAt")
            body["accountId"] = self.db.execute("SELECT user_id FROM accounts WHERE scope=?", (event["scope"],)).fetchone()[0]
            self.db.execute("UPDATE events SET prepared=1,body=? WHERE id=? AND scope=?", (json.dumps(body), event["id"], event["scope"]))
        return body

    def acknowledge(self, event, result):
        with self.transaction():
            row = self.book(event["scope"], event["book"])
            if row and "progress" in result:
                data = json.loads(row["data"])
                data["book"]["progress"] = result["progress"]
                self.db.execute("UPDATE books SET data=? WHERE scope=? AND book=?", (json.dumps(data), event["scope"], event["book"]))
            self.db.execute("DELETE FROM events WHERE id=? AND scope=?", (event["id"], event["scope"]))

    def fail(self, event, message, conflict=None):
        attempts = event["attempts"] + 1
        self.db.execute("UPDATE events SET attempts=?,retry_at=?,error=?,conflict=? WHERE id=? AND scope=?", (attempts, time.time() + min(300, 2 ** min(attempts, 8)), message[:1000], json.dumps(conflict) if conflict is not None else None, event["id"], event["scope"]))

    def resolve(self, scope, book, remote, keep_local):
        # Resolution creates new event IDs; an already accepted uncertain receipt
        # is always retried before a conflict is offered by the sync controller.
        with self.transaction():
            row = self.book(scope, book)
            data = json.loads(row["data"])
            changed = data["book"].get("version") != remote["book"].get("version")
            if changed and keep_local:
                raise ValueError("The source revision changed. Export pending work and choose a new position in the new file.")
            events = [e for e in self.events(scope) if e["book"] == book]
            if any(event["prepared"] and not event["conflict"] for event in events):
                raise ValueError("Retry uncertain saves before resolving a conflict; their reading time may already be accepted.")
            bodies = [json.loads(event["body"]) for event in events]
            latest = next((body for body in reversed(bodies) if any(key in body for key in ("position", "page", "percent"))), {})
            seconds = {}
            for event in events:
                body = json.loads(event["body"])
                seconds[body["day"]] = seconds.get(body["day"], 0) + body.get("seconds", 0)
            if changed:
                self.db.execute("DELETE FROM assets WHERE scope=? AND book=?", (scope, book))
            self.db.execute("UPDATE books SET data=?,version=?,complete=CASE WHEN ? THEN 0 ELSE complete END WHERE scope=? AND book=?", (json.dumps(remote), json.dumps(remote["book"].get("version")), int(changed), scope, book))
            self.db.execute("DELETE FROM events WHERE scope=? AND book=?", (scope, book))
            for day, duration in (seconds or {date.today().isoformat(): 0}).items():
                while True:
                    body = {k: latest[k] for k in ("position", "page", "percent") if keep_local and k in latest}
                    event_id = str(uuid.uuid4())
                    body.update(eventId=event_id, version=remote["book"]["version"], day=day, seconds=min(600, duration), accountId=self.db.execute("SELECT user_id FROM accounts WHERE scope=?", (scope,)).fetchone()[0])
                    self.db.execute("INSERT INTO events(scope,book,event_id,body) VALUES(?,?,?,?)", (scope, book, event_id, json.dumps(body)))
                    duration -= min(600, duration)
                    if duration <= 0:
                        break
        if changed:
            self.collect_garbage(scope)

    def close(self):
        self.db.close()
