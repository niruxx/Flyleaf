# Flyleaf Desktop — phased roadmap to feature parity

Branch: **`feature/desktop-client`**. Reviewed **2026-11-19**.

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
- [x] Multiple named server profiles; explicit opt-in startup reconnect checks the selected
  profile once and returns to sign-in on failure, without retrying passwords.
- [x] Optional remembered session tokens in Windows Credential Manager or Linux Secret Service;
  serialized background vault operations, origin/profile scoping, server validation and
  missing/locked-vault feedback. No password storage or plaintext fallback.
- [x] Preserve filters, selected series/volume, loaded catalog pages, splitter layout and
  scroll position when returning from a reader; refresh current server progress.
- [x] Genre/tag/creator/language/format filters, safe external metadata links, native
  full-text result snippets and server-backed saved-filter create/update/delete/apply.
  Language/format require the server's advertised capability; older servers disable them.
- [x] Native registration/invite codes when enabled, explicit first-administrator setup,
  display name/email and permitted username editing, plus current/new password changes.
- [x] Same-account/server resume prompts after expiry; retain unsaved displayed pages in
  memory, require an explicit choice, and reject pending-page replay for changed/unverified files.
- [ ] Physical Linux Secret Service verification on GNOME/KDE and a clean machine;
  Windows fictional-secret roundtrip and Linux adapter contract tests pass locally.
- [x] Durable account-scoped pending-position recovery across app exit/crash (Phase 3).
- [ ] Open full-text matches at the exact passage once EPUB/PDF native readers support it.
- [-] SSO, second factors and related recovery flows when the server supports them.

Exit: a new user can connect and find a readable item with keyboard-only navigation;
expired/revoked sessions and account changes have tested, understandable recovery.

## Phase 2 — Native reader coverage

### Image books and manga

- [x] Read server-supported CBZ/CBR/CB7/CBT/image folders by streaming page endpoints.
- [x] Fit page, fit width and fixed zoom; keyboard navigation, page picker and RTL direction.
- [x] Fullscreen, explicit loading errors, page retry and acknowledgement of saved positions.
- [x] Serialize/coalesce progress writes; failed pages never advance saved progress.
- [x] Two-page/smart spreads, cover-alone handling, splitting, crop and original-resolution requests.
- [x] Webtoon/continuous layouts, nearby-page prefetch, auto-scroll and a 48 MiB decoded cache;
  keep at most three continuous page widgets. Split completion and failed-spread saves tested.
- [x] Paper/image filters, reader profile bindings and per-series overrides.
- [x] Native bookmark/highlight/private-note create/edit/delete/navigation through reader Tools.
- [x] Actionable image-page annotation badges, explicit future-title reveal and bounded-cache
  tests with multi-megapixel pages.
- [ ] Long-session memory benchmarks on representative physical Windows/Linux machines.

### Reflowable ebooks

- [x] Native MuPDF EPUB renderer in a disposable worker process; paginated/continuous
  reading, text extraction and internal/external links without a browser runtime.
- [x] Source DOM → UTF-16 CFI point/range mapping; synthetic Unicode source positions
  round-trip through the pinned server/Foliate converters. Reject ambiguous/unverified
  anchors and retain the previous server position; explicit resume choice when needed.
- [x] TOC, bookmarks, search, highlights, notes, dictionary/translation and typography controls.
  Select text directly on single/continuous native pages or in the page-text inspector;
  document highlights are drawn on the matching page.
- [x] EPUB/KEPUB and server-converted FB2/MOBI/AZW3/TXT/DOCX/RTF route through the
  server's canonical EPUB file endpoint (`?native=epub` for FB2/MOBI/AZW3).
  Conversion errors remain visible and do not save progress.
- [x] Native converted-format fixtures render end to end, including FB2/MOBI/KF8 and
  TXT/DOCX/RTF. Actual pinned Foliate CFIs agree with the native rendition DOM.
- [x] CFI corpus covers mixed text/comment/CDATA nodes, Unicode UTF-16 offsets, basic
  assertions, ranges and changed-source rejection.
- [ ] Broader publisher corpus and existing separate KOReader/device MOBI/KF8 regressions (Phase 7).
- [ ] Fixed-layout EPUB, embedded fonts, publisher CSS and RTL/CJK/vertical-text validation.
- [x] Native system-voice read aloud, word tracking, voice/speed, continuation and sleep timer.
- [ ] Verify Windows/Linux voice playback, interruption and restoration with multilingual books;
  validate accessible direct page selection, footnotes and highlights in continuous/spread layouts.
  Windows file-sink synthesis works, but word/end callback verification remains unresolved;
  do not treat the implemented controls as validated voice interoperability.

