from collections.abc import Callable
from datetime import date

from PySide6.QtCore import Qt, QTimer
from PySide6.QtGui import QKeySequence, QPixmap, QShortcut
from PySide6.QtWidgets import (
    QComboBox, QHBoxLayout, QInputDialog, QPushButton, QScrollArea, QVBoxLayout, QWidget,
)

from .api import ApiError, FlyleafApi
from .widgets import decode_image, label, text

IMAGE_FORMATS = frozenset({"cbz", "cbr", "cb7", "cbt", "folder"})


class ImageReader(QWidget):
    """Native image reader; saves only acknowledged displayed pages, never attempted pages."""

    def __init__(self, api: FlyleafApi, data: dict, leave: Callable[[], None]):
        super().__init__()
        self.api = api
        self.book = data["book"]
        self.leave = leave
        self.page = 0
        self.total = 0
        self._generation = 0
        self._disposed = False
        self._image = None
        self._pending: int | None = None
        self._saving = False
        self._after_save: Callable[[], None] | None = None
        self._last_saved: int | None = None
        self.setFocusPolicy(Qt.FocusPolicy.StrongFocus)
        layout = QVBoxLayout(self)
        layout.setContentsMargins(12, 8, 12, 8)
        toolbar = QHBoxLayout()
        self.back = QPushButton("Back to library")
        self.back.clicked.connect(lambda: self.request_leave(self.leave))
        toolbar.addWidget(self.back)
        title = label(text(self.book.get("title"), "Reading"))
        title.setAccessibleName("Book title")
        toolbar.addWidget(title, 1)
        self.direction = QComboBox()
        self.direction.setAccessibleName("Reading direction")
        self.direction.addItem("Left to right", "ltr")
        self.direction.addItem("Right to left", "rtl")
        settings = data.get("settings") or {}
        rtl = settings.get("direction") == "rtl" or (settings.get("direction", "auto") == "auto" and self.book.get("kind") == "manga")
        self.direction.setCurrentIndex(1 if rtl else 0)
        toolbar.addWidget(self.direction)
        self.zoom = QComboBox()
        self.zoom.setAccessibleName("Page size")
        for title, value in [("Fit page", "page"), ("Fit width", "width"), ("100%", 1.0), ("150%", 1.5), ("200%", 2.0)]:
            self.zoom.addItem(title, value)
        self.zoom.currentIndexChanged.connect(self._render)
        toolbar.addWidget(self.zoom)
        layout.addLayout(toolbar)
        self.page_notice = label("Loading page count…", wrap=True)
        self.page_notice.setObjectName("pageNotice")
        layout.addWidget(self.page_notice)
        self.scroll = QScrollArea()
        self.scroll.setAlignment(Qt.AlignmentFlag.AlignCenter)
        self.scroll.setWidgetResizable(False)
        self.canvas = label("Loading…", wrap=True)
        self.canvas.setObjectName("pageCanvas")
        self.canvas.setAlignment(Qt.AlignmentFlag.AlignCenter)
        self.canvas.resize(500, 200)
        self.scroll.setWidget(self.canvas)
        layout.addWidget(self.scroll, 1)
        self.retry_page = QPushButton("Retry loading page")
        self.retry_page.clicked.connect(self.retry_loading)
        self.retry_page.hide()
        layout.addWidget(self.retry_page)
        navigation = QHBoxLayout()
        self.previous = QPushButton("Previous page")
        self.previous.clicked.connect(lambda: self.move(-1))
        self.next = QPushButton("Next page")
        self.next.clicked.connect(lambda: self.move(1))
        self.position = QPushButton("Loading…")
        self.position.setAccessibleName("Current page; choose to go to a page")
        self.position.clicked.connect(self.go_to_page)
        navigation.addWidget(self.previous)
        navigation.addStretch()
        navigation.addWidget(self.position)
        navigation.addStretch()
        navigation.addWidget(self.next)
        layout.addLayout(navigation)
        sync = QHBoxLayout()
        self.sync_notice = label("Progress is saved to this server while connected.", wrap=True)
        self.sync_notice.setObjectName("syncNotice")
        sync.addWidget(self.sync_notice, 1)
        self.retry_save = QPushButton("Retry saving")
        self.retry_save.clicked.connect(self.flush_progress)
        self.retry_save.hide()
        sync.addWidget(self.retry_save)
        self.discard_save = QPushButton("Leave without saving")
        self.discard_save.clicked.connect(self._discard_and_leave)
        self.discard_save.hide()
        sync.addWidget(self.discard_save)
        layout.addLayout(sync)
        self.save_timer = QTimer(self)
        self.save_timer.setSingleShot(True)
        self.save_timer.setInterval(500)
        self.save_timer.timeout.connect(self.flush_progress)
        self.shortcuts: list[QShortcut] = []
        for key, callback in [
            (Qt.Key.Key_Right, lambda: self.move(-1 if self.direction.currentData() == "rtl" else 1)),
            (Qt.Key.Key_Left, lambda: self.move(1 if self.direction.currentData() == "rtl" else -1)),
            (Qt.Key.Key_PageDown, lambda: self.move(1)), (Qt.Key.Key_PageUp, lambda: self.move(-1)),
            (Qt.Key.Key_Home, lambda: self.show_page(0)), (Qt.Key.Key_End, lambda: self.show_page(self.total - 1)),
        ]:
            shortcut = QShortcut(QKeySequence(key), self)
            shortcut.setContext(Qt.ShortcutContext.WidgetWithChildrenShortcut)
            shortcut.activated.connect(callback)
            self.shortcuts.append(shortcut)
        self._navigation()
        self.load_pages()

    def load_pages(self) -> None:
        self.retry_page.hide()
        self.page_notice.setText("Loading page count…")
        self.api.json("GET", f"/api/books/{self.book['id']}/pages", self._pages_loaded, self._load_failed)

    def retry_loading(self) -> None:
        self.show_page(self.page) if self.total else self.load_pages()

    def _pages_loaded(self, data: object) -> None:
        if self._disposed:
            return
        if not isinstance(data, dict) or not isinstance(data.get("count"), int) or data["count"] <= 0:
            self._load_failed(ApiError("This book has no readable image pages."))
            return
        self.total = data["count"]
        progress = self.book.get("progress") or {}
        page = progress.get("page")
        if not isinstance(page, int):
            page = int(float(progress.get("percent") or 0) * max(0, self.total - 1))
        self.show_page(min(max(0, page), self.total - 1))

    def show_page(self, page: int) -> None:
        if self._disposed or not self.total or not 0 <= page < self.total:
            return
        self.page = page
        self._generation += 1
        generation = self._generation
        self._image = None
        self.canvas.clear()
        self.canvas.setText("Loading…")
        self.page_notice.setText(f"Loading page {page + 1}…")
        self.retry_page.hide()
        self._navigation()
        path = f"/api/books/{self.book['id']}/pages/{page}?w=2000"

        def loaded(payload: bytes) -> None:
            if self._disposed or generation != self._generation:
                return
            try:
                image = decode_image(payload)
            except ValueError as error:
                self._load_failed(ApiError(str(error)), generation)
                return
            self._image = image
            self.page_notice.setText("Arrow keys follow reading direction; Page Up / Page Down move through the book. F11 toggles fullscreen.")
            self._render()
            self.scroll.verticalScrollBar().setValue(0)
            self.scroll.horizontalScrollBar().setValue(0)
            if page != self._last_saved:
                self._pending = page
                self.sync_notice.setText("Position changed · waiting to save…")
                self.save_timer.start()
        self.api.image(path, loaded, lambda error: self._load_failed(error, generation), page=True)

    def _load_failed(self, error: ApiError, generation: int | None = None) -> None:
        if self._disposed or (generation is not None and generation != self._generation):
            return
        self.page_notice.setText(error.message)
        self.canvas.clear()
        self.canvas.setText("This page could not be loaded. Your last displayed page remains the saved reading position.")
        self.canvas.resize(540, 140)
        self.retry_page.setText("Retry loading page" if self.total else "Retry page list")
        self.retry_page.show()

    def move(self, offset: int) -> None:
        self.show_page(self.page + offset)

    def go_to_page(self) -> None:
        if not self.total:
            return
        number, accepted = QInputDialog.getInt(self, "Go to page", "Page", self.page + 1, 1, self.total)
        if accepted:
            self.show_page(number - 1)

    def _navigation(self) -> None:
        self.previous.setEnabled(self.total > 0 and self.page > 0)
        self.next.setEnabled(self.total > 0 and self.page + 1 < self.total)
        self.position.setText(f"Page {self.page + 1} of {self.total}" if self.total else "Loading…")
        self.position.setEnabled(self.total > 0)

    def _render(self, *_args) -> None:
        if self._image is None or self._disposed:
            return
        size = self._image.size()
        viewport = self.scroll.viewport().size()
        mode = self.zoom.currentData()
        if mode == "page":
            size.scale(max(1, viewport.width() - 16), max(1, viewport.height() - 16), Qt.AspectRatioMode.KeepAspectRatio)
        elif mode == "width":
            size.scale(max(1, viewport.width() - 16), 100_000, Qt.AspectRatioMode.KeepAspectRatio)
        else:
            size *= float(mode)
        pixmap = QPixmap.fromImage(self._image).scaled(size, Qt.AspectRatioMode.KeepAspectRatio, Qt.TransformationMode.SmoothTransformation)
        self.canvas.setPixmap(pixmap)
        self.canvas.setAccessibleName(f"Page {self.page + 1} of {self.total}")
        self.canvas.resize(pixmap.size())

    def resizeEvent(self, event) -> None:
        super().resizeEvent(event)
        QTimer.singleShot(0, self._render)

    @property
    def has_unsaved_changes(self) -> bool:
        return self._saving or self._pending is not None

    def flush_progress(self) -> None:
        if self._disposed or self._saving:
            return
        self.save_timer.stop()
        if self._pending is None:
            if self._after_save:
                callback, self._after_save = self._after_save, None
                callback()
            return
        page, self._pending = self._pending, None
        self._saving = True
        self.retry_save.hide()
        self.discard_save.hide()
        self.sync_notice.setText("Saving position to the server…")
        # No active-time deltas yet: retrying a position must not double-count reading time.
        body = {"page": page, "percent": (page + 1) / self.total, "day": date.today().isoformat()}

        def saved(_data: object) -> None:
            if self._disposed:
                return
            self._saving = False
            self._last_saved = page
            self.sync_notice.setText("Position saved to the server")
            if self._pending is not None or self._after_save:
                self.flush_progress()

        def failed(error: ApiError) -> None:
            if self._disposed:
                return
            self._saving = False
            if self._pending is None:
                self._pending = page
            self.sync_notice.setText("Position not saved: " + error.message)
            self.retry_save.show()
            if self._after_save:
                self.discard_save.show()
        self.api.json("PUT", f"/api/books/{self.book['id']}/progress", saved, failed, body)

    def request_leave(self, callback: Callable[[], None]) -> None:
        self._after_save = callback
        self.flush_progress()

    def _discard_and_leave(self) -> None:
        if self._after_save:
            callback, self._after_save = self._after_save, None
            self._pending = None
            callback()

    def dispose(self) -> None:
        self._disposed = True
        self._generation += 1
        self.save_timer.stop()
        self._image = None
