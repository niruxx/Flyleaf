"""First-run welcome and device preferences, painted entirely with Qt."""
import math

from PySide6.QtCore import Qt, QTimer, QRectF, Signal, QElapsedTimer, QSignalBlocker
from PySide6.QtGui import QColor, QFont, QPainter, QLinearGradient, QPen
from PySide6.QtWidgets import QCheckBox, QComboBox, QFrame, QHBoxLayout, QPushButton, QVBoxLayout, QWidget, QScrollArea

from .widgets import label
from .material import colors, symbol, PRESETS


class BookGarden(QWidget):
    """Quiet floating book artwork. Stop drawing frames when hidden or reduced."""
    def __init__(self, appearance):
        super().__init__()
        self.appearance = appearance
        self.setMinimumSize(250, 200)
        self.setAccessibleName("Illustration of an open book surrounded by stars")
        self.clock = QElapsedTimer()
        self.clock.start()
        self.timer = QTimer(self)
        self.timer.setInterval(33)
        self.timer.timeout.connect(self.update)
        appearance.changed.connect(self.sync_motion)

    def sync_motion(self):
        if self.isVisible() and not self.window().isMinimized() and self.appearance.motion_enabled:
            self.timer.start()
        else:
            self.timer.stop()
        self.update()

    def showEvent(self, event):
        super().showEvent(event)
        self.sync_motion()

    def hideEvent(self, event):
        self.timer.stop()
        super().hideEvent(event)

    def paintEvent(self, event):
        p = QPainter(self)
        p.setRenderHint(QPainter.RenderHint.Antialiasing)
        side = min(self.width(), self.height())
        p.translate(self.width() / 2, self.height() / 2)
        p.scale(side / 320, side / 320)
        phase = self.clock.elapsed() / 1500 if self.appearance.motion_enabled else 0
        p.translate(0, math.sin(phase) * 4)
        p.setPen(Qt.PenStyle.NoPen)
        c = colors()
        p.setBrush(QColor(c["surface"]))
        for angle in range(0, 360, 60):
            p.save(); p.rotate(angle + math.sin(phase) * 2)
            p.drawEllipse(QRectF(-67, -145, 134, 200)); p.restore()
        for x, y, size in [(-106, -82, 5), (112, -48, 7), (88, 94, 4), (-111, 55, 3)]:
            p.setPen(QPen(QColor(c["primary"]), 2))
            p.drawLine(x - size, y, x + size, y)
            p.drawLine(x, y - size, x, y + size)
        p.rotate(-9)
        p.setPen(Qt.PenStyle.NoPen)
        p.setBrush(QColor(c["primary"]))
        p.drawRoundedRect(QRectF(-102, -67, 204, 142), 12, 12)
        gradient = QLinearGradient(-90, 0, 90, 0)
        gradient.setColorAt(0, QColor(c["surfaceLow"]))
        gradient.setColorAt(0.49, QColor(c["secondaryContainer"]))
        gradient.setColorAt(0.51, QColor(c["surfaceHighest"]))
        gradient.setColorAt(1, QColor(c["surface"]))
        p.setBrush(gradient)
        p.drawRoundedRect(QRectF(-94, -74, 188, 136), 8, 8)
        p.setPen(QPen(QColor(c["primary"]), 2))
        p.drawLine(0, -68, 0, 57)
        for y in range(-42, 40, 16):
            p.drawLine(-72, y, -22, y)
            p.drawLine(21, y, 72, y)
        p.setPen(QPen(QColor(c["onTertiaryContainer"]), 7))
        p.drawLine(58, -73, 58, -26)
        p.end()


def primary(button):
    button.setProperty("primary", True)
    button.setMinimumHeight(44)
    return button


