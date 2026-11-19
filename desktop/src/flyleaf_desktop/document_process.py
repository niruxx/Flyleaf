"""Nonblocking GUI adapter for the process-isolated native document engine."""
import multiprocessing
import time
import threading
import queue
from PySide6.QtCore import QObject, QTimer
from .document_backend import serve


class DocumentProcess(QObject):
    def __init__(self, parent):
        super().__init__(parent)
        context = multiprocessing.get_context("spawn")
        self.connection, child = context.Pipe()
        self.process = context.Process(target=serve, args=(child,), daemon=True)
        self.process.start()
        child.close()
        self.pending = {}
        self.outbound = queue.Queue(maxsize=64)
        self.send_errors = queue.Queue()
        self.sender = threading.Thread(target=self._send, daemon=True)
        self.sender.start()
        self.sequence = 0
        self.timer = QTimer(self)
        self.timer.setInterval(25)
        self.timer.timeout.connect(self.poll)

    def request(self, operation, success, failure, **arguments):
        self.sequence += 1
        self.pending[self.sequence] = (success, failure, time.monotonic())
        try:
            self.outbound.put_nowait((self.sequence, operation, arguments))
        except queue.Full:
            self.pending.pop(self.sequence)
            failure("The native document engine stopped. Reopen the book to retry.")
            return
        self.timer.start()

    def _send(self):
        while True:
            value = self.outbound.get()
            if value is None:
                return
            try:
                self.connection.send(value)
            except (OSError, EOFError):
                self.send_errors.put(True)
                return

    def poll(self):
        try:
            while self.connection.poll():
                identity, result, error = self.connection.recv()
                callbacks = self.pending.pop(identity, None)
                if callbacks:
                    callbacks[1](error) if error else callbacks[0](result)
            if not self.send_errors.empty() or not self.process.is_alive() or any(time.monotonic() - entry[2] > 90 for entry in self.pending.values()):
                pending, self.pending = self.pending, {}
                self.close()
                for _success, failure, _started in pending.values():
                    failure("The native document engine stopped or timed out. Reopen the book to retry.")
        except (EOFError, OSError):
            pending, self.pending = self.pending, {}
            self.close()
            for _success, failure, _started in pending.values():
                failure("The native document engine stopped. Reopen the book to retry.")
        if not self.pending:
            self.timer.stop()

    def close(self):
        self.timer.stop()
        self.pending.clear()
        if self.process.is_alive():
            self.process.terminate()
        self.process.join(timeout=.5)
        if self.process.is_alive():
            self.process.kill()
            self.process.join(timeout=.5)
        self.connection.close()
        try:
            self.outbound.put_nowait(None)
        except queue.Full:
            pass
