# Flyleaf Desktop — phased roadmap to feature parity

Branch: **`feature/desktop-client`**. Reviewed **2026-11-18**.

Target: a native, non-Chromium Windows/Linux application connected to an existing
Flyleaf server. The server owns the database and permissions; the client uses its
API. Full parity is the destination, not a claim about this initial source preview.

Status: **[x] implemented foundation**, **[ ] pending**, **[-] depends on planned
server functionality**. An implemented item still needs platform/release validation.

## Phase 0 — Architecture and development foundation

- [x] Separate `desktop/` project in the server repository; keep changes on this branch.
- [x] Qt 6 Widgets via PySide6 Essentials; no browser runtime or embedded web UI.
- [x] Asynchronous API layer with cookie authentication, TLS validation, request bounds,
  timeouts, origin checks and cancellation of old-session callbacks.
- [x] Native shell and testable separation between connection, catalog and reader code.
- [x] Automated Qt-widget and local HTTP-contract tests; dependencies pinned for repeatability.
- [ ] Establish supported Windows versions, Linux distributions, architectures and Python/Qt baselines.
- [ ] Run a Windows/Linux CI matrix and dependency/security checks on this branch.
- [ ] Define the minimum supported Flyleaf server version and a capability handshake.

Exit: repeatable development setup, passing tests on both target platforms, and an
approved dependency inventory with no hidden browser runtime.

## Phase 1 — Connect, authenticate, and browse

- [x] Illustrated first-run welcome → server IP/hostname/URL → sign-in → local appearance
  setup; remember completion and skip the introduction on returning launches.
- [x] Default port, IPv6 and reverse-proxy base paths.
- [x] Detect incorrect servers, initial setup requirements, network failures and invalid certificates.
- [x] Username/email and password sign-in using the existing server session API.
- [x] Session in memory; sign-out and switching servers clear account data and cookies.
- [x] Remember the server address without writing credentials or session tokens to settings.
- [x] Native Home, visible libraries, Want to read, series details and volume selection.
- [x] Search, title/author/recent sorting, reading-state filters and incremental catalog paging.
- [x] Asynchronous cover loading, mature-artwork suppression and basic future-title masking.
- [x] Mark books read/unread through the API.
- [ ] Multiple named server profiles and deterministic reconnect behavior.
- [ ] Optional remembered sessions in Windows Credential Manager and a Linux secret service;
  handle a missing/locked vault without falling back to plaintext credentials.
- [x] Keep the catalog view, filters, scroll position and selected volume when returning from a reader.
- [ ] Genre/tag/creator/language/format filters, metadata links, full-text results and saved filters.
- [ ] Native account registration, first-run server setup, profile editing and password changes.
- [ ] Resume prompts after expired sessions without losing pending positions or exposing another account's data.
- [-] SSO, second factors and related recovery flows when the server supports them.

Exit: a new user can connect and find a readable item with keyboard-only navigation;
expired/revoked sessions and account changes have tested, understandable recovery.

## Phase 2 — Native reader coverage

### Image books and manga

- [x] Read server-supported CBZ/CBR/CB7/CBT/image folders by streaming page endpoints.
- [x] Fit page, fit width and fixed zoom; keyboard navigation, page picker and RTL direction.
- [x] Fullscreen, explicit loading errors, page retry and acknowledgement of saved positions.
- [x] Serialize/coalesce progress writes; failed pages never advance saved progress.
- [ ] Two-page/smart spreads, cover-alone handling, splitting, crop and original-resolution zoom.
- [ ] Webtoon/continuous layouts, controlled prefetch, auto-scroll and large-page memory tests.
- [ ] Paper/image filters, reader profile bindings and per-series overrides.
- [ ] Native bookmark/annotation overlays and deliberate spoiler reveals.

### Reflowable ebooks

- [ ] Select and validate a native EPUB renderer: CSS/layout fidelity, fonts, images, tables,
  links/footnotes, accessibility, pagination and continuous flow; no embedded browser substitute.
- [ ] Design precise EPUB CFI import/export against the pinned server/Foliate corpus before
  writing ebook progress. Do not invent CFIs or overwrite a valid position with an approximation.
- [ ] TOC, bookmarks, search, highlights, notes, dictionary/translation and typography controls.
- [ ] EPUB/KEPUB, FB2, legacy MOBI and KF8/AZW3 support through verified native import or
  explicit server-assisted renditions with source-to-rendition position mapping.
