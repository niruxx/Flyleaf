"""Small native-widget helpers. Server-provided strings are always plain text."""

from PySide6.QtCore import QBuffer, QByteArray, QIODevice, QRect, QRectF, QSize, Qt, QEvent, QPersistentModelIndex, QVariantAnimation, QEasingCurve
from PySide6.QtGui import QFont, QIcon, QImage, QImageReader, QPalette, QColor, QPainter, QPainterPath, QPen
from PySide6.QtWidgets import QApplication, QLabel, QStyle, QStyledItemDelegate, QStyleOptionViewItem, QSizePolicy
from .material import colors, ui_px


class WrappedLabel(QLabel):
    """Keep native wrapped text readable when a layout assigns a narrow width."""

    def _fit_height(self) -> None:
        # QLabel.heightForWidth includes its existing minimum height. Reset it
        # before measuring so a temporarily narrow layout cannot lock in tall text.
        self.setMinimumHeight(0)
        self.setMinimumHeight(max(0, self.heightForWidth(max(1, self.width()))))

    def setText(self, value: str) -> None:
        super().setText(value)
        self._fit_height()
        if self.property("collapseEmpty"):
            self.setVisible(bool(value))

    def clear(self):
        self.setText("")

    def resizeEvent(self, event) -> None:
        super().resizeEvent(event)
        self._fit_height()


class CoverDelegate(QStyledItemDelegate):
    """Tonal book cards with clipped artwork, focus rings and short hover lift."""
    def __init__(self, view, appearance=None):
        super().__init__(view)
        self.view, self.appearance = view, appearance
        self.hovered = QPersistentModelIndex()
        self.lift = 0.0
        self.animation = QVariantAnimation(self)
        self.animation.setDuration(150)
        self.animation.setEasingCurve(QEasingCurve.Type.OutCubic)
        self.animation.valueChanged.connect(self._animate)
        view.setMouseTracking(True)
        view.viewport().installEventFilter(self)
        if appearance:
            appearance.changed.connect(self.stop_motion)

    def _animate(self, value):
        self.lift = float(value)
        self.view.viewport().update()

    def stop_motion(self):
        self.animation.stop()
        self.lift = 0.0
        self.hovered = QPersistentModelIndex()
        self.view.viewport().update()

    def eventFilter(self, watched, event):
        if event.type() == QEvent.Type.MouseMove:
            target = QPersistentModelIndex(self.view.indexAt(event.position().toPoint()))
            if target != self.hovered:
                self.hovered = target
                self.animation.stop()
                self.lift = 0
                if target.isValid() and self.appearance and self.appearance.motion_enabled:
                    self.animation.setStartValue(0.0); self.animation.setEndValue(3.0)
                    self.animation.start()
                self.view.viewport().update()
        elif event.type() in (QEvent.Type.Leave, QEvent.Type.Hide):
            self.stop_motion()
        return False

    def sizeHint(self, option, index) -> QSize:
        return QSize(ui_px(184), ui_px(286))

    def paint(self, painter, option, index) -> None:
        native = QStyleOptionViewItem(option)
        self.initStyleOption(native, index)
        artwork, lines = QIcon(native.icon), native.text.splitlines()
        c = colors()
        selected = bool(option.state & QStyle.StateFlag.State_Selected)
        hover = index == self.hovered
        scale = ui_px(1000) / 1000
        area = QRectF(0, 0, option.rect.width() / scale, option.rect.height() / scale).adjusted(4, 4, -4, -4)
        if hover:
            area.translate(0, -self.lift)
        painter.save()
        painter.translate(option.rect.topLeft())
        painter.scale(scale, scale)
        painter.setRenderHint(QPainter.RenderHint.Antialiasing)
        painter.setPen(Qt.PenStyle.NoPen)
        painter.setBrush(QColor(c["primaryContainer"] if selected else c["surfaceHighest"] if hover else c["surfaceLow"]))
        painter.drawRoundedRect(area, 22, 22)
        if selected or option.state & QStyle.StateFlag.State_HasFocus:
            painter.setBrush(Qt.BrushStyle.NoBrush)
            painter.setPen(QPen(QColor(c["primary"]), 2))
            painter.drawRoundedRect(area.adjusted(1, 1, -1, -1), 22, 22)
        cover = QRectF(area.center().x() - 64, area.top() + 12, 128, 180)
        painter.setPen(Qt.PenStyle.NoPen)
        painter.setBrush(QColor(0, 0, 0, 24))
        painter.drawRoundedRect(cover.translated(0, 3), 12, 12)
        painter.save()
        clip = QPainterPath(); clip.addRoundedRect(cover, 12, 12)
        painter.setClipPath(clip)
        artwork.paint(painter, cover.toRect(), Qt.AlignmentFlag.AlignCenter)
        painter.restore()
        ink = c["onPrimaryContainer"] if selected else c["onSurface"]
        painter.setPen(QColor(ink))
        title_font = QFont(option.font); title_font.setPixelSize(15); title_font.setWeight(QFont.Weight.DemiBold)
        painter.setFont(title_font)
        caption = QRectF(area.left() + 12, cover.bottom() + 11, area.width() - 24, 40)
        painter.drawText(caption, Qt.TextFlag.TextWordWrap | Qt.AlignmentFlag.AlignTop, lines[0] if lines else "")
        author_font = QFont(option.font); author_font.setPixelSize(12)
        painter.setFont(author_font)
        painter.setPen(QColor(c["onPrimaryContainer"] if selected else c["onSurfaceVariant"]))
        author = painter.fontMetrics().elidedText(lines[1] if len(lines) > 1 else "", Qt.TextElideMode.ElideRight, round(caption.width()))
        painter.drawText(QRectF(caption.left(), area.bottom() - 29, caption.width(), 17), Qt.AlignmentFlag.AlignVCenter, author)
        record = index.data(Qt.ItemDataRole.UserRole) or {}
        progress = record.get("data", {}).get("progress")
        percent = progress.get("percent", 0) if isinstance(progress, dict) else progress if isinstance(progress, (int, float)) else 0
        if isinstance(percent, (int, float)) and percent > 0:
            track = QRectF(area.left() + 12, area.bottom() - 9, area.width() - 24, 3)
            painter.setPen(Qt.PenStyle.NoPen); painter.setBrush(QColor(c["secondaryContainer"]))
            painter.drawRoundedRect(track, 2, 2)
            painter.setBrush(QColor(c["primary"])); track.setWidth(track.width() * min(1, percent))
            painter.drawRoundedRect(track, 2, 2)
        painter.restore()


