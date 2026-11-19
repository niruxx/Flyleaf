"""OS-only session storage: Windows generic credentials or Linux Secret Service.

No automatic backend discovery, file keyrings, passwords, or plaintext fallback.
All vault operations run serially off the GUI thread.
"""
import ctypes
from contextlib import closing
from ctypes import wintypes
import hashlib
import sys

from PySide6.QtCore import QObject, QRunnable, QThreadPool, Signal


class VaultUnavailable(Exception):
    pass


class SessionVault:
    def key(self, profile):
        digest = hashlib.sha256(profile["address"].encode()).hexdigest()[:32]
        return f"Flyleaf Desktop/{digest}/{profile['id']}"

    def perform(self, operation, profile, secret=None):
        try:
            if sys.platform == "win32":
                return self._windows(operation, self.key(profile), secret)
            if sys.platform.startswith("linux"):
                return self._linux(operation, self.key(profile), secret)
            raise VaultUnavailable("Remembered sessions are supported on Windows and Linux only.")
        except VaultUnavailable:
            raise
        except Exception:
            raise VaultUnavailable("The system vault is unavailable or locked. Unlock it in your desktop's password manager and retry. Your session stays in memory only.") from None

    @staticmethod
    def _windows(operation, target, secret):
        class Credential(ctypes.Structure):
            _fields_ = [("Flags", wintypes.DWORD), ("Type", wintypes.DWORD),
                        ("TargetName", wintypes.LPWSTR), ("Comment", wintypes.LPWSTR),
                        ("LastWritten", wintypes.FILETIME), ("CredentialBlobSize", wintypes.DWORD),
                        ("CredentialBlob", ctypes.POINTER(ctypes.c_ubyte)), ("Persist", wintypes.DWORD),
                        ("AttributeCount", wintypes.DWORD), ("Attributes", ctypes.c_void_p),
                        ("TargetAlias", wintypes.LPWSTR), ("UserName", wintypes.LPWSTR)]
        api = ctypes.WinDLL("Advapi32.dll", use_last_error=True)
        pointer = ctypes.POINTER(Credential)
        api.CredReadW.argtypes = [wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD, ctypes.POINTER(pointer)]
        api.CredReadW.restype = wintypes.BOOL
        api.CredWriteW.argtypes = [pointer, wintypes.DWORD]
        api.CredWriteW.restype = wintypes.BOOL
        api.CredDeleteW.argtypes = [wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD]
        api.CredDeleteW.restype = wintypes.BOOL
        api.CredFree.argtypes = [ctypes.c_void_p]
        api.CredFree.restype = None
        if operation == "read":
            result = pointer()
            if not api.CredReadW(target, 1, 0, ctypes.byref(result)):
                if ctypes.get_last_error() == 1168:
                    return None
                raise ctypes.WinError(ctypes.get_last_error())
            try:
                return ctypes.string_at(result.contents.CredentialBlob, result.contents.CredentialBlobSize).decode("utf-8")
            finally:
                api.CredFree(result)
        if operation == "delete":
            if not api.CredDeleteW(target, 1, 0) and ctypes.get_last_error() != 1168:
                raise ctypes.WinError(ctypes.get_last_error())
            return None
        raw = secret.encode("utf-8")
        if len(raw) > 2560:
            raise VaultUnavailable("The session is too large for Windows Credential Manager. It remains in memory only.")
        buffer = (ctypes.c_ubyte * len(raw)).from_buffer_copy(raw)
        credential = Credential(Type=1, TargetName=target, CredentialBlobSize=len(raw),
                                CredentialBlob=buffer, Persist=2, UserName="Flyleaf session")
        if not api.CredWriteW(ctypes.byref(credential), 0):
            raise ctypes.WinError(ctypes.get_last_error())

    @staticmethod
    def _linux(operation, target, secret):
        try:
            import secretstorage
        except ImportError:
            raise VaultUnavailable("Install the desktop's 'sessions' extra and enable a Linux Secret Service to remember sessions. Nothing is saved in plaintext.") from None
        with closing(secretstorage.dbus_init()) as bus:
            # Reading a remembered session must never create/unlock a collection.
            collection = secretstorage.get_collection_by_alias(bus, "default")
            if collection.is_locked():
                raise VaultUnavailable("Your system password vault is locked. Unlock it, then retry. Your session stays in memory only.")
            attributes = {"application": "flyleaf-desktop", "session": target}
            items = list(collection.search_items(attributes))
            if operation == "read":
                if not items:
                    return None
                if items[0].is_locked():
                    raise VaultUnavailable("This session's vault entry is locked. Unlock it and retry.")
                return items[0].get_secret().decode("utf-8")
            if operation == "delete":
                for item in items:
                    item.delete()
            else:
                collection.create_item("Flyleaf Desktop session", attributes, secret.encode("utf-8"), replace=True)


class _Signals(QObject):
    finished = Signal(int, object, str)


class _Job(QRunnable):
    def __init__(self, number, vault, operation, profile, secret):
        super().__init__()
        self.signals = _Signals()
        self.arguments = number, vault, operation, dict(profile), secret

    def run(self):
        number, vault, operation, profile, secret = self.arguments
        try:
            result = vault.perform(operation, profile, secret)
            self.signals.finished.emit(number, result, "")
        except Exception as error:
            self.signals.finished.emit(number, None, str(error) if isinstance(error, VaultUnavailable) else "System vault operation failed.")


class VaultTasks(QObject):
    def __init__(self, parent, vault=None):
        super().__init__(parent)
        self.vault = vault or SessionVault()
        self.pool = QThreadPool(self)
        self.pool.setMaxThreadCount(1)
        self.pending = {}
        self.sequence = 0

    def submit(self, operation, profile, callback, secret=None):
        self.sequence += 1
        number = self.sequence
        job = _Job(number, self.vault, operation, profile, secret)
        self.pending[number] = (job, callback)
        job.signals.finished.connect(self._finished)
        self.pool.start(job)

    def _finished(self, number, result, error):
        entry = self.pending.pop(number, None)
        if entry:
            entry[1](result, error)
