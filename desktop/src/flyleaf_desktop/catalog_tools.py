"""Server-backed catalog filters and account-owned saved shelves."""
from PySide6.QtCore import Signal, QSignalBlocker
from PySide6.QtWidgets import QComboBox, QCompleter, QFormLayout, QHBoxLayout, QLineEdit, QPushButton, QVBoxLayout, QWidget
from .widgets import label, text


class CatalogTools(QWidget):
    applied = Signal(dict)
    selected_filter = Signal(dict)

    def __init__(self, api):
        super().__init__()
        self.api = api
        self.session = 0
        self.params = {}
        self.extra = {}
        outer = QVBoxLayout(self)
        outer.setContentsMargins(0, 0, 0, 0)
        outer.addWidget(label("Find your next read", heading=True))
        outer.addWidget(label("Match genres, tags and creators by name. Saved searches belong to your account and also appear in Flyleaf's web app.", wrap=True))
        form = QFormLayout()
        self.fields = {}
        for name, caption, placeholder in [("genre", "Genres", "Separate multiple genres with ;"), ("tag", "Tag", "Exact tag"), ("person", "Creator", "Exact creator name"), ("language", "Language", "Language code, e.g. en or ja")]:
            edit = QLineEdit()
            edit.setMaxLength(200)
            edit.setPlaceholderText(placeholder)
            edit.setAccessibleName(caption)
            self.fields[name] = edit
            form.addRow(caption, edit)
            edit.returnPressed.connect(self.apply)
        self.format = QComboBox()
        self.format.setAccessibleName("File format")
        self.format.addItem("Any format", "")
        for value in ("epub", "kepub", "pdf", "mobi", "azw3", "fb2", "txt", "docx", "rtf", "cbz", "cbr", "cb7", "cbt", "folder", "audio"):
            self.format.addItem(value.upper(), value)
        form.addRow("Format", self.format)
        outer.addLayout(form)
        buttons = QHBoxLayout()
        apply_button = QPushButton("Apply filters")
        apply_button.clicked.connect(self.apply)
        clear = QPushButton("Clear filters")
        clear.clicked.connect(self.clear_filters)
        buttons.addWidget(apply_button)
        buttons.addWidget(clear)
        outer.addLayout(buttons)
        saved_row = QHBoxLayout()
        self.saved = QComboBox()
        self.saved.setAccessibleName("Saved filters")
        self.saved.addItem("New saved filter", None)
        self.saved.currentIndexChanged.connect(self.choose_saved)
        saved_row.addWidget(self.saved, 1)
        self.name = QLineEdit()
        self.name.setMaxLength(80)
        self.name.setPlaceholderText("Saved filter name")
        self.name.setAccessibleName("Saved filter name")
        saved_row.addWidget(self.name, 1)
        self.save = QPushButton("Save")
        self.delete = QPushButton("Delete")
        saved_row.addWidget(self.save)
        saved_row.addWidget(self.delete)
        outer.addLayout(saved_row)
        self.notice = label("", wrap=True)
        outer.addWidget(self.notice)
        self.delete.clicked.connect(self.delete_saved)

    def start_session(self, capabilities):
        self.clear_session()
        supported = capabilities.get("catalogFilters", []) if isinstance(capabilities, dict) else []
        for name, control in [("language", self.fields["language"]), ("format", self.format)]:
            control.setEnabled(name in supported)
            control.setToolTip("" if name in supported else "This server does not advertise this catalog filter. Update Flyleaf to enable it.")
        session = self.session
        self.api.json("GET", "/api/genres", lambda data: self._genres(data, session), lambda _error: None)
        self.reload_saved()

    def clear_session(self):
        self.session += 1
        self.params, self.extra = {}, {}
        for edit in self.fields.values():
            edit.clear()
        self.format.setCurrentIndex(0)
        with QSignalBlocker(self.saved):
            self.saved.clear()
            self.saved.addItem("New saved filter", None)
        self.name.clear()
        self.notice.clear()
        self.delete.setEnabled(False)
        self.save.setEnabled(True)

    def _genres(self, data, session):
        if session != self.session or not isinstance(data, list):
            return
        names = [text(item.get("name")) for item in data if isinstance(item, dict)]
        self.fields["genre"].setCompleter(QCompleter(names, self.fields["genre"]))

    def values(self):
        result = dict(self.extra)
        for key, edit in self.fields.items():
            value = edit.text().strip() if edit.isEnabled() else ""
            if value:
                result[key] = [part.strip() for part in value.split(";") if part.strip()] if key == "genre" else value
        if self.format.isEnabled() and self.format.currentData():
            result["format"] = self.format.currentData()
        return result

    def apply(self):
        self.params = self.values()
        self.applied.emit(dict(self.params))

    def clear_filters(self):
        for edit in self.fields.values():
            edit.clear()
        self.format.setCurrentIndex(0)
        self.extra = {}
        self.apply()

    def choose_saved(self):
        item = self.saved.currentData()
        self.delete.setEnabled(isinstance(item, dict))
        self.name.setText(text(item.get("name")) if isinstance(item, dict) else "")
        if not isinstance(item, dict) or not isinstance(item.get("filter"), dict):
            return
        query = dict(item["filter"])
        if (query.get("language") and not self.fields["language"].isEnabled()) or (query.get("format") and not self.format.isEnabled()):
            self.notice.setText("This saved filter requires language/format support from a newer Flyleaf server. It has not been applied.")
            return
        self.extra = {key: value for key, value in query.items() if key not in (*self.fields.keys(), "format", "q", "sort", "read", "library", "want")}
        for key, edit in self.fields.items():
            value = query.get(key, "")
            edit.setText("; ".join(str(v) for v in value) if isinstance(value, list) else str(value))
        self.format.setCurrentIndex(max(0, self.format.findData(query.get("format", ""))))
        self.params = self.values()
        self.notice.setText("Additional saved criteria: " + ", ".join(self.extra) if self.extra else "Saved filter applied.")
        self.selected_filter.emit(query)

    def reload_saved(self, selected=None):
        session = self.session
        def loaded(data):
            if session != self.session or not isinstance(data, list):
                return
            with QSignalBlocker(self.saved):
                self.saved.clear()
                self.saved.addItem("New saved filter", None)
                for item in data:
                    if isinstance(item, dict) and type(item.get("id")) is int:
                        self.saved.addItem(text(item.get("name"), "Saved filter"), item)
                        if item["id"] == selected:
                            self.saved.setCurrentIndex(self.saved.count() - 1)
            self.delete.setEnabled(self.saved.currentIndex() > 0)
        self.api.json("GET", "/api/filters", loaded, lambda error: self.notice.setText("Saved filters unavailable: " + error.message) if session == self.session else None)

    def save_query(self, query):
        name = self.name.text().strip()
        if not name:
            self.notice.setText("Give this filter a name.")
            return
        current = self.saved.currentData()
        identity = current.get("id") if isinstance(current, dict) else None
        body = {"name": name, "filter": {key: value for key, value in query.items() if key not in ("offset", "limit") and value is not None and value != ""}}
        session = self.session
        self.save.setEnabled(False)
        def saved(data):
            if session != self.session:
                return
            self.save.setEnabled(True)
            self.notice.setText("Filter saved to your account on the server.")
            self.reload_saved(data.get("id") if isinstance(data, dict) else identity)
        def failed(error):
            if session == self.session:
                self.save.setEnabled(True)
                self.notice.setText(error.message)
        self.api.json("PATCH" if identity else "POST", f"/api/filters/{identity}" if identity else "/api/filters", saved, failed, body)

    def delete_saved(self):
        item = self.saved.currentData()
        if not isinstance(item, dict):
            return
        session = self.session
        def deleted(_data):
            if session == self.session:
                self.name.clear()
                self.notice.setText("Saved filter deleted.")
                self.reload_saved()
        self.api.json("DELETE", f"/api/filters/{item['id']}", deleted, lambda error: self.notice.setText(error.message) if session == self.session else None)
