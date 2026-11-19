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
- Named server profiles, an opt-in single reconnect attempt on launch, and optional
  remembered sessions stored only in the OS password vault. Sign-out forgets the session.
- Native first-administrator setup, registration/invite codes when the server enables
  sign-up, and **File → My account** for profile and password changes.
- Native Home, library and Want to read navigation; search, sorting, reading-state
  filters, cover thumbnails, paged loading, series details and volume selection.
- **Filters & saved searches** adds genres, tags, creators, language and format;
  create/update/apply/delete saved searches on your account. Language and format
  controls are enabled only when the server advertises support (included on this branch).
- **Inside books** searches the server's text index and shows matching passages as
  plain text. Catalog filters do not apply to this scope. Opening a result uses its
  native format reader; opening at the exact full-text passage remains pending.
- Returning from reading restores the selected series/volume, loaded catalog pages,
  filter controls, splitter sizes and scroll positions while refreshing progress.
- Native comic/image reading for server-supported **CBZ, CBR, CB7, CBT and image
  folders**. The server opens archives and streams pages; the client renders images
  with Qt, with fit-page/fit-width/zoom, right-to-left navigation and fullscreen.
- Page progress writes back to Flyleaf. A page is saved only after it loads. Saves
  are serialized/coalesced. Capable servers use a durable account-scoped outbox;
  older servers retain acknowledged position-only saves.
- Mark read/unread through the server; mature artwork is not fetched when the server
  marks it blurred, and future volume titles are masked when spoiler-safe browsing
  is enabled in the account preferences.
- A native **Material 3 Expressive** reading room matching Flyleaf's web design:
  bundled Roboto Flex, tonal surfaces, pill navigation and buttons, rounded book
  cards, expressive welcome artwork, a Home invitation and matching window chrome.
- Light/dark/system modes with Flyleaf, Ocean, Sakura, Forest, Ember and Graphite
  color palettes. Change them in **View**, or toggle light/dark from the title bar.
  Screen fades, button state layers/ripples, cover hover lift and the floating welcome
  illustration respect both system and local reduced-motion choices.
- A compact icon navigation rail preserves space in smaller windows. Native text
  names, keyboard navigation, hover tooltips and visible focus indicators remain available.
- Matching window controls support platform-managed dragging/resizing, maximize,
  minimize and close. **Application menu (Alt+M) → View** changes the theme, reduces
  motion or restores the system window frame. F11 toggles fullscreen; Alt+F4 closes
  through the same pending-progress safeguard as the Close button.

- HiDPI rendering uses Qt logical coordinates, point-sized fonts and device-pixel
  aware reader pixmaps. **View → Interface size** adds independent 100–200% sizing.
- **Content Finder** in the sidebar for permitted accounts: source/kind/genre
  browsing, search, folder navigation, details, file selection and server-side download
  submission. **Downloads and following** shows server progress/errors/history, retry
  and cancel/remove controls, followed series and new chapter updates. Follow a title
  with a destination library and an explicit choice to download future chapters;
  check for updates, change follow settings or download a discovered chapter manually.
  Sources/plugins are configured on the server; downloads go to its libraries, separate
  from the desktop's offline cache. The sidebar requires the Content Finder permission.
- Comic tools add smart spreads, cover-alone, split pages, continuous/webtoon flow,
  bounded image caching, auto-scroll, crop, paper filters and per-series settings.
- Native **PDF and EPUB** rendering uses process-isolated MuPDF: contents, search,
  zoom, rotation, selectable page-text inspector, links and typography controls.
  Server-convertible formats use the canonical `/file` EPUB rendition. EPUB progress
  uses source-verified CFIs; unsupported anchors retain the existing server position
  until an explicit resume choice. Complex publisher layouts need further validation.
- Reader **Tools** includes bookmarks, highlights/private notes, dictionary/translation
  and profile bindings. Highlight selection uses the page-text inspector; direct
  selection on single/continuous rendered pages is also supported. Spread selection
  uses the inspector; highlights stay bound to their verified source page.
- System-voice read aloud provides word tracking, voice/speed selection, page
  continuation and a sleep timer. Linux requires installed eSpeak/system voices.
- Audiobooks use **VLC/libVLC**, with tracks/chapters, speed, seek, sleep timer and
  foreground media keys. Install VLC separately; `python-vlc` alone is not its runtime.
  Set `FLYLEAF_VLC_PATH` to a portable VLC folder on Windows if necessary. A local
  authenticated range relay keeps server cookies out of VLC URLs.

**Phase 3 now includes:** offline downloads with integrity checks, storage budgets and
pinning; durable progress/time replay and conflict review; position history/guarded
restore; searchable notes and native Markdown/CSV/Readwise/Obsidian exports.
Windows SMTC and Linux MPRIS adapters provide native audiobook media controls.

**Still pending:** complex EPUB compatibility, verified Windows speech word callbacks,
physical Linux/platform and long-session QA, standalone runtime packaging, journal UI
and remaining library, integration and administration parity.
This is a development preview; see [the phased roadmap](roadmap.md) and
[native dependencies and licensing](docs/dependencies.md). MuPDF is AGPL/commercial
licensed; the application's MIT metadata does not override dependency terms.

## Run on Windows

Requires Python 3.11 or newer. The tested local development environment is Windows
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