def text(value: object, fallback: str = "") -> str:
    return value[:4000] if isinstance(value, str) and value else fallback


def label(value: str = "", *, heading: bool = False, wrap: bool = False) -> QLabel:
    widget = WrappedLabel(value) if wrap else QLabel(value)
    widget.setTextFormat(Qt.TextFormat.PlainText)
    widget.setWordWrap(wrap)
    widget.setSizePolicy(QSizePolicy.Policy.Preferred, QSizePolicy.Policy.Fixed)
    if wrap and not value:
        widget.setProperty("collapseEmpty", True)
        widget.hide()
    if heading:
        widget.setProperty("heading", True)
        font = QFont(widget.font())
        font.setPixelSize(26)
        font.setWeight(QFont.Weight.DemiBold)
        widget.setFont(font)
    return widget


def decode_image(payload: bytes, *, thumbnail: bool = False) -> QImage:
    source = QBuffer()
    source.setData(QByteArray(payload))
    source.open(QIODevice.OpenModeFlag.ReadOnly)
    reader = QImageReader(source)
    reader.setAutoTransform(True)
    size = reader.size()
    if not size.isValid() or size.width() * size.height() > 40_000_000:
        raise ValueError("This image is invalid or exceeds the 40-megapixel reader limit.")
    if thumbnail:
        reader.setScaledSize(size.scaled(QSize(384, 540), Qt.AspectRatioMode.KeepAspectRatio))
    image = reader.read()
    if image.isNull():
        raise ValueError("This image format is not supported by the installed Qt image plugins.")
    return image
