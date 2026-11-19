"""Native VLC audiobook playback, guarded position writes and authenticated streaming."""
from datetime import date
import os
from pathlib import Path
import queue
import time
import math
from PySide6.QtCore import Qt, QTimer, QUrl
from PySide6.QtGui import QKeySequence, QShortcut
from PySide6.QtWidgets import (QComboBox, QHBoxLayout, QListWidget, QListWidgetItem,
    QPushButton, QSlider, QSpinBox, QVBoxLayout, QWidget)
from .audio_relay import AudioRelay
from .widgets import label, text

_dll_directories = []


def load_vlc():
    if os.name == "nt":
        candidates = [Path(os.environ["FLYLEAF_VLC_PATH"])] if os.environ.get("FLYLEAF_VLC_PATH") else []
        candidates += [Path(__file__).resolve().parents[2] / "build" / "vlc" / "vlc-3.0.24",
                       Path(os.environ.get("ProgramFiles", "C:/Program Files")) / "VideoLAN" / "VLC"]
        for path in candidates:
            if (path / "libvlc.dll").is_file():
                if hasattr(os, "add_dll_directory"):
                    _dll_directories.append(os.add_dll_directory(str(path)))
                os.environ["PYTHON_VLC_LIB_PATH"] = str(path / "libvlc.dll")
                os.environ["PYTHON_VLC_MODULE_PATH"] = str(path / "plugins")
                break
    try:
        import vlc
        return vlc
    except (Exception, SystemExit) as error:
        raise RuntimeError("Native audio requires VLC/libVLC. Install VLC on this computer, or set FLYLEAF_VLC_PATH to a portable VLC folder, then reopen this book.") from error


def clock(seconds):
    seconds = max(0, int(seconds))
    return f"{seconds // 3600}:{seconds // 60 % 60:02}:{seconds % 60:02}"


