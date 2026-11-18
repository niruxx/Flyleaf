"""Shared native widget palette, short transitions and motion preferences."""
from PySide6.QtCore import QObject, Signal, QPropertyAnimation, QEasingCurve, Qt
from PySide6.QtGui import QColor, QPalette
from PySide6.QtWidgets import QApplication, QGraphicsOpacityEffect, QStackedWidget


class Appearance(QObject):
    changed = Signal()

    def __init__(self, settings, parent):
        super().__init__(parent)
        self.settings = settings
        self.theme = str(settings.value("appearance/theme", "dark"))
        self.reduce_motion = settings.value("appearance/reduceMotion", False, type=bool)
        self.style_hints = QApplication.styleHints()
        self.accessibility_hints = self.style_hints.accessibility()
        self.style_hints.colorSchemeChanged.connect(self.apply)
        self.accessibility_hints.motionPreferenceChanged.connect(self._motion_changed)
        self.apply()

    def _motion_changed(self):
        self.changed.emit()

    @property
    def motion_enabled(self):
        preference = self.accessibility_hints.motionPreference()
        return not self.reduce_motion and "Reduced" not in preference.name

    def configure(self, theme=None, reduce_motion=None):
        if theme in ("dark", "light", "system"):
            self.theme = theme
            self.settings.setValue("appearance/theme", theme)
        if reduce_motion is not None:
            self.reduce_motion = bool(reduce_motion)
            self.settings.setValue("appearance/reduceMotion", self.reduce_motion)
        self.settings.sync()
        self.apply()

    def apply(self):
        dark = self.theme == "dark" or (self.theme == "system" and self.style_hints.colorScheme() == Qt.ColorScheme.Dark)
        bg, surface, field = ("#11141d", "#1b2030", "#151a27") if dark else ("#f4f3fa", "#ffffff", "#f5f4fa")
        fg, muted, border = ("#f1efff", "#b7bfd4", "#343c53") if dark else ("#262238", "#625e76", "#dcd8eb")
        accent, hover = ("#c4b2ff", "#34304d") if dark else ("#6845b8", "#ece5ff")
        palette = QPalette()
        for role, value in [(QPalette.ColorRole.Window, bg), (QPalette.ColorRole.WindowText, fg),
                            (QPalette.ColorRole.Base, field), (QPalette.ColorRole.AlternateBase, surface),
                            (QPalette.ColorRole.Text, fg), (QPalette.ColorRole.Button, surface),
                            (QPalette.ColorRole.ButtonText, fg), (QPalette.ColorRole.Highlight, accent),
                            (QPalette.ColorRole.HighlightedText, "#151020" if dark else "#ffffff"),
                            (QPalette.ColorRole.ToolTipBase, surface), (QPalette.ColorRole.ToolTipText, fg),
                            (QPalette.ColorRole.PlaceholderText, muted), (QPalette.ColorRole.Link, accent)]:
            palette.setColor(role, QColor(value))
        palette.setColor(QPalette.ColorGroup.Disabled, QPalette.ColorRole.Text, QColor(muted))
        palette.setColor(QPalette.ColorGroup.Disabled, QPalette.ColorRole.ButtonText, QColor(muted))
        app = QApplication.instance()
        app.setPalette(palette)
        app.setStyleSheet(f"""
            QMainWindow, QDialog {{ background: {bg}; color: {fg}; }}
            QWidget {{ color: {fg}; selection-background-color: {accent}; }}
            QLabel {{ background: transparent; }}
            QLabel[muted="true"], QLabel#eyebrow {{ color: {muted}; }}
            QLabel#eyebrow {{ font-size: 11px; font-weight: 700; letter-spacing: 2px; }}
            QFrame#setupCard {{ background: {surface}; border: 1px solid {border}; border-radius: 22px; }}
            QWidget#titleBar {{ background: {surface}; border-bottom: 1px solid {border}; }}
            QMenuBar, QMenu, QToolTip {{ background: {surface}; color: {fg}; border: 1px solid {border}; }}
            QMenu::item {{ padding: 9px 24px; }} QMenu::item:selected {{ background: {hover}; }}
            QLineEdit, QComboBox, QPlainTextEdit, QListWidget {{ background: {field}; border: 1px solid {border}; border-radius: 10px; padding: 9px; }}
            QLineEdit, QComboBox {{ min-height: 22px; }}
            QLineEdit:focus, QComboBox:focus, QPlainTextEdit:focus, QListWidget:focus {{ border: 1px solid {accent}; }}
            QComboBox::drop-down {{ border: none; width: 22px; }}
            QComboBox QAbstractItemView {{ background: {surface}; color: {fg}; selection-background-color: {hover}; }}
            QPushButton, QToolButton {{ background: {surface}; border: 1px solid {border}; border-radius: 9px; padding: 10px 16px; }}
            QPushButton:hover, QToolButton:hover {{ background: {hover}; border-color: {accent}; }}
            QPushButton:pressed, QToolButton:pressed {{ background: {border}; }}
            QPushButton:focus, QToolButton:focus {{ border: 2px solid {accent}; padding: 9px 15px; }}
            QPushButton[primary="true"] {{ background: {accent}; color: {"#171021" if dark else "#ffffff"}; font-weight: 600; border-color: {accent}; }}
            QPushButton[primary="true"]:hover {{ background: {"#d7caff" if dark else "#7955cc"}; }}
            QPushButton:disabled {{ color: {muted}; background: {field}; border-color: {border}; }}
            QToolButton#windowControl {{ border: none; border-radius: 0; padding: 0; min-width: 44px; min-height: 38px; }}
            QToolButton#closeControl:hover {{ background: #b93855; color: white; }}
            QToolButton#closeControl {{ border: none; border-radius: 0; padding: 0; min-width: 44px; min-height: 38px; }}
            QCheckBox {{ spacing: 10px; padding: 4px 0; }}
            QCheckBox::indicator {{ width: 17px; height: 17px; border: 1px solid {border}; border-radius: 4px; background: {field}; }}
            QCheckBox::indicator:checked {{ background: {accent}; border-color: {accent}; image: none; }}
            QListWidget::item {{ padding: 8px; border-radius: 7px; border: 1px solid transparent; }}
            QListWidget::item:hover {{ background: {hover}; }}
            QListWidget::item:selected {{ background: {hover}; color: {fg}; border-color: {accent}; }}
            QListWidget#libraryNavigation {{ background: {surface}; }}
            QListWidget#libraryNavigation::item {{ padding: 14px 10px; margin: 3px 0; }}
            QListWidget#seriesGrid {{ background: transparent; border: none; }}
            QScrollArea {{ border: none; background: {bg}; }}
            QScrollBar:vertical {{ background: transparent; width: 10px; margin: 0; }}
            QScrollBar::handle:vertical {{ background: {border}; border-radius: 5px; min-height: 28px; }}
            QScrollBar::add-line:vertical, QScrollBar::sub-line:vertical {{ height: 0; }}
            QScrollBar::add-page:vertical, QScrollBar::sub-page:vertical {{ background: transparent; }}
            QSplitter::handle {{ background: transparent; width: 14px; }}
            QProgressBar {{ border: none; background: {field}; border-radius: 3px; height: 5px; max-height: 5px; }}
            QProgressBar::chunk {{ background: {accent}; border-radius: 3px; }}
            QStatusBar {{ background: {bg}; color: {muted}; border-top: 1px solid {border}; }}
            QStatusBar::item {{ border: none; }}
        """)
        self.changed.emit()