### PDFs and audiobooks

- [x] MuPDF PDF rendering, TOC/search, zoom/rotation, selectable page-text inspector,
  notes/highlights and native page sync; real worker and widget journeys tested.
- [x] VLC native playback, tracks/chapters, speed, seek, sleep timer and foreground media keys.
  Real silent-WAV resume/seek test checks that transient zero positions are not saved.
- [x] Loopback range relay scopes upstream requests and cookies to the current server/book;
  reject redirects and invalid local capabilities, surface expired sessions, revoke on close.
- [x] Windows SMTC and Linux MPRIS adapters for metadata, transport, seeking and rate;
  Windows real-window registration and MPRIS interface contract checks pass locally.
- [x] Verified-position recovery for interrupted streams and suspend-sized clock gaps.
- [ ] Real Linux media-session verification, physical suspend/reconnect and long-session QA.
- [x] Direct word selection/copy/highlighting on single and continuous PDF/EPUB canvases.
  Spread selection uses the page-text inspector to preserve accurate geometry.
- [ ] Codec/clean-machine runtime packaging and dependency license release decision
  (MuPDF AGPL/commercial); see docs/dependencies.md.
- [x] Active reading/listening-time measurement and idempotent replay (Phase 3).
  Legacy servers retain position-only behavior; pending durable work pauses on downgrade.

Phase 2 **native reader foundation is implemented; the compatibility/release exit gate
is still pending**. Do not mark the entire phase complete until these remaining checks pass.

Exit: every server-supported readable format has a declared native support level,
tested progress interoperability and documented limitations. Browser fallback does not pass this gate.

## Phase 3 — Progress, personal data and offline reliability

- [x] Measure active foreground reading, verified audio playback and started speech,
  excluding idle/suspend gaps and preserving sampled local-day buckets.
- [x] Account/server-scoped SQLite outbox, transactional server receipts, exact-body retries,
  retry backoff and a persistent sync-status entry with visible failures.
- [x] Explicit offline library with books, covers, metadata and reader assets; atomic
  asset downloads, SHA-256 integrity and source verification before marking complete.
- [x] Configurable storage budget, pinning, cleanup previews and source invalidation;
  incomplete downloads and pending reading work cannot be silently evicted.
- [x] Local/server conflict previews and explicit keep-local/keep-server resolution,
  preserving sampled time. Uncertain receipts and revoked access cannot be blindly rebased.
- [ ] Physical concurrent desktop/browser/Kobo/KOReader interoperability matrix.
- [x] Native position history and guarded restore with source-revision and expected-position
  checks; refuse restore while local work remains pending. Server source identity is mtime.
- [x] Checkpoint positions/time across close, expiry, crash and network loss; schema-version
  checks refuse future stores without resetting data.
- [ ] Released-version upgrade/downgrade migration corpus and power-loss testing.
- [x] Test account/server namespaces, vault-scoped offline unlock, revoked-access quarantine
  and protected-response identity checks; sign-out never exposes another account's cached work.
- [ ] Physical Linux vault and multi-profile end-to-end verification.
- [x] Searchable cross-book/per-book highlights, bookmarks and notes; Markdown/CSV,
  Readwise CSV and Obsidian ZIP exports, plus explicit token-based Readwise submission.
  Offline notes support cached search/JSON export; editing requires the server.
- [ ] External Readwise delivery with an authorized test account (no delivery performed locally).
- [-] Dedicated per-book notebook and richer note features as the server/API implements them.

Phase 3 **core workflows are implemented**. The Windows checkpoint passes 77 native
tests (one Linux session-bus test skipped) and a real isolated-server journey through
durable progress, offline download/read/reconnect, annotation exports and guarded
position restore. Physical platform/device, power-loss and released-version migration
checks above remain pending. Local caches are not application-encrypted; offline unlock
requires the matching previously validated OS-vault session.

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

- [x] Permission-aware Content Finder sidebar, native source/kind/genre filters, catalog
  search, details/files and source setup/error feedback; plugins run only on the server.
- [x] Target-library selection and submitting selected files to the server download queue.
- [x] Native server download queue with progress/errors/history, selected retry and
  cancel/remove confirmation. Poll only while the queue is visible; clear account data on logout.
- [x] Follow a source title with an explicit automatic-download choice and destination;
  manage followed-series settings, check for new chapters and unfollow natively.
- [x] Chapter-update feed and manual download of newly discovered chapters.
- [x] Folder-source browsing with parent navigation and paginated results; file selection
  helpers and guarded duplicate in-flight submissions.
