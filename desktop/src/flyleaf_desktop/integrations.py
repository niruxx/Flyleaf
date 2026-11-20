"""Native controls for server-owned integrations."""
from urllib.parse import parse_qs, quote, urlsplit

from PySide6.QtCore import QUrl
from PySide6.QtGui import QDesktopServices
from PySide6.QtWidgets import QApplication, QFileDialog, QHBoxLayout, QInputDialog, QLineEdit, QListWidget, QMessageBox

from .personal_workspace import PersonalPanel, button, current, fill
from .widgets import label, text


OAUTH_PROVIDERS = {
    "anilist": ("anilist.co", "/api/v2/oauth/authorize"),
    "mal": ("myanimelist.net", "/v1/oauth2/authorize"),
}


def authorization_url(server, provider, value):
    if provider not in OAUTH_PROVIDERS or not isinstance(value, str):
        return None
    try:
        url = urlsplit(value)
        host, path = OAUTH_PROVIDERS[provider]
        query = parse_qs(url.query)
        expected = server.rstrip("/") + f"/api/tracking/{provider}/callback"
        if (url.scheme == "https" and url.netloc == host and url.path == path and not url.fragment
                and query.get("redirect_uri") == [expected] and len(query.get("state", [])) == 1
                and query.get("response_type") == ["code"]):
            return QUrl(value)
    except ValueError:
        pass
    return None


