"""Shared native widget palette, short transitions and motion preferences."""
from pathlib import Path
import re
from .material import PRESETS, install_font, scheme

from PySide6.QtCore import QObject, Signal, QPropertyAnimation, QEasingCurve, Qt
from PySide6.QtGui import QColor, QPalette
from PySide6.QtWidgets import QApplication, QGraphicsOpacityEffect, QStackedWidget


class Appearance(QObject):
    changed = Signal()

    def __init__(self, settings, parent):
        super().__init__(parent)
        self.settings = settings
        self.theme = str(settings.value("appearance/theme", "dark"))
        self.preset = str(settings.value("appearance/preset", "flyleaf"))
        self.ui_scale = max(1.0, min(2.0, settings.value("appearance/uiScale", 1.0, type=float)))
        install_font()
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

    def configure(self, theme=None, reduce_motion=None, preset=None, ui_scale=None):
        if theme in ("dark", "light", "system"):
            self.theme = theme
            self.settings.setValue("appearance/theme", theme)
        if reduce_motion is not None:
            self.reduce_motion = bool(reduce_motion)
            self.settings.setValue("appearance/reduceMotion", self.reduce_motion)
        if preset in PRESETS:
            self.preset = preset
            self.settings.setValue("appearance/preset", preset)
        if ui_scale is not None:
            self.ui_scale = max(1.0, min(2.0, float(ui_scale)))
            self.settings.setValue("appearance/uiScale", self.ui_scale)
        self.settings.sync()
        self.apply()

    def apply(self):
        dark = self.theme == "dark" or (self.theme == "system" and self.style_hints.colorScheme() == Qt.ColorScheme.Dark)
        c = scheme(dark, self.preset)
        self.colors = c
        bg, surface, field = c["surfaceLow"], c["surface"], c["surfaceHighest"]
        fg, muted, border = c["onSurface"], c["onSurfaceVariant"], c["outlineVariant"]
        accent, container, on_container = c["primary"], c["primaryContainer"], c["onPrimaryContainer"]
        secondary, on_secondary = c["secondaryContainer"], c["onSecondaryContainer"]
        palette = QPalette()
        for role, value in [(QPalette.ColorRole.Window, bg), (QPalette.ColorRole.WindowText, fg),
                            (QPalette.ColorRole.Base, surface), (QPalette.ColorRole.AlternateBase, bg),
                            (QPalette.ColorRole.Text, fg), (QPalette.ColorRole.Button, secondary),
                            (QPalette.ColorRole.ButtonText, on_secondary), (QPalette.ColorRole.Highlight, accent),
                            (QPalette.ColorRole.HighlightedText, c["onPrimary"]),
                            (QPalette.ColorRole.ToolTipBase, c["surfaceHigh"]), (QPalette.ColorRole.ToolTipText, fg),
                            (QPalette.ColorRole.PlaceholderText, muted), (QPalette.ColorRole.Link, accent)]:
            palette.setColor(role, QColor(value))
        for role in (QPalette.ColorRole.Text, QPalette.ColorRole.ButtonText, QPalette.ColorRole.WindowText):
            palette.setColor(QPalette.ColorGroup.Disabled, role, QColor(muted))
        app = QApplication.instance()
        app.setProperty("uiScale", self.ui_scale)
        install_font(self.ui_scale)
        app.setProperty("materialColors", c)
        app.setPalette(palette)
        resources = Path(__file__).with_name("resources").as_posix()
        check = resources + ("/check-dark.svg" if dark else "/check-light.svg")
        stylesheet = f"""
            QMainWindow, QDialog {{ background: {bg}; color: {fg}; }}
            QWidget {{ color: {fg}; selection-background-color: {accent}; selection-color: {c['onPrimary']}; }}
            QLabel {{ background: transparent; }}
            QLabel[heading="true"] {{ font-size: 26px; }}
            QLabel[muted="true"] {{ color: {muted}; }}
            QLabel#eyebrow {{ color: {accent}; font-size: 11px; font-weight: 650; letter-spacing: 1.6px; }}
            QLabel[role="display"] {{ font-size: 46px; font-weight: 650; letter-spacing: -1.8px; }}
            QLabel[role="headline"] {{ font-size: 28px; font-weight: 650; letter-spacing: -0.7px; }}
            QLabel[role="title"] {{ font-size: 20px; font-weight: 600; letter-spacing: -0.4px; }}
            QLabel[role="caption"] {{ color: {muted}; font-size: 12px; }}
            QFrame#setupCard {{ background: {surface}; border: none; border-radius: 32px; }}
            QFrame#librarySurface, QFrame#readerToolbar, QFrame#readerNavigation {{ background: {surface}; border: none; border-radius: 28px; }}
            QFrame#detailPanel {{ background: {bg}; border: none; border-radius: 24px; }}
            QFrame#homeHero, QFrame#welcomeHero {{ background: {container}; border: none; border-radius: 32px; }}
            QFrame#homeHero QLabel, QFrame#welcomeHero QLabel {{ color: {on_container}; }}
            QFrame#homeHero QLabel#eyebrow, QFrame#welcomeHero QLabel#eyebrow {{ color: {on_container}; }}
            QFrame[feature="0"] {{ background: {container}; border-radius: 28px; }}
            QFrame[feature="1"] {{ background: {secondary}; border-radius: 28px; }}
            QFrame[feature="2"] {{ background: {c['tertiaryContainer']}; border-radius: 28px; }}
            QFrame[feature="0"] QLabel {{ color: {on_container}; }}
            QFrame[feature="1"] QLabel {{ color: {on_secondary}; }}
            QFrame[feature="2"] QLabel {{ color: {c['onTertiaryContainer']}; }}
            QWidget#titleBar {{ background: {bg}; border: none; }}
            QLabel#brandName {{ font-size: 22px; font-weight: 700; letter-spacing: -0.8px; }}
            QLabel#windowContext {{ color: {muted}; font-size: 12px; }}
            QMenuBar, QMenu {{ background: {c['surfaceHigh']}; color: {fg}; border: 1px solid {border}; border-radius: 16px; padding: 6px; }}
            QMenu::item {{ padding: 11px 26px; border-radius: 10px; }}
            QMenu::item:selected {{ background: {secondary}; color: {on_secondary}; }}
            QMenu::separator {{ height: 1px; background: {border}; margin: 6px 12px; }}
            QToolTip {{ background: {c['surfaceHigh']}; color: {fg}; border: none; padding: 8px 12px; }}
            QLineEdit, QComboBox {{ background: {field}; border: 1px solid transparent; border-radius: 12px; padding: 10px 12px; min-height: 24px; }}
            QLineEdit:hover, QComboBox:hover {{ border-color: {border}; }}
            QLineEdit:focus, QComboBox:focus {{ border: 2px solid {accent}; padding: 9px 11px; }}
            QLineEdit#librarySearch {{ border-radius: 24px; padding-left: 18px; min-height: 26px; }}
            QLineEdit#librarySearch:focus {{ padding-left: 17px; }}
            QComboBox::drop-down {{ border: none; width: 24px; }}
            QComboBox::down-arrow {{ image: url('{resources}/chevron.svg'); width: 12px; height: 12px; }}
            QComboBox QAbstractItemView {{ background: {c['surfaceHigh']}; color: {fg}; selection-background-color: {container}; selection-color: {on_container}; border: 1px solid {border}; padding: 6px; }}
            QPlainTextEdit, QListWidget {{ background: {bg}; border: 1px solid transparent; border-radius: 16px; padding: 8px; }}
            QPlainTextEdit:focus, QListWidget:focus {{ border-color: {accent}; }}
            QPlainTextEdit#seriesSummary {{ background: transparent; border: none; padding: 0; }}
            QPushButton, QToolButton {{ background: {secondary}; color: {on_secondary}; border: 1px solid transparent; border-radius: 22px; padding: 10px 18px; min-height: 22px; font-weight: 550; }}
            QPushButton:hover, QToolButton:hover {{ background: {c['surfaceHighest']}; border-color: {border}; }}
            QPushButton:pressed, QToolButton:pressed {{ background: {container}; color: {on_container}; }}
            QPushButton:focus, QToolButton:focus {{ border: 2px solid {accent}; padding: 9px 17px; }}
            QPushButton[primary="true"] {{ background: {accent}; color: {c['onPrimary']}; font-weight: 650; }}
            QPushButton[primary="true"]:hover {{ border-color: {c['onPrimary']}; }}
            QPushButton[kind="text"], QToolButton[kind="text"] {{ background: transparent; color: {accent}; }}
            QPushButton[kind="text"]:hover, QToolButton[kind="text"]:hover {{ background: {secondary}; }}
            QPushButton:disabled, QToolButton:disabled, QComboBox:disabled {{ color: {muted}; background: {c['surfaceContainer']}; border-color: transparent; }}
            QToolButton#windowControl, QToolButton#closeControl {{ background: transparent; border: none; border-radius: 18px; padding: 0; min-width: 40px; min-height: 36px; }}
            QToolButton#windowControl:hover {{ background: {secondary}; }}
            QToolButton#windowControl::menu-indicator {{ image: none; width: 0; }}
            QToolButton#closeControl:hover {{ background: #b93855; color: white; }}
            QCheckBox {{ spacing: 10px; padding: 6px 0; }}
            QTabWidget::pane {{ border: none; background: transparent; }}
            QTabBar::tab {{ background: transparent; color: {muted}; padding: 10px 16px; border-radius: 14px; margin: 3px; }}
            QTabBar::tab:selected {{ background: {container}; color: {on_container}; }}
            QTabBar::tab:hover {{ background: {c['surfaceHighest']}; }}
            QCheckBox::indicator, QListView::indicator {{ width: 18px; height: 18px; border: 2px solid {c['outline']}; border-radius: 5px; background: transparent; }}
            QCheckBox::indicator:checked, QListView::indicator:checked {{ background: {accent}; border-color: {accent}; image: url('{check}'); }}
            QCheckBox::indicator:focus {{ border-color: {accent}; }}
            QListWidget::item {{ padding: 10px; border-radius: 14px; border: 1px solid transparent; }}
            QListWidget::item:hover {{ background: {c['surfaceHighest']}; }}
            QListWidget::item:selected {{ background: {container}; color: {on_container}; }}
            QListWidget#libraryNavigation {{ background: transparent; border: none; padding: 0; }}
            QListWidget#libraryNavigation::item {{ padding: 0; margin: 0; }}
            QListWidget#seriesGrid {{ background: transparent; border: none; padding: 0; }}
            QScrollArea {{ border: none; background: transparent; }}
            QScrollBar:vertical {{ background: transparent; width: 8px; margin: 0; }}
            QScrollBar::handle:vertical {{ background: {border}; border-radius: 4px; min-height: 28px; }}
            QScrollBar::add-line:vertical, QScrollBar::sub-line:vertical {{ height: 0; }}
            QScrollBar::add-page:vertical, QScrollBar::sub-page:vertical {{ background: transparent; }}
            QSplitter::handle {{ background: transparent; width: 16px; }}
            QProgressBar {{ border: none; background: {secondary}; border-radius: 4px; height: 6px; max-height: 6px; }}
            QProgressBar::chunk {{ background: {accent}; border-radius: 4px; }}
            QStatusBar {{ background: {bg}; color: {muted}; border: none; font-size: 11px; padding-left: 12px; }}
            QStatusBar::item {{ border: none; }}
        """
        stylesheet = re.sub(r"(-?\d+(?:\.\d+)?)px", lambda m: f"{float(m.group(1)) * self.ui_scale:g}px", stylesheet)
        app.setStyleSheet(stylesheet)
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