- [ ] Source-wide check schedules, follow-from-existing-downloads sync, recommendations,
  bulk queue operations and richer source artwork/details parity.
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

- [x] Native Material 3 Expressive UI aligned with Flyleaf's `m3.css`/`expressive.css`:
  OKLCH tonal roles, Roboto Flex, expressive welcome/Home surfaces, rounded cards,
  pill navigation/buttons, themed forms, reader bars and matching title bar.
- [x] Light/dark/system appearance and Flyleaf/Ocean/Sakura/Forest/Ember/Graphite palettes;
  native rounded vector icons and locally bundled font/license with no runtime font download.
- [x] Compact navigation rail, keyboard focus and text tooltips; collapsed empty feedback
  and wrapped-label reflow without retaining a narrow layout's old height.
- [x] Matching title bar with standard window actions, system move/resize requests,
  application-menu shortcut and persisted system-frame fallback.
- [x] Short incoming-screen fades, button state layers/press ripples, cover hover lift and ambient welcome art;
  respect system/local reduced motion and stop hidden/minimized welcome animation.
- [x] Local Qt tests for onboarding, preferences, transition cleanup, small setup layouts
  and Close-button progress protection; rendered dark/light screenshot review.
- [x] Text-role contrast checks across all six palettes in light/dark modes, font/icon
  availability checks and a wrapped-text shrink regression check.
- [x] Point-sized UI fonts, larger cards/controls, Qt logical geometry and DPR-aware
  reader images; independent 100–200% interface size. Offscreen 200% screenshots and
  real PDF/EPUB/comic widget DPR checks; physical mixed-monitor validation remains pending.
- [ ] Physical Windows/Wayland/X11 title-bar QA: edge/corner resize, snap, window menus,
  maximize/restore, fullscreen, multi-monitor DPI and assistive technology.
- [ ] High-contrast/forced-colors mode, large-font reflow and screen-reader review of the
  welcome, authentication, appearance and themed window controls.
- [ ] Resolve the existing MOBI DOM-profile and KF8-to-EPUB failures in
  `tests/library-sync.test.cjs`; reproduced with the committed test baseline as well
  as this branch. New catalog-filter and saved-filter API checks pass.
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
| Connect / session sign-in / sign-out | Implemented with optional OS-vault sessions; Linux physical QA pending | 1 |
| Native Home, library, search, sort, paging | Catalog filters, saved searches, full-text snippets and reader-return state implemented; custom Home pending | 1, 4 |
| Comic/image reading and page progress | Advanced layouts/filters, annotation badges, active time and durable progress implemented | 2, 3 |
| EPUB/KEPUB/MOBI/AZW3/FB2/documents | Native canonical-EPUB foundation and verified CFIs; conversion/layout corpus gates pending | 2 |
| PDF and audiobook playback | MuPDF PDF, VLC audio and native OS media adapters implemented; platform/runtime packaging gates pending | 2 |
| Reader profiles, TTS, lookup and typography | Native controls implemented; platform voice validation pending | 2 |
| Offline books/outbox/conflicts/position recovery | Durable outbox, offline cache, conflict review and account-scoped recovery implemented; platform matrix pending | 1, 3 |
| Bookmarks/highlights/notes and exports | Reader tools, cross-book search, cached notes and native export workflows implemented | 2, 3 |
| Per-book notebook | Depends on planned server functionality | 3 |
| Collections, reading lists, smart shelves and tags | Saved smart-filter CRUD/apply implemented; collection/list/tag management pending | 1, 4 |
| Ratings, reviews, recommendations and statistics | Pending | 4 |
| Custom Home, Fits tonight, journal, e-ink and full spoiler protection | Pending beyond basic title masking | 4 |
| Notifications and unified activity | Pending | 4 |
| Content Finder, follows, plugins, downloads and uploads | Native search/folder browsing, server downloads/retry/cancel, follows and chapter updates implemented; advanced source controls, plugin administration and uploads pending | 5 |
| Tracking, send-to-device, OPDS/API keys and webhooks | Pending | 5 |
| Metadata, libraries, users, quotas, backups and server settings | Pending | 6 |
| Planned web/server features | Track as dependencies; do not count unfinished server features as implemented parity | 3–6 |
| Standalone installers and verified OS support | Pending | 7 |

Keep this inventory synchronized with the server roadmap and OpenAPI descriptions.
Tests, OS names in a dependency's documentation and an external-browser shortcut
are not substitutes for testing the corresponding native workflow.
