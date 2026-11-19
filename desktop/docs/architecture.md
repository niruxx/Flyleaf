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
- `onboarding.py`: welcome artwork and first-run local appearance setup.
- `appearance.py`: shared palette and cancellable incoming-screen transitions.
- `motion.py`: brief button hover/focus feedback with no continuous animation loop.
- `chrome.py`: matching title bar and platform-managed move/resize requests.
- `library.py`: native library navigation, search, filters, paging and details.
- `image_reader.py`: server-streamed comic/image pages, navigation and acknowledged position writes.
- `app.py`: session lifecycle, routing between native widgets and desktop actions.

The remote Flyleaf server remains authoritative for authentication, permissions,
private libraries, age restrictions, metadata, conversion, progress and shared
features. The desktop client uses the same API as the web app; it must not read a
network-mounted server database or bypass permissions by opening server files.
Any eventual local SQLite store is an account-scoped client cache/outbox only.

Server responses are untrusted input. Metadata labels use plain text; external
resources cannot receive the session through arbitrary cover URLs. Resetting the
connection aborts outstanding requests, discards stale callbacks and replaces the
cookie jar before another account's data is shown. There is no persistent login
until a verified OS credential-vault design is implemented.

The first-run wizard configures this client, not the server's initial administrator
account. That server administration feature remains pending. Device preferences store
only theme, reduced motion, frame choice and onboarding completion alongside the
validated address. Credentials remain in memory.

Screen fades affect incoming widgets only, last 220 ms and cancel on navigation,
theme changes, reduced motion, account cleanup or removal of an animated reader.
No outgoing account screenshot is retained. Button halos run for 140 ms per event;
the welcome's 30 fps artwork stops when hidden, minimized or motion is reduced.
Qt accessibility motion hints are respected in addition to the user's setting.

The default themed title bar uses Qt's system move/resize requests so the window
manager owns those operations. The system-frame option remains available for
platform conventions or accessibility needs; actual snap, Wayland/X11 and multiple
monitor behavior still require physical platform validation. The Close button uses
the existing progress-save guard. These are widgets and painter effects, not a web
rendering layer. See [Qt system move/resize](https://doc.qt.io/qt-6/qwindow.html#startSystemMove),
[property animations](https://doc.qt.io/qt-6/qpropertyanimation.html) and
[accessibility hints](https://doc.qt.io/qt-6/qaccessibilityhints.html).

## Reading engines and parity

Do not embed Qt WebEngine or another browser merely to tick a reader-parity box.
Reflowable EPUB requires an explicit layout and CFI interoperability design.
Qt's rich-text widgets alone do not reproduce Foliate or arbitrary publisher CSS.
PDF and multimedia additions need their own module/dependency decision: do not
silently replace Essentials with a dependency bundle that ships WebEngine.

An external-browser button is a convenience, not feature parity. A platform is
validated only after its own tests run. API wrappers, hidden controls, and a roadmap
checkbox do not count as an implemented native feature. See [roadmap.md](../roadmap.md)
for the complete surface inventory and phase gates.
