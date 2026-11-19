"""Account-scoped, loopback-only byte-range relay. VLC never receives server cookies."""
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.request import Request, build_opener, HTTPRedirectHandler
from urllib.error import HTTPError
from urllib.parse import urlsplit
import queue
import re
import secrets
import threading


class _NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, request, file, code, message, headers, url):
        return None


class AudioRelay:
    def __init__(self, server_base, book_id, cookie, track_count, local_files=None, account_id=None):
        if type(book_id) is not int or not 0 < track_count <= 10000:
            raise ValueError("Invalid audio track metadata.")
        self.base, self.book_id, self.cookie = server_base, book_id, cookie
        self.track_count = track_count
        self.token = secrets.token_urlsafe(32)
        self.events = queue.Queue()
        self.closed = False
        self.responses = set()
        self.lock = threading.Lock()
        relay = self
        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_args):
                pass  # Never log the unguessable local media capability.

            def do_HEAD(self):
                self.serve(True)

            def do_GET(self):
                self.serve(False)

            def serve(self, head):
                path = urlsplit(self.path)
                match = re.fullmatch("/" + re.escape(relay.token) + r"/(\d+)", path.path)
                if relay.closed or path.query or not match or int(match[1]) >= relay.track_count:
                    self.send_error(404); return
                if local_files is not None:
                    file = local_files.get(int(match[1]))
                    if file is None:
                        self.send_error(404); return
                    length = file.stat().st_size
                    start, end = 0, length - 1
                    byte_range = self.headers.get("Range")
                    if byte_range:
                        bounds = re.fullmatch(r"bytes=(\d+)-(\d*)", byte_range)
                        if not bounds:
                            self.send_error(416); return
                        start = int(bounds[1]); end = min(length - 1, int(bounds[2])) if bounds[2] else length - 1
                    if not 0 <= start <= end < length:
                        self.send_error(416); return
                    self.send_response(206 if byte_range else 200)
                    self.send_header("Content-Length", str(end - start + 1))
                    self.send_header("Accept-Ranges", "bytes")
                    self.send_header("Cache-Control", "no-store")
                    if byte_range:
                        self.send_header("Content-Range", f"bytes {start}-{end}/{length}")
                    self.end_headers()
                    if not head:
                        try:
                            with file.open("rb") as stream:
                                stream.seek(start)
                                remaining = end - start + 1
                                while remaining and not relay.closed:
                                    data = stream.read(min(65536, remaining))
                                    if not data:
                                        break
                                    self.wfile.write(data); remaining -= len(data)
                        except OSError:
                            pass
                    return
                headers = {"X-Flyleaf": "1", "Cookie": relay.cookie, "Accept": "audio/*"}
                byte_range = self.headers.get("Range")
                if byte_range:
                    if not re.fullmatch(r"bytes=\d+-\d*", byte_range):
                        self.send_error(416); return
                    headers["Range"] = byte_range
                response = None
                try:
                    url = f"{relay.base}/api/books/{relay.book_id}/tracks/{int(match[1])}"
                    response = build_opener(_NoRedirect()).open(Request(url, method="HEAD" if head else "GET", headers=headers), timeout=20)
                    if account_id is not None and response.headers.get("X-Flyleaf-Account") != str(account_id):
                        relay.events.put(401)
                        self.send_error(401); return
                    if response.status not in (200, 206):
                        self.send_error(502); return
                    with relay.lock:
                        if relay.closed:
                            return
                        relay.responses.add(response)
                    self.send_response(response.status)
                    for name in ("Content-Type", "Content-Length", "Content-Range", "Accept-Ranges"):
                        if response.headers.get(name):
                            self.send_header(name, response.headers[name])
                    self.send_header("Cache-Control", "no-store")
                    self.end_headers()
                    if not head:
                        while not relay.closed:
                            data = response.read(64 * 1024)
                            if not data:
                                break
                            self.wfile.write(data)
                except HTTPError as error:
                    relay.events.put(error.code)
                    self.send_error(error.code if error.code in (401, 403, 404, 416) else 502)
                    error.close()
                except (OSError, ValueError):
                    relay.events.put(503)
                    if not self.wfile.closed:
                        try:
                            self.send_error(502)
                        except OSError:
                            pass
                finally:
                    if response:
                        with relay.lock:
                            relay.responses.discard(response)
                        response.close()
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.server.daemon_threads = True
        self.thread = threading.Thread(target=self.server.serve_forever, kwargs={"poll_interval": .1}, daemon=True)
        self.thread.start()

    def url(self, track):
        return f"http://127.0.0.1:{self.server.server_port}/{self.token}/{track}"

    def close(self):
        self.closed = True
        self.cookie = ""
        with self.lock:
            responses = list(self.responses)
        for response in responses:
            try:
                response.close()
            except OSError:
                pass
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=.5)
