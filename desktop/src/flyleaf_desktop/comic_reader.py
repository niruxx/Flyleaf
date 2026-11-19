"""Bounded native comic spreads, split pages, image filters and virtual webtoon flow."""
from collections import OrderedDict
from PySide6.QtCore import Qt, QTimer
from PySide6.QtGui import QImage, QPainter, QPixmap
from PySide6.QtWidgets import (QCheckBox, QComboBox, QDialog, QFormLayout, QPushButton,
    QSpinBox, QVBoxLayout, QWidget, QLabel, QScrollArea)
from .api import ApiError
from .image_reader import ImageReader
from .widgets import decode_image, label

CACHE_BYTES = 48 * 1024 * 1024


class ComicReader(ImageReader):
    def __init__(self, api, data, leave):
        self._cache = OrderedDict()
        self._cache_bytes = 0
        self._visible_pages = ()
        self._split_part = 0
        self._split_page = None
        self._fraction = {}
        self._history = []
        self._stream = []
        self._stream_busy = False
        self._original = False
        self._layout_mode = (data.get("settings") or {}).get("layout", "single")
        super().__init__(api, data, leave)
        self.options = QDialog(self)
        self.options.setWindowTitle("Reader layout")
        self.options.resize(520, 620)
        option_layout = QVBoxLayout(self.options)
        option_scroll = QScrollArea()
        option_scroll.setWidgetResizable(True)
        host = QWidget()
        form = QFormLayout(host)
        option_scroll.setWidget(host)
        option_layout.addWidget(option_scroll)
        self.layout_choice = QComboBox()
        for caption, value in [("Single page", "single"), ("Smart two-page spreads", "double"), ("Continuous / webtoon", "webtoon")]:
            self.layout_choice.addItem(caption, value)
        form.addRow("Layout", self.layout_choice)
        self.cover_alone = QCheckBox("Show the cover on its own")
        self.smart_spreads = QCheckBox("Keep wide pages on their own")
        form.addRow(self.cover_alone); form.addRow(self.smart_spreads)
        self.split = QComboBox()
        for caption, value in [("Do not split", "none"), ("Split wide pages", "split"), ("Split in reverse order", "split-reverse")]:
            self.split.addItem(caption, value)
        form.addRow("Wide-page handling", self.split)
        self.crop = QCheckBox("Trim white page borders")
        self.original = QCheckBox("Request original-resolution pages")
        form.addRow(self.crop); form.addRow(self.original)
        self.effect = QComboBox()
        for caption, value in [("Original colors", "none"), ("Greyscale", "grey"), ("Sepia paper", "sepia"), ("Invert", "invert"), ("Whiten paper", "white")]:
            self.effect.addItem(caption, value)
        form.addRow("Paper / image filter", self.effect)
        self.brightness = QSpinBox(); self.brightness.setRange(30, 180); self.brightness.setSuffix("%")
        self.contrast = QSpinBox(); self.contrast.setRange(30, 180); self.contrast.setSuffix("%")
        form.addRow("Brightness", self.brightness); form.addRow("Contrast", self.contrast)
        self.auto_speed = QSpinBox(); self.auto_speed.setRange(1, 10)
        form.addRow("Auto-scroll speed", self.auto_speed)
        self.auto_scroll = QCheckBox("Auto-scroll while this reader is visible")
        self.auto_scroll.toggled.connect(self._auto_toggled)
        form.addRow(self.auto_scroll)
        apply_button = QPushButton("Apply")
        apply_button.setProperty("primary", True)
        apply_button.clicked.connect(self.apply_options)
        form.addRow(apply_button)
        save = QPushButton("Save these settings for this series")
        save.setEnabled(type(self.book.get("seriesId")) is int)
        save.clicked.connect(self.save_series_settings)
        form.addRow(save)
        self.option_notice = label("", wrap=True)
        form.addRow(self.option_notice)
        self.reader_menu.addAction("Layout, filters & auto-scroll", self.options.show)
        self.auto_timer = QTimer(self)
        self.auto_timer.setInterval(30)
        self.auto_timer.timeout.connect(self._scroll_tick)
        self.stream_widget = QWidget()
        self.stream_layout = QVBoxLayout(self.stream_widget)
        self.stream_layout.setContentsMargins(0, 0, 0, 0)
        self.stream_layout.setSpacing(8)
        self.scroll.verticalScrollBar().valueChanged.connect(self._stream_position)
        self.apply_reader_settings(self.settings, reload=False)
        if self._layout_mode != "single":
            self.apply_options()

    def apply_reader_settings(self, settings, reload=True):
        self.settings.update(settings)
        self.layout_choice.setCurrentIndex(max(0, self.layout_choice.findData(settings.get("layout", "single"))))
        self.cover_alone.setChecked(settings.get("coverAlone", True))
        self.smart_spreads.setChecked(settings.get("smartSpreads", True))
        self.split.setCurrentIndex(max(0, self.split.findData(settings.get("pageSplit", "none"))))
        self.crop.setChecked(settings.get("autoCrop", False))
        effect = "invert" if settings.get("filterInvert") else "grey" if settings.get("filterGreyscale") else "white" if settings.get("whitenPaper") else "none"
        self.effect.setCurrentIndex(max(0, self.effect.findData(effect)))
        self.brightness.setValue(max(30, min(180, int(settings.get("filterBrightness", 100)))))
        self.contrast.setValue(max(30, min(180, int(settings.get("filterContrast", 100)))))
        self.auto_speed.setValue(max(1, min(10, int(settings.get("autoScrollSpeed", 3)))))
        if reload:
            self.apply_options()

    def reader_settings(self):
        return {**self.settings, "layout": self.layout_choice.currentData(), "coverAlone": self.cover_alone.isChecked(),
                "smartSpreads": self.smart_spreads.isChecked(), "pageSplit": self.split.currentData(),
                "autoCrop": self.crop.isChecked(), "filterBrightness": self.brightness.value(),
                "filterContrast": self.contrast.value(), "filterGreyscale": self.effect.currentData() == "grey",
                "filterInvert": self.effect.currentData() == "invert", "whitenPaper": self.effect.currentData() == "white",
                "autoScrollSpeed": self.auto_speed.value(), "direction": self.direction.currentData()}

    def save_series_settings(self):
        if type(self.book.get("seriesId")) is not int:
            return
        self.apply_options()
        self.api.json("PUT", f"/api/series/{self.book['seriesId']}/reader-settings", lambda _data: self.option_notice.setText("Saved for this series.") if not self._disposed else None,
                      lambda error: self.option_notice.setText(error.message) if not self._disposed else None, {"settings": self.reader_settings()})

    def apply_options(self):
        self.settings = self.reader_settings()
        self._original = self.original.isChecked()
        self._layout_mode = self.layout_choice.currentData()
        self._split_part = 0
        self._cache.clear(); self._cache_bytes = 0
        self._generation += 1
        for entry in self._stream:
            self.stream_layout.removeWidget(entry["label"])
            entry["label"].deleteLater()
        self._stream.clear(); self._stream_busy = False
        current = self.scroll.takeWidget()
        if current is not None:
            current.setParent(self); current.hide()
        if self._layout_mode == "webtoon":
            self.scroll.setWidget(self.stream_widget)
            self.scroll.setWidgetResizable(True)
            self.zoom.setCurrentIndex(1)
        else:
            self.scroll.setWidget(self.canvas)
            self.scroll.setWidgetResizable(False)
        self.show_page(self.page)

    def _get(self, page, token, done):
        cached = self._cache.get(page)
        if cached is not None:
            self._cache.move_to_end(page); done(cached); return
        suffix = "" if self._original else "?w=2000"
        def loaded(payload):
            if self._disposed or token != self._generation:
                return
            try:
                image = decode_image(payload)
            except ValueError as error:
                self._load_failed(ApiError(str(error)), token); self._stream_busy = False; return
            size = image.sizeInBytes()
            while self._cache and self._cache_bytes + size > CACHE_BYTES:
                _, removed = self._cache.popitem(last=False); self._cache_bytes -= removed.sizeInBytes()
            if size <= CACHE_BYTES:
                self._cache[page] = image; self._cache_bytes += size
            done(image)
        self.api.image(f"/api/books/{self.book['id']}/pages/{page}{suffix}", loaded,
                       lambda error: (setattr(self, "_stream_busy", False), self._load_failed(error, token)), page=True)

    def _filter(self, image):
        effect = self.effect.currentData() if hasattr(self, "effect") else "none"
        brightness = self.brightness.value() if hasattr(self, "brightness") else 100
        contrast = self.contrast.value() if hasattr(self, "contrast") else 100
        crop = self.crop.isChecked() if hasattr(self, "crop") else False
        if effect == "none" and brightness == contrast == 100 and not crop:
            return image
        from PIL import Image, ImageEnhance, ImageOps, ImageChops
        native = image.convertToFormat(QImage.Format.Format_RGBA8888)
        picture = Image.frombytes("RGBA", (native.width(), native.height()), bytes(native.bits())).convert("RGB")
        if crop:
            difference = ImageChops.difference(picture, Image.new("RGB", picture.size, "white"))
            box = difference.point(lambda p: 255 if p > 18 else 0).getbbox()
            if box:
                picture = picture.crop(box)
        if effect == "grey":
            picture = ImageOps.grayscale(picture).convert("RGB")
        elif effect == "sepia":
            picture = ImageOps.colorize(ImageOps.grayscale(picture), "#32271b", "#f5e6c8")
        elif effect == "invert":
            picture = ImageOps.invert(picture)
        elif effect == "white":
            picture = ImageOps.autocontrast(picture, cutoff=1)
        if brightness != 100:
            picture = ImageEnhance.Brightness(picture).enhance(brightness / 100)
        if contrast != 100:
            picture = ImageEnhance.Contrast(picture).enhance(contrast / 100)
        picture = picture.convert("RGBA")
        return QImage(picture.tobytes(), picture.width, picture.height, QImage.Format.Format_RGBA8888).copy()

    def show_page(self, page):
        if not hasattr(self, "options"):
            return super().show_page(page)
        if self._disposed or not self.total or not 0 <= page < self.total:
            return
        if self._layout_mode == "webtoon":
            self._start_stream(page); return
        self.page = page; self._generation += 1; token = self._generation
        self._image = None; self.retry_page.hide()
        self.page_notice.setText("Loading pages…")
        self._navigation()
        def first(image):
            wide = image.width() > image.height() * 1.2
            split = self.split.currentData() != "none" and wide
            self._split_page = page if split else None
            if split:
                reverse = (self.direction.currentData() == "rtl") ^ (self.split.currentData() == "split-reverse")
                side = 1 - self._split_part if reverse else self._split_part
                left = image.width() // 2
                part = image.copy(left if side else 0, 0, image.width() - left if side else left, image.height())
                self._fraction[page] = (self._split_part + 1) / 2
                self._display([part], (page,), token)
                return
            self._fraction[page] = 1
            pair = self._layout_mode == "double" and not (page == 0 and self.cover_alone.isChecked()) and not (wide and self.smart_spreads.isChecked()) and page + 1 < self.total
            if not pair:
                self._display([image], (page,), token); return
            def second(other):
                if self.smart_spreads.isChecked() and other.width() > other.height() * 1.2:
                    self._display([image], (page,), token)
                else:
                    images = [other, image] if self.direction.currentData() == "rtl" else [image, other]
                    self._display(images, (page, page + 1), token)
            self._get(page + 1, token, second)
        self._get(page, token, first)

    def _display(self, images, pages, token):
        if token != self._generation or self._disposed:
            return
        try:
            images = [self._filter(image) for image in images]
        except Exception as error:
            self._load_failed(ApiError("Image filter unavailable: " + str(error)), token); return
        if len(images) == 1:
            self._image = images[0]
        else:
            height = min(3000, max(image.height() for image in images))
            scaled = [image.scaledToHeight(height, Qt.TransformationMode.SmoothTransformation) for image in images]
            self._image = QImage(sum(image.width() for image in scaled), height, QImage.Format.Format_RGB32)
            self._image.fill(Qt.GlobalColor.black)
            painter = QPainter(self._image); x = 0
            for image in scaled:
                painter.drawImage(x, 0, image); x += image.width()
            painter.end()
        self._visible_pages = pages
        self._navigation()
        self._render()
        self.scroll.verticalScrollBar().setValue(0)
        self.page_notice.setText("Pages " + "–".join(str(p + 1) for p in pages) + f" of {self.total}")
        self._pending = pages[-1]
        self._checkpoint()
        self.sync_notice.setText("Position changed · waiting to save…")
        self.save_timer.start()

    def move(self, offset):
        if self._layout_mode == "webtoon":
            self._start_stream(min(self.total - 1, max(0, self.page + offset))); return
        if self._split_page == self.page:
            if offset > 0 and self._split_part == 0:
                self._split_part = 1; self.show_page(self.page); return
            if offset < 0 and self._split_part == 1:
                self._split_part = 0; self.show_page(self.page); return
        self._split_part = 0
        if offset > 0:
            target = self.page + max(1, len(self._visible_pages))
            if target < self.total:
                self._history.append(self.page); self.show_page(target)
        else:
            self.show_page(self._history.pop() if self._history else max(0, self.page - 1))

    def _navigation(self):
        super()._navigation()
        if not hasattr(self, "split") or self._layout_mode == "webtoon":
            return
        split = self._split_page == self.page
        self.previous.setEnabled(self.page > 0 or split and self._split_part == 1)
        self.next.setEnabled(self.page + max(1, len(self._visible_pages)) < self.total or split and self._split_part == 0)

    def progress_body(self, page):
        body = super().progress_body(page)
        body["percent"] = (page + self._fraction.get(page, 1)) / self.total
        return body

    def _start_stream(self, page):
        self._generation += 1
        self._stream_busy = False
        for entry in self._stream:
            self.stream_layout.removeWidget(entry["label"]); entry["label"].deleteLater()
        self._stream = []
        self.page = page
        self._append_stream(page)

    def _append_stream(self, page):
        if self._stream_busy or page >= self.total:
            return
        self._stream_busy = True
        token = self._generation
        def ready(image):
            self._stream_busy = False
            if token != self._generation or self._disposed:
                return
            try:
                image = self._filter(image)
            except Exception as error:
                self._load_failed(ApiError(str(error)), token); return
            widget = self.create_stream_label(page)
            widget.setAlignment(Qt.AlignmentFlag.AlignCenter)
            widget.setAccessibleName(f"Page {page + 1}")
            widget.setPixmap(QPixmap.fromImage(image))
            self.stream_layout.addWidget(widget)
            self._stream.append({"page": page, "label": widget})
            if self._image is None or len(self._stream) == 1:
                self._image = image
            self._render()
            if len(self._stream) > 3:
                previous = self._stream.pop(0)
                self.stream_discarded(previous["page"])
                height = previous["label"].height() + self.stream_layout.spacing()
                before = self.scroll.verticalScrollBar().value()
                self.stream_layout.removeWidget(previous["label"]); previous["label"].deleteLater()
                QTimer.singleShot(0, lambda: self.scroll.verticalScrollBar().setValue(max(0, before - height)) if not self._disposed else None)
            self.page_notice.setText("Continuous reading · nearby pages load as you scroll")
            QTimer.singleShot(0, self._stream_position)
        self._get(page, token, ready)

    def create_stream_label(self, page):
        return QLabel()

    def stream_discarded(self, page):
        pass

    def _stream_position(self, *_args):
        if self._disposed or self._layout_mode != "webtoon" or not self._stream:
            return
        bar = self.scroll.verticalScrollBar()
        center = bar.value() + self.scroll.viewport().height() / 2
        visible = next((entry for entry in self._stream if entry["label"].y() <= center < entry["label"].y() + entry["label"].height()), self._stream[0])
        page = visible["page"]
        if page != self.page or self._pending is None and self._last_saved != page:
            self.page = page; self._pending = page; self.save_timer.start(); self._navigation()
            self._checkpoint()
        last = self._stream[-1]
        self._sync_annotation_badge()
        if bar.value() + self.scroll.viewport().height() * 2 >= last["label"].y() + last["label"].height():
            self._append_stream(last["page"] + 1)

    def _render(self, *_args):
        if self._layout_mode != "webtoon" or not hasattr(self, "stream_widget"):
            return super()._render(*_args)
        width = max(100, self.scroll.viewport().width() - 16)
        ratio = self.devicePixelRatioF()
        for entry in self._stream:
            pixmap = entry["label"].pixmap()
            if pixmap is None or pixmap.isNull():
                continue
            height = round(width * pixmap.height() / pixmap.width())
            scaled = pixmap.scaled(round(width * ratio), round(height * ratio), Qt.AspectRatioMode.KeepAspectRatio, Qt.TransformationMode.SmoothTransformation)
            scaled.setDevicePixelRatio(ratio)
            entry["label"].setPixmap(scaled); entry["label"].setFixedSize(width, height)
        self._sync_annotation_badge()

    def _auto_toggled(self, enabled):
        self.auto_timer.start() if enabled else self.auto_timer.stop()

    def _scroll_tick(self):
        if self.isVisible() and not self.window().isMinimized():
            bar = self.scroll.verticalScrollBar()
            bar.setValue(min(bar.maximum(), bar.value() + self.auto_speed.value()))

    def dispose(self):
        super().dispose()
        if hasattr(self, "auto_timer"):
            self.auto_timer.stop(); self.options.close()
        self._cache.clear(); self._cache_bytes = 0
