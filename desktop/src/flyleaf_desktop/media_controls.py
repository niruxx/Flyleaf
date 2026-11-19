"""Native OS media sessions; all external callbacks enter Qt through a signal."""
from datetime import timedelta
import math
import sys
from PySide6.QtCore import QObject, QTimer, Signal
from PySide6.QtWidgets import QApplication


class WindowsControls:
    def __init__(self, hwnd, command):
        from winrt.windows.media.interop import get_for_window
        from winrt.windows.media import (SystemMediaTransportControlsButton as Button,
            MediaPlaybackStatus, MediaPlaybackType, SystemMediaTransportControlsTimelineProperties)
        self.status_type = MediaPlaybackStatus
        self.timeline_type = SystemMediaTransportControlsTimelineProperties
        self.controls = get_for_window(hwnd)
        self.controls.is_enabled = False
        self.controls.is_play_enabled = self.controls.is_pause_enabled = self.controls.is_stop_enabled = True
        mapping = {Button.PLAY: "play", Button.PAUSE: "pause", Button.STOP: "pause", Button.NEXT: "next", Button.PREVIOUS: "previous", Button.FAST_FORWARD: "forward", Button.REWIND: "back"}
        self.button = self.controls.add_button_pressed(lambda _sender, event: command(mapping.get(event.button, "none"), None))
        self.position = self.controls.add_playback_position_change_requested(lambda _sender, event: command("seek", event.requested_playback_position.total_seconds()))
        self.rate = self.controls.add_playback_rate_change_requested(lambda _sender, event: command("rate", event.requested_playback_rate))
        self.controls.display_updater.type = MediaPlaybackType.MUSIC
        self.title = None

    def update(self, snapshot):
        controls = self.controls
        controls.is_enabled = snapshot["ready"]
        controls.is_next_enabled = snapshot["next"]
        controls.is_previous_enabled = snapshot["previous"]
        controls.playback_status = self.status_type.PLAYING if snapshot["playing"] else self.status_type.PAUSED if snapshot["ready"] else self.status_type.STOPPED
        controls.playback_rate = snapshot["rate"]
        metadata = (snapshot["title"], snapshot["artist"], snapshot["track"])
        if metadata != self.title:
            self.title = metadata
            properties = controls.display_updater.music_properties
            properties.title, properties.artist = snapshot["title"], snapshot["artist"]
            properties.album_title = snapshot["track"]
            controls.display_updater.update()
        timeline = self.timeline_type()
        timeline.start_time = timeline.min_seek_time = timedelta(0)
        timeline.position = timedelta(seconds=snapshot["position"])
        timeline.end_time = timeline.max_seek_time = timedelta(seconds=snapshot["duration"])
        controls.update_timeline_properties(timeline)

    def close(self):
        self.controls.is_enabled = False
        self.controls.display_updater.clear_all()
        self.controls.display_updater.update()
        self.controls.remove_button_pressed(self.button)
        self.controls.remove_playback_position_change_requested(self.position)
        self.controls.remove_playback_rate_change_requested(self.rate)


class MediaControls(QObject):
    command = Signal(str, object)
    unavailable = Signal(str)

    def __init__(self, reader):
        super().__init__(reader)
        self.reader, self.backend, self.error = reader, None, ""
        self.closed = False
        self.command.connect(self.receive)
        self.timer = QTimer(self); self.timer.setInterval(1000); self.timer.timeout.connect(self.update)
        if QApplication.platformName() == "offscreen":
            return
        try:
            if sys.platform == "win32":
                self.backend = WindowsControls(int(reader.window().winId()), self.command.emit)
            elif sys.platform.startswith("linux"):
                from .mpris import MprisControls
                self.backend = MprisControls(self.command.emit, self.unavailable.emit)
            if self.backend:
                self.timer.start(); self.update()
        except Exception:
            self.error = "System media controls are unavailable. Playback controls in Flyleaf still work."

    def snapshot(self):
        reader = self.reader
        player = reader.player
        tracks = getattr(reader, "track_info", [])
        return {"ready": bool(reader._ready), "playing": bool(reader._ready and player and player.is_playing()),
                "position": max(0, player.get_time() / 1000) if player else 0,
                "duration": max(0, player.get_length() / 1000) if player else 0,
                "rate": float(reader.rate.currentData() or 1),
                "volume": max(0, min(1, player.audio_get_volume() / 100)) if player else 1,
                "title": str(reader.book.get("title") or "Flyleaf audiobook"),
                "artist": str(reader.book.get("author") or ""),
                "track": str(tracks[reader.page].get("title") or "") if 0 <= reader.page < len(tracks) else "",
                "track_id": f"/org/flyleaf/book_{reader.book['id']}/track_{reader.page}",
                "next": reader.page + 1 < reader.total, "previous": reader.page > 0}

    def update(self):
        if self.closed or self.reader._disposed or not self.backend:
            return
        try:
            self.backend.update(self.snapshot())
        except Exception:
            self.unavailable.emit("System media controls disconnected. Playback in Flyleaf is still available.")
            self.close()

    def receive(self, command, value):
        if self.closed or self.reader._disposed:
            return
        reader = self.reader
        if command == "play" and reader.player and not reader.player.is_playing():
            reader.toggle_play()
        elif command == "pause": reader.pause()
        elif command == "toggle": reader.toggle_play()
        elif command == "next": reader.load_track(reader.page + 1, 0, True)
        elif command == "previous": reader.load_track(reader.page - 1, 0, True)
        elif command == "forward": reader.skip(30)
        elif command == "back": reader.skip(-30)
        elif command in ("seek", "rate", "volume", "offset") and isinstance(value, (int, float)) and math.isfinite(value):
            if command == "seek": reader.seek_to(max(0, value))
            elif command == "offset": reader.skip(value)
            elif command == "volume" and reader.player: reader.player.audio_set_volume(round(max(0, min(1, value)) * 100))
            elif command == "rate":
                value = max(.5, min(2, value))
                index = reader.rate.findData(value)
                if index < 0:
                    reader.rate.addItem(f"{value:g}×", value)
                    index = reader.rate.findData(value)
                if index >= 0: reader.rate.setCurrentIndex(index)
        elif command == "raise":
            reader.window().showNormal(); reader.window().activateWindow()
        elif command == "quit": reader.window().close()

    def close(self):
        if self.closed:
            return
        self.closed = True
        self.timer.stop()
        if self.backend:
            try:
                self.backend.close()
            except Exception:
                pass
            self.backend = None
