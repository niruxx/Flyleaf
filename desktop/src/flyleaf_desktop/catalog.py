"""Preferences shared with the Flyleaf web catalog."""

from PySide6.QtWidgets import QCheckBox, QComboBox, QDialog, QDialogButtonBox, QFormLayout, QVBoxLayout

from .widgets import label

DEFAULTS = {"startPage": "home", "cardSize": "standard", "sort": "default", "showCovers": True}
PAGES = [("Home", "home"), ("Library", "library"), ("Want to read", "want")]
SIZES = [("Compact", "compact"), ("Standard", "standard"), ("Large", "large")]
SORTS = [("Title A–Z", "name"), ("Title Z–A", "name_desc"), ("Author", "author"),
         ("Recently added", "added"), ("Recently read", "read"), ("Recently updated", "updated")]


def catalog_prefs(user):
    prefs = (user.get("prefs") or {}).get("catalog")
    return {**DEFAULTS, **prefs} if isinstance(prefs, dict) else DEFAULTS.copy()


class CatalogDialog(QDialog):
    def __init__(self, parent, api, user, applied):
        super().__init__(parent)
        self.api = api
        self.user = user
        self.applied = applied
        self.initial = catalog_prefs(user)
        self.setWindowTitle("Catalog preferences")
        self.setMinimumWidth(370)
        layout = QVBoxLayout(self)
        form = QFormLayout()
        self.choices = {}
        for key, title, options in [("startPage", "&Start page", PAGES), ("cardSize", "&Card size", SIZES),
                                    ("sort", "Default library &sort", [("Use app default", "default"), *SORTS])]:
            choice = QComboBox(self)
            for text, value in options:
                choice.addItem(text, value)
            form.addRow(title, choice)
            self.choices[key] = choice
        self.covers = QCheckBox("Show cover art on catalog cards", self)
        form.addRow(self.covers)
        layout.addLayout(form)
        self.status = label(wrap=True)
        layout.addWidget(self.status)
        standard = QDialogButtonBox.StandardButton
        self.buttons = QDialogButtonBox(standard.Save | standard.Cancel | standard.RestoreDefaults)
        self.buttons.accepted.connect(self.save)
        self.buttons.rejected.connect(self.reject)
        self.buttons.button(standard.RestoreDefaults).clicked.connect(lambda: self.fill(DEFAULTS))
        layout.addWidget(self.buttons)
        self.fill(self.initial)

    def fill(self, prefs):
        for key, choice in self.choices.items():
            choice.setCurrentIndex(max(0, choice.findData(prefs[key])))
        self.covers.setChecked(prefs["showCovers"] is not False)

    def save(self):
        current = {key: choice.currentData() for key, choice in self.choices.items()}
        current["showCovers"] = self.covers.isChecked()
        changes = {key: value for key, value in current.items() if value != self.initial[key]}
        if not changes:
            self.accept()
            return
        self.buttons.setEnabled(False)
        self.status.setText("Saving…")

        def failed(error):
            if self.isVisible():
                self.status.setText(error.message)
                self.buttons.setEnabled(True)

        def saved(data):
            if not self.isVisible():
                return
            if not isinstance(data, dict) or not isinstance(data.get("catalog"), dict):
                self.status.setText("Update the Flyleaf server to save catalog preferences.")
                self.buttons.setEnabled(True)
                return
            self.user["prefs"] = {**(self.user.get("prefs") or {}), "catalog": data["catalog"]}
            self.applied()
            self.accept()

        self.api.json("PUT", "/api/me/prefs", saved, failed, {"catalog": changes})
