"""Brief, paint-only hover feedback shared by buttons across every screen."""
from PySide6.QtCore import QEvent, QObject, Property, QPropertyAnimation, QEasingCurve, Qt, QRectF, QPointF
from PySide6.QtGui import QPainter, QPen, QPainterPath, QColor
from PySide6.QtWidgets import QApplication, QAbstractButton, QWidget
from .material import colors
from shiboken6 import isValid


class ButtonHalo(QWidget):
    def __init__(self, button):
        super().__init__(button)
        self.setAttribute(Qt.WidgetAttribute.WA_TransparentForMouseEvents)
        self.level = 0.0
        self.animation = QPropertyAnimation(self, b"strength", self)
        self.animation.setDuration(140)
        self.animation.setEasingCurve(QEasingCurve.Type.OutCubic)
        self.phase = 1.0
        self.origin = QPointF()
        self.ripple_animation = QPropertyAnimation(self, b"ripplePhase", self)
        self.ripple_animation.setDuration(350)
        self.ripple_animation.setEasingCurve(QEasingCurve.Type.OutCubic)
        self.setGeometry(button.rect())
        self.show()

    def get_strength(self):
        return self.level

    def set_strength(self, value):
        self.level = value
        self.update()

    strength = Property(float, get_strength, set_strength)

    def get_phase(self):
        return self.phase

    def set_phase(self, phase):
        self.phase = phase
        self.update()

    ripplePhase = Property(float, get_phase, set_phase)

    def ripple(self, origin):
        self.origin = origin
        self.ripple_animation.stop()
        self.ripple_animation.setStartValue(0.0)
        self.ripple_animation.setEndValue(1.0)
        self.ripple_animation.start()

    def animate_to(self, value):
        self.animation.stop()
        self.animation.setStartValue(self.level)
        self.animation.setEndValue(value)
        self.animation.start()

    def clear(self):
        self.animation.stop()
        self.ripple_animation.stop()
        self.phase = 1.0
        self.set_strength(0)

    def paintEvent(self, event):
        if self.level <= 0 and self.phase >= 1:
            return
        painter = QPainter(self)
        painter.setRenderHint(QPainter.RenderHint.Antialiasing)
        area = QRectF(self.rect()).adjusted(2, 2, -2, -2)
        radius = min(22, area.height() / 2)
        clip = QPainterPath(); clip.addRoundedRect(area, radius, radius)
        painter.setClipPath(clip)
        color = QColor(colors()["onPrimary"] if self.parentWidget().property("primary") else colors()["primary"])
        color.setAlphaF(self.level * .07)
        painter.fillPath(clip, color)
        color.setAlphaF(self.level * .4)
        painter.setPen(QPen(color, 1.5)); painter.setBrush(Qt.BrushStyle.NoBrush)
        painter.drawRoundedRect(area, radius, radius)
        if self.phase < 1:
            color.setAlphaF((1 - self.phase) * .18)
            painter.setPen(Qt.PenStyle.NoPen); painter.setBrush(color)
            size = max(self.width(), self.height()) * self.phase * 1.3
            painter.drawEllipse(self.origin, size, size)
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
        kind = event.type()
        if kind not in (QEvent.Type.Enter, QEvent.Type.FocusIn, QEvent.Type.MouseButtonPress,
                         QEvent.Type.Hide, QEvent.Type.EnabledChange, QEvent.Type.Resize,
                         QEvent.Type.Leave, QEvent.Type.FocusOut) or not isValid(self.window):
            return False
        if not isinstance(widget, QAbstractButton) or not (widget.window() is self.window or self.window.isAncestorOf(widget)):
            return False
        halo = getattr(widget, "_flyleaf_halo", None)
        if kind in (QEvent.Type.Enter, QEvent.Type.FocusIn, QEvent.Type.MouseButtonPress) and self.appearance.motion_enabled and widget.isEnabled():
            if halo is None:
                halo = widget._flyleaf_halo = ButtonHalo(widget)
            halo.animate_to(1.0)
            if kind == QEvent.Type.MouseButtonPress and event.button() == Qt.MouseButton.LeftButton:
                halo.ripple(event.position())
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
