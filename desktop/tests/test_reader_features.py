"""Native discovery and streaming boundaries; no live accounts or credentials."""
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import io
import threading
import unittest
import wave
from urllib.request import Request, urlopen
from urllib.error import HTTPError
from PySide6.QtCore import QObject, Signal, QUrl, QTimer, QBuffer, QIODevice
from PySide6.QtGui import QImage
from PySide6.QtNetwork import QNetworkAccessManager, QNetworkCookie
from test_client import APP, wait_for
from flyleaf_desktop.finder import FinderPage
from flyleaf_desktop.audio_relay import AudioRelay


class PendingApi:
    def __init__(self):
        self.calls = []

    def json(self, method, path, success, failure, body=None, **kwargs):
        self.calls.append((method, path, success, failure, body, kwargs))

    def reply(self, suffix, value):
        call = next(c for c in reversed(self.calls) if c[1].endswith(suffix))
        call[2](value)


class FinderTests(unittest.TestCase):
    def test_genres_survive_initial_search_and_old_account_callbacks_are_ignored(self):
        api = PendingApi()
        page = FinderPage(api)
        try:
            page.start_session({"id": 7})
            api.reply("/libraries", [{"id": 2, "name": "My library"}])
            api.reply("/sources", [{"id": "test", "name": "Sample source", "hasGenres": True, "canBrowse": True}])
            page.sources.setCurrentRow(0)
            api.reply("/genres", [{"id": "fantasy", "name": "Fantasy"}])
            self.assertEqual(page.genres.count(), 2)
            api.reply("/latest", {"items": [{"id": "book-1", "title": "A garden"}], "hasMore": False})
            page.results.setCurrentRow(0)
            api.reply("/details", {"id": "book-1", "title": "A garden", "files": [{"id": "f1", "title": "Volume 1", "format": "epub"}]})
            from PySide6.QtCore import Qt
            page.files.item(0).setCheckState(Qt.CheckState.Checked)
            page.queue_download()
            call = api.calls[-1]
            self.assertEqual(call[4]["libraryId"], 2)
            self.assertEqual(call[4]["files"][0]["id"], "f1")
            page.clear_session()
            call[2]({"ids": [123]})
            self.assertEqual(page.notice.text(), "")
            self.assertEqual(page.files.count(), 0)
        finally:
            page.close(); page.deleteLater(); APP.processEvents()


