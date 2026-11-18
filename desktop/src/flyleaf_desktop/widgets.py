"""Small native-widget helpers. Server-provided strings are always plain text."""

from PySide6.QtCore import QBuffer, QByteArray, QIODevice, QRect, QSize, Qt
from PySide6.QtGui import QFont, QIcon, QImage, QImageReader, QPalette
from PySide6.QtWidgets import QApplication, QLabel, QStyle, QStyledItemDelegate, QStyleOptionViewItem


class WrappedLabel(QLabel):
    """Keep native wrapped text readable when a layout assigns a narrow width."""

    def _fit_height(self) -> None:
        self.setMinimumHeight(max(0, self.heightForWidth(max(1, self.width()))))

    def setText(self, value: str) -> None:
        super().setText(value)
        self._fit_height()

    def resizeEvent(self, event) -> None:
        super().resizeEvent(event)
        self._fit_height()


class CoverDelegate(QStyledItemDelegate):
    """Predictable cover/caption geometry while retaining native selection and focus."""

    def sizeHint(self, option, index) -> QSize:
        return QSize(160, 240)

    def paint(self, painter, option, index) -> None:
        native = QStyleOptionViewItem(option)
        self.initStyleOption(native, index)
        caption, artwork = native.text, QIcon(native.icon)
        native.text = ""
        native.icon = QIcon()
        native.features &= ~QStyleOptionViewItem.ViewItemFeature.HasDisplay
        native.features &= ~QStyleOptionViewItem.ViewItemFeature.HasDecoration
        style = native.widget.style() if native.widget else QApplication.style()
        style.drawControl(QStyle.ControlElement.CE_ItemViewItem, native, painter, native.widget)
        painter.save()
        area = option.rect.adjusted(6, 6, -6, -6)
        cover = QRect(area.center().x() - 56, area.top(), 112, 160)
        artwork.paint(painter, cover, Qt.AlignmentFlag.AlignCenter)
        selected = bool(option.state & QStyle.StateFlag.State_Selected)
        painter.setPen(option.palette.color(QPalette.ColorRole.Text))
        painter.setFont(option.font)
        caption_area = QRect(area.left(), cover.bottom() + 7, area.width(), max(1, area.bottom() - cover.bottom() - 6))
        painter.drawText(caption_area, Qt.AlignmentFlag.AlignHCenter | Qt.AlignmentFlag.AlignTop | Qt.TextFlag.TextWordWrap, caption)
        painter.restore()


def text(value: object, fallback: str = "") -> str:
    return value[:4000] if isinstance(value, str) and value else fallback


def label(value: str = "", *, heading: bool = False, wrap: bool = False) -> QLabel:
    widget = WrappedLabel(value) if wrap else QLabel(value)
    widget.setTextFormat(Qt.TextFormat.PlainText)
    widget.setWordWrap(wrap)
    if heading:
        font = QFont(widget.font())
        font.setPointSize(font.pointSize() + 7)
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
        reader.setScaledSize(size.scaled(QSize(224, 320), Qt.AspectRatioMode.KeepAspectRatio))
    image = reader.read()
    if image.isNull():
        raise ValueError("This image format is not supported by the installed Qt image plugins.")
    return image
