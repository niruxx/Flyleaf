"""Native Material 3 roles derived from Flyleaf's public/css/m3.css OKLCH tokens."""
import math
from pathlib import Path

from PySide6.QtCore import QRectF, Qt, QSize
from PySide6.QtGui import QColor, QFont, QFontDatabase, QIcon, QIconEngine, QPainter, QPainterPath, QPen, QPixmap
from PySide6.QtWidgets import QApplication

PRESETS = {"flyleaf": (268, 1.0), "ocean": (228, 1.0), "sakura": (350, .9),
           "forest": (150, .9), "ember": (40, 1.1), "graphite": (260, .08)}
_font_family = None


def install_font(scale=1.0):
    global _font_family
    if _font_family is None:
        path = Path(__file__).with_name("resources") / "fonts" / "RobotoFlex.ttf"
        identity = QFontDatabase.addApplicationFont(str(path))
        families = QFontDatabase.applicationFontFamilies(identity)
        _font_family = families[0] if families else "Segoe UI"
    font = QFont(_font_family)
    font.setPointSizeF(12.0 * scale)
    QApplication.instance().setFont(font)


def ui_px(value):
    """Logical UI units only. Qt applies monitor device-pixel scaling separately."""
    return round(value * float(QApplication.instance().property("uiScale") or 1.0))


def oklch(lightness, chroma, hue):
    """OKLCH → sRGB, matching the web app's seed palette without a web renderer."""
    angle = math.radians(hue)
    a, b = chroma * math.cos(angle), chroma * math.sin(angle)
    l = (lightness + .3963377774 * a + .2158037573 * b) ** 3
    m = (lightness - .1055613458 * a - .0638541728 * b) ** 3
    s = (lightness - .0894841775 * a - 1.291485548 * b) ** 3
    linear = (4.0767416621 * l - 3.3077115913 * m + .2309699292 * s,
              -1.2684380046 * l + 2.6097574011 * m - .3413193965 * s,
              -.0041960863 * l - .7034186147 * m + 1.707614701 * s)
    def channel(value):
        value = 12.92 * value if value <= .0031308 else 1.055 * value ** (1 / 2.4) - .055
        return round(max(0, min(1, value)) * 255)
    return QColor(*(channel(value) for value in linear)).name()


def scheme(dark, preset="flyleaf"):
    hue, strength = PRESETS.get(preset, PRESETS["flyleaf"])
    values = {
        "primary": (.81, .1) if dark else (.47, .15),
        "onPrimary": (.3, .1) if dark else (1, 0),
        "primaryContainer": (.39, .12) if dark else (.91, .055),
        "onPrimaryContainer": (.92, .05) if dark else (.31, .11),
        "secondaryContainer": (.37, .035) if dark else (.92, .03),
        "onSecondaryContainer": (.92, .025) if dark else (.32, .04),
        "surface": (.175, .008) if dark else (.985, .006),
        "surfaceLow": (.205, .009) if dark else (.965, .008),
        "surfaceContainer": (.225, .01) if dark else (.948, .009),
        "surfaceHigh": (.26, .011) if dark else (.93, .01),
        "surfaceHighest": (.295, .012) if dark else (.91, .011),
        "onSurface": (.91, .008) if dark else (.22, .012),
        "onSurfaceVariant": (.8, .016) if dark else (.43, .02),
        "outline": (.63, .016) if dark else (.6, .018),
        "outlineVariant": (.41, .015) if dark else (.84, .014),
    }
    result = {role: oklch(l, c * strength, hue) for role, (l, c) in values.items()}
    result["tertiaryContainer"] = oklch(.39 if dark else .92, (.08 if dark else .05) * strength, hue + 60)
    result["onTertiaryContainer"] = oklch(.92 if dark else .32, (.04 if dark else .08) * strength, hue + 60)
    return result


def colors():
    return QApplication.instance().property("materialColors") or scheme(False)