An empty server offers native administrator account creation; library administration
still uses the server's existing interface. Use the Flyleaf username/email and password,
not a Kobo/KOReader API key. This build supports
the existing password/session API; SSO and second-factor UI are roadmap work dependent
on the server's supported flows.

Named profiles (address, name, reconnect/remember choices), the validated server address,
first-run completion and appearance preferences are persisted using Qt settings.
Passwords are never saved. Offline book content and personal reading data are stored
in an account/server-scoped local cache when downloaded or checkpointed. Session cookies stay in memory
unless you select **Remember this session**: only the token and its server/account
identity enter Windows Credential Manager or Linux Secret Service. No file keyring
or plaintext fallback is used. TLS certificates are verified normally;
the client does not ignore certificate errors or follow API redirects to another
host. Use the server's final base URL. HTTP is supported for existing LAN installs,
with an inline indication that it is unencrypted.

Servers advertising `durableProgress: 1` support crash-safe positions and sampled
active reading/listening time through immutable idempotent receipts. The client verifies
`X-Flyleaf-Account` on protected responses; reverse proxies must preserve that header.
Pending work pauses safely if the server loses this capability. Older servers save
positions without additive time. If the session expires, sign-in is required; unsaved progress is
not automatically replayed under a different account. Unsaved displayed pages survive
session expiry in memory: signing back into the same account/server offers a choice
between the unsaved page and the server's latest position. File-version checks guard
unsaved-page replay. On capable servers, verified positions and time are checkpointed locally across exit
and crash. The offline sync dialog offers explicit conflict comparison and resolution
when another device changes progress or the source file changes. An uncertain receipt
must be retried before rebasing; time is never added again merely because an acknowledgment
was lost. Local caches are protected by OS user permissions, not application encryption.
Sign-out locks offline access; reopening offline requires the matching OS-vault session.

The initial reader requests page images up to 2000 pixels wide. Network responses,
decoded dimensions and Qt image allocation are bounded. Original-resolution reading,
advanced spreads, webtoon tools and all codecs need separate validation.

### Remembering a session

Windows session storage uses Credential Manager through the OS API.
On Linux, install the optional Secret Service adapter into the desktop environment:

```sh
desktop/.venv/bin/python -m pip install './desktop[sessions]'
```

An existing, unlocked default Secret Service collection is required. If the service,
package or collection is missing/locked, sign-in still works in memory and the app
explains how to retry. It does not create or unlock a collection automatically. Select
**Retry saved session** after unlocking it. A saved token is verified against the selected
server and its original account before the library opens. Removing a remembered profile
also removes its vault entry; failure keeps the profile visible for a retry.

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
runtime, first-run completion, appearance persistence, reduced motion, Material palette
text contrast, bundled typography/vector icons, wrapped-label reflow, small-window
setup layouts, window-control progress safeguards, profiles/vault errors, account forms,
filter queries, reader-state restoration, isolated session recovery, Finder HTTP
cleanup, logical UI scaling and native reader pixel ratios. PDF/EPUB fixtures render
through real workers; source CFIs round-trip through the pinned server/Foliate adapter
when server dependencies are installed. Generated silent audio tests actual VLC
resume/seek when its runtime is available; otherwise that test reports a skip. Linux vault
tests use a contract adapter; physical Linux Secret Service QA remains pending.
They do not claim that every real server, certificate deployment, device
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
Flyleaf server, including native administrator creation, profile/password changes,
language/format and saved filters, comic scanning, page streaming, durable progress,
offline download/read/reconnect, annotation exports, guarded history restore and sign-out. That live check is reproducible with
`tools/check_disposable_server.py --initialize-disposable-server` after starting a
**new, empty loopback server** on port 8299 with its own `FLYLEAF_DATA_DIR`. The tool
creates a test administrator and library; it refuses already configured or remote
servers. Never point it at your normal installation.

## Offline and format limits

Use **File → Download current book for offline**, then **Offline library & sync**.
Downloads are not marked ready until every asset and the current source revision
verify. The default account budget is 2 GiB (configurable 256 MiB–16 GiB); pinned
books and pending work are protected during cleanup. Each downloaded asset is limited
to 128 MiB, including an individual audiobook track. Large tracks require online
streaming. Partial downloads remain incomplete and can be retried.

| Format | Native support | Remaining validation |
|---|---|---|
| Image archives/folders | Server pages, spreads/continuous, filters, notes, offline | Physical long-session/large-library benchmarks |
| PDF | MuPDF pages, search, rotation, native selection/highlights, offline | Publisher corpus, accessibility and runtime packaging |
| EPUB/KEPUB | Reflow, TOC, source-verified CFIs, native selection, offline | Fixed layout, embedded fonts, complex CSS, RTL/CJK/vertical text |
| FB2/MOBI/AZW3 | Native EPUB rendition with actual Foliate CFI fixture checks | Broader publisher corpus; separate KOReader regressions remain |
| TXT/DOCX/RTF | Server canonical EPUB conversion and native rendering | Complex document fidelity |
| Audiobooks | VLC streaming/offline, verified seek, sleep, SMTC/MPRIS adapters | Clean-machine codecs, real Linux media sessions, long playback |

Windows speech synthesizes successfully to a silent WAV sink; word-event completion
verification is still pending. Linux voice playback requires platform testing.
Speech time is counted only after an actual started callback. These gaps remain
explicit roadmap items rather than a claim of complete Phase 2 compatibility.
