"""Render the real Qt application against fictional local API responses."""
import os
from pathlib import Path
import sys
import time

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")
DESKTOP = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(DESKTOP / "src"))
sys.path.insert(0, str(DESKTOP / "tests"))

from PySide6.QtCore import QSettings, QBuffer, QIODevice, Qt, QRectF
from PySide6.QtGui import QImage, QPainter, QPen, QColor, QFont, QPainterPath
from PySide6.QtTest import QTest
from PySide6.QtWidgets import QApplication

from flyleaf_desktop.app import MainWindow
from support import Fixture


def fictional_cover(title, index):
    """Original vector cover art for screenshots only, never inserted into a real library."""
    palettes = [("#20473c", "#dec991"), ("#c8dbd9", "#355456"), ("#eedfc2", "#87543e"),
                ("#cfc1df", "#57436b"), ("#263d67", "#e1d4ad"), ("#e6c6c7", "#713d52")]
    bg, ink = palettes[index % len(palettes)]
    canvas = QImage(600, 850, QImage.Format.Format_RGB32)
    canvas.fill(QColor(bg))
    p = QPainter(canvas)
    p.setRenderHint(QPainter.RenderHint.Antialiasing)
    p.setPen(QPen(QColor(ink), 2))
    p.drawRoundedRect(QRectF(32, 32, 536, 786), 220, 220)
    p.setFont(QFont("Roboto Flex", 11))
    p.drawText(QRectF(55, 65, 490, 35), Qt.AlignmentFlag.AlignCenter, "F L Y L E A F   E D I T I O N S")
    sun = QColor(ink); sun.setAlpha(120)
    p.setPen(Qt.PenStyle.NoPen); p.setBrush(sun)
    p.drawEllipse(QRectF(150, 145, 300, 300))
    p.setPen(QPen(QColor(ink), 3)); p.setBrush(Qt.BrushStyle.NoBrush)
    for offset in (0, 45):
        curve = QPainterPath(); curve.moveTo(110, 430 + offset)
        curve.cubicTo(285, 100 + offset, 320, 330 + offset, 490, 430 + offset)
        p.drawPath(curve)
    p.drawLine(95, 490, 505, 490)
    font = QFont("Roboto Flex", 34); font.setWeight(QFont.Weight.Medium)
    p.setFont(font)
    p.drawText(QRectF(85, 520, 430, 205), Qt.AlignmentFlag.AlignCenter | Qt.TextFlag.TextWordWrap, title)
    p.setFont(QFont("Roboto Flex", 11))
    p.drawText(QRectF(65, 745, 470, 35), Qt.AlignmentFlag.AlignCenter, "ELENA ROWE" if index == 0 else "OLIVER FINCH")
    p.end()
    buffer = QBuffer(); buffer.open(QIODevice.OpenModeFlag.WriteOnly)
    canvas.save(buffer, "PNG")
    return bytes(buffer.data())


def main():
    app = QApplication.instance() or QApplication([])
    fixture = Fixture()
    fixture.capabilities["durableProgress"] = 1
    fixture.annotations = [{"id": 1, "kind": "bookmark", "page": 0, "locator": "0", "note": "A fictional private reading note for this preview.", "text": "A quiet place to read."}]
    fixture.user["permissions"]["contentFinder"] = True
    fixture.finder_sources = [{"id": "sample", "name": "Flyleaf Editions", "kinds": ["comics"], "canBrowse": True}]
    for index, title in enumerate(["A Map of Small Things", "Where the Light Goes", "Letters to the Moon", "The Last Bookshop", "Field Notes"], 2):
        fixture.catalog.append({**fixture.series, "id": index, "name": title, "authors": ["Oliver Finch"], "coverUrl": f"/api/series/{index}/cover"})
    output = DESKTOP / "build" / "screenshots"
    output.mkdir(parents=True, exist_ok=True)
    settings = QSettings(str(output / "preview.ini"), QSettings.Format.IniFormat)
    settings.clear()
    window = MainWindow(settings)
    for index, series in enumerate(fixture.catalog):
        fixture.cover_images[series["coverUrl"]] = fictional_cover(series["name"], index)
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
        window.reader.companion_tools.show_history()
        wait(lambda: window.reader.companion_tools.history.items.count() == 1)
        window.reader.companion_tools.history.grab().save(str(output / "position-history.png"))
        window.reader.companion_tools.history.hide()
        window.reader.flush_progress()
        wait(lambda: not window.reader.has_unsaved_changes)
        window._return_to_library()
        window.library.sidebar.setCurrentRow(3)
        wait(lambda: window.library.finder.sources.count() == 1)
        window.library.finder.sources.setCurrentRow(0)
        wait(lambda: window.library.finder.results.count() == 2)
        window.library.finder.results.setCurrentRow(0)
        wait(lambda: window.library.finder.files.count() == 2)
        capture("content-finder")
        fixture.finder_downloads = [{"id": 1, "title": "The Night Garden", "fileTitle": "Volume 2", "status": "downloading", "received": 24, "total": 40, "library": "Comics"}, {"id": 2, "title": "A Map of Small Things", "status": "failed", "error": "The source is temporarily unavailable. Retry when it returns.", "library": "Comics"}]
        window.library.finder.tabs.setCurrentIndex(1)
        wait(lambda: window.library.finder.activity.downloads.count() == 2)
        window.library.finder.activity.downloads.setCurrentRow(1)
        capture("content-finder-downloads")
        window.library.sidebar.setCurrentRow(0)
        window.appearance.configure(ui_scale=1.25)
        capture("library-interface-125")
        window.appearance.configure(ui_scale=1.0)
        window.appearance.configure(theme="light")
        wait(lambda: window.library.grid.count() == 6 and not window.library._covers and window.library._cover_active == 0)
        window.library.grid.setCurrentRow(0)
        wait(lambda: window.library.books.count() == 1)
        capture("library-light")
        window.download_current()
        wait(lambda: not window.downloads.active)
        window.offline_dialog.grab().save(str(output / "offline-sync.png"))
        window.offline_dialog.hide()
        window.show_annotations()
        wait(lambda: window.annotations_dialog.items.count() == 1)
        window.annotations_dialog.items.setCurrentRow(0)
        window.annotations_dialog.grab().save(str(output / "annotation-search.png"))
        window.annotations_dialog.hide()
        window.appearance.configure(theme="dark")
        window.show_account()
        capture("account")
        window._leave_account()
        window.library.filter_dialog.show()
        QTest.qWait(100)
        window.library.filter_dialog.grab().save(str(output / "filters.png"))
        window.library.filter_dialog.hide()
        window.create_account.configure(setup=True)
        window.stack.setCurrentWidget(window.create_account)
        capture("server-setup")
        window.create_account.configure(invite=True)
        capture("registration")
        window.recovery.populate({"book": fixture.book, "page": 1, "pending": True})
        window.stack.setCurrentWidget(window.recovery)
        capture("recovery")
        window.appearance.configure(theme="light")
        window.stack.setCurrentWidget(window.welcome)
        window.resize(820, 600)
        capture("welcome-small")
        window.resize(820, 640)
        window.stack.setCurrentWidget(window.library)
        capture("library-small")
        window.show_account()
        capture("account-small")
        print(f"Native Qt screenshots: {output}")
    finally:
        if window.reader:
            window.reader.dispose()
        window.close()
        fixture.close()


if __name__ == "__main__":
    main()
