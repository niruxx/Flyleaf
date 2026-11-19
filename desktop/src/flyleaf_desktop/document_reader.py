"""Native PDF/EPUB reader backed by process-isolated MuPDF, never a web view."""
from datetime import date
from PySide6.QtCore import Qt, QUrl, QRectF, QTimer
from PySide6.QtGui import QDesktopServices, QPainter, QColor, QTextCursor
from PySide6.QtWidgets import (QComboBox, QDialog, QHBoxLayout, QLineEdit, QListWidget,
    QListWidgetItem, QPlainTextEdit, QPushButton, QSpinBox, QVBoxLayout, QCheckBox, QTextEdit, QScrollArea, QWidget)
from .api import ApiError
from .document_process import DocumentProcess
from .comic_reader import ComicReader
from .widgets import decode_image, label

TEXT_FORMATS = frozenset({"epub", "kepub", "fb2", "mobi", "azw3", "txt", "docx", "rtf"})


class DocumentReader(ComicReader):
    def create_canvas(self):
        from .selection_canvas import SelectionCanvas
        canvas = SelectionCanvas()
        canvas.selected.connect(self._canvas_selected)
        return canvas

    def _canvas_selected(self, passage, page=None):
        self.selection_page = self.page if page is None else page
        self.selection_text = passage
        if hasattr(self, "companion_tools"):
            self.companion_tools.quote.setPlainText(passage)
            self.companion_tools.word.setText(passage[:500])

    def create_stream_label(self, page):
        from .selection_canvas import SelectionCanvas
        canvas = SelectionCanvas()
        metadata = self._page_metadata.get(page) or {}
        canvas.set_words(metadata.get("words", []), metadata.get("imageSize", [1, 1]))
        canvas.selected.connect(lambda passage: self._canvas_selected(passage, page))
        return canvas

    def stream_discarded(self, page):
        if getattr(self, "selection_page", None) == page:
            self.selection_page = None; self.selection_text = ""

    def __init__(self, api, data, leave):
        data = {**data, "settings": dict(data.get("settings") or {})}
        if data["settings"].get("flow") == "scrolled" and data["book"].get("format") in TEXT_FORMATS:
            data["settings"]["layout"] = "webtoon"
        self.engine = None
        self._locators = {}
        self._writes_enabled = True
        self._rotation = 0
        try:
            self._font_size = max(10, min(40, round(float(data["settings"].get("fontSize", 100)) * 18 / 100)))
        except (TypeError, ValueError):
            self._font_size = 18
        self._reflowable = False
        self._text = ""
        self._page_metadata = {}
        self.speech = None
        self._speech_active = False
        self._speech_playing = False
        self._continue_speech = False
        self._speech_offset = 0
        super().__init__(api, data, leave)
        self.tools = QDialog(self)
        self.tools.setWindowTitle("Contents, search and selectable text")
        self.tools.resize(620, 680)
        tool_layout = QVBoxLayout(self.tools)
        tool_scroll = QScrollArea()
        tool_scroll.setWidgetResizable(True)
        tool_body = QWidget()
        content = QVBoxLayout(tool_body)
        tool_scroll.setWidget(tool_body)
        tool_layout.addWidget(tool_scroll)
        content.addWidget(label("Reading tools", heading=True))
        row = QHBoxLayout()
        self.toc = QComboBox()
        self.toc.setAccessibleName("Table of contents")
        self.toc.currentIndexChanged.connect(lambda _: self.show_page(self.toc.currentData()) if type(self.toc.currentData()) is int else None)
        row.addWidget(self.toc, 1)
        self.rotation = QComboBox()
        self.rotation.setAccessibleName("Page rotation")
        for value in (0, 90, 180, 270):
            self.rotation.addItem(f"{value}°", value)
        self.rotation.currentIndexChanged.connect(self._rotate)
        row.addWidget(self.rotation)
        self.font_size = QSpinBox()
        self.font_size.setRange(10, 40)
        self.font_size.setValue(18)
        self.font_size.setSuffix(" pt")
        self.font_size.setAccessibleName("Ebook font size")
        row.addWidget(self.font_size)
        relayout = QPushButton("Apply typography")
        relayout.clicked.connect(self.relayout)
        row.addWidget(relayout)
        content.addLayout(row)
        typography = QHBoxLayout()
        self.font_family = QComboBox(); self.font_family.setAccessibleName("Ebook font family")
        for caption, family in [("Publisher font", "publisher"), ("Serif", "serif"), ("Sans serif", "sans-serif"), ("Monospace", "monospace")]:
            self.font_family.addItem(caption, family)
        typography.addWidget(self.font_family)
        self.line_height = QComboBox(); self.line_height.setAccessibleName("Ebook line spacing")
        for spacing in (1.0, 1.25, 1.5, 1.75, 2.0):
            self.line_height.addItem(f"{spacing:g}× line spacing", spacing)
        self.line_height.setCurrentIndex(2); typography.addWidget(self.line_height)
        self.margin = QComboBox(); self.margin.setAccessibleName("Ebook page margins")
        for caption, value in [("Narrow margins", "narrow"), ("Normal margins", "normal"), ("Wide margins", "wide")]:
            self.margin.addItem(caption, value)
        self.margin.setCurrentIndex(1); typography.addWidget(self.margin)
        content.addLayout(typography)
        search_row = QHBoxLayout()
        self.search = QLineEdit()
        self.search.setAccessibleName("Search document text")
        self.search.setPlaceholderText("Find in this book")
        self.search.returnPressed.connect(self.find_text)
        search_row.addWidget(self.search, 1)
        find = QPushButton("Find")
        find.clicked.connect(self.find_text)
        search_row.addWidget(find)
        content.addLayout(search_row)
        self.matches = QListWidget()
        self.matches.setAccessibleName("Text search results")
        self.matches.setMaximumHeight(140)
        self.matches.itemActivated.connect(lambda item: self.show_page(item.data(Qt.ItemDataRole.UserRole)))
        self.matches.itemClicked.connect(lambda item: self.show_page(item.data(Qt.ItemDataRole.UserRole)))
        content.addWidget(self.matches)
        content.addWidget(label("Selectable text from the current page", wrap=True))
        self.page_text = QPlainTextEdit()
        self.page_text.setReadOnly(True)
        self.page_text.setAccessibleName("Selectable current page text")
        content.addWidget(self.page_text, 1)
        self.links = QListWidget()
        self.links.setAccessibleName("Links and footnotes on this page")
        self.links.setMaximumHeight(100)
        self.links.itemActivated.connect(self.open_link)
        content.addWidget(self.links)
        self.resume_here = QPushButton("Resume here and enable position saving")
        self.resume_here.clicked.connect(self.enable_position_writes)
        self.resume_here.hide()
        content.addWidget(self.resume_here)
        self.reader_menu.addAction("Contents, search, text & read aloud", self.tools.show)
        speech_row = QHBoxLayout()
        self.voice = QComboBox(); self.voice.addItem("System voice", None)
        self.voice.setAccessibleName("Read aloud voice")
        speech_row.addWidget(self.voice, 1)
        self.speech_rate = QSpinBox(); self.speech_rate.setRange(80, 350); self.speech_rate.setValue(180)
        self.speech_rate.setSuffix(" wpm"); self.speech_rate.setAccessibleName("Read aloud speed")
        speech_row.addWidget(self.speech_rate)
        self.sleep_minutes = QSpinBox(); self.sleep_minutes.setRange(0, 180); self.sleep_minutes.setSuffix(" min")
        self.sleep_minutes.setSpecialValueText("No sleep timer"); self.sleep_minutes.setAccessibleName("Read aloud sleep timer")
        speech_row.addWidget(self.sleep_minutes)
        content.addLayout(speech_row)
        self.continue_reading = QCheckBox("Continue read aloud on the next page")
        self.continue_reading.setChecked(True)
        content.addWidget(self.continue_reading)
        speech_buttons = QHBoxLayout()
        read = QPushButton("Read page aloud"); read.clicked.connect(self.start_speech)
        pause = QPushButton("Pause read aloud"); pause.clicked.connect(self.stop_speech)
        speech_buttons.addWidget(read); speech_buttons.addWidget(pause)
        content.addLayout(speech_buttons)
        self.sleep_timer = QTimer(self); self.sleep_timer.setSingleShot(True)
        self.sleep_timer.timeout.connect(self.stop_speech)

    def load_pages(self):
        if self.book.get("format") in ("fb2", "mobi", "azw3") and not getattr(self.api, "offline", False) and getattr(self.api, "capabilities", {}).get("nativeEpubRenditions") != 1:
            self._load_failed(ApiError("Update the Flyleaf server to enable native EPUB renditions for FB2, MOBI and AZW3."))
            return
        self._page_metadata.clear()
        self._cache.clear(); self._cache_bytes = 0
        self.page_notice.setText("Loading the native document…")
        self.retry_page.hide()
        if self.engine:
            self.engine.close()
        try:
            self.engine = DocumentProcess(self)
        except Exception:
            self._load_failed(ApiError("The native document engine could not start. Check the installed reader dependencies."))
            return
        def loaded(payload):
            if self._disposed:
                return
            position = (self.book.get("progress") or {}).get("position")
            self.engine.request("open", self._opened, self._engine_failed, payload=payload,
                                format="pdf" if self.book.get("format") == "pdf" else "epub", position=position,
                                font_size=self._font_size)
        suffix = "?native=epub" if self.book.get("format") in ("fb2", "mobi", "azw3") else ""
        self.api.binary(f"/api/books/{self.book['id']}/file{suffix}", loaded, self._load_failed)

    def _engine_failed(self, message):
        if not self._disposed:
            self._load_failed(ApiError(message))

    def _opened(self, metadata):
        if self._disposed:
            return
        self.total = metadata["count"]
        self._reflowable = metadata["reflowable"]
        progress = self.book.get("progress") or {}
        if self._reflowable and progress.get("percent") and not progress.get("position"):
            metadata["unresolved"] = True
            metadata["warning"] = "This ebook has saved progress without an exact text anchor. Choose where to resume before saving a new position."
        self._writes_enabled = not metadata.get("unresolved")
        self.resume_here.setVisible(not self._writes_enabled)
        self.toc.blockSignals(True)
        self.toc.clear()
        self.toc.addItem("Table of contents", None)
        for level, title, number in metadata.get("toc", []):
            self.toc.addItem("  " * min(6, max(0, level - 1)) + str(title), max(0, number - 1))
        self.toc.blockSignals(False)
        self.font_size.setEnabled(self._reflowable)
        for control in (self.font_family, self.line_height, self.margin):
            control.setEnabled(self._reflowable)
        self.crop.setChecked(False)
        self.crop.setEnabled(False)
        self.crop.setToolTip("Document selection uses the original page geometry.")
        self.font_size.setValue(self._font_size)
        self.rotation.setEnabled(not self._reflowable)
        page = metadata.get("page", 0) if self._reflowable else progress.get("page", 0)
        self.show_page(min(self.total - 1, max(0, page if type(page) is int else 0)))
        if metadata.get("warning"):
            self.sync_notice.setText(metadata["warning"])
            if metadata.get("unresolved"):
                self.tools.show()

    def show_page(self, page):
        if self._disposed or not self.total or type(page) is not int or not 0 <= page < self.total:
            return
        if hasattr(self, "options") and self._layout_mode in ("double", "webtoon"):
            return super().show_page(page)
        self.page = page
        self.selection_page = None; self.selection_text = ""
        if self.speech and self._speech_active:
            self.speech.stop(); self._speech_active = False
        self._speech_offset = 0
        self._generation += 1
        token = self._generation
        self._image = None
        self.canvas.clear()
        self.canvas.setText("Rendering page…")
        self.page_notice.setText(f"Rendering page {page + 1}…")
        self._navigation()
        def rendered(result):
            if token != self._generation or self._disposed:
                return
            try:
                self._image = decode_image(result["image"])
                self._image = self._filter(self._image)
            except ValueError as error:
                self._engine_failed(str(error)); return
            if result.get("highlights"):
                painter = QPainter(self._image)
                painter.setPen(Qt.PenStyle.NoPen)
                painter.setBrush(QColor(255, 211, 54, 100))
                for rectangle in result["highlights"]:
                    painter.drawRect(QRectF(*rectangle))
                painter.end()
            self._text = result["text"]
            self._page_metadata[page] = {key: value for key, value in result.items() if key != "image"}
            while len(self._page_metadata) > 8:
                del self._page_metadata[next(iter(self._page_metadata))]
            self.canvas.set_words(result.get("words", []), result.get("imageSize", [1, 1]))
            self.page_text.setPlainText(self._text)
            self.links.clear()
            for link in result.get("links", []):
                item = QListWidgetItem(link["title"])
                item.setData(Qt.ItemDataRole.UserRole, link)
                self.links.addItem(item)
            locator = result.get("position")
            if locator:
                self._locators[page] = locator
            self._render()
            self.scroll.verticalScrollBar().setValue(0)
            self.page_notice.setText("Use Contents & text for search, selection, links and typography.")
            if self._writes_enabled and (not self._reflowable or locator):
                self._pending = page
                self._checkpoint()
                self.sync_notice.setText("Position changed · waiting to save…")
                self.save_timer.start()
            elif self._reflowable:
                self.sync_notice.setText("Exact EPUB position is not verified for this page. The server's existing position has been retained.")
            if self._continue_speech:
                self._continue_speech = False
                self.start_speech()
        self.engine.request("render", rendered, self._engine_failed, page=page, width=min(4000, max(1800, round(self.scroll.viewport().width() * self.devicePixelRatioF() * 1.5))), rotation=self._rotation, annotations=self.companion_tools.annotations)

    def _get(self, page, token, done):
        if page in self._cache and page in self._page_metadata:
            self._cache.move_to_end(page); done(self._cache[page]); return
        def rendered(result):
            if self._disposed or token != self._generation:
                return
            try:
                image = decode_image(result["image"])
            except ValueError as error:
                self._engine_failed(str(error)); return
            if result.get("highlights"):
                painter = QPainter(image)
                painter.setPen(Qt.PenStyle.NoPen); painter.setBrush(QColor(255, 211, 54, 100))
                for rectangle in result["highlights"]:
                    painter.drawRect(QRectF(*rectangle))
                painter.end()
            self._page_metadata[page] = {key: value for key, value in result.items() if key != "image"}
            while len(self._page_metadata) > 8:
                del self._page_metadata[next(iter(self._page_metadata))]
            if page == self.page:
                self._apply_page_metadata(page)
            if result.get("position"):
                self._locators[page] = result["position"]
            from .comic_reader import CACHE_BYTES
            while self._cache and self._cache_bytes + image.sizeInBytes() > CACHE_BYTES:
                _, removed = self._cache.popitem(last=False); self._cache_bytes -= removed.sizeInBytes()
            if image.sizeInBytes() <= CACHE_BYTES:
                self._cache[page] = image; self._cache_bytes += image.sizeInBytes()
            done(image)
        self.engine.request("render", rendered, self._engine_failed, page=page, width=min(4000, max(1800, round(self.scroll.viewport().width() * self.devicePixelRatioF() * 1.5))), rotation=self._rotation, annotations=self.companion_tools.annotations)

    def _display(self, images, pages, token):
        super()._display(images, pages, token)
        self.canvas.set_words([], [1, 1])
        self._apply_page_metadata(pages[0])
        self._guard_position_write(pages[-1])

    def _stream_position(self, *_args):
        old = self.page
        super()._stream_position(*_args)
        if old != self.page or not self._text:
            if self._speech_active:
                self.stop_speech()
            self._apply_page_metadata(self.page)
        self._guard_position_write(self.page)
        if self._continue_speech and self._stream:
            self._continue_speech = False; self.start_speech()

    def _apply_page_metadata(self, page):
        metadata = self._page_metadata.get(page)
        if metadata and hasattr(self, "page_text"):
            self._text = metadata.get("text", "")
            self.page_text.setPlainText(self._text)
            self.links.clear()
            for link in metadata.get("links", []):
                item = QListWidgetItem(link["title"])
                item.setData(Qt.ItemDataRole.UserRole, link)
                self.links.addItem(item)

    def _guard_position_write(self, page):
        if self._reflowable and (not self._writes_enabled or not self._locators.get(page)):
            self._pending = None
            self.save_timer.stop()
            self.sync_notice.setText("Exact EPUB position not verified. The server's existing position is retained.")

    def find_text(self):
        token = self._generation
        self.matches.clear()
        def found(results):
            if self._disposed or token != self._generation:
                return
            for result in results:
                item = QListWidgetItem(f"Page {result['page'] + 1} · {result['text'][:180]}")
                item.setData(Qt.ItemDataRole.UserRole, result["page"])
                self.matches.addItem(item)
            if not results:
                self.page_text.setPlainText("No text matches. Scanned pages may need OCR on the server.")
        self.engine.request("search", found, self._engine_failed, query=self.search.text())

    def _rotate(self):
        self._rotation = self.rotation.currentData()
        self.show_page(self.page)

    def open_link(self, item):
        target = item.data(Qt.ItemDataRole.UserRole)
        if "page" in target:
            self.show_page(target["page"])
        elif target.get("url", "").startswith(("https://", "http://")) and not QUrl(target["url"]).userInfo():
            QDesktopServices.openUrl(QUrl(target["url"]))

    def relayout(self):
        if not self._reflowable or self._disposed:
            return
        if self.has_unsaved_changes:
            self.request_leave(self.relayout)
            return
        position = self._locators.get(self.page)
        if not position:
            self.sync_notice.setText("Typography cannot change until the current source position is verified.")
            return
        self._font_size = self.font_size.value()
        self._generation += 1
        self.settings.update({"fontSize": round(self._font_size / 18 * 100), "fontFamily": self.font_family.currentData(), "lineHeight": self.line_height.currentData(), "margin": self.margin.currentData()})
        def laid_out(metadata):
            if self._disposed:
                return
            self._locators.clear()
            self._page_metadata.clear()
            self._cache.clear(); self._cache_bytes = 0
            self.total = metadata["count"]
            self.show_page(metadata["page"])
        self.engine.request("layout", laid_out, self._engine_failed, font_size=self._font_size, position=position,
                            font_family=self.font_family.currentData(), line_height=self.line_height.currentData(), margin=self.margin.currentData())

    def reader_settings(self):
        settings = super().reader_settings()
        settings["flow"] = "scrolled" if self.layout_choice.currentData() == "webtoon" else "paginated"
        return settings

    def apply_reader_settings(self, settings, reload=True):
        super().apply_reader_settings({**settings, "autoCrop": False}, reload=False)
        if hasattr(self, "font_size"):
            try:
                self.font_size.setValue(max(10, min(40, round(float(settings.get("fontSize", 100)) * 18 / 100))))
            except (TypeError, ValueError):
                pass
            self.font_family.setCurrentIndex(max(0, self.font_family.findData(settings.get("fontFamily", "publisher"))))
            self.line_height.setCurrentIndex(max(0, self.line_height.findData(settings.get("lineHeight", 1.5))))
            self.margin.setCurrentIndex(max(0, self.margin.findData(settings.get("margin", "normal"))))
        if reload:
            self.apply_options()
            if self._reflowable:
                self.relayout()

    def enable_position_writes(self):
        if self._reflowable and not self._locators.get(self.page):
            return
        self._writes_enabled = True
        self.resume_here.hide()
        self._pending = self.page
        self.flush_progress()

    def current_locator(self):
        return self._locators.get(self._pending if self._pending is not None else self.page)

    def start_speech(self):
        if not self._text or self._disposed:
            if not self._disposed:
                self.sync_notice.setText("No readable text is available on this page. Scanned pages may need OCR.")
            return
        if self.speech is None:
            try:
                from .speech import SpeechProcess
                self.speech = SpeechProcess(self)
            except Exception:
                self.sync_notice.setText("The system speech engine could not start."); return
            self.speech.voices.connect(lambda voices: [self.voice.addItem(voice["name"], voice["id"]) for voice in voices])
            self.speech.word.connect(self._spoken_word)
            self.speech.started.connect(lambda: setattr(self, "_speech_playing", True))
            self.speech.failed.connect(self._speech_failed)
            self.speech.ended.connect(self._speech_ended)
        self._speech_active = True
        self._speech_playing = False
        self._speech_start = self._speech_offset
        self.speech.speak(self._text[self._speech_start:], self.voice.currentData(), self.speech_rate.value())
        if self.sleep_minutes.value() and not self.sleep_timer.isActive():
            self.sleep_timer.start(self.sleep_minutes.value() * 60000)

    def stop_speech(self):
        self._speech_playing = False
        self._speech_active = False; self._continue_speech = False
        self.sleep_timer.stop()
        if self.speech:
            self.speech.stop()

    def _speech_failed(self, message):
        self._speech_playing = False
        self._speech_active = False
        self._continue_speech = False
        self.sleep_timer.stop()
        self.sync_notice.setText(message)
        if self.speech:
            self.speech.close()
            self.speech.deleteLater()
            self.speech = None

    def _spoken_word(self, offset, length):
        if self._disposed or not self._speech_active:
            return
        self._speech_offset = self._speech_start + offset
        cursor = self.page_text.textCursor()
        start = len(self._text[:self._speech_offset].encode("utf-16-le")) // 2
        end = len(self._text[:self._speech_offset + length].encode("utf-16-le")) // 2
        cursor.setPosition(min(start, self.page_text.document().characterCount() - 1))
        cursor.setPosition(min(end, self.page_text.document().characterCount() - 1), QTextCursor.MoveMode.KeepAnchor)
        selection = QTextEdit.ExtraSelection()
        selection.cursor = cursor
        selection.format.setBackground(QColor("#c6d8ff"))
        selection.format.setForeground(QColor("#17285c"))
        self.page_text.setExtraSelections([selection])

    def _speech_ended(self):
        self._speech_playing = False
        self._speech_active = False
        if not self._disposed and self.continue_reading.isChecked() and self.page + 1 < self.total:
            self._continue_speech = True
            self.show_page(self.page + 1)

    def flush_progress(self):
        if not self._reflowable:
            super().flush_progress()
            return
        if self._disposed or self._saving:
            return
        self.save_timer.stop()
        if self._pending is None:
            if self._after_save:
                callback, self._after_save = self._after_save, None
                callback()
            return
        page, self._pending = self._pending, None
        position = self._locators.get(page)
        if not position or not self._writes_enabled:
            self.sync_notice.setText("The source position could not be verified; no ebook progress was overwritten.")
            return
        self._saving, self._saving_page = True, page
        body = {"position": position, "percent": (page + 1) / self.total, "day": date.today().isoformat(), "version": self.book.get("version")}
        def saved(_data):
            if self._disposed:
                return
            self._saving, self._saving_page = False, None
            self._last_saved = page
            self.sync_notice.setText("Verified EPUB position saved on this device · pending sync" if isinstance(_data, dict) and _data.get("queued") else "Verified EPUB position saved")
            if self._pending is not None or self._after_save:
                self.flush_progress()
        def failed(error):
            if self._disposed:
                return
            self._saving, self._saving_page = False, None
            if self._pending is None:
                self._pending = page
            self.sync_notice.setText("Position not saved: " + error.message)
            self.retry_save.show()
            self.discard_save.setVisible(self._after_save is not None)
        self.api.json("PUT", f"/api/books/{self.book['id']}/progress", saved, failed, body)

    def dispose(self):
        super().dispose()
        if self.engine:
            self.engine.close()
            self.engine = None
        if hasattr(self, "tools"):
            self.tools.close()
        if self.speech:
            self.speech.close(); self.speech = None
        if hasattr(self, "sleep_timer"):
            self.sleep_timer.stop()
