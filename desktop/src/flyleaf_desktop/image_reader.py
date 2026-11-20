from collections.abc import Callable
from datetime import date

from PySide6.QtCore import Qt, QTimer, QEvent
from PySide6.QtGui import QPixmap, QShortcut
from PySide6.QtWidgets import (
    QComboBox, QHBoxLayout, QInputDialog, QPushButton, QScrollArea, QVBoxLayout, QWidget, QFrame, QSizePolicy, QToolButton, QMenu,
)

from .api import ApiError, FlyleafApi
from .widgets import decode_image, label, text
from .material import symbol

IMAGE_FORMATS = frozenset({"cbz", "cbr", "cb7", "cbt", "folder"})


class ImageReader(QWidget):
    """Native image reader; saves only acknowledged displayed pages, never attempted pages."""

    def __init__(self, api: FlyleafApi, data: dict, leave: Callable[[], None]):
        super().__init__()
        self.api = api
        self.settings = dict(data.get("settings") or {})
        self.book = data["book"]
        self.leave = leave
        self.page = 0
        self.total = 0
        self._generation = 0
        self._disposed = False
        self._image = None
        self._pending: int | None = None
        self._saving = False
        self._saving_page = None
        self._after_save: Callable[[], None] | None = None
        self._last_saved: int | None = None
        self.setFocusPolicy(Qt.FocusPolicy.StrongFocus)
        layout = QVBoxLayout(self)
        layout.setContentsMargins(12, 8, 12, 8)
        toolbar_surface = QFrame()
        toolbar_surface.setObjectName("readerToolbar")
        toolbar = QHBoxLayout(toolbar_surface)
        toolbar.setContentsMargins(16, 10, 16, 10)
        self.back = QPushButton("Back to library")
        self.back.setProperty("kind", "text")
        self.back.setIcon(symbol("back"))
        self.back.clicked.connect(lambda: self.request_leave(self.leave))
        toolbar.addWidget(self.back)
        title = label(text(self.book.get("title"), "Reading"))
        title.setSizePolicy(QSizePolicy.Policy.Ignored, QSizePolicy.Policy.Fixed)
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
        layout.addWidget(toolbar_surface)
        self.page_notice = label("Loading page count…", wrap=True)
        self.page_notice.setObjectName("pageNotice")
        layout.addWidget(self.page_notice)
        self.scroll = QScrollArea()
        self.scroll.setAlignment(Qt.AlignmentFlag.AlignCenter)
        self.scroll.setWidgetResizable(False)
        self.canvas = self.create_canvas()
        self.canvas.setObjectName("pageCanvas")
        self.canvas.setAlignment(Qt.AlignmentFlag.AlignCenter)
        self.canvas.resize(500, 200)
        self.scroll.setWidget(self.canvas)
        layout.addWidget(self.scroll, 1)
        self.retry_page = QPushButton("Retry loading page")
        self.retry_page.clicked.connect(self.retry_loading)
        self.retry_page.hide()
        layout.addWidget(self.retry_page)
        navigation_surface = QFrame()
        navigation_surface.setObjectName("readerNavigation")
        navigation = QHBoxLayout(navigation_surface)
        navigation.setContentsMargins(12, 10, 12, 10)
        self.previous = QPushButton("Previous page")
        self.previous.setIcon(symbol("back"))
        self.previous.clicked.connect(lambda: self.move(-1))
        self.next = QPushButton("Next page")
        self.next.setProperty("primary", True)
        self.next.setIcon(symbol("arrow", "onPrimary"))
        self.next.clicked.connect(lambda: self.move(1))
        self.position = QPushButton("Loading…")
        self.position.setAccessibleName("Current page; choose to go to a page")
        self.position.clicked.connect(self.go_to_page)
        navigation.addWidget(self.previous)
        navigation.addStretch()
        navigation.addWidget(self.position)
        navigation.addStretch()
        navigation.addWidget(self.next)
        layout.addWidget(navigation_surface)
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
        from .reader_keys import page_keys
        motions = {
            "pageRight": lambda: self.move(-1 if self.direction.currentData() == "rtl" else 1),
            "pageLeft": lambda: self.move(1 if self.direction.currentData() == "rtl" else -1),
            "next": lambda: self.move(1), "prev": lambda: self.move(-1),
            "first": lambda: self.show_page(0), "last": lambda: self.show_page(self.total - 1),
        }
        used = set()
        for action, sequence in page_keys(data.get("keybinds")):
            key = sequence.toString()
            if key in used:
                continue
            used.add(key)
            shortcut = QShortcut(sequence, self)
            shortcut.setContext(Qt.ShortcutContext.WidgetWithChildrenShortcut)
            shortcut.activated.connect(motions[action])
            self.shortcuts.append(shortcut)
        self._navigation()
        from .reader_tools import ReaderTools
        self.companion_tools = ReaderTools(self, data)
        self.annotation_badge = QToolButton(self.scroll.viewport())
        self.annotation_badge.setIcon(symbol("bookmark"))
        self.annotation_badge.setAccessibleName("Annotations on the visible page")
        self.annotation_badge.clicked.connect(self.companion_tools.show)
        self.annotation_badge.hide()
        companion_button = QToolButton()
        companion_button.setText("Tools")
        companion_button.setAccessibleName("Reader tools")
        companion_button.setPopupMode(QToolButton.ToolButtonPopupMode.InstantPopup)
        self.reader_menu = QMenu(companion_button)
        self.reader_menu.addAction("Bookmarks, notes & profile", self.companion_tools.show)
        companion_button.setMenu(self.reader_menu)
        toolbar.addWidget(companion_button)
        self.load_pages()

    def create_canvas(self):
        return label("Loading…", wrap=True)

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
                self._checkpoint()
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
        ratio = self.devicePixelRatioF()
        physical = size * ratio
        if physical.width() * physical.height() > 24_000_000:
            physical.scale(4800, 4800, Qt.AspectRatioMode.KeepAspectRatio)
        pixmap = QPixmap.fromImage(self._image).scaled(physical, Qt.AspectRatioMode.KeepAspectRatio, Qt.TransformationMode.SmoothTransformation)
        pixmap.setDevicePixelRatio(ratio)
        self.canvas.setPixmap(pixmap)
        self.canvas.setAccessibleName(f"Page {self.page + 1} of {self.total}")
        self.canvas.resize(size)
        self._sync_annotation_badge()

    def _sync_annotation_badge(self):
        if not hasattr(self, "annotation_badge"):
            return
        pages = getattr(self, "_visible_pages", ()) or (self.page,)
        if getattr(self, "_layout_mode", "single") == "webtoon":
            pages = (self.page,)
        count = sum(annotation.get("page") in pages for annotation in self.companion_tools.annotations)
        if getattr(self, "_reflowable", False):
            count = len((getattr(self, "_page_metadata", {}).get(self.page) or {}).get("activeAnnotations", []))
        self.annotation_badge.setText(str(count))
        self.annotation_badge.setToolTip(f"{count} bookmarks / highlights on this page. Open notes.")
        self.annotation_badge.adjustSize()
        self.annotation_badge.move(max(8, self.scroll.viewport().width() - self.annotation_badge.width() - 16), 12)
        self.annotation_badge.setVisible(count > 0)
        self.annotation_badge.raise_()

    def resizeEvent(self, event) -> None:
        super().resizeEvent(event)
        QTimer.singleShot(0, self._render)

    def changeEvent(self, event):
        super().changeEvent(event)
        if event.type() == QEvent.Type.DevicePixelRatioChange:
            QTimer.singleShot(0, self._render)

    def current_locator(self):
        return str(self.page)

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
        self._saving_page = page
        self.retry_save.hide()
        self.discard_save.hide()
        self.sync_notice.setText("Saving position to the server…")
        # The durable service attaches sampled time with immutable receipt IDs.
        body = self.progress_body(page)

        def saved(_data: object) -> None:
            if self._disposed:
                return
            self._saving = False
            self._saving_page = None
            self._last_saved = page
            self.sync_notice.setText("Saved on this device · pending sync" if isinstance(_data, dict) and _data.get("queued") else "Position saved to the server")
            if self._pending is not None or self._after_save:
                self.flush_progress()

        def failed(error: ApiError) -> None:
            if self._disposed:
                return
            self._saving = False
            self._saving_page = None
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

    def progress_body(self, page):
        return {"page": page, "percent": (page + 1) / self.total, "day": date.today().isoformat(), "version": self.book.get("version")}

    def _checkpoint(self):
        service = getattr(self.api, "reliability", None)
        if not service or not service.enabled or not service.scope or self._pending is None:
            return
        if getattr(self, "_reflowable", False):
            position = self._locators.get(self._pending)
            if not position or not self._writes_enabled:
                return
            body = {"position": position, "percent": (self._pending + 1) / self.total, "version": self.book.get("version")}
        else:
            body = self.progress_body(self._pending)
        try:
            service.store.stage(service.scope, self.book["id"], body)
        except Exception as error:
            self.sync_notice.setText("Device checkpoint failed: " + str(error))

    def _discard_and_leave(self) -> None:
        if self._after_save:
            callback, self._after_save = self._after_save, None
            self._pending = None
            callback()

    def dispose(self) -> None:
        if not self._disposed:
            if hasattr(self, "active_clock"):
                self.active_clock.stop()
            service = getattr(self.api, "reliability", None)
            if service:
                service.capture(self)
        self._disposed = True
        self._generation += 1
        self.save_timer.stop()
        self._image = None
        if hasattr(self, "companion_tools"):
            if hasattr(self.companion_tools, "history"):
                self.companion_tools.history.close()
            self.companion_tools.close()
