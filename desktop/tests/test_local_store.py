import json
from pathlib import Path
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