class TrackingPanel(PersonalPanel):
    def __init__(self, api):
        super().__init__(api)
        self.layout.addWidget(label("Reading trackers", heading=True))
        self.items = QListWidget()
        self.items.setAccessibleName("Tracking services and connection state")
        self.layout.addWidget(self.items, 1)
        row = QHBoxLayout()
        button(row, "Connect…", self.connect_provider)
        button(row, "Disconnect…", self.disconnect)
        button(row, "Refresh status", self.reload)
        button(row, "Open Flyleaf in browser", self.open_server)
        self.layout.addLayout(row)
        row = QHBoxLayout()
        button(row, "Toggle automatic score import", self.toggle_pull)
        button(row, "Import scores and statuses", self.pull)
        self.layout.addLayout(row)
        row = QHBoxLayout()
        button(row, "Import MAL list file…", self.mal_list)
        button(row, "Import MAL stack…", self.mal_stack)
        self.layout.addLayout(row)
        self.layout.addWidget(label("Flyleaf sends supported progress from the server. OAuth uses your browser and requires signing into the same Flyleaf account there.", wrap=True))

    def open_server(self):
        if self.user and self.api.base:
            QDesktopServices.openUrl(QUrl(self.api.base + "/"))

    def reload(self):
        def loaded(data):
            if isinstance(data, list):
                fill(self.items, [{**row, "id": row.get("provider")} for row in data if isinstance(row, dict)], self.caption)
        self.request("GET", "/api/tracking", loaded)

    @staticmethod
    def caption(row):
        state = "Connected as " + text(row.get("username"), "reader") if row.get("connected") else "Ready to connect" if row.get("configured") else "Server configuration required"
        if row.get("connected"):
            state += f" · {row.get('pending', 0)} pending · automatic import {'on' if row.get('pullEnabled') else 'off'}"
        return text(row.get("name")) + " — " + state + ("\n" + text(row.get("lastError")) if row.get("lastError") else "")

    def connect_provider(self):
        row = current(self.items) or {}
        provider = row.get("provider")
        if not row.get("configured") or provider not in (*OAUTH_PROVIDERS, "mangaupdates", "kitsu"):
            self.notice.setText("Select a configured provider.")
            return
        epoch = self.epoch
        if provider in OAUTH_PROVIDERS:
            if QMessageBox.question(self, "Authorize in browser",
                                    "Continue to the provider in your browser? Sign into this same Flyleaf account in the browser before authorizing. Then use Refresh status here.") != QMessageBox.StandardButton.Yes or epoch != self.epoch:
                return
            def opened(data):
                url = authorization_url(self.api.base, provider, data.get("url") if isinstance(data, dict) else None)
                if url is None:
                    self.notice.setText("The server’s OAuth callback does not match this Flyleaf address. Check TRACKING_BASE_URL and use that address.")
                elif QDesktopServices.openUrl(url):
                    self.notice.setText("Complete authorization in the browser, then refresh the server-confirmed connection status here.")
                else:
                    self.notice.setText("Could not open the system browser.")
            self.request("POST", f"/api/tracking/{provider}/connect", opened)
            return
        base = urlsplit(self.api.base)
        if base.scheme != "https" and base.hostname not in ("localhost", "127.0.0.1", "::1"):
            self.notice.setText("Use HTTPS to connect a tracking account.")
            return
        user, ok = QInputDialog.getText(self, "Connect tracker", "Tracker username or email")
        if not ok or not user.strip() or epoch != self.epoch:
            return
        secret, ok = QInputDialog.getText(self, "Connect tracker", "Tracker password", QLineEdit.EchoMode.Password)
        if ok and secret and epoch == self.epoch:
            self.request("POST", f"/api/tracking/{provider}/login", lambda _data: self.reload(),
                         {"username": user.strip(), "password": secret})

    def disconnect(self):
        row = current(self.items)
        epoch = self.epoch
        if row and row.get("connected") and QMessageBox.question(self, "Disconnect tracker", "Disconnect this provider and cancel pending sync?") == QMessageBox.StandardButton.Yes and epoch == self.epoch:
            self.request("DELETE", f"/api/tracking/{row['provider']}", lambda _data: self.reload())

    def toggle_pull(self):
        row = current(self.items)
        if row and row.get("connected"):
            self.request("PATCH", f"/api/tracking/{row['provider']}", lambda _data: self.reload(),
                         {"pullEnabled": not row.get("pullEnabled")})

    def pull(self):
        row = current(self.items)
        epoch = self.epoch
        if row and row.get("connected") and QMessageBox.question(self, "Import scores and statuses",
                "Import this provider’s scores and statuses for matched series? This can update your Flyleaf ratings and statuses.") == QMessageBox.StandardButton.Yes and epoch == self.epoch:
            self.request("POST", f"/api/tracking/{row['provider']}/pull",
                         lambda data: self.notice.setText(f"{data.get('queued', 0)} imports queued."))

    def mal_list(self):
        epoch = self.epoch
        if self.busy:
            return
        path, _ = QFileDialog.getOpenFileName(self, "Import MyAnimeList export", "", "MyAnimeList exports (*.xml *.gz)")
        if not path or epoch != self.epoch:
            return
        self.busy = True
        self.body.setEnabled(False)
        self.notice.setText("Importing MyAnimeList export…")
        def complete(message):
            if epoch == self.epoch:
                self.busy = False
                self.body.setEnabled(True)
                self.notice.setText(message)
        self.api.upload_file("/api/import/mal-list", path, lambda data: complete(self.import_result(data)),
                             lambda error: complete(error.message), method="POST")

    def mal_stack(self):
        epoch = self.epoch
        url, ok = QInputDialog.getText(self, "Import MyAnimeList stack", "Public MyAnimeList stack URL")
        if ok and url.strip() and epoch == self.epoch:
            self.request("POST", "/api/import/mal-stack", lambda data: self.notice.setText(self.import_result(data)),
                         {"url": url.strip()})

    @staticmethod
    def import_result(data):
        if not isinstance(data, dict):
            return "Invalid import response."
        return "Import finished. " + " · ".join(f"{label}: {data[key]}" for key, label in (
            ("matched", "matched"), ("imported", "imported"), ("total", "entries"), ("unmatched", "unmatched"))
            if isinstance(data.get(key), int))