class ReaderGuiTests(unittest.TestCase):
    def api(self, payload=None, wide=False):
        from flyleaf_desktop.api import ApiError
        class Api(QObject):
            session_expired = Signal()
            def __init__(api):
                super().__init__()
                api.saves = []
                api.fail_page = None

            def json(api, method, path, success, failure, body=None, **_kwargs):
                if path.endswith("/pages"):
                    QTimer.singleShot(0, lambda: success({"count": 3}))
                elif path == "/api/profiles":
                    QTimer.singleShot(0, lambda: success({"profiles": []}))
                elif path.endswith("/progress"):
                    api.saves.append(body)
                    QTimer.singleShot(0, lambda: success({"ok": True}))

            def binary(api, path, success, failure):
                QTimer.singleShot(0, lambda: success(payload))

            def image(api, path, success, failure, **_kwargs):
                page = int(path.split("?")[0].split("/")[-1])
                if page == api.fail_page:
                    QTimer.singleShot(0, lambda: failure(ApiError("Unavailable page")))
                    return
                image = QImage(1000 if wide else 600, 400 if wide else 850, QImage.Format.Format_RGB32)
                image.fill("#abcdef")
                buffer = QBuffer(); buffer.open(QIODevice.OpenModeFlag.WriteOnly); image.save(buffer, "PNG")
                raw = bytes(buffer.data())
                QTimer.singleShot(0, lambda: success(raw))
        return Api()

    def cleanup(self, reader):
        reader._pending = None
        reader.dispose(); reader.close(); reader.deleteLater(); APP.processEvents()

    def test_pdf_and_epub_widgets_render_save_verified_positions_and_release_workers(self):
        from test_documents import sample_pdf, sample_epub
        from flyleaf_desktop.document_reader import DocumentReader
        for format, payload in (("pdf", sample_pdf()), ("epub", sample_epub())):
            api = self.api(payload)
            reader = DocumentReader(api, {"book": {"id": 1, "format": format, "progress": {}}}, lambda: None)
            reader.resize(1000, 800); reader.show()
            try:
                wait_for(lambda: reader._image is not None, timeout=10000)
                reader.show_page(1)
                wait_for(lambda: reader._image is not None, timeout=10000)
                reader.flush_progress()
                wait_for(lambda: not reader._saving)
                self.assertTrue(api.saves)
                if format == "epub":
                    self.assertTrue(api.saves[-1]["position"].startswith("epubcfi("))
                    self.assertNotIn("page", api.saves[-1])
                else:
                    self.assertEqual(api.saves[-1]["page"], 1)
                self.assertEqual(reader.canvas.pixmap().devicePixelRatio(), reader.devicePixelRatioF())
                worker = reader.engine.process
            finally:
                self.cleanup(reader)
            self.assertFalse(worker.is_alive())

    def test_split_last_page_does_not_finish_book_until_second_half(self):
        from flyleaf_desktop.comic_reader import ComicReader, CACHE_BYTES
        api = self.api(wide=True)
        reader = ComicReader(api, {"book": {"id": 1, "format": "cbz", "progress": {}}}, lambda: None)
        reader.resize(900, 700); reader.show()
        try:
            wait_for(lambda: reader._image is not None)
            reader.split.setCurrentIndex(reader.split.findData("split"))
            reader.apply_options()
            reader.show_page(2)
            wait_for(lambda: reader._image is not None)
            self.assertLess(reader.progress_body(2)["percent"], 1)
            self.assertTrue(reader.next.isEnabled())
            reader.next.click()
            wait_for(lambda: reader._image is not None)
            self.assertEqual(reader.progress_body(2)["percent"], 1)
            self.assertLessEqual(reader._cache_bytes, CACHE_BYTES)
            self.assertEqual(reader.canvas.pixmap().devicePixelRatio(), reader.devicePixelRatioF())
        finally:
            self.cleanup(reader)

    def test_ebook_percentage_without_anchor_requires_explicit_resume_before_writing(self):
        from test_documents import sample_epub
        from flyleaf_desktop.document_reader import DocumentReader
        api = self.api(sample_epub())
        reader = DocumentReader(api, {"book": {"id": 1, "format": "epub", "progress": {"percent": .6}}}, lambda: None)
        try:
            wait_for(lambda: reader._image is not None, timeout=10000)
            reader.flush_progress()
            self.assertEqual(api.saves, [])
            self.assertFalse(reader._writes_enabled)
            reader.enable_position_writes()
            wait_for(lambda: bool(api.saves))
            self.assertTrue(api.saves[-1]["position"].startswith("epubcfi("))
        finally:
            self.cleanup(reader)

    def test_failed_second_spread_page_keeps_last_acknowledged_position(self):
        from flyleaf_desktop.comic_reader import ComicReader
        api = self.api()
        reader = ComicReader(api, {"book": {"id": 1, "format": "cbz", "progress": {}}}, lambda: None)
        try:
            wait_for(lambda: reader._image is not None)
            reader.flush_progress(); wait_for(lambda: not reader._saving)
            api.saves.clear(); api.fail_page = 2
            reader.layout_choice.setCurrentIndex(reader.layout_choice.findData("double"))
            reader.apply_options()
            reader.show_page(1)
            wait_for(lambda: "Unavailable" in reader.page_notice.text())
            reader.flush_progress(); APP.processEvents()
            self.assertEqual(api.saves, [])
            self.assertEqual(reader._last_saved, 0)
        finally:
            self.cleanup(reader)

    def test_large_decoded_pages_and_continuous_widgets_stay_bounded(self):
        from flyleaf_desktop.comic_reader import ComicReader, CACHE_BYTES
        image = QImage(2000, 3000, QImage.Format.Format_RGB32)
        image.fill("#abcdef")
        buffer = QBuffer(); buffer.open(QIODevice.OpenModeFlag.WriteOnly); image.save(buffer, "PNG")
        raw = bytes(buffer.data())
        api = self.api()
        api.image = lambda path, success, failure, **kwargs: QTimer.singleShot(0, lambda: success(raw))
        reader = ComicReader(api, {"book": {"id": 1, "format": "cbz", "progress": {}}}, lambda: None)
        reader.resize(900, 900); reader.show()
        try:
            wait_for(lambda: reader._image is not None)
            reader.total = 12
            for page in range(8):
                reader.show_page(page)
                wait_for(lambda: reader._image is not None)
                self.assertLessEqual(reader._cache_bytes, CACHE_BYTES)
                self.assertLessEqual(len(reader._cache), 2)
            reader.layout_choice.setCurrentIndex(reader.layout_choice.findData("webtoon"))
            reader.apply_options()
            wait_for(lambda: bool(reader._stream) and not reader._stream_busy)
            for _ in range(5):
                reader.scroll.verticalScrollBar().setValue(reader.scroll.verticalScrollBar().maximum())
                APP.processEvents()
                wait_for(lambda: not reader._stream_busy)
                self.assertLessEqual(len(reader._stream), 3)
                self.assertLessEqual(reader._cache_bytes, CACHE_BYTES)
        finally:
            self.cleanup(reader)


