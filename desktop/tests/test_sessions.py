"""Vault failure contracts and serialized-session origin/expiry checks."""
import json
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

from test_client import APP
from PySide6.QtCore import QUrl
from PySide6.QtNetwork import QNetworkCookie
from flyleaf_desktop.api import FlyleafApi
from flyleaf_desktop.vault import SessionVault, VaultUnavailable


class SessionSerializationTests(unittest.TestCase):
    def setUp(self):
        self.api = FlyleafApi()
        self.api.connect_server("https://books.example.com/flyleaf")

    def tearDown(self):
        self.api.reset()
        self.api.deleteLater()
        APP.processEvents()

    def test_roundtrip_scopes_cookie_to_server_base_path(self):
        cookies = QNetworkCookie.parseCookies(b"flyleaf_session=fictional; Path=/; Secure; HttpOnly")
        self.api.manager.cookieJar().setCookiesFromUrl(cookies, QUrl(self.api.base + "/"))
        secret = self.api.export_session(7)
        self.api.reset()
        self.assertEqual(self.api.restore_session(secret), 7)
        jar = self.api.manager.cookieJar()
        self.assertEqual(len(jar.cookiesForUrl(QUrl(self.api.base + "/api/status"))), 1)
        self.assertEqual(len(jar.cookiesForUrl(QUrl("https://books.example.com/other/api/status"))), 0)
        self.assertEqual(len(jar.cookiesForUrl(QUrl("http://books.example.com/flyleaf/api/status"))), 0)

    def test_wrong_server_expired_and_foreign_cookie_names_are_rejected(self):
        for server, cookie in [("https://other.example.com", "flyleaf_session=test"),
                               (self.api.base, "unrelated_cookie=test"),
                               (self.api.base, "flyleaf_session=test; Expires=Thu, 01 Jan 1970 00:00:01 GMT")]:
            with self.subTest(server=server, cookie=cookie), self.assertRaises(ValueError):
                self.api.restore_session(json.dumps({"server": server, "userId": 7, "cookie": cookie}))
        self.assertFalse(self.api.manager.cookieJar().cookiesForUrl(QUrl(self.api.base + "/api/status")))


class LinuxVaultContractTests(unittest.TestCase):
    def setUp(self):
        self.bus = Mock()
        self.collection = Mock()
        self.collection.is_locked.return_value = False
        self.collection.search_items.return_value = []
        self.module = SimpleNamespace(dbus_init=Mock(return_value=self.bus), get_collection_by_alias=Mock(return_value=self.collection))
        self.profile = {"id": "fictional-test-profile", "address": "https://example.invalid"}
        self.vault = SessionVault()

    def perform(self, operation, secret=None):
        with patch.dict("sys.modules", {"secretstorage": self.module}), patch("flyleaf_desktop.vault.sys.platform", "linux"):
            return self.vault.perform(operation, self.profile, secret)

    def test_secret_service_roundtrip_uses_only_the_named_collection_and_closes_bus(self):
        self.perform("write", "fictional-session")
        args, kwargs = self.collection.create_item.call_args
        self.assertEqual(args[2], b"fictional-session")
        self.assertEqual(kwargs, {"replace": True})
        self.assertEqual(args[1]["application"], "flyleaf-desktop")
        item = Mock()
        item.is_locked.return_value = False
        item.get_secret.return_value = b"fictional-session"
        self.collection.search_items.return_value = [item]
        self.assertEqual(self.perform("read"), "fictional-session")
        self.perform("delete")
        item.delete.assert_called_once()
        self.assertEqual(self.bus.close.call_count, 3)

    def test_locked_or_missing_service_never_creates_or_unlocks_a_collection(self):
        self.collection.is_locked.return_value = True
        with self.assertRaises(VaultUnavailable):
            self.perform("write", "fictional-session")
        self.collection.create_item.assert_not_called()
        self.collection.unlock.assert_not_called()
        self.bus.close.assert_called_once()
        self.module.dbus_init.side_effect = RuntimeError("No session bus")
        with self.assertRaises(VaultUnavailable):
            self.perform("read")
        self.collection.create_item.assert_not_called()

    def test_profile_and_origin_namespaces_do_not_collide(self):
        key = self.vault.key(self.profile)
        self.assertNotEqual(key, self.vault.key({**self.profile, "id": "other-profile"}))
        self.assertNotEqual(key, self.vault.key({**self.profile, "address": "https://example.invalid/other"}))


if __name__ == "__main__":
    unittest.main()