class KeysPanel(PersonalPanel):
    def __init__(self, api):
        super().__init__(api)
        self.layout.addWidget(label("OPDS, Kobo and KOReader", heading=True))
        self.items = QListWidget()
        self.items.setAccessibleName("Your Flyleaf API keys")
        self.layout.addWidget(self.items, 1)
        row = QHBoxLayout()
        button(row, "Create key…", self.create)
        button(row, "Regenerate…", lambda: self.change_key(True))
        button(row, "Revoke…", lambda: self.change_key(False))
        self.layout.addLayout(row)
        row = QHBoxLayout()
        button(row, "Copy key", lambda: self.copy("key"))
        button(row, "Copy OPDS URL", lambda: self.copy("opds"))
        button(row, "Copy Kobo URL", lambda: self.copy("kobo"))
        button(row, "Copy KOReader server", lambda: self.copy("kosync"))
        self.layout.addLayout(row)
        button(self.layout, "Choose Kobo collection…", self.kobo_collection)
        self.layout.addWidget(label("OPDS uses a read or full key. Kobo and KOReader require a full key. In KOReader, use your Flyleaf username and the API key as the password.", wrap=True))

    def reload(self):
        self.request("GET", "/api/api-keys",
                     lambda data: fill(self.items, data, lambda row: text(row.get("name")) + " · " + text(row.get("scope")) + (" · used" if row.get("lastUsedAt") else " · unused")) if isinstance(data, list) else None)

    def create(self):
        epoch = self.epoch
        name, ok = QInputDialog.getText(self, "New API key", "Key name")
        if not ok or not name.strip() or epoch != self.epoch:
            return
        scope, ok = QInputDialog.getItem(self, "Key permissions", "Scope",
                                         ["Read only (OPDS)", "Full access (Kobo / KOReader)"], editable=False)
        if ok and epoch == self.epoch:
            self.request("POST", "/api/api-keys", lambda _data: self.reload(),
                         {"name": name.strip()[:60], "scope": "full" if scope.startswith("Full") else "read"})

    def change_key(self, regenerate):
        row = current(self.items)
        epoch = self.epoch
        if not row or QMessageBox.question(self, "Change API key", "Invalidate the selected key? Devices using it will need a new key.") != QMessageBox.StandardButton.Yes or epoch != self.epoch:
            return
        self.request("POST" if regenerate else "DELETE",
                     f"/api/api-keys/{row['id']}" + ("/regenerate" if regenerate else ""), lambda _data: self.reload())

    def copy(self, mode):
        row = current(self.items) or {}
        key = row.get("key")
        if not self.user or (mode != "kosync" and not key):
            self.notice.setText("Select an API key first.")
            return
        if mode == "kobo" and row.get("scope") != "full":
            self.notice.setText("Kobo needs a full-access API key.")
            return
        values = {
            "key": key, "kosync": self.api.base + "/api/kosync",
            "kobo": self.api.base + "/api/kobo/" + quote(key or "", safe=""),
            "opds": self.api.base + "/api/opds/" + quote(key or "", safe=""),
        }
        QApplication.clipboard().setText(values[mode])
        self.notice.setText("Copied to the clipboard.")

    def kobo_collection(self):
        def loaded(data):
            rows = [row for row in data if isinstance(row, dict) and row.get("owned")] if isinstance(data, list) else []
            captions = ["Disable Kobo shelf"] + [f"{text(row.get('name'))} (#{row['id']})" for row in rows]
            epoch = self.epoch
            selected, ok = QInputDialog.getItem(self, "Kobo library", "Sync this collection to Kobo", captions, editable=False)
            if ok and epoch == self.epoch:
                index = captions.index(selected)
                self.request("PUT", "/api/me/prefs", lambda _data: self.notice.setText("Kobo collection saved."),
                             {"koboCollectionId": rows[index - 1]["id"] if index else None})
        self.request("GET", "/api/collections", loaded)