class AudioReader(QWidget):
    def __init__(self, api, data, leave, *, silent=False):
        super().__init__()
        self.api, self.book, self.leave = api, data["book"], leave
        self._disposed = False
        self._saving = False
        self._saving_page = None
        self._pending = None
        self._last_saved = None
        self._after_save = None
        self._image = None
        self.page = 0
        self.total = 0
        self.relay = self.player = self.instance = None
        self.media_controls = None
        self._seek_on_start = 0
        self._seek_target = None
        self._ready = False
        self._position = "0:0"
        self._verified_locator = (self.book.get("progress") or {}).get("position") or "0:0"
        self._last_poll = time.monotonic()
        self._stream_interrupted = False
        self._resume_confirmation = False
        self._last_tick = 0
        self._last_state = None
        self._last_save_time = 0
        self._track_durations = {}
        self._probe = None
        self._probe_queue = []
        self._known_duration = 0
        outer = QVBoxLayout(self)
        back = QPushButton("Back to library")
        back.clicked.connect(lambda: self.request_leave(self.leave))
        outer.addWidget(back, alignment=Qt.AlignmentFlag.AlignLeft)
        outer.addWidget(label(text(self.book.get("title"), "Audiobook"), heading=True, wrap=True))
        self.tracks = QListWidget()
        self.tracks.setAccessibleName("Audiobook tracks and chapters")
        self.tracks.itemActivated.connect(self.select_track)
        outer.addWidget(self.tracks, 1)
        self.time = label("0:00:00 / 0:00:00")
        outer.addWidget(self.time)
        self.seek = QSlider(Qt.Orientation.Horizontal)
        self.seek.setAccessibleName("Playback position in current track")
        self.seek.sliderReleased.connect(lambda: self.seek_to(self.seek.value()))
        outer.addWidget(self.seek)
        controls = QHBoxLayout()
        previous = QPushButton("−30 seconds"); previous.clicked.connect(lambda: self.skip(-30)); controls.addWidget(previous)
        self.play = QPushButton("Play")
        self.play.setProperty("primary", True); self.play.clicked.connect(self.toggle_play); controls.addWidget(self.play)
        next_button = QPushButton("+30 seconds"); next_button.clicked.connect(lambda: self.skip(30)); controls.addWidget(next_button)
        self.rate = QComboBox(); self.rate.setAccessibleName("Playback speed")
        for rate in (.5, .75, 1.0, 1.25, 1.5, 1.75, 2.0):
            self.rate.addItem(f"{rate:g}×", rate)
        self.rate.setCurrentIndex(2)
        self.rate.currentIndexChanged.connect(lambda _: self.player.set_rate(self.rate.currentData()) if self.player else None)
        controls.addWidget(self.rate)
        self.sleep = QSpinBox(); self.sleep.setRange(0, 180); self.sleep.setSuffix(" min")
        self.sleep.setSpecialValueText("No sleep timer"); self.sleep.setAccessibleName("Audio sleep timer")
        self.sleep.valueChanged.connect(self._sleep_changed)
        controls.addWidget(self.sleep)
        outer.addLayout(controls)
        self.notice = label("Loading audiobook…", wrap=True); outer.addWidget(self.notice)
        self.media_status = label("", wrap=True); outer.addWidget(self.media_status)
        self.retry_save = QPushButton("Retry saving"); self.retry_save.clicked.connect(self.flush_progress); self.retry_save.hide()
        self.discard_save = QPushButton("Leave without saving"); self.discard_save.clicked.connect(self._discard_and_leave); self.discard_save.hide()
        outer.addWidget(self.retry_save); outer.addWidget(self.discard_save)
        self.timer = QTimer(self); self.timer.setInterval(500); self.timer.timeout.connect(self.poll)
        self.sleep_timer = QTimer(self); self.sleep_timer.setSingleShot(True); self.sleep_timer.timeout.connect(self.pause)
        self.shortcuts = []
        from .reader_tools import ReaderTools
        self.companion_tools = ReaderTools(self, data)
        notes = QPushButton("Bookmarks & notes")
        notes.clicked.connect(self.companion_tools.show)
        outer.addWidget(notes)
        for key, callback in [(Qt.Key.Key_MediaPlay, self.toggle_play), (Qt.Key.Key_MediaPause, self.pause), (Qt.Key.Key_MediaTogglePlayPause, self.toggle_play), (Qt.Key.Key_MediaNext, lambda: self.load_track(self.page + 1, 0, True)), (Qt.Key.Key_MediaPrevious, lambda: self.load_track(self.page - 1, 0, True))]:
            shortcut = QShortcut(QKeySequence(key), self); shortcut.activated.connect(callback); self.shortcuts.append(shortcut)
        try:
            self.vlc = load_vlc()
            options = ["--no-video", "--no-lua", "--no-metadata-network-access", "--quiet"]
            if silent:
                options.append("--aout=dummy")
            self.instance = self.vlc.Instance(*options)
            self.player = self.instance.media_player_new()
        except Exception as error:
            self.notice.setText(str(error)); self.play.setEnabled(False); return
        self.api.json("GET", f"/api/books/{self.book['id']}/tracks", self._tracks_loaded, lambda error: self.notice.setText(error.message) if not self._disposed else None)
        QTimer.singleShot(0, self._init_media_controls)

    def _init_media_controls(self):
        if not self._disposed:
            from .media_controls import MediaControls
            self.media_controls = MediaControls(self)
            self.media_controls.unavailable.connect(self.media_status.setText)
            self.media_status.setText(self.media_controls.error)

    def _tracks_loaded(self, data):
        if self._disposed:
            return
        records = data.get("tracks") if isinstance(data, dict) else None
        if not isinstance(records, list) or not records:
            self.notice.setText("This audiobook has no playable tracks."); return
        self.total = len(records)
        self._probe_queue = list(range(self.total))
        self._known_duration = data.get("duration") or 0
        self.track_info = records
        for index, track in enumerate(records):
            item = QListWidgetItem(text(track.get("title"), f"Track {index + 1}"))
            item.setData(Qt.ItemDataRole.UserRole, (index, 0)); self.tracks.addItem(item)
        if self.total == 1:
            for chapter in data.get("chapters") or []:
                if isinstance(chapter, dict) and isinstance(chapter.get("start"), (int, float)):
                    item = QListWidgetItem("  " + text(chapter.get("title"), "Chapter"))
                    item.setData(Qt.ItemDataRole.UserRole, (0, max(0, chapter["start"])))
                    self.tracks.addItem(item)
        cookies = self.api.manager.cookieJar().cookiesForUrl(QUrl(self.api.base + f"/api/books/{self.book['id']}/tracks/0"))
        cookie = "; ".join(bytes(c.toRawForm(c.RawForm.NameAndValueOnly)).decode("latin-1") for c in cookies if bytes(c.name()) == b"flyleaf_session")
        local_files = None
        if getattr(self.api, "offline", False):
            service = self.api.reliability
            local_files = {}
            for index in range(self.total):
                path = f"/api/books/{self.book['id']}/tracks/{index}"
                if service.store.get_asset(service.scope, self.book["id"], path) is None:
                    self.notice.setText("An offline track is missing or failed verification. Download this book again."); return
                row = service.store.db.execute("SELECT digest FROM assets WHERE scope=? AND book=? AND path=?", (service.scope, self.book["id"], path)).fetchone()
                local_files[index] = service.store.asset_file(service.scope, row["digest"])
        service = getattr(self.api, "reliability", None)
        account_id = service.user["id"] if service and service.enabled and service.user else None
        self.relay = AudioRelay(self.api.base, self.book["id"], cookie, self.total, local_files=local_files, account_id=account_id)
        saved = (self.book.get("progress") or {}).get("position") or "0:0"
        try:
            track, seconds = str(saved).split(":", 1)
            track, seconds = int(track), float(seconds)
            if not 0 <= track < self.total or not math.isfinite(seconds) or seconds < 0:
                raise ValueError("Invalid audio position")
        except (ValueError, TypeError):
            track, seconds = 0, 0
            self._resume_confirmation = True
        if (self.book.get("progress") or {}).get("percent") and not (self.book.get("progress") or {}).get("position"):
            self._resume_confirmation = True
        if self._resume_confirmation:
            self._verified_locator = None
        self.load_track(min(self.total - 1, max(0, track)), max(0, seconds), False)
        self.timer.start()

    def select_track(self, item):
        self._resume_confirmation = False
        track, seconds = item.data(Qt.ItemDataRole.UserRole)
        self.load_track(track, seconds, bool(self.player and self.player.is_playing()))

    def load_track(self, track, seconds=0, playing=False):
        if self._disposed or not self.relay or not 0 <= track < self.total or not math.isfinite(seconds):
            return
        if self._ready:
            self.queue_position(); self.flush_progress()
        self._stream_interrupted = False
        self.page = track
        self._seek_on_start = max(0, seconds)
        self._seek_target = None
        self._ready = False
        self._position = f"{track}:{int(seconds)}"
        self.player.stop()
        media = self.instance.media_new(self.relay.url(track))
        media.add_option(":no-video")
        self.player.set_media(media); media.release()
        self._start_paused = not playing
        self.player.audio_set_mute(True)
        self.player.play()
        self.notice.setText("Opening native audio stream…")

    def toggle_play(self):
        if not self.player:
            return
        self._resume_confirmation = False
        if self._stream_interrupted or self.player.get_state() in (self.vlc.State.Error, self.vlc.State.Stopped):
            try:
                track, seconds = self._verified_locator.split(":", 1)
                self.load_track(int(track), float(seconds), True)
            except (ValueError, TypeError, AttributeError):
                self.load_track(self.page, 0, True)
            return
        if not self._ready:
            self._start_paused = False
            self.player.play()
            return
        if self.player.is_playing():
            self.pause()
        else:
            self._start_paused = False
            self.player.play(); self.play.setText("Pause")

    def pause(self):
        if self.player:
            self._start_paused = True
            self.player.set_pause(1)
            self.play.setText("Play")
            self.queue_position()
            self.flush_progress()

    def seek_to(self, seconds):
        if self.player and self._ready:
            self._resume_confirmation = False
            self.load_track(self.page, max(0, seconds), bool(self.player.is_playing()))

    def skip(self, seconds):
        if self.player:
            self.seek_to(max(0, self.player.get_time() / 1000 + seconds))

    def _sleep_changed(self, minutes):
        self.sleep_timer.start(minutes * 60000) if minutes else self.sleep_timer.stop()

    def poll(self):
        if self._disposed or not self.player:
            return
        now = time.monotonic()
        elapsed, self._last_poll = now - self._last_poll, now
        if self._ready and elapsed > 8:
            self._ready = False
            self._stream_interrupted = True
            self.player.set_pause(1)
            self.play.setText("Resume after interruption")
            self.notice.setText("Playback paused after sleep or a long interruption. Resume from the last verified position.")
            return
        self._poll_probe()
        if self.relay:
            try:
                while True:
                    status = self.relay.events.get_nowait()
                    if status == 401:
                        self.pause(); self.api.session_expired.emit(); return
                    if status in (403, 404):
                        service = getattr(self.api, "reliability", None)
                        if service:
                            service.denied(f"/api/books/{self.book['id']}/tracks", status)
                        else:
                            self.pause()
                        return
                    self._stream_interrupted = True
                    self.play.setText("Reconnect")
                    self.notice.setText("Audio stream interrupted. Press Play to reconnect; your pending position is retained.")
            except queue.Empty:
                pass
        state = self.player.get_state()
        if self._stream_interrupted and not self._ready:
            return
        if state == self.vlc.State.Playing:
            if self._seek_on_start:
                if not self.player.is_seekable():
                    return
                duration = max(0, self.player.get_length() / 1000)
                self._seek_target = min(self._seek_on_start, max(0, duration - .1)) if duration else self._seek_on_start
                # libVLC 3 exposes a void setter; newer bindings may return 0.
                if self.player.set_time(round(self._seek_target * 1000)) not in (None, 0):
                    self.notice.setText("The saved audio position could not be restored. No new position has been saved.")
                    return
                self._seek_on_start = 0
            if self._seek_target is not None:
                if abs(self.player.get_time() / 1000 - self._seek_target) > 2:
                    return
                self._seek_target = None
            self._ready = True
            self.player.set_rate(self.rate.currentData())
            if self._start_paused:
                self._start_paused = False; self.player.set_pause(1)
            else:
                self.play.setText("Pause")
            self.player.audio_set_mute(False)
            self.notice.setText("Streaming from your Flyleaf server · native audio")
            if self._resume_confirmation:
                self.notice.setText("The saved audio position is invalid or missing. Select a track or press Play to deliberately resume here; existing progress is retained.")
                self.play.setText("Resume here")
            elif self._stream_interrupted:
                self.play.setText("Reconnect")
                self.notice.setText("The connection was interrupted. Buffered audio may continue; reconnect to resume from the verified position.")
        elif state == self.vlc.State.Ended and self._last_state != state:
            self.queue_position(ended=True); self.flush_progress()
            if self.page + 1 < self.total:
                self.load_track(self.page + 1, 0, True)
        elif state == self.vlc.State.Error:
            self._ready = False
            self._stream_interrupted = True
            self.play.setText("Reconnect")
            self.notice.setText("The audio stream could not play. Check the connection and installed VLC codecs, then press Play to retry.")
        self._last_state = state
        duration = max(0, self.player.get_length() / 1000)
        seconds = max(0, self.player.get_time() / 1000)
        if duration:
            self._track_durations[self.page] = duration
            self.seek.setRange(0, max(1, round(duration)))
        if not self.seek.isSliderDown():
            self.seek.setValue(round(seconds))
        self.time.setText(f"{clock(seconds)} / {clock(duration)}")
        if state == self.vlc.State.Playing:
            self._last_tick += 1
            self.queue_position()
            if self._last_tick % 10 == 0:
                self.flush_progress()

    def _poll_probe(self):
        if not self.relay:
            return
        if self._probe:
            index, media = self._probe
            status = media.get_parsed_status()
            if status in (self.vlc.MediaParsedStatus.done, self.vlc.MediaParsedStatus.failed, self.vlc.MediaParsedStatus.timeout, self.vlc.MediaParsedStatus.skipped):
                duration = media.get_duration() / 1000
                if duration > 0:
                    self._track_durations[index] = duration
                media.release(); self._probe = None
        if self._probe is None and self._probe_queue:
            index = self._probe_queue.pop(0)
            media = self.instance.media_new(self.relay.url(index))
            if media.parse_with_options(self.vlc.MediaParseFlag.network, 5000) == 0:
                self._probe = index, media
            else:
                media.release()

    def queue_position(self, ended=False):
        if not self.player or not self.total or not self._ready or self._resume_confirmation:
            return
        state = self.player.get_state()
        if state in (self.vlc.State.Error, self.vlc.State.Stopped, self.vlc.State.Opening, self.vlc.State.Buffering) or state == self.vlc.State.Ended and not ended:
            return
        raw_time = self.player.get_time()
        if raw_time < 0 and not ended:
            return
        seconds = max(0, raw_time / 1000)
        if ended:
            seconds = self._track_durations.get(self.page) or seconds
        self._position = f"{self.page}:{int(seconds)}"
        self._verified_locator = self._position
        duration = self._track_durations.get(self.page, 0)
        # Never treat unknown earlier track lengths as zero. Until all durations
        # are known, track-local position remains exact and the old fraction stays.
        percent = (self.book.get("progress") or {}).get("percent", 0)
        if self.total == 1 and duration:
            percent = min(.998, seconds / duration)
        elif len(self._track_durations) == self.total:
            percent = min(.998, (sum(self._track_durations[i] for i in range(self.page)) + seconds) / sum(self._track_durations.values()))
        if ended and self.page == self.total - 1:
            percent = 1
        self._pending = {"position": self._position, "percent": percent, "day": date.today().isoformat(), "version": self.book.get("version")}
        service = getattr(self.api, "reliability", None)
        if service and service.enabled and service.scope:
            try:
                service.store.stage(service.scope, self.book["id"], self._pending)
            except Exception as error:
                self.notice.setText("Device checkpoint failed: " + str(error))

    def current_locator(self):
        return self._verified_locator

    def go_to_locator(self, locator):
        try:
            track, seconds = str(locator).split(":", 1)
            self._resume_confirmation = False
            self.load_track(int(track), max(0, float(seconds)), False)
        except (TypeError, ValueError):
            self.notice.setText("This audio bookmark has an invalid position.")

    @property
    def has_unsaved_changes(self):
        return self._saving or self._pending is not None

    def flush_progress(self):
        if self._disposed or self._saving:
            return
        if self._pending is None:
            if self._after_save:
                callback, self._after_save = self._after_save, None; callback()
            return
        body, self._pending = self._pending, None
        submitted_track = int(body["position"].split(":", 1)[0])
        self._saving, self._saving_page = True, submitted_track
        def saved(_data):
            if self._disposed:
                return
            self._saving, self._saving_page = False, None
            self._last_saved = submitted_track
            if isinstance(_data, dict) and _data.get("queued"):
                self.notice.setText("Audio position saved on this device · pending sync")
            self.retry_save.hide(); self.discard_save.hide()
            if self._after_save:
                self.flush_progress()
        def failed(error):
            if self._disposed:
                return
            self._saving, self._saving_page = False, None
            if self._pending is None:
                self._pending = body
            self.notice.setText("Audio position not saved: " + error.message)
            self.retry_save.show(); self.discard_save.setVisible(self._after_save is not None)
        self.api.json("PUT", f"/api/books/{self.book['id']}/progress", saved, failed, body)

    def request_leave(self, callback):
        self.pause()
        self._after_save = callback
        self.flush_progress()

    def _discard_and_leave(self):
        if self._after_save:
            callback, self._after_save = self._after_save, None
            self._pending = None; callback()

    def dispose(self):
        if not self._disposed:
            if hasattr(self, "active_clock"):
                self.active_clock.stop()
            service = getattr(self.api, "reliability", None)
            if service:
                service.capture(self)
        self._disposed = True
        if self.media_controls:
            self.media_controls.close()
        self.timer.stop(); self.sleep_timer.stop()
        self.companion_tools.close()
        if hasattr(self.companion_tools, "history"):
            self.companion_tools.history.close()
        if self._probe:
            self._probe[1].parse_stop(); self._probe[1].release(); self._probe = None
        if self.player:
            self.player.stop(); self.player.release(); self.player = None
        if self.instance:
            self.instance.release(); self.instance = None
        if self.relay:
            self.relay.close(); self.relay = None
