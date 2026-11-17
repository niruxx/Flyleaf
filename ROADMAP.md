# Roadmap


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

- ✅ **Text-to-speech / read aloud** with the Web Speech API: current-sentence highlighting,
  play/pause/stop, 0.5–2× speed, a sleep timer and automatic chapter continuation for reflowable
  ebooks. Uses browser voices; navigation and closing the reader stop playback.
  [Usage and browser limits](docs/read-aloud.md)

---

## 👥 Accounts & security

- ⬜ **Single sign-on** with OpenID Connect (Authelia, Authentik, Keycloak): Kavita and Komga
  have it, and it's the most-requested feature for shared servers
- ⬜ **Two-factor authentication** (TOTP) for the admin account
---

## 🛠️ Platform

- ⬜ **Publish the Docker image** to a registry (GitHub Container Registry) from CI, for `docker pull`


---

## Home & activity

- ✅ **Customizable home**: per-account section visibility and ordering, optional
  welcome banner and shortcuts, compact cards, and shelf sorting by title, author,
  or reading progress.
- ✅ **Unified activity center**: downloads, uploads, library scans, automatic
  metadata matching, search indexing, and stored backups, with progress, filters,
  durable history, and supported retry/cancel controls.
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

- ⬜ **Sync conflict inbox** with per-device status and pending offline changes.
- ⬜ **Metadata review inbox** with proposed changes and batch approval.
- ⬜ **Command palette** for navigation and common actions.
- ⬜ **Backup health and restore preview** with archive validation.
- ⬜ **Offline policies** for storage budgets, pinned books, and cleanup.
- ⬜ **System diagnostics** with permissions, watcher and integration health.
- ⬜ **Edition and format grouping** with preferred editions and independent positions.
