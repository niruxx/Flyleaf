"""Convert Flyleaf's shared reader key names to Qt shortcuts."""
from PySide6.QtGui import QKeySequence


PAGE_KEYS = {
    "pageRight": ("Page right", "ArrowRight"),
    "pageLeft": ("Page left", "ArrowLeft"),
    "next": ("Next page", "PageDown"),
    "prev": ("Previous page", "PageUp"),
    "first": ("First page", "Home"),
    "last": ("Last page", "End"),
}
ALIASES = {"ArrowRight": "Right", "ArrowLeft": "Left", "ArrowUp": "Up", "ArrowDown": "Down",
           "PageDown": "PgDown", "PageUp": "PgUp", "Escape": "Esc"}


def qt_key(value):
    if not isinstance(value, str) or not value or len(value) > 40:
        return None
    modifier, separator, key = value.rpartition("+") if not value.endswith("+") else ("", "", value)
    portable = modifier + separator + ALIASES.get(key, key)
    sequence = QKeySequence.fromString(portable, QKeySequence.SequenceFormat.PortableText)
    return sequence if sequence.count() == 1 and sequence.toString(QKeySequence.SequenceFormat.PortableText) else None


def page_keys(overrides):
    overrides = overrides if isinstance(overrides, dict) else {}
    for action, (_caption, default) in PAGE_KEYS.items():
        values = overrides.get(action)
        if not isinstance(values, list):
            values = [default]
        for value in values:
            sequence = qt_key(value)
            if sequence:
                yield action, sequence
