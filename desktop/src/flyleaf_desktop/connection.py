from PySide6.QtCore import QSettings, Qt, Signal
from PySide6.QtWidgets import (
    QCheckBox, QComboBox, QFormLayout, QFrame, QHBoxLayout, QLineEdit, QProgressBar,
    QPushButton, QScrollArea, QVBoxLayout, QWidget,
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
    scroll = QScrollArea()
    scroll.setWidgetResizable(True)
    scroll.setFrameShape(QFrame.Shape.NoFrame)
    host = QWidget()
    centered = QVBoxLayout(host)
    centered.setContentsMargins(0, 4, 0, 4)
    centered.addStretch()
    centered.addWidget(card, alignment=Qt.AlignmentFlag.AlignHCenter)
    centered.addStretch()
    scroll.setWidget(host)
    outer.addWidget(scroll, 1)
    return content


class ConnectionPage(QWidget):
    connect_requested = Signal(str)
    save_profile_requested = Signal()
    remove_profile_requested = Signal()
    profile_selected = Signal(str)

    def __init__(self, settings: QSettings):
        super().__init__()
        outer = QVBoxLayout(self)
        outer.setContentsMargins(32, 16, 32, 16)
        content = setup_card(outer, "01 / CONNECT YOUR SERVER", "Your library, on your desktop")
        content.addWidget(label("Connect to the computer or server running Flyleaf. Your books and permissions stay on that server.", wrap=True))
        self.profiles = QComboBox()
        self.profiles.setAccessibleName("Saved server profile")
        self.profiles.addItem("New connection", "")
        self.profiles.currentIndexChanged.connect(lambda _: self.profile_selected.emit(self.profiles.currentData() or ""))
        content.addWidget(self.profiles)
        profile_row = QHBoxLayout()
        self.profile_name = QLineEdit()
        self.profile_name.setPlaceholderText("Profile name, e.g. Home library")
        self.profile_name.setAccessibleName("Server profile name")
        self.profile_name.setMaxLength(80)
        profile_row.addWidget(self.profile_name, 1)
        self.save_profile = QPushButton("Save")
        self.save_profile.clicked.connect(self.save_profile_requested)
        profile_row.addWidget(self.save_profile)
        self.remove_profile = QPushButton("Remove")
        self.remove_profile.clicked.connect(self.remove_profile_requested)
        profile_row.addWidget(self.remove_profile)
        content.addLayout(profile_row)
        self.address = QLineEdit(str(settings.value("connection/server", "")))
        self.address.setObjectName("serverAddress")
        self.address.setPlaceholderText("192.168.1.25:7878 or https://books.example.com")
        self.address.setClearButtonEnabled(True)
        form = QFormLayout()
        form.setRowWrapPolicy(QFormLayout.RowWrapPolicy.WrapAllRows)
        form.addRow("&Server IP or address", self.address)
        content.addLayout(form)
        content.addWidget(label("An IP address without a port uses 7878. Include https:// for a server with TLS; certificates are verified.", wrap=True))
        self.reconnect = QCheckBox("Reconnect to this profile when Flyleaf starts")
        content.addWidget(self.reconnect)
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
        outer.addWidget(label("Flyleaf Desktop · native Qt interface · early development build", wrap=True), alignment=Qt.AlignmentFlag.AlignHCenter)

    def submit(self) -> None:
        if self.connect_button.isEnabled():
            self.connect_requested.emit(self.address.text())

    def set_busy(self, busy: bool, message: str = "") -> None:
        self.busy.setVisible(busy)
        self.connect_button.setEnabled(not busy)
        self.connect_button.setText("Connecting…" if busy else "Connect to server  →")
        self.address.setEnabled(not busy)
        for control in (self.profiles, self.profile_name, self.save_profile, self.remove_profile, self.reconnect):
            control.setEnabled(not busy)
        self.remove_profile.setEnabled(not busy and bool(self.profiles.currentData()))
        self.notice.setText(message)


class LoginPage(QWidget):
    login_requested = Signal(str, str)
    change_server_requested = Signal()
    register_requested = Signal()
    restore_requested = Signal()

    def __init__(self):
        super().__init__()
        outer = QVBoxLayout(self)
        outer.setContentsMargins(32, 16, 32, 16)
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
        self.remember = QCheckBox("Remember this session in the system password vault")
        content.addWidget(self.remember)
        content.addWidget(label("Your password is never saved. Remembered sessions use only Windows Credential Manager or Linux Secret Service.", wrap=True))
        self.restore_button = QPushButton("Retry saved session")
        self.restore_button.clicked.connect(self.restore_requested)
        self.restore_button.hide()
        content.addWidget(self.restore_button)
        self.register_button = QPushButton("Create an account")
        self.register_button.clicked.connect(self.register_requested)
        self.register_button.hide()
        content.addWidget(self.register_button)
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
        for control in (self.login_button, self.username, self.password, self.back_button, self.remember, self.restore_button, self.register_button):
            control.setEnabled(not busy)
        self.notice.setText(message)
