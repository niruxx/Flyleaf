"""Non-secret connection profiles. Session tokens belong exclusively in the OS vault."""
import json
import uuid
from .address import normalize_server


class Profiles:
    def __init__(self, settings):
        self.settings = settings
        try:
            raw = json.loads(str(settings.value("connections/profiles", "[]")))
        except (ValueError, TypeError):
            raw = []
        self.items = []
        for item in raw if isinstance(raw, list) else []:
            try:
                self.items.append({"id": str(uuid.UUID(item["id"])), "name": str(item["name"])[:80],
                                   "address": normalize_server(item["address"]),
                                   "remember": item.get("remember") is True,
                                   "reconnect": item.get("reconnect") is True})
            except (ValueError, TypeError, KeyError, AttributeError):
                continue
        self.active = str(settings.value("connections/active", ""))

    def save(self, name, address, profile_id=None, *, remember=False, reconnect=False):
        address = normalize_server(address)
        name = name.strip()[:80]
        if not name:
            raise ValueError("Give this server profile a name.")
        previous = self.get(profile_id)
        # Changing origin creates a new identity; never reuse a different server's token.
        identity = previous["id"] if previous and previous["address"] == address else str(uuid.uuid4())
        if previous and previous["address"] != address:
            remember = False
        item = {"id": identity, "name": name, "address": address,
                "remember": bool(remember), "reconnect": bool(reconnect)}
        self.items = [p for p in self.items if p["id"] != identity] + [item]
        self.active = identity
        self.persist()
        return item

    def get(self, identity):
        return next((p for p in self.items if p["id"] == identity), None)

    def remove(self, identity):
        self.items = [p for p in self.items if p["id"] != identity]
        if self.active == identity:
            self.active = ""
        self.persist()

    def persist(self):
        self.settings.setValue("connections/profiles", json.dumps(self.items))
        self.settings.setValue("connections/active", self.active)
        self.settings.sync()
