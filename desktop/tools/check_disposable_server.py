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
import io
from unittest.mock import patch

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")
DESKTOP = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(DESKTOP / "src"))
sys.path.insert(0, str(DESKTOP / "tests"))

from PySide6.QtCore import QSettings, Qt
from PySide6.QtTest import QTest
from PySide6.QtWidgets import QApplication, QMessageBox

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
    root = DESKTOP / "build" / ("live-library-" + uuid.uuid4().hex)
    series_folder = root / "Desktop Sample"
    series_folder.mkdir(parents=True)
    with zipfile.ZipFile(series_folder / "Desktop Sample v01.cbz", "w") as archive:
        for page in range(3):
            archive.writestr(f"{page + 1:03}.png", image_bytes(page=page))
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
        wait(lambda: window.stack.currentWidget() is window.create_account)
        page = window.create_account
        page.username.setText("desktoptest")
        page.display_name.setText("Native client test")
        page.password.setText(password)
        page.confirm.setText(password)
        page.submit()
        wait(lambda: window.user is not None)
        request("/login", "POST", {"username": "desktoptest", "password": password})
        request("/libraries", "POST", {"name": "Desktop smoke test", "path": str(root), "kind": "comics", "mode": "komga", "autoMetadata": False})
        deadline = time.monotonic() + 10
        while not request("/series")["items"]:
            if time.monotonic() > deadline:
                raise RuntimeError("The test comic was not scanned")
            app.processEvents()
            QTest.qWait(50)
        window.library.refresh()
        wait(lambda: window.user is not None and window.library.grid.count() > 0)
        if window.stack.currentWidget() is window.personalize:
            window.finish_onboarding()
        window.library.grid.setCurrentRow(0)
        wait(lambda: window.library.books.count() > 0)
        # Exercise the new server predicates and account-owned filter persistence.
        series = request("/series", "GET")["items"][0]
        if not request("/series?format=cbz")["items"] or request("/series?format=pdf")["items"]:
            raise AssertionError("Real server format filtering failed")
        request(f"/series/{series['id']}", "PATCH", {"language": "en"})
        if not request("/series?language=en&format=cbz")["items"]:
            raise AssertionError("Real server language filtering failed")
        saved_filter = request("/filters", "POST", {"name": "Native smoke", "filter": {"language": "en", "format": "cbz"}})
        if saved_filter["filter"] != {"language": "en", "format": "cbz"}:
            raise AssertionError("Real server dropped saved filter fields")
        request(f"/filters/{saved_filter['id']}", "DELETE")
        window.show_account()
        window.account.display_name.setText("Native profile updated")
        window.account.save_profile.click()
        wait(lambda: window.user.get("displayName") == "Native profile updated")
        window.account.current.setText(password)
        window.account.next.setText(password + "-changed")
        window.account.confirm.setText(password + "-changed")
        window.account.save_password.click()
        wait(lambda: "Password changed" in window.account.notice.text())
        window._leave_account()
        window.library._read_selected()
        wait(lambda: window.reader is not None and window.reader._image is not None)
        reader = window.reader
        if reader.total != 3:
            raise AssertionError("The live server returned an unexpected page count")
        reader.show_page(1)
        wait(lambda: reader._image is not None and reader.page == 1)
        reader.flush_progress()
        wait(lambda: not reader.has_unsaved_changes and not window.local_store.events(window.reliability.scope))
        actual = request(f"/books/{reader.book['id']}")
        if actual["progress"]["page"] != 1:
            raise AssertionError("Native reading progress did not reach the actual Flyleaf database")
        window.downloads.start(reader.book)
        wait(lambda: not window.downloads.active)
        if not window.local_store.books(window.reliability.scope, complete=True):
            raise AssertionError("The actual server's offline assets did not verify")
        previous_reader = window.reader
        window.api.offline = True
        window.open_book(reader.book)
        wait(lambda: window.reader is not previous_reader and window.reader._image is not None)
        reader = window.reader
        reader.show_page(2)
        wait(lambda: reader._image is not None and reader.page == 2)
        reader.flush_progress()
        wait(lambda: not reader.has_unsaved_changes)
        window.reconnect_reading()
        wait(lambda: not window.local_store.events(window.reliability.scope))
        actual = request(f"/books/{reader.book['id']}")
        if actual["progress"]["page"] != 2:
            raise AssertionError("Offline progress did not reach the actual server after reconnect")
        reader.active_clock.stop()
        window.reliability.capture(reader); window.reliability.pump()
        wait(lambda: not window.local_store.events(window.reliability.scope))
        request(f"/books/{reader.book['id']}/annotations", "POST", {"kind": "highlight", "locator": "2", "page": 2, "text": "Native reading sample", "note": "Fictional private note for the live test."})
        window.show_annotations()
        wait(lambda: window.annotations_dialog.items.count() == 1)
        window.annotations_dialog.search.setText("private note")
        if window.annotations_dialog.items.count() != 1:
            raise AssertionError("Native annotation search did not find the real server note")
        exported, export_errors = [], []
        for format in ("markdown", "csv", "readwise", "obsidian"):
            window.api.binary(f"/api/annotations/export?format={format}&book={reader.book['id']}", lambda raw, kind=format: exported.append((kind, raw)), export_errors.append)
        wait(lambda: len(exported) == 4 or bool(export_errors))
        if export_errors:
            raise AssertionError("Real server annotation export failed: " + export_errors[0].message)
        for format, raw in exported:
            if format == "obsidian":
                with zipfile.ZipFile(io.BytesIO(raw)) as archive:
                    if not archive.namelist():
                        raise AssertionError("Obsidian export was empty")
            elif b"Fictional private note" not in raw:
                raise AssertionError("A note was missing from " + format + " export")
        window.annotations_dialog.hide()
        reader.companion_tools.show_history()
        history = reader.companion_tools.history
        wait(lambda: history.items.count() >= 2)
        selected = next(history.items.item(index) for index in range(history.items.count()) if not history.items.item(index).data(Qt.ItemDataRole.UserRole).get("current"))
        target_page = selected.data(Qt.ItemDataRole.UserRole)["page"]
        history.items.setCurrentItem(selected)
        with patch("flyleaf_desktop.personal_data.QMessageBox.question", return_value=QMessageBox.StandardButton.Yes):
            history.restore()
        wait(lambda: reader.page == target_page and reader._image is not None)
        history.hide()
        screenshot = DESKTOP / "build" / "screenshots" / "live-reader.png"
        screenshot.parent.mkdir(parents=True, exist_ok=True)
        window.grab().save(str(screenshot))
        reader.request_leave(window._return_to_library)
        wait(lambda: window.reader is None)
        window.sign_out()
        wait(lambda: window.user is None)
        print("Live Flyleaf server passed: native admin setup, profile/password updates, filters, archive reading, durable progress, offline download/read/reconnect, searchable notes, Markdown/CSV/Readwise/Obsidian exports, guarded position restore and sign-out.")
    finally:
        if window.reader:
            window.reader.dispose()
        window.close()


if __name__ == "__main__":
    main()
