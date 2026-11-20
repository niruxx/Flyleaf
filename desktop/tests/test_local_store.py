import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch
from types import SimpleNamespace
from test_client import APP
from PySide6.QtWidgets import QWidget
from flyleaf_desktop.local_store import LocalStore
from flyleaf_desktop.reliability import ActiveClock


class LocalStoreTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(dir=Path(__file__).resolve().parents[1] / "build")
        self.store = LocalStore(self.directory.name)
        self.scope = self.store.account("https://books.test/flyleaf", {"id": 7, "username": "reader"}, "fictional-session")
        self.data = {"book": {"id": 1, "version": 12, "title": "A garden", "format": "cbz", "progress": {"updatedAt": 100, "page": 0, "percent": .1}}}
        self.store.remember_book(self.scope, self.data)

    def tearDown(self):
        self.store.close(); self.directory.cleanup()

    def test_restart_preserves_immutable_uncertain_save_and_additive_seconds(self):
        self.store.add_seconds(self.scope, 1, "2026-11-17", 1201)
        self.store.add_seconds(self.scope, 1, "2026-11-18", 12)
        self.store.enqueue(self.scope, 1, {"page": 2, "percent": .3})
        events = self.store.events(self.scope)
        self.assertEqual(len(events), 4)
        first = self.store.prepare(events[0])
        self.assertEqual(first["baseUpdatedAt"], 100)
        self.store.fail(events[0], "Connection lost after sending")
        self.store.close(); self.store = LocalStore(self.directory.name)
        self.assertEqual(self.store.prepare(self.store.events(self.scope)[0]), first)
        self.assertEqual(sum(json.loads(e["body"]).get("seconds", 0) for e in self.store.events(self.scope)), 1213)
        self.store.acknowledge(events[0], {"progress": {"updatedAt": 200, "page": 2, "percent": .3}})
        self.assertEqual(self.store.prepare(self.store.events(self.scope)[0])["baseUpdatedAt"], 200)

    def test_future_schema_is_rejected_and_server_downgrade_cannot_send_legacy_writes(self):
        from flyleaf_desktop.reliability import Reliability
        self.store.enqueue(self.scope, 1, {"page": 2, "percent": .3})
        api = SimpleNamespace(base="https://books.test/flyleaf", json=lambda *args, **kwargs: self.fail("A downgraded server must not receive unsafe legacy replay"))
        service = Reliability(api, self.store)
        try:
            service.start({"id": 7}, {})
            self.assertTrue(service.enabled)
            self.assertFalse(service.server_supported)
            service.pump()
            self.assertEqual(len(self.store.events(self.scope)), 1)
        finally:
            service.timer.stop(); service.stop(); service.deleteLater(); APP.processEvents()
        self.store.db.execute("PRAGMA user_version=999")
        with self.assertRaises(ValueError):
            LocalStore(self.directory.name)
        self.assertEqual(len(self.store.events(self.scope)), 1)

    def test_revoked_book_drops_content_but_keeps_immutable_progress_and_time_for_review(self):
        from flyleaf_desktop.reliability import Reliability
        service = Reliability(SimpleNamespace(base="https://books.test/flyleaf"), self.store)
        service.start({"id": 7}, {"durableProgress": 1})
        try:
            self.store.put_asset(self.scope, 1, "/api/books/1/file", b"private contents")
            self.store.finish_download(self.scope, 1, ["/api/books/1/file"])
            self.store.stage(self.scope, 1, {"page": 2, "percent": .3, "version": 12})
            self.store.add_seconds(self.scope, 1, "2026-11-18", 40)
            service.denied("/api/books/1/reader", 403)
            self.assertEqual(self.store.books(self.scope), [])
            self.assertIsNone(self.store.get_asset(self.scope, 1, "/api/books/1/file"))
            row = self.store.book(self.scope, 1)
            self.assertNotIn("A garden", row["data"])
            event = self.store.events(self.scope)[0]
            self.assertEqual(json.loads(event["body"])["seconds"], 40)
            self.assertEqual(json.loads(event["conflict"])["reason"], "access")
            service.observed("/api/books/1/reader", self.data)
            self.assertIsNone(self.store.events(self.scope)[0]["conflict"])
            self.assertEqual(self.store.prepare(self.store.events(self.scope)[0])["baseUpdatedAt"], 100)
        finally:
            service.timer.stop(); service.stop(); service.deleteLater(); APP.processEvents()

    def test_crash_checkpoint_becomes_a_durable_event_on_next_authenticated_session(self):
        from flyleaf_desktop.reliability import Reliability
        self.store.stage(self.scope, 1, {"page": 5, "percent": .6, "version": 12})
        self.store.add_seconds(self.scope, 1, "2026-11-18", 40)
        self.store.close(); self.store = LocalStore(self.directory.name)
        api = SimpleNamespace(base="https://books.test/flyleaf")
        service = Reliability(api, self.store)
        try:
            service.start({"id": 7}, {"durableProgress": 1})
            body = self.store.prepare(self.store.events(self.scope)[0])
            self.assertEqual(body["page"], 5)
            self.assertEqual(body["seconds"], 40)
            self.assertEqual(body["baseUpdatedAt"], 100)
            self.assertEqual(self.store.db.execute("SELECT COUNT(*) FROM drafts").fetchone()[0], 0)
        finally:
            service.timer.stop(); service.stop(); service.deleteLater(); APP.processEvents()

    def test_account_and_server_boundaries_vault_lock_and_no_plaintext_secrets(self):
        self.store.put_asset(self.scope, 1, "/api/books/1/file", b"private book")
        for server, user in (("https://books.test/flyleaf", 8), ("https://other.test", 7)):
            scope = self.store.account(server, {"id": user})
            self.assertIsNone(self.store.book(scope, 1))
            self.assertIsNone(self.store.get_asset(scope, 1, "/api/books/1/file"))
            self.assertEqual(self.store.events(scope), [])
        self.assertIsNotNone(self.store.unlock("https://books.test/flyleaf", 7, "fictional-session"))
        self.assertIsNone(self.store.unlock("https://books.test/flyleaf", 7, "different-session"))
        self.assertNotIn("fictional-session", "\n".join(self.store.db.iterdump()))
        self.store.lock_offline(self.scope)
        self.assertIsNone(self.store.unlock("https://books.test/flyleaf", 7, "fictional-session"))

    def test_partial_corrupt_and_revised_assets_cannot_open_as_complete_books(self):
        path = "/api/books/1/file"
        self.store.put_asset(self.scope, 1, path, b"book data")
        with self.assertRaises(ValueError):
            self.store.finish_download(self.scope, 1, [path, "/missing"])
        self.assertEqual(self.store.books(self.scope, complete=True), [])
        self.store.finish_download(self.scope, 1, [path])
        digest = self.store.db.execute("SELECT digest FROM assets").fetchone()[0]
        self.store.asset_file(self.scope, digest).write_bytes(b"tampered")
        self.assertIsNone(self.store.get_asset(self.scope, 1, path))
        self.assertEqual(self.store.books(self.scope, complete=True), [])
        self.store.put_asset(self.scope, 1, path, b"book data")
        self.store.finish_download(self.scope, 1, [path])
        self.store.remember_book(self.scope, {"book": {**self.data["book"], "version": 13}})
        self.assertIsNone(self.store.get_asset(self.scope, 1, path))

    def test_cleanup_protects_pins_and_pending_work_and_new_metadata_does_not_hide_conflicts(self):
        self.store.pin(self.scope, 1, True)
        self.assertEqual(self.store.cleanup_preview(self.scope), [])
        self.store.pin(self.scope, 1, False)
        self.store.enqueue(self.scope, 1, {"page": 2, "percent": .3})
        self.assertEqual(self.store.cleanup_preview(self.scope), [])
        with self.assertRaises(ValueError):
            self.store.remove_book(self.scope, 1)
        self.store.remember_book(self.scope, {"book": {**self.data["book"], "progress": {"updatedAt": 999}}})
        self.assertEqual(self.store.prepare(self.store.events(self.scope)[0])["baseUpdatedAt"], 100)
        self.store.remember_book(self.scope, {"book": {**self.data["book"], "version": 14}})
        self.assertEqual(self.store.book(self.scope, 1)["version"], "12")

    def test_explicit_server_resolution_preserves_time_without_overwriting_remote_location(self):
        self.store.add_seconds(self.scope, 1, "2026-11-18", 90)
        self.store.enqueue(self.scope, 1, {"page": 2, "percent": .3})
        original = self.store.events(self.scope)[0]["event_id"]
        remote = {"book": {**self.data["book"], "progress": {"updatedAt": 300, "page": 8, "percent": .9}}}
        self.store.resolve(self.scope, 1, remote, False)
        event = self.store.events(self.scope)[0]
        body = self.store.prepare(event)
        self.assertNotEqual(body["eventId"], original)
        self.assertEqual(body["seconds"], 90)
        self.assertEqual(body["baseUpdatedAt"], 300)
        self.assertNotIn("page", body)
        with self.assertRaises(ValueError):
            self.store.resolve(self.scope, 1, {"book": {**remote["book"], "version": 99}}, True)

    def test_conflict_resolution_consumes_latest_checkpoint_and_all_sampled_days(self):
        for keep_local in (True, False):
            with self.subTest(keep_local=keep_local):
                book = 2 if keep_local else 3
                data = {"book": {**self.data["book"], "id": book}}
                self.store.remember_book(self.scope, data)
                self.store.add_seconds(self.scope, book, "2026-11-18", 580)
                self.store.enqueue(self.scope, book, {"page": 2, "percent": .3})
                event = next(row for row in self.store.events(self.scope) if row["book"] == book)
                self.store.prepare(event)
                self.store.fail(event, "Conflict", {"reason": "positionChanged" if keep_local else "sourceChanged"})
                preview = self.store.pending_position(self.scope, book)
                latest = {"page": 4, "percent": .5}
                self.store.stage(self.scope, book, {**latest, "version": 12})
                self.store.add_seconds(self.scope, book, "2026-11-18", 35)
                self.store.add_seconds(self.scope, book, "2026-11-19", 8)
                version = 12 if keep_local else 13
                remote = {"book": {**data["book"], "version": version, "progress": {"updatedAt": 300, "page": 8}}}
                with self.assertRaisesRegex(ValueError, "local position changed"):
                    self.store.resolve(self.scope, book, remote, keep_local, expected_local=preview)
                self.store.resolve(self.scope, book, remote, keep_local, expected_local=latest)
                self.store.close()
                self.store = LocalStore(self.directory.name)
                events = [row for row in self.store.events(self.scope) if row["book"] == book]
                self.assertNotIn(event["event_id"], [row["event_id"] for row in events])
                bodies = [json.loads(row["body"]) for row in events]
                self.assertEqual([(body["day"], body["seconds"]) for body in bodies],
                                 [("2026-11-18", 600), ("2026-11-18", 15), ("2026-11-19", 8)])
                self.assertTrue(all(body["version"] == version for body in bodies))
                self.assertTrue(all(body.get("timeOnly", False) is not keep_local for body in bodies))
                self.assertEqual(self.store.pending_position(self.scope, book), latest if keep_local else {})
                self.assertEqual(self.store.prepare(events[0])["baseUpdatedAt"], 300)
                self.assertEqual(self.store.db.execute("SELECT COUNT(*) FROM drafts").fetchone()[0], 0)
                self.assertEqual(self.store.db.execute("SELECT COUNT(*) FROM clocks").fetchone()[0], 0)

    def test_time_only_replay_acknowledges_an_unread_book_without_recreating_its_position(self):
        from flyleaf_desktop.reliability import Reliability
        self.data["book"]["progress"] = None
        self.store.remember_book(self.scope, self.data)
        self.store.add_seconds(self.scope, 1, "2026-11-18", 40)

        def accept(_method, _path, success, _failure, body, **_options):
            self.assertTrue(body["timeOnly"])
            self.assertIsNone(body["baseUpdatedAt"])
            success({"ok": True, "progress": None})

        service = Reliability(SimpleNamespace(base="https://books.test/flyleaf", json=accept), self.store)
        try:
            service.start({"id": 7}, {"durableProgress": 1})
            service.pump()
            self.assertEqual(self.store.events(self.scope), [])
            self.assertIsNone(json.loads(self.store.book(self.scope, 1)["data"])["book"]["progress"])
        finally:
            service.timer.stop(); service.stop(); service.deleteLater(); APP.processEvents()

    def test_abrupt_process_exit_recovers_committed_state_and_rolls_back_partial_ack(self):
        self.store.close()
        src = Path(__file__).resolve().parents[1] / "src"
        script = """
import os, sys
sys.path.insert(0, sys.argv[1])
from flyleaf_desktop.local_store import LocalStore
store = LocalStore(sys.argv[2])
scope = sys.argv[3]
store.add_seconds(scope, 1, "2026-11-18", 40)
store.enqueue(scope, 1, {"page": 2, "percent": .3})
event = store.events(scope)[0]
store.prepare(event)
store.stage(scope, 1, {"page": 3, "percent": .4, "version": 12})
with store.transaction():
    store.db.execute("DELETE FROM events WHERE id=?", (event["id"],))
    os._exit(17)
"""
        result = subprocess.run([sys.executable, "-c", script, str(src), self.directory.name, self.scope],
                                capture_output=True, text=True, timeout=15)
        self.store = LocalStore(self.directory.name)
        self.assertEqual(result.returncode, 17, result.stderr)
        event, = self.store.events(self.scope)
        body = self.store.prepare(event)
        self.assertEqual((event["prepared"], body["baseUpdatedAt"], body["page"], body["seconds"]), (1, 100, 2, 40))
        self.assertEqual(self.store.pending_position(self.scope, 1), {"page": 3, "percent": .4})
        self.assertEqual(self.store.db.execute("PRAGMA integrity_check").fetchone()[0], "ok")

    def test_active_clock_excludes_suspend_intervals_and_persists_sampled_seconds(self):
        reader = QWidget()
        service = SimpleNamespace(scope=self.scope, store=self.store, enabled=True)
        reader.api = SimpleNamespace(reliability=service)
        reader.book = {"id": 1}
        reader._disposed = False
        with patch("flyleaf_desktop.reliability.time.monotonic", return_value=0):
            clock = ActiveClock(reader)
        clock.active = lambda now: True
        try:
            for value in (1.2, 2.4, 40, 41.1):
                with patch("flyleaf_desktop.reliability.time.monotonic", return_value=value):
                    clock.tick()
            seconds = self.store.db.execute("SELECT SUM(seconds) FROM clocks WHERE scope=?", (self.scope,)).fetchone()[0]
            self.assertEqual(seconds, 3)
        finally:
            clock.timer.stop(); APP.removeEventFilter(clock); reader.deleteLater(); APP.processEvents()


if __name__ == "__main__":
    unittest.main()
