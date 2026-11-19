"""Native account creation, profile editing and explicit session recovery."""
import re
from PySide6.QtCore import Signal
from PySide6.QtWidgets import QFormLayout, QHBoxLayout, QLineEdit, QPushButton, QVBoxLayout, QWidget
from .connection import setup_card
from .onboarding import primary
from .widgets import label, text


def field(form, title, secret=False):
    edit = QLineEdit()
    edit.setMaxLength(256 if secret else 64)
    if secret:
        edit.setEchoMode(QLineEdit.EchoMode.Password)
    form.addRow(title, edit)
    return edit


def password_error(password, confirm):
    if not 8 <= len(password) <= 256:
        return "Use a password between 8 and 256 characters."
    if password != confirm:
        return "The passwords do not match."
    return ""


class CreateAccountPage(QWidget):
    submitted = Signal(dict)
    back_requested = Signal()

    def __init__(self):
        super().__init__()
        outer = QVBoxLayout(self)
        self.content = setup_card(outer, "YOUR FLYLEAF ACCOUNT", "A new chapter starts here")
        self.explanation = label("", wrap=True)
        self.content.addWidget(self.explanation)
        form = QFormLayout()
        form.setRowWrapPolicy(QFormLayout.RowWrapPolicy.WrapAllRows)
        self.username = field(form, "&Username")
        self.display_name = field(form, "&Display name (optional)")
        self.email = field(form, "&Email (optional, administrator setup)")
        self.email.setMaxLength(254)
        self.password = field(form, "&Password", True)
        self.confirm = field(form, "&Confirm password", True)
        self.invite = field(form, "&Invite code", True)
        self.form = form
        self.content.addLayout(form)
        self.notice = label("", wrap=True)
        self.content.addWidget(self.notice)
        buttons = QHBoxLayout()
        self.back = QPushButton("Back")
        self.back.clicked.connect(self.back_requested)
        self.submit_button = primary(QPushButton("Create account"))
        self.submit_button.clicked.connect(self.submit)
        buttons.addWidget(self.back)
        buttons.addWidget(self.submit_button)
        self.content.addLayout(buttons)
        self.confirm.returnPressed.connect(self.submit)
        self.setup = False

    def configure(self, *, setup=False, invite=False):
        self.setup = setup
        self.clear_secrets()
        self.username.clear()
        self.display_name.clear()
        self.email.clear()
        self.notice.clear()
        self.form.setRowVisible(self.email, setup)
        self.form.setRowVisible(self.invite, invite)
        self.explanation.setText("This server has no accounts. Create its first administrator account. This account controls the server and its libraries." if setup else "Create an account on this server. Your administrator controls access and shared libraries.")
        self.submit_button.setText("Create administrator" if setup else "Create account")
        self.set_busy(False)

    def submit(self):
        if not self.submit_button.isEnabled():
            return
        username = self.username.text().strip()
        error = "Use 3–32 letters, numbers, dots, dashes or underscores for your username." if not re.fullmatch(r"[a-zA-Z0-9_.-]{3,32}", username) else password_error(self.password.text(), self.confirm.text())
        if error:
            self.notice.setText(error)
            return
        body = {"username": username, "displayName": self.display_name.text().strip(), "password": self.password.text()}
        if self.setup:
            body["email"] = self.email.text().strip()
        else:
            body["inviteCode"] = self.invite.text().strip()
        self.submitted.emit(body)

    def clear_secrets(self):
        for edit in (self.password, self.confirm, self.invite):
            edit.clear()

    def clear(self):
        self.clear_secrets()
        for edit in (self.username, self.display_name, self.email):
            edit.clear()
        self.notice.clear()

    def set_busy(self, busy, message=""):
        self.notice.setText(message)
        for widget in (self.username, self.display_name, self.email, self.password, self.confirm, self.invite, self.submit_button, self.back):
            widget.setEnabled(not busy)


