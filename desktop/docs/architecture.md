# Desktop architecture decision

Status: adopted for the initial client, 2026-11-18.
Branch: `feature/desktop-client`.

## Toolkit

Use **Qt 6 Widgets through the official PySide6 bindings**, with only the
**PySide6-Essentials** distribution in the initial dependency set. Widgets provides
desktop controls, focus/keyboard behavior, layouts, accessibility infrastructure,
high-DPI support and platform-aware styling. Qt Network provides event-driven HTTP,
cookies, proxy support and certificate-verified TLS without a browser engine.

Python handles application orchestration; the widgets, networking and image
rendering use Qt's native C++ implementations. C++/CMake is a possible future choice
for measured bottlenecks, but a compiler toolchain is not required to develop this
initial application. No web-server process is launched by the client.

Qt Quick is also non-browser technology and remains an option for a later custom
visual layer. Widgets is the starting point because conventional desktop controls,
keyboard navigation and a maintainable first client matter more than reproducing
the browser app pixel for pixel. Shared layout and behavior are goals; Windows and
Linux should retain appropriate platform conventions rather than promise identical
system themes, fonts and dialog rendering.

GTK 4 is a credible alternative, especially for a Linux-first application. For this
Windows/Linux-first client, its Windows runtime/theme setup adds deployment work.
Qt's cohesive Windows/Linux APIs and tooling make it the preferred foundation here.