def draw_symbol(p, name):
    """Small rounded vector vocabulary; independent of installed icon fonts."""
    if name in ("book", "library"):
        path = QPainterPath()
        path.moveTo(12, 6); path.cubicTo(8, 3, 4, 4, 3, 5)
        path.lineTo(3, 19); path.cubicTo(7, 17, 9, 18, 12, 20)
        path.cubicTo(15, 18, 18, 17, 21, 19); path.lineTo(21, 5)
        path.cubicTo(17, 3, 15, 4, 12, 6); path.lineTo(12, 20)
        p.drawPath(path)
    elif name == "home":
        path = QPainterPath(); path.moveTo(3, 11); path.lineTo(12, 3); path.lineTo(21, 11)
        path.moveTo(5, 10); path.lineTo(5, 21); path.lineTo(10, 21); path.lineTo(10, 15)
        path.lineTo(14, 15); path.lineTo(14, 21); path.lineTo(19, 21); path.lineTo(19, 10)
        p.drawPath(path)
    elif name == "bookmark":
        path = QPainterPath(); path.moveTo(6, 3); path.lineTo(18, 3); path.lineTo(18, 21)
        path.lineTo(12, 17); path.lineTo(6, 21); path.closeSubpath(); p.drawPath(path)
    elif name == "search":
        p.drawEllipse(QRectF(3, 3, 13, 13)); p.drawLine(15, 15, 21, 21)
    elif name == "filter":
        for y, x in [(6, 15), (12, 8), (18, 16)]:
            p.drawLine(3, y, 21, y); p.drawEllipse(QRectF(x - 2, y - 2, 4, 4))
    elif name == "refresh":
        p.drawArc(QRectF(4, 4, 16, 16), 40 * 16, 290 * 16)
        p.drawLine(20, 3, 20, 9); p.drawLine(20, 9, 14, 9)
    elif name in ("arrow", "back"):
        if name == "back":
            p.translate(24, 0); p.scale(-1, 1)
        p.drawLine(4, 12, 20, 12); p.drawLine(14, 6, 20, 12); p.drawLine(14, 18, 20, 12)
    elif name == "play":
        path = QPainterPath(); path.moveTo(8, 4); path.lineTo(20, 12); path.lineTo(8, 20); path.closeSubpath(); p.drawPath(path)
    elif name == "person":
        p.drawEllipse(QRectF(8, 3, 8, 8)); p.drawArc(QRectF(4, 14, 16, 14), 0, 180 * 16)
    elif name == "server":
        for y in (3, 13):
            p.drawRoundedRect(QRectF(3, y, 18, 7), 2, 2); p.drawPoint(7, y + 3)
    elif name == "check":
        p.drawLine(5, 12, 10, 17); p.drawLine(10, 17, 20, 6)
    elif name == "sun":
        p.drawEllipse(QRectF(8, 8, 8, 8))
        for degree in range(0, 360, 45):
            p.save(); p.translate(12, 12); p.rotate(degree); p.drawLine(0, -9, 0, -7); p.restore()
    elif name == "spark":
        path = QPainterPath(); path.moveTo(12, 2); path.quadTo(13, 11, 22, 12)
        path.quadTo(13, 13, 12, 22); path.quadTo(11, 13, 2, 12); path.quadTo(11, 11, 12, 2); p.drawPath(path)
    else:
        p.drawRoundedRect(QRectF(4, 4, 16, 16), 5, 5)


class SymbolEngine(QIconEngine):
    def __init__(self, name, role="onSurface"):
        super().__init__(); self.name, self.role = name, role

    def clone(self):
        return SymbolEngine(self.name, self.role)

    def paint(self, painter, rect, mode, state):
        painter.save()
        side = min(rect.width(), rect.height())
        painter.translate(rect.center().x() - side / 2, rect.center().y() - side / 2)
        painter.scale(side / 24, side / 24)
        painter.setRenderHint(QPainter.RenderHint.Antialiasing)
        ink = colors()["onSurfaceVariant" if mode == QIcon.Mode.Disabled else self.role]
        painter.setPen(QPen(QColor(ink), 1.8, Qt.PenStyle.SolidLine, Qt.PenCapStyle.RoundCap, Qt.PenJoinStyle.RoundJoin))
        painter.setBrush(Qt.BrushStyle.NoBrush)
        draw_symbol(painter, self.name)
        painter.restore()

    def pixmap(self, size, mode, state):
        pixmap = QPixmap(size); pixmap.fill(Qt.GlobalColor.transparent)
        painter = QPainter(pixmap); self.paint(painter, pixmap.rect(), mode, state); painter.end()
        return pixmap


def symbol(name, role="onSurface"):
    return QIcon(SymbolEngine(name, role))
