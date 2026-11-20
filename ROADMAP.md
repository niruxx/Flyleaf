# Roadmap

Pending work reviewed **2026-11-18**. New proposals below are **⬜ pending**, not
implemented or promised for a particular release. Priorities: **P0** protects data
and release reliability; **P1** improves everyday usability and compatibility;
**P2** explores distinctive reading experiences. Existing implementation milestones
still need the release checks and physical-device validation listed here.

**Recommended order:** offline/account safety → reliable saves and scans → green
regression tests → browser/device compatibility → onboarding and accessibility →
distinctive reader enhancements.

### 🟨 KOReader and Kobo sync

Both integrations are implemented and covered by automated tests; full device compatibility
is still being verified. [Setup, supported formats and limitations](docs/device-sync.md)

- 🟨 **KOReader** (`/api/kosync`): revocable API-key login, checksum matching and two-way
  progress for pages, EPUB, FB2 and supported legacy MOBI6 layouts, with native-anchor fallback.
  MOBI/KF8/AZW3 can also download a position-preserving EPUB for KOReader; device validation
  targets **2026.07.1** and remains pending.
- 🟨 **Kobo sync** (`/api/kobo/<key>`): collection delivery, covers, cached KEPUB downloads,
  two-way reading progress, individual-book shelf edits, resumable pagination and batch updates.

**Remaining work**

- ✅ **Complex MOBI positions**: two-way mapping for filepos/NCX targets, including mid-text
  splits, nested tables with explicit or implicit row groups, and preformatted Unicode text.
  Native observations distinguish legacy/modern anchor DOMs; ambiguous or malformed layouts
  keep compatible native-anchor fallback. Physical-device validation remains separate below.
- ✅ **KF8/AZW3 interoperability**: cached EPUB downloads for reflowable, unencrypted books,
  preserving Foliate section/text CFI paths and matching the generated binary checksum back
  to the original library book. Unsupported conversions fail explicitly; originals stay intact.
- ✅ **Publisher CSS compatibility**: specificity-preserving body/non-body branches for
  ambiguous and stateful selectors, including functional selectors and imported stylesheets.
  EPUB positions resolve the static whitespace cascade; device-dependent or unsupported
  whitespace uses native-anchor fallback. Firmware/rendering validation remains below.
