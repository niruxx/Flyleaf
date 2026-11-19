"""Brief, paint-only hover feedback shared by buttons across every screen."""
from PySide6.QtCore import QEvent, QObject, Property, QPropertyAnimation, QEasingCurve, Qt
from PySide6.QtGui import QPainter, QPen
from PySide6.QtWidgets import QApplication, QAbstractButton, QWidget


class ButtonHalo(QWidget):
    def __init__(self, button):
        super().__init__(button)
        self.setAttribute(Qt.WidgetAttribute.WA_TransparentForMouseEvents)
        self.level = 0.0
        self.animation = QPropertyAnimation(self, b"strength", self)
        self.animation.setDuration(140)
        self.animation.setEasingCurve(QEasingCurve.Type.OutCubic)
        self.setGeometry(button.rect())
        self.show()

    def get_strength(self):
        return self.level

    def set_strength(self, value):
        self.level = value
        self.update()

    strength = Property(float, get_strength, set_strength)

    def animate_to(self, value):
        self.animation.stop()
        self.animation.setStartValue(self.level)
        self.animation.setEndValue(value)
        self.animation.start()

    def clear(self):
        self.animation.stop()
        self.set_strength(0)

    def paintEvent(self, event):
        if self.level <= 0:
            return
        painter = QPainter(self)
        painter.setRenderHint(QPainter.RenderHint.Antialiasing)
        color = self.palette().highlight().color()
        color.setAlphaF(self.level * 0.65)
        painter.setPen(QPen(color, 2))
        painter.setBrush(Qt.BrushStyle.NoBrush)
        painter.drawRoundedRect(self.rect().adjusted(2, 2, -2, -2), 8, 8)
        painter.end()


class MotionFeedback(QObject):
    def __init__(self, window, appearance):
        super().__init__(window)
        self.window = window
        self.appearance = appearance
        QApplication.instance().installEventFilter(self)
        appearance.changed.connect(self.clear)

    def clear(self):
        for halo in self.window.findChildren(ButtonHalo):
            halo.clear()

    def eventFilter(self, widget, event):
        if not isinstance(widget, QAbstractButton) or widget.window() is not self.window:
            return False
        halo = getattr(widget, "_flyleaf_halo", None)
        kind = event.type()
        if kind in (QEvent.Type.Enter, QEvent.Type.FocusIn) and self.appearance.motion_enabled and widget.isEnabled():
            if halo is None:
                halo = widget._flyleaf_halo = ButtonHalo(widget)
            halo.animate_to(1.0)
        elif halo is not None:
            if kind in (QEvent.Type.Hide, QEvent.Type.EnabledChange):
                halo.clear()
            elif kind == QEvent.Type.Resize:
                halo.setGeometry(widget.rect())
            elif kind in (QEvent.Type.Leave, QEvent.Type.FocusOut):
                if self.appearance.motion_enabled:
                    halo.animate_to(0.0)
                else:
                    halo.clear()
        return False
