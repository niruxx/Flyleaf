"""Linux MPRIS on a private asyncio thread; no Qt or VLC calls from D-Bus."""
import asyncio
import os
import threading
from dbus_next import Variant, DBusError
from dbus_next.service import ServiceInterface, method, dbus_property, signal
from dbus_next.constants import PropertyAccess

READ = PropertyAccess.READ


class Root(ServiceInterface):
    def __init__(self, command):
        super().__init__("org.mpris.MediaPlayer2")
        self.command = command

    @method()
    def Raise(self): self.command("raise", None)
    @method()
    def Quit(self): self.command("quit", None)
    @dbus_property(access=READ)
    def CanQuit(self) -> 'b': return True
    @dbus_property(access=READ)
    def CanRaise(self) -> 'b': return True
    @dbus_property(access=READ)
    def HasTrackList(self) -> 'b': return False
    @dbus_property(access=READ)
    def Identity(self) -> 's': return "Flyleaf"
    @dbus_property(access=READ)
    def DesktopEntry(self) -> 's': return "flyleaf"
    @dbus_property(access=READ)
    def SupportedUriSchemes(self) -> 'as': return []
    @dbus_property(access=READ)
    def SupportedMimeTypes(self) -> 'as': return ["audio/mpeg", "audio/mp4", "audio/ogg", "audio/flac", "audio/wav"]


class Player(ServiceInterface):
    def __init__(self, command):
        super().__init__("org.mpris.MediaPlayer2.Player")
        self.command = command
        self.state = {"ready": False, "playing": False, "position": 0, "duration": 0, "rate": 1., "volume": 1., "title": "Flyleaf", "artist": "", "track_id": "/org/flyleaf/none", "next": False, "previous": False}

    @method()
    def Next(self): self.command("next", None)
    @method()
    def Previous(self): self.command("previous", None)
    @method()
    def Pause(self): self.command("pause", None)
    @method()
    def PlayPause(self): self.command("toggle", None)
    @method()
    def Stop(self): self.command("pause", None)
    @method()
    def Play(self): self.command("play", None)
    @method()
    def Seek(self, Offset: 'x'): self.command("offset", Offset / 1_000_000)
    @method()
    def SetPosition(self, TrackId: 'o', Position: 'x'):
        if TrackId == self.state["track_id"] and Position >= 0:
            self.command("seek", Position / 1_000_000)
    @method()
    def OpenUri(self, Uri: 's'):
        raise DBusError("org.mpris.MediaPlayer2.Error.NotSupported", "Open books in Flyleaf.")
    @signal()
    def Seeked(self, position) -> 'x': return position
    @dbus_property(access=READ)
    def PlaybackStatus(self) -> 's': return "Playing" if self.state["playing"] else "Paused" if self.state["ready"] else "Stopped"
    @dbus_property(access=READ)
    def LoopStatus(self) -> 's': return "None"
    @dbus_property()
    def Rate(self) -> 'd': return self.state["rate"]
    @Rate.setter
    def Rate(self, value: 'd'): self.command("rate", value)
    @dbus_property(access=READ)
    def Shuffle(self) -> 'b': return False
    @dbus_property(access=READ)
    def Metadata(self) -> 'a{sv}':
        return {"mpris:trackid": Variant('o', self.state["track_id"]), "mpris:length": Variant('x', int(self.state["duration"] * 1_000_000)),
                "xesam:title": Variant('s', self.state["title"]), "xesam:artist": Variant('as', [self.state["artist"]] if self.state["artist"] else [])}
    @dbus_property()
    def Volume(self) -> 'd': return self.state["volume"]
    @Volume.setter
    def Volume(self, value: 'd'): self.command("volume", value)
    @dbus_property(access=READ)
    def Position(self) -> 'x': return int(self.state["position"] * 1_000_000)
    @dbus_property(access=READ)
    def MinimumRate(self) -> 'd': return .5
    @dbus_property(access=READ)
    def MaximumRate(self) -> 'd': return 2.
    @dbus_property(access=READ)
    def CanGoNext(self) -> 'b': return self.state["next"]
    @dbus_property(access=READ)
    def CanGoPrevious(self) -> 'b': return self.state["previous"]
    @dbus_property(access=READ)
    def CanPlay(self) -> 'b': return self.state["ready"]
    @dbus_property(access=READ)
    def CanPause(self) -> 'b': return self.state["ready"]
    @dbus_property(access=READ)
    def CanSeek(self) -> 'b': return self.state["ready"]
    @dbus_property(access=READ)
    def CanControl(self) -> 'b': return True

    def update(self, state):
        previous = self.state
        self.state = state
        self.emit_properties_changed({"PlaybackStatus": self.PlaybackStatus, "Metadata": self.Metadata, "Rate": self.Rate, "Volume": self.Volume,
                                      "CanGoNext": self.CanGoNext, "CanGoPrevious": self.CanGoPrevious, "CanPlay": self.CanPlay, "CanPause": self.CanPause, "CanSeek": self.CanSeek})
        if state["ready"] and (state["track_id"] != previous["track_id"] or abs(state["position"] - previous["position"]) > 3):
            self.Seeked(self.Position)


class MprisControls:
    def __init__(self, command, failure):
        self.command, self.failure = command, failure
        self.loop = asyncio.new_event_loop()
        self.bus = self.player = None
        self.closed = False
        self.thread = threading.Thread(target=self.run, daemon=True)
        self.thread.start()
        self.starting = asyncio.run_coroutine_threadsafe(self.start(), self.loop)

    def run(self):
        asyncio.set_event_loop(self.loop)
        try:
            self.loop.run_forever()
        finally:
            async def cleanup():
                if self.bus:
                    self.bus.disconnect()
                    try:
                        await asyncio.wait_for(self.bus.wait_for_disconnect(), .2)
                    except Exception:
                        pass
                tasks = [task for task in asyncio.all_tasks() if task is not asyncio.current_task()]
                for task in tasks:
                    task.cancel()
                if tasks:
                    await asyncio.gather(*tasks, return_exceptions=True)
            self.loop.run_until_complete(cleanup())
            self.loop.close()

    async def start(self):
        try:
            from dbus_next.aio import MessageBus
            self.bus = await MessageBus().connect()
            if self.closed:
                self.bus.disconnect(); return
            self.player = Player(self.command)
            self.bus.export('/org/mpris/MediaPlayer2', Root(self.command))
            self.bus.export('/org/mpris/MediaPlayer2', self.player)
            await self.bus.request_name('org.mpris.MediaPlayer2.flyleaf.instance' + str(os.getpid()))
        except Exception:
            if not self.closed:
                self.failure("Linux system media controls are unavailable. Check your desktop D-Bus session.")

    def update(self, state):
        if not self.closed:
            self.loop.call_soon_threadsafe(lambda: self.player.update(state) if self.player and not self.closed else None)

    def close(self):
        if self.closed:
            return
        self.closed = True
        self.starting.cancel()
        def stop():
            self.loop.stop()
        self.loop.call_soon_threadsafe(stop)
        self.thread.join(timeout=.5)
