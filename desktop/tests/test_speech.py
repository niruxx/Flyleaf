import sys
from types import SimpleNamespace
import unittest
from unittest.mock import patch
from flyleaf_desktop.speech import word_range, pyttsx_speech_worker


class SpeechTests(unittest.TestCase):
    def test_driver_offsets_normalize_to_python_characters_without_bisecting_unicode(self):
        text = "Hi 😀 garden"
        self.assertEqual(word_range(text, 6, 6, True), (5, 6))
        self.assertEqual(word_range(text, 6, 6, False), (5, 6))
        self.assertIsNone(word_range(text, 4, 1, True))
        self.assertIsNone(word_range(text, 99, 1, False))

    def test_spoken_word_name_is_not_mistaken_for_utterance_identity(self):
        class Engine:
            def __init__(self): self.callbacks = {}
            def getProperty(self, name): return [SimpleNamespace(id="voice", name="Test voice")]
            def setProperty(self, *args): pass
            def connect(self, name, callback): self.callbacks[name] = callback
            def startLoop(self, *args): pass
            def endLoop(self): pass
            def stop(self): pass
            def iterate(self): pass
            def say(self, text, name):
                self.callbacks["started-utterance"](name)
                self.callbacks["started-word"]("garden", 0 if sys.platform == "win32" else 1, 6)
                self.callbacks["finished-utterance"](name, True)
        class Connection:
            def __init__(self):
                self.commands = [("speak", 1, {"text": "garden", "rate": 180}), ("close", 2, None)]
                self.messages = []
            def poll(self): return True
            def recv(self): return self.commands.pop(0)
            def send(self, value): self.messages.append(value)
            def close(self): pass
        connection = Connection()
        with patch("pyttsx3.init", return_value=Engine()):
            pyttsx_speech_worker(connection)
        self.assertIn(("started", 1, None), connection.messages)
        self.assertIn(("word", 1, (0, 6)), connection.messages)
        self.assertIn(("ended", 1, True), connection.messages)


if __name__ == "__main__":
    unittest.main()
