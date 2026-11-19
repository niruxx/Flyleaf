"""Native selectable word geometry over a rendered document page."""
from PySide6.QtCore import Qt, QRectF, Signal
from PySide6.QtGui import QPainter, QColor, QKeySequence, QShortcut
from PySide6.QtWidgets import QLabel, QApplication


class SelectionCanvas(QLabel):
    selected = Signal(str)

    def __init__(self):
        super().__init__("Loading…")
        self.words = []
        self.source_size = (1, 1)
        self.anchor = self.end = None
        self.selected_text = ""
        self.setAccessibleName("Document page; drag to select text")
        self.setFocusPolicy(Qt.FocusPolicy.StrongFocus)
        self.copy = QShortcut(QKeySequence.StandardKey.Copy, self)
        self.copy.activated.connect(lambda: QApplication.clipboard().setText(self.selected_text) if self.selected_text else None)

    def set_words(self, words, size):
        self.words, self.source_size = words, size
        self.anchor = self.end = None
        self.selected_text = ""
        self.update()

    def word_at(self, point):
        if not self.words:
            return None
        x = point.x() * self.source_size[0] / max(1, self.width())
        y = point.y() * self.source_size[1] / max(1, self.height())
        for index, word in enumerate(self.words):
            if QRectF(*word["rect"]).contains(x, y):
                return index
        return None

    def mousePressEvent(self, event):
        if event.button() == Qt.MouseButton.LeftButton:
            self.anchor = self.end = self.word_at(event.position())
            self.update_selection(); event.accept(); return
        super().mousePressEvent(event)

    def mouseMoveEvent(self, event):
        if event.buttons() & Qt.MouseButton.LeftButton and self.anchor is not None:
            found = self.word_at(event.position())
            if found is not None:
                self.end = found; self.update_selection()
            event.accept(); return
        super().mouseMoveEvent(event)

    def update_selection(self):
        if self.anchor is not None and self.end is not None:
            start, end = sorted((self.anchor, self.end))
            self.selected_text = " ".join(word["text"] for word in self.words[start:end + 1])
        else:
            self.selected_text = ""
        self.selected.emit(self.selected_text)
        self.update()

    def paintEvent(self, event):
        super().paintEvent(event)
        if self.anchor is None or self.end is None:
            return
        start, end = sorted((self.anchor, self.end))
        painter = QPainter(self)
        painter.scale(self.width() / self.source_size[0], self.height() / self.source_size[1])
        painter.setPen(Qt.PenStyle.NoPen); painter.setBrush(QColor(112, 161, 255, 90))
        for word in self.words[start:end + 1]:
            painter.drawRect(QRectF(*word["rect"]))
        painter.end()
