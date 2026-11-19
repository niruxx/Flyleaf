"""Account-owned native bookmarks, notes, lookup and profile bindings."""
from PySide6.QtCore import Qt
from PySide6.QtWidgets import (QComboBox, QDialog, QHBoxLayout, QLineEdit, QListWidget,
    QListWidgetItem, QPlainTextEdit, QPushButton, QVBoxLayout)
from .widgets import label, text

ROLE = Qt.ItemDataRole.UserRole


class ReaderTools(QDialog):
    def __init__(self, reader, data):
        super().__init__(reader)
        self.reader, self.api = reader, reader.api
        self.setWindowTitle("Bookmarks, notes and reader profile")
        self.resize(580, 680)
        self.annotations = [a for a in data.get("annotations", []) if isinstance(a, dict)]
        outer = QVBoxLayout(self)
        outer.addWidget(label("Your reading companion", heading=True))
        row = QHBoxLayout()
        self.profiles = QComboBox()
        self.profiles.setAccessibleName("Reader profile")
        self.profiles.addItem("Choose reader profile", None)
        row.addWidget(self.profiles, 1)
        bind = QPushButton("Use for this series")
        bind.clicked.connect(self.bind_profile)
        bind.setEnabled(type(reader.book.get("seriesId")) is int)
        row.addWidget(bind)
        outer.addLayout(row)
        history = QPushButton("Reading-position history…")
        history.clicked.connect(self.show_history)
        outer.addWidget(history)
        self.items = QListWidget()
        self.items.setAccessibleName("Bookmarks and highlights")
        self.items.itemActivated.connect(self.go_to_annotation)
        self.items.currentItemChanged.connect(self.select_annotation)
        outer.addWidget(self.items, 1)
        self.quote = QPlainTextEdit()
        self.quote.setPlaceholderText("Selected text or a passage to remember")
        self.quote.setAccessibleName("Highlight text")
        self.quote.setMaximumHeight(90)
        outer.addWidget(self.quote)
        self.note = QPlainTextEdit()
        self.note.setPlaceholderText("Your private note")
        self.note.setAccessibleName("Annotation note")
        self.note.setMaximumHeight(90)
        outer.addWidget(self.note)
        buttons = QHBoxLayout()
        for caption, method in [("Bookmark page", lambda: self.add("bookmark")), ("Highlight & note", lambda: self.add("highlight")), ("Save note", self.save_note), ("Delete", self.delete)]:
            button = QPushButton(caption); button.clicked.connect(method); buttons.addWidget(button)
        outer.addLayout(buttons)
        lookup = QHBoxLayout()
        self.word = QLineEdit()
        self.word.setPlaceholderText("Word or text to look up")
        self.word.setAccessibleName("Lookup text")
        self.word.setMaxLength(500)
        lookup.addWidget(self.word, 1)
        self.language = QLineEdit("en")
        self.language.setAccessibleName("Translation target language")
        self.language.setMaximumWidth(80)
        lookup.addWidget(self.language)
        define = QPushButton("Define"); define.clicked.connect(lambda: self.lookup(False)); lookup.addWidget(define)
        translate = QPushButton("Translate"); translate.clicked.connect(lambda: self.lookup(True)); lookup.addWidget(translate)
        outer.addLayout(lookup)
        self.lookup_result = QPlainTextEdit()
        self.lookup_result.setReadOnly(True)
        self.lookup_result.setAccessibleName("Lookup result")
        self.lookup_result.setMaximumHeight(120)
        outer.addWidget(self.lookup_result)
        self.notice = label("", wrap=True)
        outer.addWidget(self.notice)
        self.reload()
        def profiles(data):
            if reader._disposed or not isinstance(data, dict):
                return
            for profile in data.get("profiles", []):
                if isinstance(profile, dict):
                    self.profiles.addItem(text(profile.get("name"), "Profile"), profile.get("id"))
        self.api.json("GET", "/api/profiles", profiles, lambda error: self.notice.setText(error.message) if not reader._disposed else None)

    def showEvent(self, event):
        super().showEvent(event)
        selected = getattr(getattr(self.reader, "canvas", None), "selected_text", "")
        if selected:
            self.quote.setPlainText(selected); self.word.setText(selected[:500])
        elif hasattr(self.reader, "page_text"):
            selected = self.reader.page_text.textCursor().selectedText().replace("\u2029", "\n")
            if selected:
                self.quote.setPlainText(selected)
                self.word.setText(selected[:500])

    def reload(self):
        service = getattr(self.api, "reliability", None)
        if service and service.scope:
            row = service.store.book(service.scope, self.reader.book["id"])
            if row:
                import json
                data = json.loads(row["data"])
                data["annotations"] = self.annotations
                service.store.db.execute("UPDATE books SET data=? WHERE scope=? AND book=?", (json.dumps(data), service.scope, self.reader.book["id"]))
        self.items.clear()
        for annotation in self.annotations:
            caption = text(annotation.get("note"), text(annotation.get("text"), "Bookmark"))
            item = QListWidgetItem(f"{annotation.get('kind', 'note').title()} · {caption[:160]}")
            item.setData(ROLE, annotation)
            self.items.addItem(item)

    def show_history(self):
        from .personal_data import HistoryDialog
        if not hasattr(self, "history"):
            self.history = HistoryDialog(self.reader)
        self.history.load(); self.history.show()

    def select_annotation(self, item, _previous=None):
        if item:
            value = item.data(ROLE)
            self.quote.setPlainText(value.get("text") if isinstance(value.get("text"), str) else "")
            self.note.setPlainText(value.get("note") if isinstance(value.get("note"), str) else "")

    def _locator(self):
        if hasattr(self.reader, "current_locator"):
            return self.reader.current_locator()
        return str(self.reader.page)

    def add(self, kind):
        audio = self.reader.book.get("format") == "audio"
        if self.reader._disposed or (not getattr(self.reader, "_ready", False) if audio else self.reader._image is None):
            return
        locator = self._locator()
        if not locator and not (kind == "highlight" and getattr(self.reader, "_reflowable", False)):
            self.notice.setText("This page has no verified source position; the annotation was not saved.")
            return
        if kind == "highlight" and getattr(self.reader, "engine", None) is not None:
            passage = self.quote.toPlainText()
            note, generation = self.note.toPlainText(), self.reader._generation
            page = getattr(self.reader, "selection_page", None) if passage == getattr(self.reader, "selection_text", None) else None
            source_page = self.reader.page if page is None else page
            self.reader.engine.request("selection_locator", lambda verified: self._post_annotation(kind, verified, passage, note, generation, source_page), self.failed, page=source_page, selected=passage)
            return
        self._post_annotation(kind, locator)

    def _post_annotation(self, kind, locator, passage=None, note=None, generation=None, source_page=None):
        if self.reader._disposed:
            return
        if generation is not None and generation != self.reader._generation:
            self.notice.setText("The displayed page changed. Select the passage again before saving.")
            return
        selected_page = getattr(self.reader, "selection_page", None) if kind == "highlight" and self.quote.toPlainText() == getattr(self.reader, "selection_text", None) else None
        page = source_page if source_page is not None else self.reader.page if selected_page is None else selected_page
        if kind == "highlight" and selected_page is not None and not getattr(self.reader, "_reflowable", False):
            locator = str(page)
        body = {"kind": kind, "locator": locator, "page": None if getattr(self.reader, "_reflowable", False) else page,
                "percent": (page + 1) / max(1, self.reader.total),
                "text": (self.quote.toPlainText() if passage is None else passage)[:5000], "note": (self.note.toPlainText() if note is None else note)[:10000]}
        if self.reader.book.get("format") == "audio":
            self.reader.queue_position()
            body["page"] = None
            body["percent"] = (self.reader._pending or {}).get("percent", 0)
        def added(value):
            if self.reader._disposed:
                return
            self.annotations.append(value); self.reload(); self.notice.setText("Saved to your Flyleaf account.")
            if hasattr(self.reader, "show_page"):
                if hasattr(self.reader, "_cache"):
                    self.reader._cache.clear(); self.reader._cache_bytes = 0
                self.reader.show_page(self.reader.page)
        self.api.json("POST", f"/api/books/{self.reader.book['id']}/annotations", added, self.failed, body)

    def save_note(self):
        item = self.items.currentItem()
        if not item:
            return
        value = item.data(ROLE)
        def saved(result):
            if not self.reader._disposed:
                self.annotations = [result if a.get("id") == result["id"] else a for a in self.annotations]
                self.reload(); self.notice.setText("Note updated.")
        self.api.json("PATCH", f"/api/annotations/{value['id']}", saved, self.failed, {"note": self.note.toPlainText()[:10000]})

    def delete(self):
        item = self.items.currentItem()
        if not item:
            return
        identity = item.data(ROLE)["id"]
        def deleted(_data):
            if not self.reader._disposed:
                self.annotations = [a for a in self.annotations if a.get("id") != identity]
                self.reload(); self.notice.setText("Annotation deleted.")
                if hasattr(self.reader, "show_page"):
                    if hasattr(self.reader, "_cache"):
                        self.reader._cache.clear(); self.reader._cache_bytes = 0
                    self.reader.show_page(self.reader.page)
        self.api.json("DELETE", f"/api/annotations/{identity}", deleted, self.failed)

    def go_to_annotation(self, item):
        value = item.data(ROLE)
        if self.reader.book.get("format") == "audio":
            self.reader.go_to_locator(value["locator"])
        elif getattr(self.reader, "_reflowable", False):
            self.reader.engine.request("resolve", self.reader.show_page, self.failed, cfi=value["locator"])
        elif type(value.get("page")) is int:
            self.reader.show_page(value["page"])

    def bind_profile(self):
        identity = self.profiles.currentData()
        if identity is None or type(self.reader.book.get("seriesId")) is not int:
            return
        def bound(_data):
            if self.reader._disposed:
                return
            def refreshed(data):
                if self.reader._disposed:
                    return
                if hasattr(self.reader, "apply_reader_settings"):
                    self.reader.apply_reader_settings(data.get("settings", {}))
                self.notice.setText("Reader profile bound to this series.")
            self.api.json("GET", f"/api/books/{self.reader.book['id']}/reader", refreshed, self.failed)
        self.api.json("PUT", f"/api/series/{self.reader.book['seriesId']}/profile", bound, self.failed, {"profileId": identity})

    def lookup(self, translate):
        if not self.word.text().strip():
            return
        parameters = {"q": self.word.text(), "from": self.reader.book.get("language") or "en", "to": self.language.text()} if translate else {"word": self.word.text(), "lang": self.reader.book.get("language") or "en"}
        def loaded(data):
            if self.reader._disposed:
                return
            if translate:
                result = text(data.get("text"))
            else:
                result = "\n\n".join(text(definition.get("text")) for entry in data.get("entries", []) if isinstance(entry, dict) for definition in entry.get("definitions", []) if isinstance(definition, dict))
            self.lookup_result.setPlainText(result or "No result returned by the server.")
        self.api.json("GET", "/api/lookup/translate" if translate else "/api/lookup/define", loaded, self.failed, params=parameters)

    def failed(self, error):
        if not self.reader._disposed:
            self.notice.setText(error.message if hasattr(error, "message") else str(error))