class WebhooksPanel(PersonalPanel):
    def __init__(self, api):
        super().__init__(api)
        self.events = {}
        self.items = QListWidget()
        self.items.setAccessibleName("Server webhooks")
        self.layout.addWidget(self.items, 1)
        row = QHBoxLayout()
        button(row, "New webhook…", lambda: self.edit(False))
        button(row, "Edit…", lambda: self.edit(True))
        button(row, "Enable / disable", self.toggle)
        button(row, "Remove…", lambda: self.act("delete"))
        button(row, "Send test…", lambda: self.act("test"))
        self.layout.addLayout(row)
        button(self.layout, "Copy signing secret", self.copy_secret)

    def clear_session(self):
        super().clear_session()
        self.events = {}

    def reload(self):
        def loaded(data):
            if isinstance(data, dict):
                self.events = data.get("events") or {}
                fill(self.items, data.get("hooks", []), lambda row:
                     text(urlsplit(text(row.get("url"))).hostname) + " · " + ("Enabled" if row.get("enabled") else "Disabled") +
                     " · " + ", ".join(row.get("events") or []))
        self.request("GET", "/api/admin/webhooks", loaded)

    def edit(self, existing):
        row = current(self.items) if existing else {}
        if row is None:
            return
        epoch = self.epoch
        address, ok = QInputDialog.getText(self, "Webhook destination", "HTTP or HTTPS URL", text=text(row.get("url")))
        if not ok or epoch != self.epoch:
            return
        events, ok = QInputDialog.getMultiLineText(self, "Webhook events", "Use * or comma-separated event names.\n" + ", ".join(self.events), ", ".join(row.get("events") or ["*"]))
        if ok and epoch == self.epoch:
            self.request("PATCH" if existing else "POST", "/api/admin/webhooks" + (f"/{row['id']}" if existing else ""),
                         lambda _data: self.reload(), {"url": address.strip(), "events": [item.strip() for item in events.split(",") if item.strip()]})

    def toggle(self):
        row = current(self.items)
        if row:
            self.request("PATCH", f"/api/admin/webhooks/{row['id']}", lambda _data: self.reload(),
                         {"enabled": not row.get("enabled")})

    def copy_secret(self):
        row = current(self.items)
        if row and row.get("secret"):
            QApplication.clipboard().setText(row["secret"])
            self.notice.setText("Signing secret copied.")

    def act(self, operation):
        row = current(self.items)
        epoch = self.epoch
        prompt = "Remove this server webhook?" if operation == "delete" else "Send a test delivery to the configured destination?"
        if not row or QMessageBox.question(self, "Webhook", prompt) != QMessageBox.StandardButton.Yes or epoch != self.epoch:
            return
        path = f"/api/admin/webhooks/{row['id']}"
        if operation == "delete":
            self.request("DELETE", path, lambda _data: self.reload())
        else:
            self.request("POST", path + "/test", lambda data: self.notice.setText(
                "Test delivered." if data.get("ok") else text(data.get("error"), f"Test failed (HTTP {data.get('status', 'unknown')}).")))


