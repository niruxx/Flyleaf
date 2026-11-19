"""Material role contrast and layout regressions that screenshots alone can miss."""
import unittest
from PySide6.QtCore import Qt
from PySide6.QtGui import QColor, QFontDatabase
from test_client import APP
from flyleaf_desktop.material import PRESETS, install_font, scheme, symbol
from flyleaf_desktop.widgets import label


def luminance(value):
    color = QColor(value)
    def linear(v):
        return v / 12.92 if v <= .04045 else ((v + .055) / 1.055) ** 2.4
    return sum(linear(v) * weight for v, weight in zip((color.redF(), color.greenF(), color.blueF()), (.2126, .7152, .0722)))


class MaterialTests(unittest.TestCase):
    def test_all_palettes_keep_text_roles_readable_in_both_modes(self):
        for preset in PRESETS:
            for dark in (False, True):
                c = scheme(dark, preset)
                for ink, surface in [("onSurface", "surface"), ("onSurfaceVariant", "surfaceLow"),
                                     ("onPrimary", "primary"), ("onPrimaryContainer", "primaryContainer"),
                                     ("onSecondaryContainer", "secondaryContainer"), ("onTertiaryContainer", "tertiaryContainer")]:
                    with self.subTest(preset=preset, dark=dark, role=ink):
                        light, dim = sorted((luminance(c[ink]), luminance(c[surface])), reverse=True)
                        self.assertGreaterEqual((light + .05) / (dim + .05), 4.5)

    def test_wrapped_text_shrinks_after_narrow_first_layout(self):
        install_font()
        text = label("Your next chapter starts here. A familiar story, or a new favourite.", wrap=True)
        try:
            text.resize(100, 400)
            text.show()
            APP.processEvents()
            narrow = text.minimumHeight()
            text.resize(600, 400)
            APP.processEvents()
            self.assertLess(text.minimumHeight(), narrow)
            self.assertLess(text.minimumHeight(), 70)
        finally:
            text.close()
            text.deleteLater()
            APP.processEvents()

    def test_bundled_typography_and_vector_symbols_work_without_system_icon_fonts(self):
        install_font()
        self.assertIn("Roboto Flex", QFontDatabase.families())
        for name in ("home", "library", "bookmark", "search", "filter", "person", "play", "sun"):
            pixmap = symbol(name).pixmap(24, 24)
            self.assertFalse(pixmap.isNull())
            self.assertTrue(any(pixmap.toImage().pixelColor(x, y).alpha() for x in range(24) for y in range(24)))


if __name__ == "__main__":
    unittest.main()