class AccountPage(QWidget):
    profile_requested = Signal(dict)
    password_requested = Signal(dict)
    back_requested = Signal()

    def __init__(self):
        super().__init__()
        outer = QVBoxLayout(self)
        content = setup_card(outer, "YOUR ACCOUNT", "Make it feel like you")
        form = QFormLayout()
        form.setRowWrapPolicy(QFormLayout.RowWrapPolicy.WrapAllRows)
        self.username = field(form, "&Username (admin can edit)")
        self.display_name = field(form, "&Display name")
        self.email = field(form, "&Email")
        self.email.setMaxLength(254)
        content.addLayout(form)
        self.save_profile = primary(QPushButton("Save profile"))
        self.save_profile.clicked.connect(self._profile)
        content.addWidget(self.save_profile)
        password_form = QFormLayout()
        password_form.setRowWrapPolicy(QFormLayout.RowWrapPolicy.WrapAllRows)
        self.current = field(password_form, "C&urrent password", True)
        self.next = field(password_form, "&New password", True)
        self.confirm = field(password_form, "&Confirm new password", True)
        content.addLayout(password_form)
        self.save_password = QPushButton("Change password")
        self.save_password.clicked.connect(self._password)
        content.addWidget(self.save_password)
        self.notice = label("", wrap=True)
        content.addWidget(self.notice)
        self.back = QPushButton("Back to library")
        self.back.clicked.connect(self.back_requested)
        content.addWidget(self.back)

    def populate(self, user):
        self.username.setText(text(user.get("username")))
        self.username.setReadOnly(user.get("role") != "admin")
        self.display_name.setText(text(user.get("displayName")))
        self.email.setText(text(user.get("email")))
        self.clear_secrets()
        self.set_busy(False)

    def _profile(self):
        body = {"displayName": self.display_name.text().strip(), "email": self.email.text().strip()}
        if not self.username.isReadOnly():
            body["username"] = self.username.text().strip()
        self.profile_requested.emit(body)

    def _password(self):
        error = password_error(self.next.text(), self.confirm.text())
        if not self.current.text():
            error = "Enter your current password."
        if error:
            self.notice.setText(error)
        else:
            self.password_requested.emit({"current": self.current.text(), "next": self.next.text()})

    def clear_secrets(self):
        for edit in (self.current, self.next, self.confirm):
            edit.clear()

    def clear(self):
        self.clear_secrets()
        for edit in (self.username, self.display_name, self.email):
            edit.clear()
        self.notice.clear()

    def set_busy(self, busy, message=""):
        self.notice.setText(message)
        for widget in (self.username, self.display_name, self.email, self.current, self.next, self.confirm, self.save_profile, self.save_password, self.back):
            widget.setEnabled(not busy)


class RecoveryPage(QWidget):
    resume_requested = Signal(bool)
    dismiss_requested = Signal()

    def __init__(self):
        super().__init__()
        outer = QVBoxLayout(self)
        content = setup_card(outer, "WELCOME BACK", "Pick up your story")
        self.message = label("", wrap=True)
        content.addWidget(self.message)
        self.resume_pending = primary(QPushButton("Resume my unsaved page"))
        self.resume_pending.clicked.connect(lambda: self.resume_requested.emit(True))
        content.addWidget(self.resume_pending)
        self.resume_server = QPushButton("Use the server's latest position")
        self.resume_server.clicked.connect(lambda: self.resume_requested.emit(False))
        content.addWidget(self.resume_server)
        dismiss = QPushButton("Discard recovery and open library")
        dismiss.clicked.connect(self.dismiss_requested)
        content.addWidget(dismiss)

    def populate(self, recovery):
        self.message.setText(f"You were reading {text(recovery['book'].get('title'), 'a book')}. " + (f"Page {recovery['page'] + 1} was not saved. Choose whether to resume it or load the server's latest position. Nothing has been replayed." if recovery['pending'] else "Choose whether to reopen it at the server's latest position."))
        self.resume_pending.setVisible(recovery["pending"])

    def clear(self):
        self.message.clear()
