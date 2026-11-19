import asyncio
import importlib.util
import os
import unittest
from test_client import APP


@unittest.skipUnless(importlib.util.find_spec("dbus_next"), "Linux media adapter is not installed on this platform")
class MprisTests(unittest.TestCase):
    def test_native_interface_has_metadata_transport_and_track_scoped_seeking(self):
        from flyleaf_desktop.mpris import Root, Player
        calls = []
        player = Player(lambda *arguments: calls.append(arguments))
        properties = {value.name for value in player.introspect().properties}
        self.assertTrue({"PlaybackStatus", "Metadata", "Position", "Rate", "CanSeek"} <= properties)
        self.assertEqual(player.Metadata["mpris:trackid"].value, "/org/flyleaf/none")
        player.Seek(30_000_000)
        player.SetPosition("/org/other/track", 10_000_000)
        self.assertEqual(calls, [("offset", 30.)])
        player.SetPosition("/org/flyleaf/none", 10_000_000)
        self.assertEqual(calls[-1], ("seek", 10.))
        self.assertNotIn("xesam:url", player.Metadata)
        self.assertEqual(Root(lambda *args: None).SupportedUriSchemes, [])

    @unittest.skipUnless(os.environ.get("DBUS_SESSION_BUS_ADDRESS"), "Run under dbus-run-session on Linux for real MPRIS verification")
    def test_real_session_bus_exports_metadata_and_dispatches_commands(self):
        from flyleaf_desktop.mpris import MprisControls
        calls, errors = [], []
        bridge = MprisControls(lambda *args: calls.append(args), errors.append)
        try:
            bridge.starting.result(timeout=5)
            self.assertEqual(errors, [])
            self.assertIsNotNone(bridge.player)
            async def verify():
                from dbus_next.aio import MessageBus
                bus = await MessageBus().connect()
                try:
                    name = 'org.mpris.MediaPlayer2.flyleaf.instance' + str(os.getpid())
                    xml = await bus.introspect(name, '/org/mpris/MediaPlayer2')
                    interface = bus.get_proxy_object(name, '/org/mpris/MediaPlayer2', xml).get_interface('org.mpris.MediaPlayer2.Player')
                    metadata = await interface.get_metadata()
                    self.assertNotIn('xesam:url', metadata)
                    await interface.call_pause()
                    self.assertIn(("pause", None), calls)
                finally:
                    bus.disconnect()
            asyncio.run(verify())
        finally:
            bridge.close()
        self.assertFalse(bridge.thread.is_alive())


if __name__ == "__main__":
    unittest.main()
