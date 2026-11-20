"""A local HTTP contract fixture; no real account credentials or library files."""
import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit

from PySide6.QtCore import QBuffer, QIODevice, Qt
from PySide6.QtGui import QColor, QImage, QPainter, QFont, QFontDatabase
from PySide6.QtWidgets import QApplication


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
        self.storage = None
        self.moves: list[dict] = []
        self.png = image_bytes()
        self.user = {"id": 7, "username": "reader", "displayName": "Alex", "role": "guest", "permissions": {}, "prefs": {}}
        self.book = {"id": 1, "seriesId": 1, "title": "The Night Garden", "label": "Volume 1", "format": "cbz", "engine": "pages", "kind": "comics", "pageCount": 3, "progress": None, "coverUrl": "/api/books/1/cover"}
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
                    self.respond(200, {"needsSetup": False, "user": None})
                elif path == "/api/not-json":
                    self.respond(200, b"<html>Proxy login</html>", content_type="text/html")
                elif path == "/api/redirect":
                    self.send_response(302)
                    self.send_header("Location", "http://different.invalid/secret")
                    self.send_header("Content-Length", "0")
                    self.end_headers()
                elif not fixture.authorized or "flyleaf_session=fixture-session" not in self.headers.get("Cookie", ""):
                    self.respond(401, {"error": "Not signed in."})
                elif path == "/api/libraries":
                    self.respond(200, [{"id": 1, "name": "Comics", "kind": "comics"}])
                elif path == "/api/storage-migration" and fixture.storage is not None:
                    self.respond(200, fixture.storage)
                elif path == "/api/storage-migration/preview" and fixture.storage is not None:
                    from urllib.parse import parse_qs
                    destination = parse_qs(urlsplit(self.path).query)["destination"][0]
                    self.respond(200, {"destination": destination, "files": 3, "bytes": 1048576,
                                       "free": 1073741824, "fits": True})
                elif path == "/api/home":
                    self.respond(200, {"continueReading": [], "recentlyAdded": fixture.catalog})
                elif path == "/api/series":
                    self.respond(200, {"items": fixture.catalog, "hasMore": False})
                elif path == "/api/series/1":
                    self.respond(200, fixture.series)
                elif path == "/api/books/1/reader":
                    self.respond(200, {"book": fixture.book, "settings": {"direction": "ltr"}})
                elif path == "/api/books/1/pages":
                    self.respond(503, {"error": "Storage temporarily unavailable"}) if fixture.fail_page_list else self.respond(200, {"count": 3})
                elif path.startswith("/api/books/1/pages/"):
                    page = int(path.split("/")[-1])
                    self.respond(503, {"error": "Page unavailable"}) if page == fixture.fail_page else self.respond(200, fixture.png, content_type="image/png")
                elif path.endswith("/cover"):
                    self.respond(200, fixture.png, content_type="image/png")
                else:
                    self.respond(404, {"error": "Not found."})

            def do_POST(self):
                body = json.loads(self.rfile.read(int(self.headers.get("Content-Length", "0"))) or b"{}")
                fixture.requests.append(("POST", self.path, dict(self.headers)))
                if self.headers.get("X-Flyleaf") != "1":
                    self.respond(403, {"error": "Missing request header."})
                elif self.path == "/api/login":
                    if body == {"username": "reader", "password": "test-only-password"}:
                        fixture.authorized = True
                        self.respond(200, {"user": fixture.user}, cookie=True)
                    else:
                        self.respond(401, {"error": "Incorrect username or password."})
                elif self.path == "/api/logout":
                    self.respond(200, {"ok": True})
                elif self.path == "/api/storage-migration" and fixture.storage is not None:
                    fixture.moves.append(body)
                    self.respond(202, {"id": 1})
                elif self.path.endswith("/finished"):
                    self.respond(200, {"ok": True})
                else:
                    self.respond(404, {"error": "Not found."})

            def do_PUT(self):
                body = json.loads(self.rfile.read(int(self.headers.get("Content-Length", "0"))) or b"{}")
                fixture.requests.append(("PUT", self.path, dict(self.headers)))
                if self.path == "/api/me/prefs":
                    prefs = fixture.user["prefs"]
                    prefs["catalog"] = {**prefs.get("catalog", {}), **body.get("catalog", {})}
                    self.respond(200, prefs)
                elif fixture.fail_save:
                    self.respond(503, {"error": "Server temporarily unavailable"})
                elif self.path == "/api/books/1/progress":
                    fixture.saves.append(body)
                    fixture.book["progress"] = {**body, "finished": body.get("percent", 0) >= .999}
                    self.respond(200, {"ok": True})
                else:
                    self.respond(404, {"error": "Not found."})

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.url = f"http://127.0.0.1:{self.server.server_port}"
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def close(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(3)
