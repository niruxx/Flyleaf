from PySide6.QtCore import QSettings, Qt, Signal
from PySide6.QtWidgets import (
    QCheckBox, QFormLayout, QFrame, QHBoxLayout, QLineEdit, QProgressBar,
    QPushButton, QVBoxLayout, QWidget,
)

from .widgets import label
from .onboarding import primary


def setup_card(outer, step, title):
    card = QFrame()
    card.setObjectName("setupCard")
    card.setMaximumWidth(580)
    card.setMinimumWidth(460)
    content = QVBoxLayout(card)
    content.setContentsMargins(28, 22, 28, 22)
    content.setSpacing(10)
    marker = label(step)
    marker.setObjectName("eyebrow")
    content.addWidget(marker)
    content.addWidget(label(title, heading=True, wrap=True))
    outer.addWidget(card, alignment=Qt.AlignmentFlag.AlignHCenter)
    return content


class ConnectionPage(QWidget):
    connect_requested = Signal(str)

    def __init__(self, settings: QSettings):
        super().__init__()
        outer = QVBoxLayout(self)
        outer.setContentsMargins(32, 16, 32, 16)
        outer.addStretch()
        content = setup_card(outer, "01 / CONNECT YOUR SERVER", "Your library, on your desktop")
        content.addWidget(label("Connect to the computer or server running Flyleaf. Your books and permissions stay on that server.", wrap=True))
        self.address = QLineEdit(str(settings.value("connection/server", "")))
        self.address.setObjectName("serverAddress")
        self.address.setPlaceholderText("192.168.1.25:7878 or https://books.example.com")
        self.address.setClearButtonEnabled(True)
        form = QFormLayout()
        form.setRowWrapPolicy(QFormLayout.RowWrapPolicy.WrapAllRows)
        form.addRow("&Server IP or address", self.address)
        content.addLayout(form)
        content.addWidget(label("An IP address without a port uses 7878. Include https:// for a server with TLS; certificates are verified.", wrap=True))
        self.notice = label("", wrap=True)
        self.notice.setObjectName("connectionNotice")
        content.addWidget(self.notice)
        self.busy = QProgressBar()
        self.busy.setRange(0, 0)
        self.busy.hide()
        content.addWidget(self.busy)
        self.connect_button = primary(QPushButton("Connect to server  →"))
        self.connect_button.setObjectName("connectButton")
        self.connect_button.setDefault(True)
        self.connect_button.clicked.connect(self.submit)
        self.address.returnPressed.connect(self.submit)
        content.addWidget(self.connect_button)
        outer.addStretch()
        outer.addWidget(label("Flyleaf Desktop · native Qt interface · early development build"), alignment=Qt.AlignmentFlag.AlignHCenter)

    def submit(self) -> None:
        if self.connect_button.isEnabled():
            self.connect_requested.emit(self.address.text())

    def set_busy(self, busy: bool, message: str = "") -> None:
        self.busy.setVisible(busy)
        self.connect_button.setEnabled(not busy)
        self.connect_button.setText("Connecting…" if busy else "Connect to server  →")
        self.address.setEnabled(not busy)
        self.notice.setText(message)


class LoginPage(QWidget):
    login_requested = Signal(str, str)
    change_server_requested = Signal()

    def __init__(self):
        super().__init__()
        outer = QVBoxLayout(self)
        outer.setContentsMargins(32, 16, 32, 16)
        outer.addStretch()
        content = setup_card(outer, "02 / SIGN IN", "A familiar place awaits")
        self.server = label("", wrap=True)
        content.addWidget(self.server)
        self.username = QLineEdit()
        self.username.setObjectName("username")
        self.password = QLineEdit()
        self.password.setObjectName("password")
        self.password.setEchoMode(QLineEdit.EchoMode.Password)
        self.password.setMaxLength(256)
        form = QFormLayout()
        form.setRowWrapPolicy(QFormLayout.RowWrapPolicy.WrapAllRows)
        form.addRow("&Username or email", self.username)
        form.addRow("&Password", self.password)
        content.addLayout(form)
        reveal = QCheckBox("Show password")
        reveal.toggled.connect(lambda visible: self.password.setEchoMode(QLineEdit.EchoMode.Normal if visible else QLineEdit.EchoMode.Password))
        content.addWidget(reveal)
        content.addWidget(label("Your password and session are kept in memory only. This build remembers the server address, not your credentials.", wrap=True))
        self.notice = label("", wrap=True)
        self.notice.setObjectName("loginNotice")
        content.addWidget(self.notice)
        self.busy = QProgressBar()
        self.busy.setRange(0, 0)
        self.busy.hide()
        content.addWidget(self.busy)
        buttons = QHBoxLayout()
        self.back_button = QPushButton("Change server")
        self.back_button.clicked.connect(self.change_server_requested)
        self.login_button = primary(QPushButton("Sign in  →"))
        self.login_button.setObjectName("signInButton")
        self.login_button.setDefault(True)
        self.login_button.clicked.connect(self.submit)
        self.username.returnPressed.connect(self.submit)
        self.password.returnPressed.connect(self.submit)
        buttons.addWidget(self.back_button)
        buttons.addStretch()
        buttons.addWidget(self.login_button)
        content.addLayout(buttons)
        outer.addStretch()

    def submit(self) -> None:
        if not self.login_button.isEnabled():
            return
        if not self.username.text().strip() or not self.password.text():
            self.notice.setText("Enter your username and password.")
            return
        self.login_requested.emit(self.username.text().strip(), self.password.text())

    def set_busy(self, busy: bool, message: str = "") -> None:
        self.busy.setVisible(busy)
        self.login_button.setText("Signing in…" if busy else "Sign in  →")
        for control in (self.login_button, self.username, self.password, self.back_button):
            control.setEnabled(not busy)
        self.notice.setText(message)
