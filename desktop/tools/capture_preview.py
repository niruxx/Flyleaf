"""Render the real Qt application against fictional local API responses."""
import os
from pathlib import Path
import sys
import time

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")
DESKTOP = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(DESKTOP / "src"))
sys.path.insert(0, str(DESKTOP / "tests"))

from PySide6.QtCore import QSettings
from PySide6.QtTest import QTest
from PySide6.QtWidgets import QApplication

from flyleaf_desktop.app import MainWindow
from support import Fixture


def main():
    app = QApplication.instance() or QApplication([])
    fixture = Fixture()
    for index, title in enumerate(["A Map of Small Things", "Where the Light Goes", "Letters to the Moon", "The Last Bookshop", "Field Notes"], 2):
        fixture.catalog.append({**fixture.series, "id": index, "name": title, "authors": ["Oliver Finch"], "coverUrl": "/api/series/1/cover"})
    output = DESKTOP / "build" / "screenshots"
    output.mkdir(parents=True, exist_ok=True)
    settings = QSettings(str(output / "preview.ini"), QSettings.Format.IniFormat)
    settings.clear()
    window = MainWindow(settings)
    window.resize(1280, 860)
    window.show()

    def wait(condition):
        deadline = time.monotonic() + 5
        while not condition() and time.monotonic() < deadline:
            app.processEvents()
            QTest.qWait(20)
        if not condition():
            raise RuntimeError("Native preview did not become ready")

    def capture(name):
        app.processEvents()
        QTest.qWait(300)
        if not window.grab().save(str(output / f"{name}.png")):
            raise RuntimeError("Could not write preview screenshot")

    try:
        window.connection.address.setText("192.168.1.25:7878")
        capture("welcome")
        window._begin_setup()
        capture("connect")
        window.connect_server(fixture.url)
        wait(lambda: window.stack.currentWidget() is window.login)
        window.login.username.setText("reader")
        capture("sign-in")
        window.sign_in("reader", "test-only-password")
        wait(lambda: window.library.grid.count() == 6 and not window.library._covers and window.library._cover_active == 0)
        capture("personalize")
        window.finish_onboarding()
        window.library.grid.setCurrentRow(0)
        wait(lambda: window.library.books.count() == 1)
        capture("library")
        window.open_book(fixture.book)
        wait(lambda: window.reader is not None and window.reader._image is not None)
        capture("reader")
        window.reader.flush_progress()
        wait(lambda: not window.reader.has_unsaved_changes)
        window._return_to_library()
        window.appearance.configure(theme="light")
        wait(lambda: window.library.grid.count() == 6 and not window.library._covers and window.library._cover_active == 0)
        window.library.grid.setCurrentRow(0)
        wait(lambda: window.library.books.count() == 1)
        capture("library-light")
        window.stack.setCurrentWidget(window.welcome)
        window.resize(820, 600)
        capture("welcome-small")
        print(f"Native Qt screenshots: {output}")
    finally:
        if window.reader:
            window.reader.dispose()
        window.close()
        fixture.close()


if __name__ == "__main__":
    main()