class WelcomePage(QWidget):
    continue_requested = Signal()

    def __init__(self, appearance):
        super().__init__()
        layout = QVBoxLayout(self)
        layout.setContentsMargins(28, 16, 28, 24)
        layout.setSpacing(16)
        hero_frame = QFrame()
        hero_frame.setObjectName("welcomeHero")
        hero = QHBoxLayout(hero_frame)
        hero.setContentsMargins(36, 32, 28, 32)
        hero.setSpacing(20)
        words = QVBoxLayout()
        words.setSpacing(16)
        words.addStretch()
        eyebrow = label("WELCOME TO FLYLEAF")
        eyebrow.setObjectName("eyebrow")
        words.addWidget(eyebrow)
        title = label("Your library.\nA little closer.")
        title.setProperty("role", "display")
        words.addWidget(title)
        subtitle = label("A quiet home for big adventures. Connect to your Flyleaf server and pick up where your story left off.", wrap=True)
        subtitle.setMaximumWidth(460)
        subtitle.setProperty("muted", True)
        words.addWidget(subtitle)
        words.addSpacing(18)
        self.start_button = primary(QPushButton("Make yourself at home  →"))
        self.start_button.setAccessibleName("Get started with Flyleaf setup")
        self.start_button.setIcon(symbol("arrow", "onPrimary"))
        self.start_button.clicked.connect(self.continue_requested)
        words.addWidget(self.start_button, alignment=Qt.AlignmentFlag.AlignLeft)
        words.addStretch()
        hero.addLayout(words, 3)
        self.art = BookGarden(appearance)
        hero.addWidget(self.art, 2)
        layout.addWidget(hero_frame, 1)
        features = QHBoxLayout()
        for number, title, description in [("01", "Your collection", "Connect to the server you call home."), ("02", "Your place, saved", "Reading progress follows your account."), ("03", "Your kind of calm", "Choose your palette and motion settings.")]:
            card = QFrame()
            card.setProperty("feature", str(int(number) - 1))
            content = QVBoxLayout(card)
            content.setContentsMargins(18, 16, 18, 16)
            badge = label(number + " / " + title.upper())
            badge.setProperty("role", "caption")
            content.addWidget(badge)
            caption = label(description, wrap=True)
            caption.setProperty("muted", True)
            content.addWidget(caption)
            features.addWidget(card, 1)
        layout.addLayout(features)


class PersonalizePage(QWidget):
    finished = Signal()

    def __init__(self, appearance):
        super().__init__()
        self.appearance = appearance
        outer = QVBoxLayout(self)
        outer.setContentsMargins(36, 20, 36, 20)
        card = QFrame()
        card.setObjectName("setupCard")
        card.setMaximumWidth(560)
        content = QVBoxLayout(card)
        content.setContentsMargins(32, 28, 32, 28)
        content.setSpacing(16)
        step = label("03 / MAKE IT YOURS")
        step.setObjectName("eyebrow")
        content.addWidget(step)
        content.addWidget(label("Settle into your space", heading=True, wrap=True))
        content.addWidget(label("You're connected. Choose a comfortable look before opening your library. You can change these settings anytime in View.", wrap=True))
        self.theme = QComboBox()
        self.theme.setAccessibleName("Color theme")
        for title, value in [("Dark", "dark"), ("Light", "light"), ("Follow system", "system")]:
            self.theme.addItem(title, value)
        self.theme.setCurrentIndex(max(0, self.theme.findData(appearance.theme)))
        self.theme.currentIndexChanged.connect(lambda _: appearance.configure(theme=self.theme.currentData()))
        content.addWidget(label("Color theme"))
        content.addWidget(self.theme)
        self.palette = QComboBox()
        self.palette.setAccessibleName("Material color palette")
        for value in PRESETS:
            self.palette.addItem(value.title(), value)
        self.palette.setCurrentIndex(max(0, self.palette.findData(appearance.preset)))
        self.palette.currentIndexChanged.connect(lambda _: appearance.configure(preset=self.palette.currentData()))
        content.addWidget(label("Color palette"))
        content.addWidget(self.palette)
        self.reduce_motion = QCheckBox("Reduce motion and animated effects")
        self.reduce_motion.setChecked(appearance.reduce_motion)
        self.reduce_motion.toggled.connect(lambda value: appearance.configure(reduce_motion=value))
        content.addWidget(self.reduce_motion)
        note = label("System reduced-motion preferences are also respected. Your appearance choices are saved on this computer.", wrap=True)
        note.setProperty("muted", True)
        content.addWidget(note)
        self.finish_button = primary(QPushButton("Open my library  →"))
        self.finish_button.clicked.connect(self.finished)
        content.addWidget(self.finish_button)
        scroll = QScrollArea()
        scroll.setWidgetResizable(True)
        host = QWidget()
        centered = QVBoxLayout(host)
        centered.addStretch()
        centered.addWidget(card, alignment=Qt.AlignmentFlag.AlignHCenter)
        centered.addStretch()
        scroll.setWidget(host)
        outer.addWidget(scroll, 1)
        appearance.changed.connect(self.sync_preferences)

    def sync_preferences(self):
        with QSignalBlocker(self.theme), QSignalBlocker(self.reduce_motion), QSignalBlocker(self.palette):
            self.theme.setCurrentIndex(max(0, self.theme.findData(self.appearance.theme)))
            self.reduce_motion.setChecked(self.appearance.reduce_motion)
            self.palette.setCurrentIndex(max(0, self.palette.findData(self.appearance.preset)))