- 🟨 **Device validation**: test actual KOReader and Kobo versions for rendering, fixed-layout
  books, bookmarks, interrupted sync and shelf edits, then document supported versions.
  [Validation checklist](docs/device-sync.md#compatibility-validation)

---

## 📖 Reader

- ⬜ **Restore and verify text-to-speech / read aloud**: the current checkout is missing
  `public/js/reader/read-aloud.js`, which the existing test suite references. Reconcile
  implementation, tests and documentation before marking this complete. Intended behavior:
  current-sentence highlighting, play/pause/stop, adjustable speed, sleep timer and chapter
  continuation, with browser voice availability and interruption behavior clearly explained.
  [Usage and browser limits](docs/read-aloud.md)

---

## 👥 Accounts & security

- ⬜ **Single sign-on** with OpenID Connect (Authelia, Authentik, Keycloak), including
  explicit account linking, role mapping and a tested local-admin recovery path
- ⬜ **Two-factor authentication** (TOTP) for the admin account
---

## 🛠️ Platform

- ⬜ **Publish the Docker image** to a registry (GitHub Container Registry) from CI, for `docker pull`
- 🟨 **Windows / Linux desktop client**: native Qt 6 Widgets/PySide6 Essentials project
  on `feature/desktop-client`, with no embedded browser. Illustrated client onboarding,
  server connection, sign-in, browsing, native comic/image reading, coordinated themes,
  reduced-motion effects and a matching title bar are implemented; native ebooks, PDF, audio,
  offline operation, installers and full parity remain pending.
  [Run the preview](desktop/README.md) · [Phased desktop parity roadmap](desktop/roadmap.md)


---

## Home & activity

- ✅ **Customizable home**: per-account section visibility and ordering, optional
  welcome banner and shortcuts, compact cards, and shelf sorting by title, author,
  or reading progress.
- ✅ **Unified activity center**: downloads, uploads, library scans, automatic
  metadata matching, search indexing, and stored backups, with progress, filters,
  durable history, and supported retry/cancel controls.
- ✅ **Personal storage moves**: browse and validate destinations, track progress across signed-in sessions,
  and recover failed moves or find original copies from Activity.
- ✅ **Content Finder source links**: recover links from download history and review missing links on imported series.
  [Usage and current coverage](docs/home-and-activity.md)
- ⬜ **Additional activity sources**: device sync, reader conversions, backup
  downloads, and restore operations.

---

## A distinctive reading experience

- ✅ **Fits tonight**: time-budget discovery using indexed text, page counts, known
  audio durations, and personal reading pace, while preserving series reading order.
- ✅ **Spoiler-safe series browsing**: hide future titles and covers, reveal individual
  items deliberately, and protect unstarted series summaries.
- ✅ **Private reading journal**: reading days, highlights, personal reflections and
  moods, with monthly Markdown export.
- ✅ **E-ink interface**: monochrome app chrome and temporary reader display overrides,
  without changing saved reading profiles.
- ✅ **Reading-position recovery**: bounded history across progress writers, guarded
  restores, and recent Kobo/KOReader position observations.
  [Usage, estimates, and limitations](docs/reading-room.md)

## Follow-on UI & system work

### P0 — Stability, data safety & code review

These are focused review findings and hardening tasks, not a completed security audit.

- ⬜ **Offline replay that preserves progress**: retain saves on 429 and transient 5xx
  responses, pause for sign-in on 401, and distinguish revoked access from temporary
  failures. Add retry backoff, visible pending/failed states and replay tests.
  Review: [offline queue](public/js/offline.js).
- ⬜ **Shared-browser account isolation**: scope offline books, cached reader responses,
  queued progress and remembered state to the account and server. Define sign-out cleanup
  and test switching accounts while offline; never replay one account's saves as another.
  Review: [offline storage](public/js/offline.js) and [service worker](public/sw.js).
- ⬜ **Durable preference saves**: keep failed changes pending, show saving/saved/retry
  feedback, and flush or cancel queued saves safely on navigation and account changes.
  Review: [preferences](public/js/prefs.js).
- 🟨 **Safe scans on unavailable storage**: catalog preservation and reconnect checks are implemented. Validate
  behavior on disconnected SMB/NFS mounts and physical drive replacement.
  Review: [scanner](server/scanner.js).
- ⬜ **Restore a green regression suite**: repair missing `server/metadata-match.js` and
  read-aloud test dependencies; resolve the previously observed MOBI DOM-profile and
  KF8/KOReader rendition failures. Reconcile completed-feature claims with passing tests.
- ⬜ **Repeatable checks and CI**: add one documented test command, isolated temporary
  databases, formatting/lint checks, frontend import validation and CI on supported Node
  versions and operating systems. Add real browser journeys alongside demo-API screenshots.
- ⬜ **Idempotent background jobs**: review duplicate retries, retrying an already-running
  index or backup, restart recovery, cancellation cleanup and stalled-job detection.
  Task-history failures must not turn a successful underlying operation into a failed one.
- ⬜ **Backup health and restore preview**: extend existing manifest/database inspection
  with archive completeness checks, destination/path mapping, required space and an explicit
  replacement preview. Test restore drills, migration failures and recovery after interruption.
- ⬜ **Safe upgrades and maintenance**: coordinate scans, downloads, indexing and backups
  before database replacement; resume safely afterward. Test interrupted upgrades, rollback
  and restoring an older backup while jobs or readers are active.
- ⬜ **Concurrency and file-operation review**: test simultaneous imports/downloads,
  filename collisions, disk exhaustion, interrupted streams and safe atomic renames. Verify
  path containment and permission checks at execution time as well as at queue time.
- ⬜ **Progress correctness across writers**: test web, offline replay, Kobo and KOReader
  together, including stale timestamps, repeated deliveries and restore races. Preserve
  active reading time exactly once when a request is retried after an uncertain response.
- ⬜ **Performance and resource budgets**: benchmark large libraries, frequent history
  writes and concurrent conversions. Review synchronous work, pruning queries, streaming,
  pagination, database contention, memory limits and corrupt/archive-expansion limits.
- ⬜ **Access-control regression matrix**: cover private/shared libraries, age restrictions,
  API-key scopes, covers, search, OPDS, offline caches, journal exports and history restores.
  Verify secrets and private reading data are absent from logs and support exports.

### P1 — Compatibility & predictable installation

- ⬜ **Published browser support matrix**: test Safari/iOS, Chrome/Android, Firefox and
  desktop Chromium in browser and installed-PWA modes. Cover opening/resuming each reader,
  fullscreen, rotation, gestures, audio, downloads and reconnecting after suspension.
- ⬜ **Feature detection and useful fallbacks**: explain HTTPS requirements and unavailable
  offline storage, persistence, voices, wake locks and lock-screen controls. Keep navigation
  and reading usable when optional browser APIs or animations are unavailable.
- ⬜ **Physical e-reader validation**: extend the Kobo/KOReader checklist with firmware,
  browser and publisher-CSS combinations; record exact positions, covers and rendering.
  Test e-ink interface readability on real hardware without promising hardware refresh control.
- ⬜ **OPDS/client compatibility fixtures**: publish tested app/version combinations,
  authentication and streaming behavior. Exercise Unicode titles, paging, cover access,
  large downloads and the difference between catalog access and actual progress sync.
- ⬜ **Format compatibility corpus**: keep redistributable fixtures for RTL/CJK/vertical
  text, non-Latin filenames, legacy encodings, fixed-layout EPUBs, complex PDFs, malformed
  archives and long manga strips. Explain encrypted/unsupported formats before opening fails.
- ⬜ **Audiobook compatibility**: measure multi-track duration, handle chapter/track
  boundaries and interrupted streams, and verify seeking, speed, background playback,
  HTTP Range requests and offline resumption across browsers.
- ⬜ **Deployment compatibility**: test Windows/Linux paths, ARM64/x86-64 containers,
  read-only libraries, network shares, reverse proxies, large uploads and TLS termination.
  Document whether subpath hosting is supported and detect incompatible configurations.
- ⬜ **Portable migration and metadata round trips**: preview imports from Calibre and
  other library tools, match identities safely and map changed library roots. Export reading
  data in documented formats and offer optional sidecars without silently rewriting originals.

### P1 — Ease of use, accessibility & UI polish

- ⬜ **Guided setup and device connection checks**: walk through library selection,
  permissions, scan preview, sample reading and offline readiness. Give Kobo/KOReader/OPDS
  setup a connection test with actionable errors and copyable configuration.
- ⬜ **Accessibility review**: verify keyboard-only navigation, screen-reader names,
  dialog focus/return focus, shortcut discovery, contrast, text scaling and touch targets.
  Test reduced motion, e-ink, 200% zoom and layouts with long translated or RTL labels.
- ⬜ **Command palette**: accessible keyboard and touch entry points for books, authors,
  shelves, settings and common actions; preserve ordinary browser and reader shortcuts.
- ⬜ **Clear navigation and consistent controls**: audit menu terminology, action placement,
  back behavior, selection state and the mobile drawer. Restore filters, scroll position and
  library layout when returning from a book instead of forcing users to reconstruct a view.
- ⬜ **Trustworthy feedback and error recovery**: consistent loading/empty/error states,
  actionable failure messages, retry buttons and visible save state. Avoid unhandled async
  actions, silent failures and updates to views the user has already left.
- ⬜ **Undo and safer bulk changes**: preview metadata edits, moves and merges; distinguish
  removing a catalog entry from deleting a file. Provide undo where reversible and clearly
  state the scope and consequences of actions that cannot be undone.
- ⬜ **Offline policies and readiness**: storage budgets, pinning, cleanup previews and
  persistence status. Check that a saved book has all required assets; recover interrupted
  downloads and make storage eviction, revision changes and pending uploads understandable.
- ⬜ **Journal drafts and honest completeness**: recover unsent reflections, guard against
  accidental dismissal, support offline drafts per account and paginate large months.
  Show when highlight/export limits truncate results rather than implying a complete export.
- ⬜ **Per-book notebook**: add a clear **Notes** entry in book details and the reader,
  bringing existing highlights, bookmark notes and book-linked journal reflections together.
  Allow multiple private, titled free-form notes without requiring a highlighted passage,
  page position or journal date; support search, tags, pinning and Markdown export per book.
  Include visible save state, recoverable drafts, edit history and account-scoped offline
  sync with conflict handling. Preserve notes and their book attribution when files move,
  editions change or a book is removed; make deletion of personal notes an explicit choice.
- ⬜ **Home customization polish**: live preview, optional per-shelf sorting, keyboard/touch
  reordering and clearer distinctions between sorting a shelf's selection and the full catalog.
  Offer a per-device layout override for phones and e-readers without resetting the account layout.
- ⬜ **Unified activity-center follow-through**: searchable/paged history with owner and
  library context, clear queued/running/completed states, supported bulk actions and a route
  to the affected book or setting. Complete the additional activity sources listed above.
- ⬜ **System diagnostics**: build on existing health/metrics endpoints to explain disk
  space, library permissions, watcher failures, indexing and integration health. Generate a
  redacted support bundle with the user's review before exporting it.
- ⬜ **Metadata review inbox**: proposed matches and field changes side by side, confidence
  explanations, field locks, cover comparison and batch approval with undo where possible.
- ⬜ **Sync conflict inbox**: per-device observations, pending offline saves, understandable
  location previews and an explicit choice between competing positions. Use stronger content
  revision identifiers than modification time alone when deciding whether a restore is compatible.

### P2 — Distinctive reader experiences

These are product proposals to validate with readers, not claims that alternatives lack them.

- ⬜ **Spoiler-safe “Where was I?”**: show the last chapter, reader-written context,
  bookmarks and saved passages up to the current position when returning after a break.
  Start with deterministic/user-authored recaps; make any future generated recap optional,
  source-linked and bounded by progress rather than sending an entire library by default.
- ⬜ **Book/audio handoff and edition grouping**: explicitly link related editions and
  formats, choose a preferred copy and keep positions independent until a reliable mapping
  exists. Offer previewed text/audio handoff only for verified alignment, with a manual fallback.
- ⬜ **A personal reading memory**: resurface selected highlights and reflections after a
  chosen interval, connect notes across books and create exportable monthly reading letters.
  Keep reminders opt-in and private; let readers explain or dismiss a resurfaced passage.
- ⬜ **Fits tonight, chapter-aware**: offer a finishable EPUB chapter or audio section,
  explain estimate confidence and let readers correct their pace. Include multi-track audio
  once duration is known, plus a natural stopping-point/sleep-timer suggestion.
- ⬜ **Spoiler-safe series journeys**: distinguish publication order, chronological order,
  side stories and optional extras, with user-curated paths and language/edition choices.
  Hide future artwork, titles and relationship spoilers consistently along the selected path.
- ⬜ **Deliberate reading sessions**: choose a book and optional time goal, enter a quiet
  reading view, then offer a gentle stopping point and private reflection. Avoid intrusive
  notifications or streak pressure; allow unfinished sessions to resume naturally.
- ⬜ **Personal discovery with explanations**: optional reader-entered mood, effort and
  time preferences, transparent recommendation reasons and “less like this” controls.
  Test rediscovery of unread owned books before encouraging more downloads.
- ⬜ **Reading accessibility across languages**: remember optional vocabulary lookups,
  export personal word lists and explore aligned bilingual editions. Keep dictionaries and
  translation providers explicit, with local/offline options where practical.
- ⬜ **Optional OCR and comic navigation research**: evaluate searchable scanned pages,
  reading-order-aware text selection and panel navigation with preview/correction controls.
  Preserve original images and require quality and performance benchmarks before rollout.

### Completion criteria for new work

A pending item should be marked complete only after its intended flow and failure/recovery
paths work, privacy and permission checks pass, relevant automated checks are green, and
desktop/mobile UI states have been reviewed. Hardware-specific claims additionally require
the named physical device/client validation. Record limitations and migration behavior in docs.

Compatibility planning references:
[browser storage persistence and eviction](https://developer.mozilla.org/en-US/docs/Web/API/Storage_API/Storage_quotas_and_eviction_criteria),
[Komga's published OPDS client matrix](https://komga.org/docs/guides/opds/).
