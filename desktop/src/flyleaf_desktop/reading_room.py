"""Native reading-room surfaces and navigation inspired by Flyleaf's expressive.css."""
from PySide6.QtCore import QRectF, QSize, Qt, Signal
from PySide6.QtGui import QColor, QFont, QPainter, QPainterPath, QPen
from PySide6.QtWidgets import QFrame, QHBoxLayout, QStyledItemDelegate, QVBoxLayout, QWidget, QPushButton
from .material import colors, draw_symbol, symbol, ui_px
from .widgets import label


class RoomArt(QWidget):
    def __init__(self):
        super().__init__()
        self.setMinimumWidth(140)
        self.setMaximumWidth(220)
        self.setAccessibleName("Decorative open book on an expressive flower shape")

    def paintEvent(self, event):
        p = QPainter(self)
        p.setRenderHint(QPainter.RenderHint.Antialiasing)
        side = min(self.width(), self.height()) * .9
        p.translate(self.width() / 2, self.height() / 2)
        p.scale(side / 180, side / 180)
        c = colors()
        p.setPen(Qt.PenStyle.NoPen)
        p.setBrush(QColor(c["surface"]))
        for angle in range(0, 360, 60):
            p.save(); p.rotate(angle); p.drawEllipse(QRectF(-44, -86, 88, 118)); p.restore()
        p.rotate(-10)
        p.translate(-43, -43)
        p.scale(3.6, 3.6)
        p.setBrush(Qt.BrushStyle.NoBrush)
        p.setPen(QPen(QColor(c["primary"]), 1.2, Qt.PenStyle.SolidLine, Qt.PenCapStyle.RoundCap, Qt.PenJoinStyle.RoundJoin))
        draw_symbol(p, "book")
        p.end()


class RoomHero(QFrame):
    browse_requested = Signal()

    def __init__(self):
        super().__init__()
        self.setObjectName("homeHero")
        self.setMaximumHeight(248)
        row = QHBoxLayout(self)
        row.setContentsMargins(26, 20, 20, 20)
        copy = QVBoxLayout()
        copy.setSpacing(8)
        eyebrow = label("YOUR PERSONAL READING ROOM")
        eyebrow.setObjectName("eyebrow")
        copy.addWidget(eyebrow)
        title = label("Your next chapter starts here.", wrap=True)
        title.setProperty("role", "headline")
        copy.addWidget(title)
        caption = label("A familiar story, or a new favourite. Make a little time for yourself.", wrap=True)
        caption.setMaximumWidth(470)
        copy.addWidget(caption)
        browse = QPushButton("Browse library")
        browse.setProperty("primary", True)
        browse.setIcon(symbol("book", "onPrimary"))
        browse.clicked.connect(self.browse_requested)
        copy.addWidget(browse, alignment=Qt.AlignmentFlag.AlignLeft)
        row.addLayout(copy, 3)
        self.art = RoomArt()
        row.addWidget(self.art, 1)

    def resizeEvent(self, event):
        super().resizeEvent(event)
        self.art.setVisible(self.width() >= 560)


class NavigationDelegate(QStyledItemDelegate):
    def sizeHint(self, option, index):
        return QSize(0, ui_px(56))

    def paint(self, p, option, index):
        from PySide6.QtWidgets import QStyle
        c = colors()
        area = QRectF(option.rect).adjusted(2, 3, -2, -3)
        selected = bool(option.state & QStyle.StateFlag.State_Selected)
        hover = bool(option.state & QStyle.StateFlag.State_MouseOver)
        p.save(); p.setRenderHint(QPainter.RenderHint.Antialiasing)
        p.setPen(Qt.PenStyle.NoPen)
        if selected or hover:
            p.setBrush(QColor(c["primaryContainer"] if selected else c["surfaceHighest"]))
            p.drawRoundedRect(area, 20, 20)
        if option.state & QStyle.StateFlag.State_HasFocus:
            p.setBrush(Qt.BrushStyle.NoBrush); p.setPen(QPen(QColor(c["primary"]), 2))
            p.drawRoundedRect(area.adjusted(1, 1, -1, -1), 20, 20)
        value = index.data(Qt.ItemDataRole.UserRole)
        mode = value[0] if value else "library"
        name = {"home": "home", "want": "bookmark", "finder": "search"}.get(mode, "library")
        compact = area.width() < ui_px(110)
        x = area.center().x() - ui_px(12) if compact else area.left() + ui_px(14)
        p.save(); p.translate(x, area.center().y() - ui_px(12)); p.scale(ui_px(24) / 24, ui_px(24) / 24)
        p.setPen(QPen(QColor(c["onPrimaryContainer"] if selected else c["onSurfaceVariant"]), 1.8, Qt.PenStyle.SolidLine, Qt.PenCapStyle.RoundCap, Qt.PenJoinStyle.RoundJoin))
        p.setBrush(Qt.BrushStyle.NoBrush); draw_symbol(p, name)
        p.restore()
        if not compact:
            font = QFont(option.font); font.setWeight(QFont.Weight.DemiBold if selected else QFont.Weight.Medium)
            p.setFont(font); p.setPen(QColor(c["onPrimaryContainer"] if selected else c["onSurface"]))
            rect = option.rect.adjusted(ui_px(54), 0, -ui_px(12), 0)
            caption = option.fontMetrics.elidedText(str(index.data() or ""), Qt.TextElideMode.ElideRight, rect.width())
            p.drawText(rect, Qt.AlignmentFlag.AlignVCenter, caption)
        p.restore()
