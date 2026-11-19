# Flyleaf Desktop

A native Windows/Linux client built with **Qt 6 Widgets and PySide6 Essentials**.
It connects to an existing Flyleaf server through its HTTP API. It does not open
the server's SQLite database, embed the web interface, or depend on Chromium,
Electron, Qt WebEngine, or an operating-system WebView.

Development stays on **`feature/desktop-client`**. This is an early source preview,
not a feature-parity release or a packaged installer.

## What works now

- Illustrated first-run welcome, followed by server connection, sign-in and appearance
  setup. Returning launches go directly to the connection screen.
- Server setup asks for the server's IP address or URL. Bare addresses use port 7878;
  explicit HTTP/HTTPS addresses and reverse-proxy base paths are supported.
- Server compatibility/setup checks, username/password sign-in, in-memory session
  cookies, sign-out, account-expiry feedback, and changing servers.
- Native Home, library and Want to read navigation; search, sorting, reading-state
  filters, cover thumbnails, paged loading, series details and volume selection.
- Native comic/image reading for server-supported **CBZ, CBR, CB7, CBT and image
  folders**. The server opens archives and streams pages; the client renders images
  with Qt, with fit-page/fit-width/zoom, right-to-left navigation and fullscreen.
- Page progress writes back to Flyleaf. A page is saved only after it loads. Saves
  are serialized/coalesced, failures remain pending in memory, and leaving waits
  for acknowledgement or an explicit choice to leave without saving.
- Mark read/unread through the server; mature artwork is not fetched when the server
  marks it blurred, and future volume titles are masked when spoiler-safe browsing
  is enabled in the account preferences.
- Coordinated Midnight, Paper and system-following themes across setup, library,
  reader and title bar. Short screen fades, animated button feedback and a gently
  floating welcome illustration respect both system and local reduced-motion choices.
- Matching window controls support platform-managed dragging/resizing, maximize,
  minimize and close. **Application menu (Alt+M) → View** changes the theme, reduces
  motion or restores the system window frame. F11 toggles fullscreen; Alt+F4 closes
  through the same pending-progress safeguard as the Close button.

**Not implemented yet:** native EPUB, PDF or audio readers; offline downloads;
annotation/journal UI; active reading-time measurement; the rest of the web app's
library, discovery, integration and administration features. Unsupported formats
show an explanation and offer an explicit external-browser action. That action is
not counted as native reading or parity. See [the phased roadmap](roadmap.md).

## Run on Windows

Requires Python 3.10 or newer. The tested local development environment is Windows
with Python 3.14 and Qt/PySide6 Essentials 6.12.0.

```powershell
cd desktop
python -m venv .venv
.venv\Scripts\python.exe -m pip install -r requirements.txt
.venv\Scripts\python.exe run.py
```

After setup, double-click `desktop/launch.cmd` to start without a console window.
For startup diagnostics, use `python.exe run.py` instead of the launcher.

## Run on Linux

```sh
cd desktop
python3 -m venv .venv
.venv/bin/python -m pip install -r requirements.txt
.venv/bin/python run.py
# Or: sh launch.sh
```

Install your distribution's Qt platform dependencies if the platform plugin reports
missing XCB/Wayland or system libraries. Linux desktop validation and standalone
packages remain pending; a shared codebase alone is not proof of cross-platform QA.

You can prefill an address without automatically connecting:

```sh
python run.py --server 192.168.1.25:7878
```

For development without installing the project, `run.py` adds `src/` to the import
path. Alternatively, `pip install -e .` installs the `flyleaf-desktop` entry point.

## Connection and session behavior

The server needs its administrator account and libraries configured first. Use the
Flyleaf username/email and password, not a Kobo/KOReader API key. This build supports
the existing password/session API; SSO and second-factor UI are roadmap work dependent
on the server's supported flows.

The validated server address, first-run completion and appearance preferences are
persisted using Qt settings. Passwords,
cookies and book content are not saved to disk by the client. Saved connections
with OS-vault credentials are future work. TLS certificates are verified normally;
the client does not ignore certificate errors or follow API redirects to another
host. Use the server's final base URL. HTTP is supported for existing LAN installs,
with an inline indication that it is unencrypted.

Progress is a page position, not an active reading-time estimate. There is no durable
offline outbox yet. If the session expires, sign-in is required; unsaved progress is
not automatically replayed under a different account. A later save from another
device can still change the current position. Durable recovery and conflict handling
are explicit roadmap gates before an offline-capable or parity release.

The initial reader requests page images up to 2000 pixels wide. Network responses,
decoded dimensions and Qt image allocation are bounded. Original-resolution reading,
advanced spreads, webtoon tools and all codecs need separate validation.

## Tests and native screenshots

From the repository root:

```powershell
$env:QT_QPA_PLATFORM = 'offscreen'
desktop/.venv/Scripts/python.exe -m unittest discover -s desktop/tests -v
```

On Linux:

```sh
QT_QPA_PLATFORM=offscreen desktop/.venv/bin/python -m unittest discover -s desktop/tests -v
```

Tests launch actual Qt widgets and talk to a local HTTP fixture. They cover address
validation, cookie authentication, native browsing/reading, progress failures,
account cleanup, stale callback cancellation, redirects and absence of a browser
runtime, first-run completion, appearance persistence, reduced motion, small-window
setup layouts and window-control progress safeguards. They do not claim that every real server, certificate deployment, device
or format has been tested. [Architecture decisions](docs/architecture.md) explain
the toolkit choice and parity rules.

Generate screenshots of the real native UI against fictional library data:

```powershell
desktop/.venv/Scripts/python.exe desktop/tools/capture_preview.py
```

Images are saved to `desktop/build/screenshots/`. A branch-scoped GitHub Actions
workflow is included for Windows/Linux tests and Python-package validation; its
remote runs are still pending. A Python wheel is not a standalone desktop installer.

The current Windows checkpoint passes the native tests, screenshot review, editable
installation and local wheel build. It was also exercised against a real isolated
Flyleaf server, including comic scanning, native page streaming, database progress
and sign-out. That live check is reproducible with
`tools/check_disposable_server.py --initialize-disposable-server` after starting a
**new, empty loopback server** on port 8299 with its own `FLYLEAF_DATA_DIR`. The tool
creates a test administrator and library; it refuses already configured or remote
servers. Never point it at your normal installation.
