"""Native Home display with the Flyleaf account's shared layout preferences."""
from PySide6.QtCore import Qt, Signal
from PySide6.QtWidgets import QCheckBox, QComboBox, QFormLayout, QHBoxLayout, QLineEdit, QListWidget, QListWidgetItem

from .personal_workspace import PersonalPanel, button
from .reader_keys import PAGE_KEYS, qt_key
from .widgets import label


SECTIONS = {
    "continue": ("Continue reading", "continueReading", "book"),
    "want": ("Want to read", "wantToRead", "series"),
    "added": ("Recently added", "recentlyAdded", "series"),
    "updated": ("Recently updated", "recentlyUpdated", "series"),
}
SHARED_ORDER = ("continue", "glance", "updates", "recommendations", "discover", "want",
                "shelves", "added", "updated", "genres", "libraries", "explore")
SORTS = {"default": "Server shelf order", "az": "Title A–Z", "za": "Title Z–A",
         "author": "Author A–Z", "progress": "Reading progress"}
ROLE = Qt.ItemDataRole.UserRole


def ordered_home(value):
    value = value if isinstance(value, dict) else {}
    values = value.get("order")
    order = list(dict.fromkeys(key for key in values if isinstance(key, str) and key in SHARED_ORDER)) if isinstance(values, list) else []
    return [*order, *(key for key in SHARED_ORDER if key not in order)]


def records_for_home(data, prefs, section=None):
    prefs = prefs if isinstance(prefs, dict) else {}
    hidden = prefs.get("hidden") if isinstance(prefs.get("hidden"), list) else []
    sort = prefs.get("sort")
    records = []
    for key in ordered_home(prefs):
        if key not in SECTIONS or key in hidden or section and key != section:
            continue
        _, source, kind = SECTIONS[key]
        rows = [row for row in data.get(source) or [] if isinstance(row, dict) and type(row.get("id")) is int]
        title = lambda row: str(row.get("sortName") or row.get("name") or row.get("title") or "").casefold()
        if sort in ("az", "za"):
            rows.sort(key=title, reverse=sort == "za")
        elif sort == "author":
            rows.sort(key=lambda row: (str((row.get("authors") or [row.get("author") or ""])[0]).casefold(), title(row)))
        elif sort == "progress":
            def progress(row):
                value = row.get("progress")
                value = value.get("percent") if isinstance(value, dict) else value
                return value if isinstance(value, (int, float)) else 0
            rows.sort(key=progress, reverse=True)
        records.extend({"kind": kind, "data": row} for row in rows)
    return records


