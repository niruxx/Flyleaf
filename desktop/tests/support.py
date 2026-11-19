"""A local HTTP contract fixture; no real account credentials or library files."""
import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit, parse_qs

from PySide6.QtCore import QBuffer, QIODevice, Qt
from PySide6.QtGui import QColor, QImage, QPainter, QFont, QFontDatabase
from PySide6.QtWidgets import QApplication
from flyleaf_desktop.vault import VaultUnavailable


class FakeVault:
    def __init__(self):
        self.entries = {}
        self.fail = None
        self.calls = []

    def perform(self, operation, profile, secret=None):
        self.calls.append((operation, profile["id"]))
        if self.fail in (operation, "all"):
            raise VaultUnavailable("The system vault is locked. Nothing was saved in plaintext.")
        key = profile["address"], profile["id"]
        if operation == "read":
            return self.entries.get(key)
        if operation == "write":
            self.entries[key] = secret
        else:
            self.entries.pop(key, None)


def ensure_test_font():
    # Qt's Windows offscreen plugin has no system font database. Load a real local
    # font for meaningful layout screenshots; the actual Windows platform uses OS fonts.
    if QFontDatabase.families():
        return
    candidates = [Path("C:/Windows/Fonts/segoeui.ttf"), Path("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf")]
    for path in candidates:
        if path.exists():
            font_id = QFontDatabase.addApplicationFont(str(path))
            families = QFontDatabase.applicationFontFamilies(font_id)
            if families:
                QApplication.instance().setFont(QFont(families[0], 10))
                return
    raise RuntimeError("Install a system font before running native layout tests")


def image_bytes(title: str = "THE NIGHT GARDEN", page: int | None = None) -> bytes:
    image = QImage(600, 850, QImage.Format.Format_RGB32)
    image.fill(QColor("#203d36"))
    painter = QPainter(image)
    painter.setPen(QColor("#dfca9b"))
    painter.setFont(QFont("Sans Serif", 24))
    painter.drawText(image.rect().adjusted(50, 50, -50, -50), Qt.AlignmentFlag.AlignCenter | Qt.TextFlag.TextWordWrap,
                     title if page is None else f"{title}\n\nPage {page + 1}\n\nA fictional reading sample")
    painter.end()
    buffer = QBuffer()
    buffer.open(QIODevice.OpenModeFlag.WriteOnly)
    image.save(buffer, "PNG")
    return bytes(buffer.data())


