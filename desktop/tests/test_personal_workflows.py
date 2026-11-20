import unittest
from urllib.parse import urlencode

from test_client import APP
from flyleaf_desktop.home_layout import ordered_home, records_for_home
from flyleaf_desktop.integrations import authorization_url
from flyleaf_desktop.reader_keys import page_keys


class PersonalWorkflowTests(unittest.TestCase):
    def test_account_home_layout_keeps_section_order_and_sort(self):
        data = {
            "continueReading": [{"id": 1, "title": "Continue"}],
            "recentlyAdded": [{"id": 2, "name": "Zulu"}, {"id": 3, "name": "Alpha"}],
            "wantToRead": [{"id": 4, "name": "Hidden"}],
        }
        prefs = {"order": ["added", "continue", "added", ["unsupported"]], "hidden": ["want"], "sort": "az"}
        records = records_for_home(data, prefs)
        self.assertEqual([(row["kind"], row["data"]["id"]) for row in records],
                         [("series", 3), ("series", 2), ("book", 1)])
        self.assertEqual(ordered_home(prefs)[:2], ["added", "continue"])
        self.assertEqual(len(records_for_home(data, prefs, "continue")), 1)

    def test_shared_shortcuts_map_browser_keys_and_preserve_disabled_actions(self):
        keys = {action: key.toString() for action, key in page_keys({"next": ["J"], "prev": [], "first": ["Ctrl+Home"]})}
        self.assertEqual(keys["pageRight"], "Right")
        self.assertEqual(keys["next"], "J")
        self.assertEqual(keys["first"], "Ctrl+Home")
        self.assertNotIn("prev", keys)

    def test_browser_authorization_requires_the_intended_provider_and_callback(self):
        server = "https://books.example"
        endpoint = "https://anilist.co/api/v2/oauth/authorize"
        query = {"redirect_uri": server + "/api/tracking/anilist/callback", "state": "test-state", "response_type": "code"}
        valid = endpoint + "?" + urlencode(query)
        self.assertIsNotNone(authorization_url(server, "anilist", valid))
        for value in (
            valid.replace("https://anilist.co/", "https://attacker.example/"),
            valid.replace("https://anilist.co/", "https://anilist.co@attacker.example/"),
            endpoint + "?" + urlencode({**query, "redirect_uri": "https://other.example/api/tracking/anilist/callback"}),
            endpoint + "?" + urlencode({**query, "state": ""}),
        ):
            with self.subTest(value=value):
                self.assertIsNone(authorization_url(server, "anilist", value))