class SourcesPanel(PersonalPanel):
    endpoint = "/api/admin/plugins"

    def __init__(self, api):
        super().__init__(api)
        self.mode = "installed"
        row = QHBoxLayout()
        button(row, "Installed plugins", self.reload)
        button(row, "Plugin catalog", self.catalog)
        button(row, "Mihon extensions", self.extensions)
        button(row, "Repositories", self.repos)
        self.layout.addLayout(row)
        self.items = QListWidget()
        self.items.setAccessibleName("Server sources and extensions")
        self.layout.addWidget(self.items, 1)
        row = QHBoxLayout()
        button(row, "Install / update…", self.install)
        button(row, "Configure / enable…", self.configure)
        button(row, "Remove…", self.remove)
        self.layout.addLayout(row)
        row = QHBoxLayout()
        button(row, "Suwayomi status", self.status)
        button(row, "Manage Suwayomi runtime…", self.manage_runtime)
        button(row, "Add plugin repository…", self.add_repo)
        self.layout.addLayout(row)
        self.layout.addWidget(label("The Flyleaf server installs and runs sources. Select installed plugins to configure their settings.", wrap=True))

    def rows(self, data, mode):
        if not isinstance(data, list):
            self.notice.setText("The server returned invalid source data.")
            return
        self.mode = mode
        fill(self.items, [{**row, "id": row.get("id") or row.get("pkgName")} for row in data if isinstance(row, dict)],
             lambda row: " · ".join(filter(None, (text(row.get("name"), "Source"), text(row.get("version")),
                 "Disabled" if row.get("enabled") is False else "", text(row.get("error"))))))

    def reload(self):
        self.request("GET", self.endpoint, lambda data: self.rows(data.get("installed"), "installed"))

    def catalog(self):
        self.request("GET", self.endpoint + "/catalog", lambda data: self.rows(data, "catalog"))

    def extensions(self):
        self.request("GET", self.endpoint + "/mihon/extensions", lambda data: self.rows(
            [row for row in data if not row.get("nsfw") or row.get("installed")] if isinstance(data, list) else data, "mihon"))

    def repos(self):
        def loaded(data):
            if isinstance(data, dict):
                rows = data.get("repos") or []
                self.rows([{**row, "name": text(row.get("name"), text(row.get("url")))} for row in rows if isinstance(row, dict)], "repos")
        self.request("GET", self.endpoint, loaded)

    def add_repo(self):
        epoch = self.epoch
        url, ok = QInputDialog.getText(self, "Plugin repository", "Repository URL")
        if ok and url.strip() and epoch == self.epoch:
            self.request("POST", self.endpoint + "/repos", lambda _data: self.repos(), {"url": url.strip()})

    def status(self):
        self.request("GET", self.endpoint + "/mihon/runtime", lambda data: self.notice.setText(
            "Managed Suwayomi runtime: " + text(data.get("state") or data.get("status"), "available" if data.get("installed") else "not installed")))

    def manage_runtime(self):
        epoch = self.epoch
        selected, ok = QInputDialog.getItem(self, "Managed Suwayomi runtime", "Server action",
                                          ["Install", "Start", "Stop", "Restart"], editable=False)
        if not ok or epoch != self.epoch:
            return
        if QMessageBox.question(self, "Manage Suwayomi", f"{selected} the server’s managed extension runtime?") == QMessageBox.StandardButton.Yes and epoch == self.epoch:
            self.request("POST", self.endpoint + "/mihon/runtime/" + selected.lower(), lambda _data: self.status())

    def install(self):
        row = current(self.items)
        epoch = self.epoch
        if not row or not row.get("id") or self.mode == "repos" or QMessageBox.question(self, "Install source", "Install or update this source on the Flyleaf server?") != QMessageBox.StandardButton.Yes or epoch != self.epoch:
            return
        safe_id = quote(str(row["id"]), safe="")
        if self.mode == "mihon":
            action = "update" if row.get("installed") else "install"
            self.request("POST", self.endpoint + f"/mihon/extensions/{safe_id}/{action}", lambda _data: self.extensions())
        elif self.mode == "catalog":
            self.request("POST", self.endpoint, lambda _data: self.reload(), {"id": row["id"], "repo": row.get("repo")})
        else:
            self.request("POST", self.endpoint + f"/{safe_id}/update", lambda _data: self.reload())

    def configure(self):
        row = current(self.items)
        if not row or self.mode != "installed":
            return
        epoch = self.epoch
        options = ["Enable" if not row.get("enabled") else "Disable"] + [
            f"{text(spec.get('label'), spec['key'])} ({spec['key']})" for spec in row.get("settings", []) if spec.get("key")]
        selected, ok = QInputDialog.getItem(self, "Configure source", "Setting", options, editable=False)
        if not ok or epoch != self.epoch:
            return
        index = options.index(selected)
        if not index:
            body = {"enabled": not row.get("enabled")}
        else:
            specs = [spec for spec in row.get("settings", []) if spec.get("key")]
            spec = specs[index - 1]
            key = spec["key"]
            prior = (row.get("values") or {}).get(key, spec.get("default", ""))
            if spec.get("type") == "boolean":
                value, ok = QInputDialog.getItem(self, "Configure source", selected, ["Yes", "No"], 0 if prior else 1, False)
                value = value == "Yes"
            else:
                secret = spec.get("type") == "password"
                value, ok = QInputDialog.getText(self, "Configure source", selected,
                    QLineEdit.EchoMode.Password if secret else QLineEdit.EchoMode.Normal, "" if secret else str(prior))
            if not ok or epoch != self.epoch:
                return
            body = {"settings": {key: value}}
        self.request("PATCH", self.endpoint + "/" + quote(str(row["id"]), safe=""), lambda _data: self.reload(), body)

    def remove(self):
        row = current(self.items)
        epoch = self.epoch
        if not row or self.mode == "catalog" or QMessageBox.question(self, "Remove source", "Remove this source from the Flyleaf server? Existing books stay in their libraries.") != QMessageBox.StandardButton.Yes or epoch != self.epoch:
            return
        safe_id = quote(str(row["id"]), safe="")
        if self.mode == "mihon":
            self.request("POST", self.endpoint + f"/mihon/extensions/{safe_id}/uninstall", lambda _data: self.extensions())
        elif self.mode == "repos":
            if type(row.get("id")) is int and row["id"] > 0:
                self.request("DELETE", self.endpoint + f"/repos/{safe_id}", lambda _data: self.repos())
        else:
            self.request("DELETE", self.endpoint + f"/{safe_id}", lambda _data: self.reload())
