"""System text-to-speech in a disposable process with word tracking events."""
import multiprocessing
import time
import sys
from PySide6.QtCore import QObject, QTimer, Signal


def word_range(text, location, length, windows):
    if windows:
        raw = text.encode("utf-16-le")
        try:
            start = len(raw[:location * 2].decode("utf-16-le"))
            count = len(raw[location * 2:(location + length) * 2].decode("utf-16-le"))
        except UnicodeError:
            return None
    else:
        start, count = max(0, location - 1), length
    return (start, count) if count > 0 and 0 <= start < len(text) and start + count <= len(text) else None


def speech_worker(connection, output_file=None):
    if sys.platform == "win32":
        from .windows_speech import windows_speech_worker
        windows_speech_worker(connection, output_file)
    else:
        pyttsx_speech_worker(connection)


def pyttsx_speech_worker(connection):
    engine = None
    try:
        import pyttsx3
        engine = pyttsx3.init()
        voices = [{"id": voice.id, "name": voice.name} for voice in engine.getProperty("voices")]
        connection.send(("voices", 0, voices))
        utterances = {}
        active_turn = 0
        def started(name):
            nonlocal active_turn
            try:
                active_turn = int(name)
            except (ValueError, TypeError):
                return
            connection.send(("started", active_turn, None))
        def word(name, location, length):
            # pyttsx3 drivers supply the spoken WORD as name, not the utterance ID.
            source = utterances.get(active_turn, "")
            value = word_range(source, location, length, sys.platform == "win32")
            if value:
                connection.send(("word", active_turn, value))
        def ended(name, completed):
            try:
                turn = int(name)
            except (ValueError, TypeError):
                return
            connection.send(("ended", turn, bool(completed)))
            utterances.pop(turn, None)
        engine.connect("started-utterance", started)
        engine.connect("started-word", word)
        engine.connect("finished-utterance", ended)
        engine.startLoop(False)
        while True:
            if connection.poll():
                command, turn, value = connection.recv()
                if command == "close":
                    break
                if command == "stop":
                    engine.stop()
                elif command == "speak":
                    engine.stop()
                    if value.get("voice"):
                        engine.setProperty("voice", value["voice"])
                    engine.setProperty("rate", value.get("rate", 180))
                    utterances[turn] = value["text"]
                    engine.say(value["text"], str(turn))
            engine.iterate()
            time.sleep(.015)
    except (BrokenPipeError, EOFError, OSError):
        pass
    except Exception:
        try:
            connection.send(("error", 0, "System speech is unavailable. Check installed voices (Windows Speech or Linux eSpeak)."))
        except (BrokenPipeError, EOFError, OSError):
            pass
    finally:
        if engine:
            try:
                engine.stop(); engine.endLoop()
            except Exception:
                pass
        connection.close()


class SpeechProcess(QObject):
    voices = Signal(list)
    word = Signal(int, int)
    started = Signal()
    ended = Signal()
    failed = Signal(str)

    def __init__(self, parent):
        super().__init__(parent)
        context = multiprocessing.get_context("spawn")
        self.connection, child = context.Pipe()
        self.process = context.Process(target=speech_worker, args=(child,), daemon=True)
        self.process.start(); child.close()
        self.turn = 0
        self.ready = False
        self.pending_speech = None
        self.timer = QTimer(self)
        self.timer.setInterval(40)
        self.timer.timeout.connect(self.poll)
        self.timer.start()

    def speak(self, text, voice=None, rate=180):
        self.turn += 1
        command = ("speak", self.turn, {"text": text[:500_000], "voice": voice, "rate": max(80, min(350, rate))})
        if not self.ready:
            self.pending_speech = command
            return
        try:
            self.connection.send(command)
            self.timer.setInterval(40)
        except (OSError, EOFError):
            self.failed.emit("The system speech engine stopped. Reopen this book to retry.")

    def stop(self):
        self.turn += 1
        self.pending_speech = None
        try:
            self.connection.send(("stop", self.turn, None))
        except (OSError, EOFError):
            pass
        self.timer.setInterval(200)

    def poll(self):
        try:
            while self.connection.poll():
                kind, turn, value = self.connection.recv()
                if kind == "voices":
                    self.ready = True
                    self.voices.emit(value)
                    if self.pending_speech:
                        self.connection.send(self.pending_speech); self.pending_speech = None
                elif kind == "error":
                    self.failed.emit(value); self.timer.stop()
                elif turn == self.turn and kind == "word":
                    self.word.emit(*value)
                elif turn == self.turn and kind == "started":
                    self.started.emit()
                elif turn == self.turn and kind == "ended" and value:
                    self.ended.emit()
            if not self.process.is_alive():
                self.timer.stop()
        except (OSError, EOFError):
            self.timer.stop()

    def close(self):
        self.timer.stop()
        if self.process.is_alive():
            self.process.terminate()
        self.process.join(timeout=.5)
        if self.process.is_alive():
            self.process.kill(); self.process.join(timeout=.5)
        self.connection.close()