class RelayTests(unittest.TestCase):
    def setUp(self):
        self.requests = []
        self.status = 200
        raw = io.BytesIO()
        with wave.open(raw, "wb") as output:
            output.setnchannels(1); output.setsampwidth(2); output.setframerate(8000)
            output.writeframes(b"\0\0" * 8000 * 12)
        self.payload = raw.getvalue()
        test = self
        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_args):
                pass

            def do_GET(self):
                test.requests.append((self.path, dict(self.headers)))
                if test.status != 200:
                    self.send_response(test.status)
                    if test.status == 302:
                        self.send_header("Location", "/untrusted")
                    self.end_headers(); return
                start, end = 0, len(test.payload) - 1
                byte_range = self.headers.get("Range")
                if byte_range:
                    first, last = byte_range[6:].split("-")
                    start, end = int(first), int(last) if last else end
                data = test.payload[start:end + 1]
                self.send_response(206 if byte_range else 200)
                self.send_header("Content-Type", "audio/wav")
                self.send_header("Content-Length", str(len(data)))
                self.send_header("Accept-Ranges", "bytes")
                if byte_range:
                    self.send_header("Content-Range", f"bytes {start}-{end}/{len(test.payload)}")
                self.end_headers()
                try:
                    self.wfile.write(data)
                except OSError:
                    pass
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.server.daemon_threads = True
        self.thread = threading.Thread(target=self.server.serve_forever, kwargs={"poll_interval": .05}, daemon=True)
        self.thread.start()
        self.base = f"http://127.0.0.1:{self.server.server_port}"
        self.relay = AudioRelay(self.base, 1, "flyleaf_session=fictional", 1)

    def tearDown(self):
        self.relay.close()
        self.server.shutdown(); self.server.server_close(); self.thread.join(.5)

    def test_authenticated_ranges_capability_and_redirect_boundaries(self):
        with urlopen(Request(self.relay.url(0), headers={"Range": "bytes=12-31"}), timeout=3) as response:
            self.assertEqual(response.status, 206)
            self.assertEqual(response.read(), self.payload[12:32])
            self.assertIsNone(response.headers.get("Set-Cookie"))
        self.assertEqual(self.requests[-1][1]["Cookie"], "flyleaf_session=fictional")
        for url in (self.relay.url(1), self.relay.url(0) + "?url=elsewhere", self.relay.url(0).replace(self.relay.token, "wrong")):
            with self.assertRaises(HTTPError) as error:
                urlopen(url, timeout=3)
            self.assertEqual(error.exception.code, 404)
            error.exception.close()
        self.status = 302
        with self.assertRaises(HTTPError) as error:
            urlopen(self.relay.url(0), timeout=3)
        self.assertEqual(error.exception.code, 502)
        error.exception.close()
        self.assertFalse(any(path == "/untrusted" for path, _ in self.requests))
        self.status = 401
        with self.assertRaises(HTTPError) as error:
            urlopen(self.relay.url(0), timeout=3)
        error.exception.close()
        self.assertIn(401, list(self.relay.events.queue))

    def test_real_vlc_restores_and_seeks_without_saving_transient_zero(self):
        from flyleaf_desktop.audio_reader import AudioReader, load_vlc
        try:
            load_vlc()
        except RuntimeError as error:
            self.skipTest(str(error))
        class Api(QObject):
            session_expired = Signal()
            def __init__(api):
                super().__init__()
                api.base = self.base
                api.manager = QNetworkAccessManager(api)
                cookie = QNetworkCookie(b"flyleaf_session", b"fictional")
                api.manager.cookieJar().setCookiesFromUrl([cookie], QUrl(api.base))
                api.saves = []

            def json(api, method, path, success, failure, body=None, **_kwargs):
                if path.endswith("/tracks"):
                    success({"tracks": [{"n": 0, "title": "Test audio"}], "duration": 12})
                elif path == "/api/profiles":
                    success({"profiles": []})
                elif path.endswith("/progress"):
                    api.saves.append(body); success({"ok": True})
        api = Api()
        reader = AudioReader(api, {"book": {"id": 1, "format": "audio", "progress": {"position": "0:4", "percent": .3}}}, lambda: None, silent=True)
        try:
            try:
                wait_for(lambda: reader._ready, timeout=15000)
            except AssertionError:
                self.fail(f"{reader.notice.text()}; state={reader.player.get_state() if reader.player else None}; requests={len(self.requests)}; time={reader.player.get_time() if reader.player else None}; seek={reader._seek_target}")
            self.assertGreaterEqual(float(reader.current_locator().split(":")[1]), 3)
            reader.flush_progress()
            api.saves.clear()
            reader.seek_to(8)
            self.assertFalse(reader._ready)
            reader.queue_position(); reader.flush_progress()
            self.assertTrue(all(float(body["position"].split(":")[1]) >= 3 for body in api.saves))
            wait_for(lambda: reader._ready, timeout=15000)
            reader.queue_position(); reader.flush_progress()
            self.assertGreaterEqual(float(api.saves[-1]["position"].split(":")[1]), 7)
            self.assertTrue(all("seconds" not in body for body in api.saves))
            verified = reader.current_locator()
            reader._last_poll -= 20
            reader.poll()
            self.assertFalse(reader._ready)
            self.assertEqual(reader.current_locator(), verified)
            reader.toggle_play()
            wait_for(lambda: reader._ready, timeout=15000)
            self.assertGreaterEqual(float(reader.current_locator().split(":")[1]), 7)
        finally:
            reader.dispose(); reader.close(); reader.deleteLater(); APP.processEvents()


if __name__ == "__main__":
    unittest.main()
