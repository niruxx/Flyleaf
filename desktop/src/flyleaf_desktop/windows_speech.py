"""Windows SAPI with native stream IDs and UTF-16 word boundaries."""
import math
import time


def windows_speech_worker(connection, output_file=None):
    import pythoncom
    import win32com.client
    from .speech import word_range
    pythoncom.CoInitialize()
    voice = events = stream = None
    utterances = {}
    try:
        voice = win32com.client.Dispatch("SAPI.SpVoice")
        class Events:
            def OnStartStream(self, number, position):
                current = utterances.get(number)
                if current and not current["started"]:
                    current["started"] = True
                    connection.send(("started", current["turn"], None))

            def OnWord(self, number, position, character, length):
                current = utterances.get(number)
                if not current or current["stopped"]:
                    return
                if not current["started"]:
                    current["started"] = True
                    connection.send(("started", current["turn"], None))
                value = word_range(current["text"], character, length, True)
                if value:
                    connection.send(("word", current["turn"], value))

            def OnEndStream(self, number, position):
                current = utterances.pop(number, None)
                if current:
                    connection.send(("ended", current["turn"], not current["stopped"]))
        events = win32com.client.WithEvents(voice, Events)
        voice.EventInterests = 33790
        if output_file:
            stream = win32com.client.Dispatch("SAPI.SpFileStream")
            stream.Open(output_file, 3)
            voice.AudioOutputStream = stream
        tokens = voice.GetVoices()
        voices = [{"id": tokens.Item(index).Id, "name": tokens.Item(index).GetDescription()} for index in range(tokens.Count)]
        connection.send(("voices", 0, voices))
        while True:
            if connection.poll():
                command, turn, value = connection.recv()
                if command == "close":
                    break
                for entry in utterances.values():
                    entry["stopped"] = True
                voice.Speak("", 3)  # Async + purge, including paused utterances.
                if command == "speak":
                    if value.get("voice"):
                        match = next((tokens.Item(index) for index in range(tokens.Count) if tokens.Item(index).Id == value["voice"]), None)
                        if match is not None:
                            voice.Voice = match
                    voice.Rate = max(-10, min(10, round(math.log(max(80, min(350, value.get("rate", 180))) / 200) / math.log(1.1))))
                    number = voice.Speak(value["text"], 1)
                    utterances[number] = {"turn": turn, "text": value["text"], "started": False, "stopped": False}
            pythoncom.PumpWaitingMessages()
            time.sleep(.015)
    except (BrokenPipeError, EOFError, OSError):
        pass
    except Exception as error:
        if output_file:
            connection.send(("trace", 0, [type(error).__name__, str(error)]))
        try:
            connection.send(("error", 0, "Windows system speech is unavailable. Check installed Speech voices."))
        except (BrokenPipeError, EOFError, OSError):
            pass
    finally:
        if voice:
            try:
                voice.Speak("", 3)
            except Exception:
                pass
        if events:
            events.close()
        if stream:
            stream.Close()
        pythoncom.CoUninitialize()
        connection.close()