- [ ] TXT/DOCX/RTF through supported server conversions, with clear unsupported-layout errors.
- [ ] Fixed-layout EPUB, embedded fonts, publisher CSS and RTL/CJK/vertical-text validation.
- [ ] Native read-aloud with sentence tracking, voices, speed, continuation and sleep timer;
  track the server/web read-aloud restoration work rather than assume its parity is complete.

### PDFs and audiobooks

- [ ] Choose a PDF backend/module and packaging strategy without shipping a browser runtime.
  Validate text selection, search, annotations, TOC, zoom, rotation and accurate page sync.
- [ ] Choose native audio playback and codecs; implement chapters/tracks, speed, seeking,
  sleep timer, media keys and OS media integration.
- [ ] Validate authenticated/range requests, interruption, reconnect, suspend/resume and long sessions.
- [ ] Keep reading-time measurement and position writes accurate without retry duplication.

Exit: every server-supported readable format has a declared native support level,
tested progress interoperability and documented limitations. Browser fallback does not pass this gate.

## Phase 3 — Progress, personal data and offline reliability

- [ ] Measure actual active reading/listening time and preserve local-day semantics.
- [ ] Account-scoped durable outbox with idempotent replay, retry backoff and visible failures.
- [ ] Offline books, covers, metadata and reader assets, with atomic downloads and integrity checks.
- [ ] Storage budget, pinning, eviction/cleanup previews and invalidation after source changes.
- [x] Preview and move per-account personal folders, with progress, recovery details and updated library paths.
- [x] Show unavailable library storage and check it again after reconnecting the drive.
- [ ] Conflict previews between desktop, browser, Kobo, KOReader and other clients.
- [ ] Native reading-position history and guarded restore UI with robust content revisions.
- [ ] Preserve pending work on close, session expiry, crash, upgrade and network loss.
- [ ] Test two accounts on one device, multiple servers with overlapping IDs and revoked access.
- [ ] Searchable highlights/bookmarks/notes, per-book exports and supported Readwise/Obsidian flows.
- [-] Dedicated per-book notebook and richer note features as the server/API implements them.

Exit: reconnect/restart/account-switch scenarios cannot silently lose progress,
duplicate reading time or disclose cached personal data across accounts.

## Phase 4 — Library organization and personal reading parity

- [ ] Collections, smart shelves, reading lists and their ordering/editor actions.
- [ ] Personal tags, statuses, reviews/ratings and permission-aware bulk actions.
- [ ] Recommendations, similar books and creator/genre exploration.
- [ ] Customizable native Home with the server's account preferences and optional local layout.
- [ ] Reading stats, goals, streaks, history and yearly review, with accessible native charts.
- [ ] Fits tonight with format/time filters and transparent estimate explanations.
- [ ] Private journal: reflections/moods, reading days, highlights, edit/delete and Markdown export.
- [ ] E-ink/high-contrast presentation and complete spoiler-safe flows across supported views.
- [ ] Notifications and activity center, including supported retry/cancel/history operations.
- [ ] Profile, theme, language, keyboard bindings, font selection and accessibility preferences.
- [-] Edition grouping, reading memory/recaps and other planned server features after their APIs land.

Exit: the desktop can perform ordinary non-admin reading/organization tasks without
opening the browser, and private data/preferences agree across clients.

## Phase 5 — Discovery, transfers and integrations

- [x] Rescan library files for Content Finder links and confirm a source for imported series.

- [ ] Native Content Finder sources, kind/genre filters, catalog search and source diagnostics.
- [ ] Download queues, followed series, chapter updates, retry/cancel and target-library selection.
- [ ] Plugin and Mihon/Suwayomi integration through the server; do not run arbitrary plugins in the UI process.
- [ ] Upload files/folders with progress, cancellation, quota errors and interrupted-transfer recovery.
- [ ] Original downloads and send-to-device flows with native file dialogs and safe destination handling.
- [ ] AniList/MAL/MangaUpdates/Kitsu tracking, account state and supported import/scrobble operations.
- [ ] Open external authentication in the system browser with a verified return flow;
  never embed browser login or request broader credentials than the integration requires.
- [ ] OPDS/API keys, webhook settings and Kobo/KOReader connection/setup/status views.

Exit: server-supported discovery and integration workflows are available natively,
respect permissions and explain failures without exposing credentials in logs.

## Phase 6 — Administration parity

- [ ] Native server library management, scanning, metadata lookup/editing, artwork and duplicate review.
- [ ] Make remote server paths distinct from local desktop paths in all folder/file pickers.
- [ ] Users, personal/shared libraries, permissions, age restrictions, quotas and registration settings.
- [ ] Backups, archive inspection, restore preview, schedules and recovery-state feedback.
- [ ] Server/email configuration, plugins, activity/security logs and diagnostics.
- [ ] Keep admin-only controls out of the main reading flow and respect server permissions
  even when the connected account changes without restarting the desktop application.
