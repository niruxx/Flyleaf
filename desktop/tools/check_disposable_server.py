"""Live native-client smoke test. Only initialize an explicitly disposable, empty local server."""
import argparse
from http.cookiejar import CookieJar
import json
import os
from pathlib import Path
import secrets
import sys
import time
from urllib.parse import urlsplit
from urllib.request import build_opener, HTTPCookieProcessor, Request
import uuid
import zipfile

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")
DESKTOP = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(DESKTOP / "src"))
sys.path.insert(0, str(DESKTOP / "tests"))

from PySide6.QtCore import QSettings
from PySide6.QtTest import QTest
from PySide6.QtWidgets import QApplication

from flyleaf_desktop.address import normalize_server
from flyleaf_desktop.app import MainWindow
from support import ensure_test_font, image_bytes


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--server", default="http://127.0.0.1:8299")
    parser.add_argument("--initialize-disposable-server", action="store_true", required=True,
                        help="Explicitly allow creating a test admin and a library on this empty local server")
    options = parser.parse_args()
    base = normalize_server(options.server)
    if urlsplit(base).hostname not in ("127.0.0.1", "localhost", "::1"):
        parser.error("Use a dedicated local server, never a remote/production installation")
    opener = build_opener(HTTPCookieProcessor(CookieJar()))

    def request(path, method="GET", body=None):
        payload = json.dumps(body).encode() if body is not None else None
        with opener.open(Request(base + "/api" + path, data=payload, method=method,
                                 headers={"X-Flyleaf": "1", "Content-Type": "application/json"}), timeout=10) as response:
            return json.load(response)

    if not request("/status").get("needsSetup"):
        raise RuntimeError("Refusing to modify an already configured server. Start a new instance with an isolated FLYLEAF_DATA_DIR.")
    app = QApplication.instance() or QApplication([])
    ensure_test_font()
    password = secrets.token_urlsafe(24)
    request("/setup", "POST", {"username": "desktoptest", "password": password, "displayName": "Native client test"})
    root = DESKTOP / "build" / ("live-library-" + uuid.uuid4().hex)
    series_folder = root / "Desktop Sample"
    series_folder.mkdir(parents=True)
    with zipfile.ZipFile(series_folder / "Desktop Sample v01.cbz", "w") as archive:
        for page in range(3):
            archive.writestr(f"{page + 1:03}.png", image_bytes(page=page))
    request("/libraries", "POST", {"name": "Desktop smoke test", "path": str(root), "kind": "comics", "mode": "komga", "autoMetadata": False})
    deadline = time.monotonic() + 10
    while not request("/series")["items"]:
        if time.monotonic() > deadline:
            raise RuntimeError("The test comic was not scanned")
        time.sleep(.1)
    window = MainWindow(QSettings(str(root / "client.ini"), QSettings.Format.IniFormat))
    window.show()

    def wait(condition):
        deadline = time.monotonic() + 6
        while not condition() and time.monotonic() < deadline:
            app.processEvents()
            QTest.qWait(10)
        if not condition():
            raise RuntimeError("The native live-server journey did not become ready")

    try:
        window.connect_server(base)
        wait(lambda: window.stack.currentWidget() is window.login)
        window.sign_in("desktoptest", password)
        wait(lambda: window.user is not None and window.library.grid.count() > 0)
        if window.stack.currentWidget() is window.personalize:
            window.finish_onboarding()
        window.library.grid.setCurrentRow(0)
        wait(lambda: window.library.books.count() > 0)
        window.library._read_selected()
        wait(lambda: window.reader is not None and window.reader._image is not None)
        reader = window.reader
        if reader.total != 3:
            raise AssertionError("The live server returned an unexpected page count")
        reader.show_page(1)
        wait(lambda: reader._image is not None and reader.page == 1)
        reader.flush_progress()
        wait(lambda: not reader.has_unsaved_changes)
        actual = request(f"/books/{reader.book['id']}")
        if actual["progress"]["page"] != 1:
            raise AssertionError("Native reading progress did not reach the actual Flyleaf database")
        screenshot = DESKTOP / "build" / "screenshots" / "live-reader.png"
        screenshot.parent.mkdir(parents=True, exist_ok=True)
        window.grab().save(str(screenshot))
        reader.request_leave(window._return_to_library)
        wait(lambda: window.reader is None)
        window.sign_out()
        wait(lambda: window.user is None)
        print("Live Flyleaf server passed: native connection, session login, catalog, archive pages, database progress and sign-out.")
    finally:
        if window.reader:
            window.reader.dispose()
        window.close()


if __name__ == "__main__":
    main()