References: [Qt for Python](https://doc.qt.io/qtforpython-6/gettingstarted.html),
[Qt Network](https://doc.qt.io/qt-6/qtnetwork-programming.html),
[GTK's Windows installation and distribution guide](https://www.gtk.org/docs/installations/windows/).

## Boundaries

- `address.py`: pure normalization, default-port handling, base paths and resource-origin checks.
- `api.py`: nonblocking Qt network manager, in-memory cookies, request bounds, timeouts,
  manual redirect policy, generation-based cancellation and consistent failures.
- `connection.py`: native connection and authentication screens.
- `profiles.py`: normalized named profiles and opt-in reconnect metadata in Qt settings.
- `vault.py`: OS-only session tokens, serialized background vault operations and failures.
- `accounts.py`: explicit account creation, profile/password forms and resume choices.
- `catalog_tools.py`: catalog predicates and account-owned saved-search CRUD.
- `onboarding.py`: welcome artwork and first-run local appearance setup.
- `appearance.py`: shared palette and cancellable incoming-screen transitions.
- `material.py`: Flyleaf OKLCH-to-sRGB color roles, bundled Roboto Flex and native vector icons.
- `reading_room.py`: expressive Home surface, decorative native artwork and pill navigation delegate.
- `motion.py`: brief button hover/focus feedback with no continuous animation loop.
- `chrome.py`: matching title bar and platform-managed move/resize requests.
- `library.py`: native library navigation, search, filters, paging and details.
- `image_reader.py`: server-streamed comic/image pages, navigation and acknowledged position writes.
- `comic_reader.py`: spreads, splitting, filters and bounded continuous-page flow.
- `document_reader.py`, `document_backend.py`, `document_process.py`: native PDF/EPUB UI and isolated rendering.
- `epub_positions.py`: original-source CFI paths and UTF-16 offsets, with conservative import/export.
- `audio_reader.py`, `audio_relay.py`: native VLC playback and authenticated range streaming.
- `speech.py`: isolated system-voice playback and word events.
- `reader_tools.py`: native annotation/lookup UI and reader profile bindings.
- `finder.py`: native server-plugin discovery and selected-file download submission.
- `finder_activity.py`: server download status/retry/cancel, followed-series settings
  and chapter updates; visible-queue polling and account-scoped callback cancellation.
- `app.py`: session lifecycle, routing between native widgets and desktop actions.

The remote Flyleaf server remains authoritative for authentication, permissions,
private libraries, age restrictions, metadata, conversion, progress and shared
features. The desktop client uses the same API as the web app; it must not read a
network-mounted server database or bypass permissions by opening server files.
The local SQLite store is an account/server-scoped client cache/outbox only.
`local_store.py` owns atomic assets, integrity, drafts, sampled clocks and immutable
events. `reliability.py` serializes replay and validates source/position revisions.
`offline.py` implements downloads, budgets and explicit conflict review.
`personal_data.py` provides native annotation search/export and guarded history restore.
`selection_canvas.py` maps native word geometry without a browser.
`media_controls.py`/`mpris.py` provide OS audiobook sessions.

Server responses are untrusted input. Metadata labels use plain text; external
resources cannot receive the session through arbitrary cover URLs. Resetting the
connection aborts outstanding requests, discards stale callbacks and replaces the
cookie jar before another account's data is shown. Clearing catalog state revokes the
local user before resetting navigation widgets, so their signals cannot start new
unauthenticated catalog requests and invalidate a subsequent sign-in.

The first-run wizard configures this client and, only on an empty server, offers
explicit first-administrator creation. Registration is offered only when `/status`
advertises it. Profile/password forms use the existing `/me` and `/me/password` APIs;
the server enforces permission checks and current-password verification.

Qt settings store normalized profile names/addresses, reconnect/remember choices,
appearance preferences and onboarding completion. Passwords are never persisted.
Opt-in remembered sessions store only the cookie plus original server/account identity
in Windows Credential Manager through ctypes, or an existing Linux Secret Service
default collection through the optional pinned SecretStorage adapter (BSD-3-Clause).
There is no backend discovery, auto-unlock/collection creation, file vault or plaintext
fallback. Operations run in a serial Qt thread pool; completion callbacks check the
connection generation. Startup reconnect is opt-in and checks the active profile once.
A restored cookie is constrained to its server base path and revalidated against
`/status` with the original account ID before any catalog request. Sign-out revokes
the server session and requests vault deletion. See [SecretStorage's API](https://secretstorage.readthedocs.io/en/latest/).

Expired-session recovery is scoped by normalized server and account ID. Capable servers
also receive immutable durable events from the local SQLite outbox.
Only successfully displayed pending/in-flight save pages are retained. After the same
account signs in, it explicitly chooses a pending page or the latest server position;
another account sees neither the book title nor a replay. Pending-page recovery checks
the book file version. Durable drafts and sampled clocks survive exit/crash; server
receipts atomically combine revision comparison, time increments and acknowledgement.
Receipt retries preserve the original body and account identity. Future store schemas
are refused rather than reset. Revoked books are quarantined and cached assets removed;
pending own-account work remains available for review without exposing book content.
Protected responses carry an account header checked before render/cache. Explicit offline
unlock requires the exact previously validated OS-vault session hash. Assets and SQLite
are not encrypted; OS-user storage permissions define the local confidentiality boundary.

Catalog filters and saved searches use server APIs rather than filtering only loaded
pages. The server advertises language/format predicates through `/status` capabilities;
the native controls disable these on older servers. Repeated genre query parameters
remain lists. Full-text snippets are plain text, not HTML, and metadata links open
only explicit HTTP(S) destinations without embedded credentials. Reader return reloads
the prior number of catalog pages before restoring selection, volume, scroll and layout.

Screen fades affect incoming widgets only, last 220 ms and cancel on navigation,
theme changes, reduced motion, account cleanup or removal of an animated reader.
No outgoing account screenshot is retained. Button halos run for 140 ms per event;
the welcome's 30 fps artwork stops when hidden, minimized or motion is reduced.
Qt accessibility motion hints are respected in addition to the user's setting.

The desktop Material 3 Expressive treatment derives the same tonal roles and six seed
presets from `public/css/m3.css`, `public/css/expressive.css` and `public/js/theme.js`.
Widgets and QPainter implement the surfaces, rounded cards/navigation, icons, state
layers, clipped press ripples and 150 ms cover lift. This does not load CSS or a browser
engine. Form/reader/window surfaces share the same scheme. Native controls retain
their Qt accessibility names, plain text, focus behavior and keyboard actions; the
compact rail retains tooltips and model text. Empty feedback collapses, and wrapped
text resets its minimum height before remeasurement to avoid sticky tall labels.

Roboto Flex is bundled from the [Google Fonts source](https://github.com/google/fonts/tree/main/ofl/robotoflex)
with its SIL Open Font License. It loads through QFontDatabase once per process and
falls back to an OS font if loading fails; no font network request occurs at runtime.
System fallback fonts still supply scripts absent from the font. Physical Linux,
mixed-script/RTL, high-contrast and multiple-DPI review remain release gates.

The default themed title bar uses Qt's system move/resize requests so the window
manager owns those operations. The system-frame option remains available for
platform conventions or accessibility needs; actual snap, Wayland/X11 and multiple
monitor behavior still require physical platform validation. The Close button uses
the existing progress-save guard. These are widgets and painter effects, not a web
rendering layer. See [Qt system move/resize](https://doc.qt.io/qt-6/qwindow.html#startSystemMove),
[property animations](https://doc.qt.io/qt-6/qpropertyanimation.html) and
[accessibility hints](https://doc.qt.io/qt-6/qaccessibilityhints.html).

## Reading engines and parity

PDF and canonical server EPUB renditions render through MuPDF in a spawned process,
never a thread or WebView. A bounded outbound queue and asynchronous Qt polling keep
document download/rendering off the GUI path. Requests time out and terminate the
worker; closing a reader also terminates it. EPUB expansion and page/pixel limits
bound ordinary workloads, although the worker is not an OS sandbox.

EPUB source XML builds numeric CFI paths and UTF-16 text offsets. A unique normalized
rendered passage must map to the original text before position writes are enabled.
Import resolves the source CFI back into a verified rendered text span; it does not
translate an arbitrary percentage into a CFI. Unsupported assertions and ambiguous
anchors retain the previous position. Tests round-trip point/range anchors through
the pinned Foliate/server converters. This does not certify arbitrary publisher CSS.

Comic spreads/continuous flow share a 48 MiB decoded image cache and at most three
stream widgets. Only displayed pages affect progress; a failed second spread page
cannot acknowledge a new spread. A split page is not complete until its second half.

Audio uses libVLC through a per-reader loopback HTTP capability. Server cookies remain
in the relay, upstream redirects are denied and only the fixed book/track endpoint
can be fetched. Range requests pass through for seeking. Resume and user seeking wait
for the actual media clock before enabling writes. Native voices run in a separate
speech process. Audio/voice runtime and license details are in [dependencies.md](dependencies.md).

Finder's native sidebar page talks to server plugin APIs; no plugin code executes
locally. Session, source/search and detail generations discard obsolete callbacks.
The server rechecks library write permissions when files are queued.

UI sizing separates point fonts/logical geometry from monitor DPR. Interface-size
preferences scale logical metrics; Qt applies display scaling independently. Reader
pixmaps render at physical resolution and carry the monitor DPR to avoid blur.

An external-browser button is a convenience, not feature parity. A platform is
validated only after its own tests run. API wrappers, hidden controls, and a roadmap
checkbox do not count as an implemented native feature. See [roadmap.md](../roadmap.md)
for the complete surface inventory and phase gates.