class AnimatedStack(QStackedWidget):
    """Fade incoming content only; no snapshots retain signed-out account data."""
    def __init__(self, appearance):
        super().__init__()
        self.appearance = appearance
        self.animation = None
        self.effect_page = None
        appearance.changed.connect(self.finish_transition)

    def finish_transition(self):
        if self.animation:
            self.animation.stop()
            self.animation.deleteLater()
            self.animation = None
        if self.effect_page:
            self.effect_page.setGraphicsEffect(None)
            self.effect_page = None

    def setCurrentWidget(self, widget):
        if widget is self.currentWidget():
            return
        self.finish_transition()
        super().setCurrentWidget(widget)
        if not self.appearance.motion_enabled or not self.isVisible():
            return
        effect = QGraphicsOpacityEffect(widget)
        widget.setGraphicsEffect(effect)
        self.effect_page = widget
        self.animation = QPropertyAnimation(effect, b"opacity", self)
        self.animation.setDuration(220)
        self.animation.setStartValue(0.15)
        self.animation.setEndValue(1.0)
        self.animation.setEasingCurve(QEasingCurve.Type.OutCubic)
        self.animation.finished.connect(self.finish_transition)
        self.animation.start()

    def removeWidget(self, widget):
        if widget is self.effect_page:
            self.finish_transition()
        super().removeWidget(widget)
