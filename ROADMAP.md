# Roadmap

Features other self-hosted readers have that Flyleaf doesn't yet, plus a few improvements of
our own. The comparison is with **Kavita**, **Komga**, **Calibre-Web**, **Mihon / Suwayomi**,
**KOReader**, **Readest** and **Audiobookshelf**.

Items are grouped by how much they'd matter to readers, not by how easy they are.

✅ Done · ⬜ Not started yet. A section heading gets ✅ once everything in it is done.

---

## 🔥 High impact

### Sync with tracking sites (0 of 3 done)
Mihon, Kavita and Komga (via plugins) can push reading progress to **AniList**, **MyAnimeList**,
**MangaUpdates** and **Kitsu**. Flyleaf already matches series to AniList, MAL and MangaUpdates
for metadata, so the series IDs are already there.
- ⬜ Per-user OAuth connection in *Settings → Account*
- ⬜ Update the chapter/volume count and status (Reading / Completed) when a book is finished
- ⬜ Optionally pull the score and status back in

### Follow series for new chapters (4 of 5 done)
- ✅ **Follow** button in Content Finder, scheduled checks (`FOLLOW_CHECK_HOURS`), auto-download
  into the chosen library, an Updates list (*Following*) and a *New chapters* shelf on Home
- ✅ **Watch my downloads**: downloaded series are matched to their source (by id, or by title for
  older downloads) and newer chapters are reported
- ✅ Webhook event `series.updated`, push notifications and the notifications bell
- ✅ **Follow from the series page** for series that came from Content Finder, with an
  auto-download switch and the chapters downloading right now
- ⬜ **Per-source schedules** (some sources update hourly, others weekly)

### Real offline reading in the web app (3 of 4 done)
- ✅ *Save for offline* on a book, *Save next 3 for offline* on a series (Cache Storage)
- ✅ Progress made offline is queued and sent when the connection comes back
- ✅ A *Saved offline* page with storage usage; the app opens there when there's no connection
- ⬜ **Auto-save the next unread chapter** of whatever you're reading

### KOReader and Kobo sync (0 of 2 done)
- ⬜ A **kosync-compatible endpoint** (like Kavita and Calibre-Web), so KOReader progress syncs
  both ways with the web reader, not only through OPDS-PSE
- ⬜ **Kobo sync** (Komga, Kavita and Calibre-Web have it): the Kobo store API that lets a Kobo
  e-reader sync a shelf and reading progress straight from the server

### ✅ Search inside a book (2 of 2 done)
- ✅ Search in the reader (`/` or Ctrl+F) for EPUB, MOBI/AZW3, FB2, TXT/DOCX/RTF and text PDFs,
  with matches in context, grouped by chapter or page, and jump-to
- ✅ Library-wide full-text search with SQLite FTS5: *Inside books* on the search page, with
  snippets; a result opens the book at that chapter with the matches shown

---

## 📖 Reader (11 of 13 done)

- ⬜ **Text-to-speech / read aloud** with the Web Speech API: highlight the current sentence,
  a speed control and a sleep timer (Readest and KOReader have it)
- ✅ **Dictionary and lookup** on selected text: built-in definitions, Wikipedia, and
  "translate selection" (KOReader, Readest, Apple Books)