class Fixture:
    def __init__(self):
        ensure_test_font()
        self.requests: list[tuple[str, str, dict]] = []
        self.saves: list[dict] = []
        self.fail_save = False
        self.fail_page: int | None = None
        self.fail_page_list = False
        self.authorized = True
        self.needs_setup = False
        self.registration = None
        self.capabilities = {"catalogFilters": ["language", "format"]}
        self.progress_receipts = {}
        self.lose_save_ack_once = False
        self.deny_book = False
        self.filters = []
        self.page_size = 48
        self.credentials = {"username": "reader", "password": "test-only-password"}
        self.bodies = []
        self.png = image_bytes()
        self.cover_images = {}
        self.finder_sources = []
        self.finder_downloads = []
        self.finder_follows = []
        self.finder_updates = []
        self.annotations = []
        self.user = {"id": 7, "username": "reader", "displayName": "Alex", "role": "guest", "permissions": {}, "prefs": {}}
        self.book = {"id": 1, "version": 1, "seriesId": 1, "title": "The Night Garden", "label": "Volume 1", "format": "cbz", "engine": "pages", "kind": "comics", "pageCount": 3, "progress": None, "coverUrl": "/api/books/1/cover"}
        self.series = {"id": 1, "name": "The Night Garden", "authors": ["Elena Rowe"], "count": 1, "coverUrl": "/api/series/1/cover", "summary": "A fictional story about finding a quiet place to read.", "books": [self.book], "nextBookId": 1}
        self.catalog = [self.series]
        fixture = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_args):
                pass

            def respond(self, status, data, *, cookie=False, content_type="application/json"):
                payload = json.dumps(data).encode() if content_type == "application/json" else data
                self.send_response(status)
                self.send_header("Content-Type", content_type)
                self.send_header("Content-Length", str(len(payload)))
                if fixture.authorized:
                    self.send_header("X-Flyleaf-Account", str(fixture.user["id"]))
                if cookie:
                    self.send_header("Set-Cookie", "flyleaf_session=fixture-session; Path=/; HttpOnly; SameSite=Lax")
                self.end_headers()
                try:
                    self.wfile.write(payload)
                except (BrokenPipeError, ConnectionError):
                    pass  # The native client deliberately aborts requests on account changes.

            def do_GET(self):
                path = urlsplit(self.path).path
                fixture.requests.append(("GET", self.path, dict(self.headers)))
                if path == "/api/status":
                    signed_in = fixture.authorized and "flyleaf_session=fixture-session" in self.headers.get("Cookie", "")
                    self.respond(200, {"needsSetup": fixture.needs_setup, "registration": fixture.registration, "capabilities": fixture.capabilities, "user": fixture.user if signed_in else None})
                elif path == "/api/not-json":
                    self.respond(200, b"<html>Proxy login</html>", content_type="text/html")
                elif path == "/api/redirect":
                    self.send_response(302)
                    self.send_header("Location", "http://different.invalid/secret")
                    self.send_header("Content-Length", "0")
                    self.end_headers()
                elif not fixture.authorized or "flyleaf_session=fixture-session" not in self.headers.get("Cookie", ""):
                    self.respond(401, {"error": "Not signed in."})
                elif fixture.deny_book and path.startswith("/api/books/1/"):
                    self.respond(403, {"error": "Book access revoked."})
                elif path == "/api/libraries":
                    self.respond(200, [{"id": 1, "name": "Comics", "kind": "comics"}])
                elif path == "/api/finder/sources":
                    self.respond(200, fixture.finder_sources)
                elif path == "/api/finder/downloads/list":
                    self.respond(200, fixture.finder_downloads)
                elif path == "/api/finder/follows":
                    self.respond(200, {"follows": fixture.finder_follows})
                elif path == "/api/finder/updates":
                    self.respond(200, fixture.finder_updates)
                elif path == "/api/finder/sample/latest":
                    self.respond(200, {"items": [{"id": "garden", "title": "The Night Garden", "author": "Elena Rowe"}, {"id": "map", "title": "A Map of Small Things", "author": "Oliver Finch"}], "hasMore": False})
                elif path == "/api/finder/sample/details":
                    self.respond(200, {"id": "garden", "title": "The Night Garden", "summary": "A fictional story about finding a quiet place to read.", "files": [{"id": "v1", "title": "Volume 1", "format": "cbz"}, {"id": "v2", "title": "Volume 2", "format": "cbz"}]})
                elif path == "/api/home":
                    self.respond(200, {"continueReading": [], "recentlyAdded": [] if fixture.deny_book else fixture.catalog})
                elif path == "/api/series":
                    if fixture.deny_book:
                        self.respond(200, {"items": [], "hasMore": False}); return
                    query = parse_qs(urlsplit(self.path).query)
                    offset = int(query.get("offset", [0])[0])
                    limit = min(int(query.get("limit", [48])[0]), fixture.page_size)
                    self.respond(200, {"items": fixture.catalog[offset:offset+limit], "hasMore": len(fixture.catalog) > offset + limit})
                elif path.startswith("/api/series/") and path.split("/")[-1].isdigit():
                    series = next((s for s in fixture.catalog if s["id"] == int(path.split("/")[-1])), fixture.series)
                    self.respond(200, series)
                elif path == "/api/me":
                    self.respond(200, fixture.user)
                elif path == "/api/genres":
                    self.respond(200, [{"name": "Fantasy", "count": 1}])
                elif path == "/api/filters":
                    self.respond(200, fixture.filters)
                elif path == "/api/fulltext":
                    self.respond(200, {"results": [{"book": fixture.book, "hits": [{"section": "chapter.xhtml", "snippet": "A <quiet> \u0001garden\u0002"}]}], "status": {"enabled": True}})
                elif path == "/api/books/1/reader":
                    self.respond(200, {"book": fixture.book, "accountId": fixture.user["id"], "settings": {"direction": "ltr"}, "annotations": fixture.annotations})
                elif path == "/api/profiles":
                    self.respond(200, {"profiles": [], "defaults": {}})
                elif path == "/api/annotations":
                    self.respond(200, [{**annotation, "book": fixture.book} for annotation in fixture.annotations])
                elif path == "/api/books/1/positions":
                    self.respond(200, {"items": [{"id": 1, "percent": .33, "page": 0, "position": "0", "at": 1795017600000, "compatible": True, "current": False}], "devices": [], "updatedAt": (fixture.book.get("progress") or {}).get("updatedAt")})
                elif path == "/api/books/1/pages":
                    self.respond(503, {"error": "Storage temporarily unavailable"}) if fixture.fail_page_list else self.respond(200, {"count": 3})
                elif path.startswith("/api/books/1/pages/"):
                    page = int(path.split("/")[-1])
                    self.respond(503, {"error": "Page unavailable"}) if page == fixture.fail_page else self.respond(200, fixture.png, content_type="image/png")
                elif path.endswith("/cover"):
                    self.respond(200, fixture.cover_images.get(path, fixture.png), content_type="image/png")
                else:
                    self.respond(404, {"error": "Not found."})

            def do_POST(self):
                body = json.loads(self.rfile.read(int(self.headers.get("Content-Length", "0"))) or b"{}")
                fixture.requests.append(("POST", self.path, dict(self.headers)))
                fixture.bodies.append(("POST", self.path, body))
                if self.headers.get("X-Flyleaf") != "1":
                    self.respond(403, {"error": "Missing request header."})
                elif self.path == "/api/login":
                    if body == fixture.credentials:
                        fixture.authorized = True
                        self.respond(200, {"user": fixture.user}, cookie=True)
                    else:
                        self.respond(401, {"error": "Incorrect username or password."})
                elif self.path == "/api/logout":
                    self.respond(200, {"ok": True})
                elif self.path == "/api/finder/follows":
                    fixture.finder_follows.append({"id": 1, "title": body["book"]["title"], **body})
                    self.respond(201, fixture.finder_follows[-1])
                elif self.path in ("/api/setup", "/api/register"):
                    if self.path == "/api/setup" and not fixture.needs_setup:
                        self.respond(409, {"error": "Already set up."})
                    elif self.path == "/api/register" and fixture.registration is None:
                        self.respond(403, {"error": "Sign-up closed."})
                    elif self.path == "/api/register" and fixture.registration.get("inviteRequired") and body.get("inviteCode") != "test-invite":
                        self.respond(403, {"error": "Incorrect invite code."})
                    else:
                        fixture.needs_setup = False
                        fixture.credentials = {"username": body["username"], "password": body["password"]}
                        fixture.user = {**fixture.user, "id": 8, "username": body["username"], "displayName": body.get("displayName") or body["username"], "role": "admin" if self.path == "/api/setup" else "guest"}
                        self.respond(201, {"user": fixture.user}, cookie=True)
                elif self.path == "/api/me/password":
                    if body.get("current") != fixture.credentials["password"]:
                        self.respond(400, {"error": "Current password is incorrect."})
                    else:
                        fixture.credentials["password"] = body["next"]
                        self.respond(200, {"ok": True})
                elif self.path == "/api/filters":
                    item = {**body, "id": max([f["id"] for f in fixture.filters] or [0]) + 1}
                    fixture.filters.append(item)
                    self.respond(201, item)
                elif self.path.endswith("/finished"):
                    self.respond(200, {"ok": True})
                else:
                    self.respond(404, {"error": "Not found."})

            def do_PUT(self):
                body = json.loads(self.rfile.read(int(self.headers.get("Content-Length", "0"))) or b"{}")
                fixture.requests.append(("PUT", self.path, dict(self.headers)))
                if not fixture.authorized:
                    self.respond(401, {"error": "Not signed in."})
                elif fixture.fail_save:
                    self.respond(503, {"error": "Server temporarily unavailable"})
                elif self.path == "/api/books/1/progress":
                    if body.get("eventId"):
                        if body.get("accountId") != fixture.user["id"]:
                            self.respond(403, {"error": "Account changed", "reason": "accountMismatch"}); return
                        previous = fixture.progress_receipts.get(body["eventId"])
                        if previous:
                            self.respond(200, previous); return
                        progress = fixture.book.get("progress") or {}
                        if body.get("version") != fixture.book["version"]:
                            self.respond(409, {"error": "Source changed", "reason": "sourceChanged"}); return
                        if body.get("baseUpdatedAt") != progress.get("updatedAt"):
                            self.respond(409, {"error": "Position changed", "reason": "positionChanged", "progress": progress}); return
                    fixture.saves.append(body)
                    fixture.book["progress"] = {**body, "finished": body.get("percent", 0) >= .999}
                    if body.get("eventId"):
                        fixture.book["progress"]["updatedAt"] = len(fixture.saves) + 100
                        response = {"ok": True, "progress": fixture.book["progress"]}
                        fixture.progress_receipts[body["eventId"]] = response
                        if fixture.lose_save_ack_once:
                            fixture.lose_save_ack_once = False
                            self.respond(503, {"error": "Acknowledgement lost"}); return
                        self.respond(200, response)
                    else:
                        self.respond(200, {"ok": True})
                else:
                    self.respond(404, {"error": "Not found."})

            def do_PATCH(self):
                body = json.loads(self.rfile.read(int(self.headers.get("Content-Length", "0"))) or b"{}")
                fixture.requests.append(("PATCH", self.path, dict(self.headers)))
                fixture.bodies.append(("PATCH", self.path, body))
                if self.path == "/api/me":
                    fixture.user.update(body)
                    self.respond(200, fixture.user)
                elif self.path.startswith("/api/filters/"):
                    identity = int(self.path.split("/")[-1])
                    item = next(f for f in fixture.filters if f["id"] == identity)
                    item.update(body)
                    self.respond(200, item)
                else:
                    self.respond(404, {"error": "Not found."})

            def do_DELETE(self):
                fixture.requests.append(("DELETE", self.path, dict(self.headers)))
                identity = int(self.path.split("/")[-1])
                fixture.filters = [f for f in fixture.filters if f["id"] != identity]
                self.respond(200, {"ok": True})

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.url = f"http://127.0.0.1:{self.server.server_port}"
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def close(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(3)
