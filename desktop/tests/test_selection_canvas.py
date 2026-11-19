import unittest
from test_client import APP
from PySide6.QtCore import QEvent, QPointF, Qt
from PySide6.QtGui import QMouseEvent
from flyleaf_desktop.selection_canvas import SelectionCanvas


class SelectionTests(unittest.TestCase):
    def test_drag_uses_native_word_geometry_at_scaled_size_and_copies_plain_text(self):
        canvas = SelectionCanvas()
        canvas.set_words([{"rect": [40, 40, 80, 30], "text": "Native"}, {"rect": [140, 40, 100, 30], "text": "garden"}], [1000, 500])
        canvas.resize(500, 250)
        selected = []
        canvas.selected.connect(selected.append)
        try:
            press = QMouseEvent(QEvent.Type.MouseButtonPress, QPointF(30, 25), QPointF(30, 25), Qt.MouseButton.LeftButton, Qt.MouseButton.LeftButton, Qt.KeyboardModifier.NoModifier)
            drag = QMouseEvent(QEvent.Type.MouseMove, QPointF(95, 25), QPointF(95, 25), Qt.MouseButton.NoButton, Qt.MouseButton.LeftButton, Qt.KeyboardModifier.NoModifier)
            APP.sendEvent(canvas, press); APP.sendEvent(canvas, drag)
            self.assertEqual(selected[-1], "Native garden")
            canvas.copy.activated.emit()
            self.assertEqual(APP.clipboard().text(), "Native garden")
            canvas.set_words([], [1, 1])
            self.assertEqual(canvas.selected_text, "")
        finally:
            canvas.close(); canvas.deleteLater(); APP.processEvents()


if __name__ == "__main__":
    unittest.main()
