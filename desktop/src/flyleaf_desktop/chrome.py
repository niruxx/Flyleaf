"""Themed window controls with platform-managed move and resize operations."""
from PySide6.QtCore import QEvent, QObject, Qt, QRectF
from PySide6.QtGui import QPainter, QPen
from PySide6.QtWidgets import QApplication, QHBoxLayout, QLabel, QToolButton, QWidget


class WindowEdges(QObject):
    def __init__(self, window):
        super().__init__(window)
        self.window = window
        QApplication.instance().installEventFilter(self)

    def eventFilter(self, watched, event):
        window = self.window
        if event.type() != QEvent.Type.MouseButtonPress or not isinstance(watched, QWidget) or watched.window() is not window:
            return False
        if event.button() != Qt.MouseButton.LeftButton or window.isMaximized() or window.isFullScreen() or not window.windowFlags() & Qt.WindowType.FramelessWindowHint:
            return False
        point = window.mapFromGlobal(event.globalPosition().toPoint())
        edges = Qt.Edge(0)
        if point.x() < 6:
            edges |= Qt.Edge.LeftEdge
        elif point.x() >= window.width() - 6:
            edges |= Qt.Edge.RightEdge
        if point.y() < 6:
            edges |= Qt.Edge.TopEdge
        elif point.y() >= window.height() - 6:
            edges |= Qt.Edge.BottomEdge
        return bool(edges and window.windowHandle() and window.windowHandle().startSystemResize(edges))


class ChromeButton(QToolButton):
    def __init__(self, symbol):
        super().__init__()
        self.symbol = symbol

    def paintEvent(self, event):
        super().paintEvent(event)
        painter = QPainter(self)
        painter.setRenderHint(QPainter.RenderHint.Antialiasing)
        painter.setPen(QPen(self.palette().windowText().color(), 1.4))
        x, y = self.width() // 2, self.height() // 2
        if self.symbol == "menu":
            for offset in (-4, 0, 4):
                painter.drawLine(x - 6, y + offset, x + 6, y + offset)
        elif self.symbol == "close":
            painter.drawLine(x - 4, y - 4, x + 4, y + 4)
            painter.drawLine(x - 4, y + 4, x + 4, y - 4)
        elif self.symbol == "minimize":
            painter.drawLine(x - 5, y + 1, x + 5, y + 1)
        else:
            painter.drawRect(QRectF(x - 4, y - 4, 8, 8))
        painter.end()


class TitleBar(QWidget):
    def __init__(self, window, menu):
        super().__init__(window)
        self.window = window
        self.setObjectName("titleBar")
        self.setAttribute(Qt.WidgetAttribute.WA_StyledBackground)
        self.setFixedHeight(48)
        row = QHBoxLayout(self)
        row.setContentsMargins(12, 5, 4, 5)
        row.setSpacing(8)
        self.menu_button = ChromeButton("menu")
        self.menu_button.setFixedSize(38, 34)
        self.menu_button.setAccessibleName("Application menu")
        self.menu_button.setToolTip("Application menu (Alt+M)")
        self.menu_button.setMenu(menu)
        self.menu_button.setPopupMode(QToolButton.ToolButtonPopupMode.InstantPopup)
        row.addWidget(self.menu_button)
        self.icon = QLabel()
        self.icon.setPixmap(window.windowIcon().pixmap(24, 24))
        self.icon.setAttribute(Qt.WidgetAttribute.WA_TransparentForMouseEvents)
        row.addWidget(self.icon)
        self.caption = QLabel(window.windowTitle())
        self.caption.setTextFormat(Qt.TextFormat.PlainText)
        self.caption.setAttribute(Qt.WidgetAttribute.WA_TransparentForMouseEvents)
        window.windowTitleChanged.connect(self.caption.setText)
        row.addWidget(self.caption, 1)
        self.controls = []
        for symbol, name, callback in [("minimize", "Minimize", window.showMinimized), ("maximize", "Maximize or restore", self.toggle_maximized), ("close", "Close", window.close)]:
            button = ChromeButton(symbol)
            button.setObjectName("closeControl" if name == "Close" else "windowControl")
            button.setAccessibleName(name)
            button.setToolTip(name)
            button.clicked.connect(callback)
            row.addWidget(button)
            self.controls.append(button)
        self.edges = WindowEdges(window)

    def toggle_maximized(self):
        self.window.showNormal() if self.window.isMaximized() else self.window.showMaximized()

    def mousePressEvent(self, event):
        if event.button() == Qt.MouseButton.LeftButton and self.window.windowHandle():
            self.window.windowHandle().startSystemMove()
            event.accept()
        else:
            super().mousePressEvent(event)

    def mouseDoubleClickEvent(self, event):
        if event.button() == Qt.MouseButton.LeftButton:
            self.toggle_maximized()
            event.accept()

    def use_system_frame(self, enabled):
        visible = self.window.isVisible()
        state = self.window.windowState()
        geometry = self.window.geometry()
        self.window.setWindowFlag(Qt.WindowType.FramelessWindowHint, not enabled)
        for button in self.controls:
            button.setVisible(not enabled)
        self.window.setGeometry(geometry)
        self.window.setWindowState(state)
        if visible:
            self.window.show()