- [-] Planned metadata-review, diagnostics, backup and security additions as server capabilities mature.

Exit: each existing admin task has an explicitly tested native implementation or a
documented server-only rationale. No parity claim based solely on links to web settings.

## Phase 7 — Platform integration and distributable previews

- [x] Shared Midnight/Paper/system-following palettes across setup, catalog and reader.
- [x] Matching title bar with standard window actions, system move/resize requests,
  application-menu shortcut and persisted system-frame fallback.
- [x] Short incoming-screen fades, button hover/focus effects and ambient welcome art;
  respect system/local reduced motion and stop hidden/minimized welcome animation.
- [x] Local Qt tests for onboarding, preferences, transition cleanup, small setup layouts
  and Close-button progress protection; rendered dark/light screenshot review.
- [ ] Physical Windows/Wayland/X11 title-bar QA: edge/corner resize, snap, window menus,
  maximize/restore, fullscreen, multi-monitor DPI and assistive technology.
- [ ] High-contrast/forced-colors mode, large-font reflow and screen-reader review of the
  welcome, authentication, appearance and themed window controls.
- [ ] Standalone Windows installer/portable build and Linux packages; users should not need Python.
- [ ] Choose packaging tools only after proving the minimal Qt module set on each target OS.
- [ ] Windows/Linux CI artifacts, checksums, third-party notices, dependency inventory and reproducible build instructions.
- [ ] Code signing, update-channel verification, downgrade/rollback behavior and migration testing.
- [ ] Desktop entry/icon, URL/file associations, native dialogs, launch errors and crash reports with redaction.
- [ ] Wayland/X11, Windows DPI/scaling, multiple displays, fonts, TLS/proxies and suspend/resume testing.
- [ ] Screen readers, keyboard focus/shortcuts, translation/RTL, contrast and reduced-motion validation.
- [ ] Optional native platform themes plus a predictable fallback; measure layout instead of assuming pixel identity.

Exit: clean machines can install, launch, connect, read, update and uninstall without
developer tools or losing user data. Publish an actual tested platform matrix.

## Phase 8 — Feature-parity release gate

- [ ] Audit current web routes, OpenAPI operations and server permissions against the table below.
- [ ] Run the format, offline, account-switch, device-sync and migration corpora on Windows and Linux.
- [ ] Perform live-server journeys rather than relying only on HTTP fixtures and screenshots.
- [ ] Benchmark startup, catalog scrolling, page turns, large files, concurrent requests and memory growth.
- [ ] Review threat boundaries, dependency inventory, credentials, certificate behavior and local caches.
- [ ] Document remaining differences and obtain explicit decisions for intentionally server-managed features.
- [ ] Mark parity only when every applicable implemented web capability is accounted for and verified.

## Parity inventory

| Surface | Initial desktop status | Completion phase |
|---|---|---|
| Connect / session sign-in / sign-out | Implemented foundation; persistent credentials pending | 1 |
| Native Home, library, search, sort, paging | Implemented subset; advanced filters and state restoration pending | 1, 4 |
| Comic/image reading and page progress | Implemented subset; advanced layouts, annotations and time tracking pending | 2, 3 |
| EPUB/KEPUB/MOBI/AZW3/FB2/documents | Native readers pending | 2 |
| PDF and audiobook playback | Pending | 2 |
| Reader profiles, TTS, lookup and typography | Pending | 2 |
| Offline books/outbox/conflicts/position recovery | Pending | 3 |
| Bookmarks/highlights/notes and exports | Pending | 3 |
| Per-book notebook | Depends on planned server functionality | 3 |
| Collections, reading lists, smart shelves and tags | Pending | 4 |
| Ratings, reviews, recommendations and statistics | Pending | 4 |
| Custom Home, Fits tonight, journal, e-ink and full spoiler protection | Pending beyond basic title masking | 4 |
| Notifications and unified activity | Pending | 4 |
| Content Finder, follows, plugins, downloads and uploads | Pending | 5 |
| Tracking, send-to-device, OPDS/API keys and webhooks | Pending | 5 |
| Metadata, libraries, users, quotas, backups and server settings | Pending | 6 |
| Planned web/server features | Track as dependencies; do not count unfinished server features as implemented parity | 3–6 |
| Standalone installers and verified OS support | Pending | 7 |

Keep this inventory synchronized with the server roadmap and OpenAPI descriptions.
Tests, OS names in a dependency's documentation and an external-browser shortcut
are not substitutes for testing the corresponding native workflow.