class HomeLayoutPanel(PersonalPanel):
    preferences_changed = Signal(dict)

    def __init__(self, api, settings, local_key):
        super().__init__(api)
        self.settings, self.local_key = settings, local_key
        self.original = {}
        self.original_bindings = {}
        self.layout.addWidget(label("Customize Home", heading=True))
        self.items = QListWidget()
        self.items.setAccessibleName("Visible Home shelves and their order")
        self.layout.addWidget(self.items, 1)
        row = QHBoxLayout()
        button(row, "Move up", lambda: self.move(-1))
        button(row, "Move down", lambda: self.move(1))
        self.layout.addLayout(row)
        self.sort = QComboBox()
        for key, title in SORTS.items():
            self.sort.addItem(title, key)
        self.layout.addWidget(self.sort)
        self.hero = QCheckBox("Show the Home welcome card")
        self.compact = QCheckBox("Compact Home cards")
        self.spoiler = QCheckBox("Hide future volume titles and unread summaries")
        self.eink = QCheckBox("High-contrast e-ink appearance")
        for control in (self.hero, self.compact, self.spoiler, self.eink):
            self.layout.addWidget(control)
        self.layout.addWidget(label("Page reader shortcuts", heading=True))
        self.key_fields = {}
        form = QFormLayout()
        for action, (title, default) in PAGE_KEYS.items():
            field = QLineEdit()
            field.setPlaceholderText(default)
            field.setMaxLength(200)
            form.addRow(title, field)
            self.key_fields[action] = field
        self.layout.addLayout(form)
        self.layout.addWidget(label("Separate shortcuts with commas. Leave a field empty for defaults or enter a dash to disable it.", wrap=True))
        row = QHBoxLayout()
        button(row, "Save to account", self.save)
        button(row, "Use layout on this desktop only", self.save_local)
        button(row, "Use account layout here", lambda: self.remove_local())
        self.layout.addLayout(row)

    def clear_session(self):
        super().clear_session()
        self.original = {}
        self.original_bindings = {}
        self.sort.setCurrentIndex(0)
        for control in (self.hero, self.compact, self.spoiler, self.eink):
            control.setChecked(False)

    def reload(self):
        def loaded(user):
            if isinstance(user, dict):
                prefs = user.get("prefs") or {}
                self.user = user
                home = self.settings.value(self.local_key()) if self.local_key() else None
                self.original = prefs.get("home") if isinstance(prefs.get("home"), dict) else {}
                view = home if isinstance(home, dict) else self.original
                self.items.clear()
                for section in ordered_home(view):
                    if section not in SECTIONS:
                        continue
                    item = QListWidgetItem(SECTIONS[section][0])
                    item.setData(ROLE, section)
                    item.setCheckState(Qt.CheckState.Unchecked if section in (view.get("hidden") or []) else Qt.CheckState.Checked)
                    self.items.addItem(item)
                self.sort.setCurrentIndex(max(0, self.sort.findData(view.get("sort"))))
                self.hero.setChecked(view.get("hero") is not False)
                self.compact.setChecked(view.get("compact") is True)
                self.spoiler.setChecked(bool(prefs.get("spoilerSafe")))
                self.eink.setChecked(bool(prefs.get("einkMode")))
                bindings = prefs.get("keybinds")
                self.original_bindings = bindings if isinstance(bindings, dict) else {}
                for action, field in self.key_fields.items():
                    values = self.original_bindings.get(action)
                    field.setText((", ".join(item for item in values if isinstance(item, str)) or "-") if isinstance(values, list) else "")
        self.request("GET", "/api/me", loaded)

    def move(self, delta):
        index = self.items.currentRow()
        target = index + delta
        if index >= 0 and 0 <= target < self.items.count():
            self.items.insertItem(target, self.items.takeItem(index))
            self.items.setCurrentRow(target)

    def value(self):
        items = [self.items.item(index) for index in range(self.items.count())]
        desktop_order = iter(item.data(ROLE) for item in items)
        order = [next(desktop_order, key) if key in SECTIONS else key for key in ordered_home(self.original)]
        hidden = [key for key in (self.original.get("hidden") or []) if key not in SECTIONS]
        hidden += [item.data(ROLE) for item in items if item.checkState() != Qt.CheckState.Checked]
        return {**self.original, "order": order, "hidden": hidden, "sort": self.sort.currentData(),
                "compact": self.compact.isChecked(), "hero": self.hero.isChecked()}

    def save(self):
        if not self.items.count():
            return
        bindings = dict(self.original_bindings)
        used = set()
        for action, field in self.key_fields.items():
            value = field.text().strip()
            keys = [] if value == "-" else [key.strip() for key in value.split(",") if key.strip()]
            mapped = [qt_key(key) for key in (keys or ([PAGE_KEYS[action][1]] if not value else []))]
            if any(key is None for key in mapped):
                self.notice.setText("One or more page shortcuts are invalid. Use key names such as Ctrl+J or ArrowRight.")
                return
            canonical = {key.toString() for key in mapped}
            if len(canonical) != len(mapped) or used & canonical:
                self.notice.setText("Each page shortcut can only be assigned once.")
                return
            used.update(canonical)
            if value:
                bindings[action] = keys
            else:
                bindings.pop(action, None)
        def saved(prefs):
            self.remove_local(refresh=False)
            self.preferences_changed.emit(prefs)
            self.notice.setText("Home and reading preferences saved to your account.")
        self.request("PUT", "/api/me/prefs", saved, {"home": self.value(), "spoilerSafe": self.spoiler.isChecked(),
                                                     "einkMode": self.eink.isChecked(), "keybinds": bindings or None})

    def save_local(self):
        key = self.local_key()
        if key and self.items.count():
            self.settings.setValue(key, self.value())
            self.settings.sync()
            self.preferences_changed.emit({})
            self.notice.setText("Home layout saved for this desktop. Use Save to account to update reading preferences.")

    def remove_local(self, refresh=True):
        key = self.local_key()
        if key:
            self.settings.remove(key)
            self.settings.sync()
            if refresh:
                self.preferences_changed.emit({})
                self.reload()
