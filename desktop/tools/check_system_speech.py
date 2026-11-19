"""Windows voice synthesis/Unicode callback check, redirected to a WAV (no speakers)."""
from pathlib import Path
import sys
import time


def main():
    if sys.platform != "win32":
        raise SystemExit("This SAPI file-sink check runs on Windows; Linux voice validation uses eSpeak.")
    desktop = Path(__file__).resolve().parents[1]
    sys.path.insert(0, str(desktop / "src"))
    from flyleaf_desktop.speech import speech_worker
    output = desktop / "build" / "speech-verification.wav"
    output.parent.mkdir(parents=True, exist_ok=True)
    text = "A quiet 😀 garden. Café brings a new chapter."
    words, ended, errors, traces = [], [], [], []
    class Connection:
        def __init__(self):
            self.commands = [("speak", 1, {"text": text, "rate": 180})]
            self.deadline = time.monotonic() + 15
        def poll(self):
            if time.monotonic() > self.deadline:
                raise TimeoutError("System speech timed out")
            return bool(self.commands)
        def recv(self): return self.commands.pop(0)
        def send(self, message):
            kind, turn, value = message
            if kind == "word":
                start, count = value; words.append(text[start:start + count])
            elif kind == "ended":
                ended.append(value); self.commands.append(("close", 2, None))
            elif kind == "error":
                errors.append(value)
            elif kind == "trace":
                traces.append(value)
        def close(self): pass
    speech_worker(Connection(), str(output))
    if errors or not ended or not ended[-1]:
        raise RuntimeError("System speech did not finish the file-sink utterance: " + repr([errors, traces[-12:], words[-12:]]))
    if output.stat().st_size <= 44 or not any(word.lower().strip(".,") == "garden" for word in words):
        raise RuntimeError("The synthesized audio or UTF-16 word tracking did not verify.")
    print("Windows system speech passed: native WAV synthesis and Unicode word callbacks; no speaker playback.")


if __name__ == "__main__":
    main()