- ✅ **Auto-crop page borders** for scanned comics and PDFs (KOReader, Mihon)
- ✅ **Image filters** for manga: brightness, contrast, greyscale and invert, plus colour
  correction for yellowed scans (Mihon's custom filter)
- ⬜ **Proper pinch and double-tap zoom** inside the page reader, not just the browser's own
  zoom, with pan and reset (Mihon, Panels)
- ✅ **Book look**: paper pages with edges, a spine and grain, or an E-ink look, for ebooks, comics
  and PDFs (Apple Books, Kindle)
- ✅ **Book page turns**: pages swing over on the spine in 3D, with the next page on the back of
  the turning leaf in two-page spreads
- ✅ **Auto-scroll** for webtoon mode with adjustable speed (play/pause in the reader menu or `P`,
  `-`/`=` for speed; touching the screen pauses it)
- ✅ **Chapter end screen**: "Next chapter" with a cover preview instead of just turning the page
- ✅ **Smart dual-page**: detect wide pages and show them alone, keep spreads aligned
  (Kavita, Mihon)
- ✅ **Footnote pop-ups** in EPUBs instead of jumping to the notes page
- ✅ **Custom fonts**: upload your own TTF/OTF next to the bundled ones
- ✅ **Export highlights and notes** as Markdown, CSV, or to Readwise / Obsidian

---

## 🗂️ Library & organisation (7 of 8 done)

- ✅ **Smart filters / saved searches**: save a filter (genre + status + unread, …) as a shelf
  on Home or in the drawer (Kavita's Smart Filters, Komga's saved filters)
- ✅ **Reading lists across series**: import **ComicRack `.cbl`** files for comic events in
  reading order (Kavita, Komga)
- ✅ **Duplicate detection**: identical files, the same book in two formats or libraries, and the
  same volume or chapter twice; keep one copy and merge everyone's reading data into it
- ✅ **Missing volumes or chapters**: gaps shown on the series page ("Volumes 1–4, 6 · missing 5")
- ⬜ **Bulk edit**: select many series and set genres, tags, age rating or collection in one go
- ✅ **Watch folders for changes** instead of rescanning every `SCAN_INTERVAL_MINUTES`, so new
  files show up within seconds
- ✅ **Calibre library import**: `metadata.db` brings over titles, series, tags, descriptions,
  identifiers, covers and ratings, again whenever it changes
- ✅ **Audiobooks** (M4B / M4A / MP3 / OGG / OPUS / FLAC, a folder of tracks = one book) with a
  player (chapters, speed, sleep timer, lock-screen controls), synced progress and offline
  listening; an audiobook with the same title and author joins its ebook's series

---

## 👥 Accounts & security (3 of 5 done)

- ⬜ **Single sign-on** with OpenID Connect (Authelia, Authentik, Keycloak): Kavita and Komga
  have it, and it's the most-requested feature for shared servers
- ⬜ **Two-factor authentication** (TOTP) for the admin account
- ✅ **Failed-login alerts** in the admin panel: failed sign-ins by address and account name,
  blocked addresses with *Unblock*, and a notification after 5 wrong passwords
- ✅ **Activity log**: who logged in, downloaded or deleted what, and when (with CSV export)
- ✅ **Per-user storage quota** for personal folders, plus server-wide storage limits (largest
  upload, free space to keep on the disk)

---

## ✅ 📊 Stats & social (5 of 5 done)

- ✅ **Reading goals**: a yearly books goal and a daily minutes goal, with progress rings
- ✅ **Year in review**, with a shareable summary card
- ✅ **Streaks** (current and longest) and a reading-time heat map
- ✅ **Ratings and reviews** per series, visible to other users on the server
- ✅ **Pages-per-year goal** as well as books

---

## 🛠️ Platform (7 of 9 done)

- ✅ **Docker image** and `docker-compose.yml` (the built-in Mihon runtime runs inside the container)
- ✅ **OPDS 2.0** (JSON) feeds at `/api/opds/<key>/v2`, next to OPDS 1.2
- ✅ **Web push notifications** for new chapters, finished/failed downloads, new books, sign-ups
  and uploads
- ✅ **Backup and restore from the UI**: database only, or database and books, also on the setup page
- ✅ **Health and metrics endpoints** (`/api/health`, Prometheus at `/api/metrics`)
- ✅ **Translations (i18n)**: message files in `public/locales`, a language setting, `npm run i18n`
  to extract strings, a [translator's guide](docs/translating.md) and a Spanish translation
- ✅ **Scheduled backups**: daily or weekly, keeping the newest N, optionally on another disk;
  stored backups can be downloaded, restored or deleted from the UI
- ⬜ **Translate the rest of the interface**: the main screens (navigation, Home, sign-in,
  settings navigation, reader controls) use `t()`; the other views still need wrapping
- ⬜ **Publish the Docker image** to a registry (GitHub Container Registry) from CI, for `docker pull`
