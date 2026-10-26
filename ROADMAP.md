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

### Follow series for new chapters (3 of 5 done)
- ✅ **Follow** button in Content Finder, scheduled checks (`FOLLOW_CHECK_HOURS`), auto-download
  into the chosen library, an Updates list (*Following*) and a *New chapters* shelf on Home
- ✅ **Watch my downloads**: downloaded series are matched to their source (by id, or by title for
  older downloads) and newer chapters are reported
- ✅ Webhook event `series.updated`, push notifications and the notifications bell
- ⬜ **Follow from the series page** for series that came from Content Finder
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

### Search inside a book (1 of 2 done)
- ✅ Search in the reader (`/` or Ctrl+F) for EPUB, MOBI/AZW3, FB2, TXT/DOCX/RTF and text PDFs,
  with matches in context, grouped by chapter or page, and jump-to
- ⬜ Library-wide full-text search with SQLite FTS5 (Calibre-Web and Kavita do metadata
  search; full text would set Flyleaf apart)

---

## 📖 Reader (0 of 11 done)

- ⬜ **Text-to-speech / read aloud** with the Web Speech API: highlight the current sentence,
  a speed control and a sleep timer (Readest and KOReader have it)
- ⬜ **Dictionary and lookup** on selected text: built-in definitions, Wikipedia, and
  "translate selection" (KOReader, Readest, Apple Books)
- ⬜ **Auto-crop page borders** for scanned comics and PDFs (KOReader, Mihon)
- ⬜ **Image filters** for manga: brightness, contrast, greyscale and invert, plus colour
  correction for yellowed scans (Mihon's custom filter)
- ⬜ **Proper pinch and double-tap zoom** inside the page reader, not just the browser's own
  zoom, with pan and reset (Mihon, Panels)
- ⬜ **Auto-scroll** for webtoon mode with adjustable speed
- ⬜ **Chapter end screen**: "Next chapter" with a cover preview instead of just turning the page
- ⬜ **Smart dual-page**: detect wide pages and show them alone, keep spreads aligned
  (Kavita, Mihon)
- ⬜ **Footnote pop-ups** in EPUBs instead of jumping to the notes page
- ⬜ **Custom fonts**: upload your own TTF/OTF next to the bundled ones
- ⬜ **Export highlights and notes** as Markdown, CSV, or to Readwise / Obsidian

---

## 🗂️ Library & organisation (0 of 8 done)

- ⬜ **Smart filters / saved searches**: save a filter (genre + status + unread, …) as a shelf
  on Home or in the drawer (Kavita's Smart Filters, Komga's saved filters)
- ⬜ **Reading lists across series**: import **ComicRack `.cbl`** files for comic events in
  reading order (Kavita, Komga)
- ⬜ **Duplicate detection**: the same book in two formats or two libraries, with a merge or
  delete option
- ⬜ **Missing volumes or chapters**: show gaps in a series ("Volumes 1–4, 6 · 5 is missing")
- ⬜ **Bulk edit**: select many series and set genres, tags, age rating or collection in one go
- ⬜ **Watch folders for changes** instead of rescanning every `SCAN_INTERVAL_MINUTES`, so new
  files show up within seconds
- ⬜ **Calibre library import**: read `metadata.db` to bring over series, tags, ratings and covers
- ⬜ **Audiobooks** (M4B / MP3 folders) with a player and synced progress, the way Audiobookshelf
  does it, or at least pair an audiobook with its ebook

---

## 👥 Accounts & security (0 of 5 done)

- ⬜ **Single sign-on** with OpenID Connect (Authelia, Authentik, Keycloak): Kavita and Komga
  have it, and it's the most-requested feature for shared servers
- ⬜ **Two-factor authentication** (TOTP) for the admin account
- ⬜ **Failed-login alerts** in the admin panel (login rate limiting is already built in)
- ⬜ **Activity log**: who logged in, downloaded or deleted what, and when
- ⬜ **Per-user storage quota** for personal folders

---

## 📊 Stats & social (4 of 5 done)

- ✅ **Reading goals**: a yearly books goal and a daily minutes goal, with progress rings
- ✅ **Year in review**, with a shareable summary card
- ✅ **Streaks** (current and longest) and a reading-time heat map
- ✅ **Ratings and reviews** per series, visible to other users on the server
- ⬜ **Pages-per-year goal** as well as books

---

## 🛠️ Platform (5 of 8 done)

- ✅ **Docker image** and `docker-compose.yml` (the built-in Mihon runtime runs inside the container)
- ✅ **OPDS 2.0** (JSON) feeds at `/api/opds/<key>/v2`, next to OPDS 1.2
- ✅ **Web push notifications** for new chapters, finished/failed downloads, new books, sign-ups
  and uploads
- ✅ **Backup and restore from the UI**: database only, or database and books, also on the setup page
- ✅ **Health and metrics endpoints** (`/api/health`, Prometheus at `/api/metrics`)
- ⬜ **Translations (i18n)**: move the UI strings into message files so the community can translate them
- ⬜ **Publish the Docker image** to a registry (GitHub Container Registry) from CI, for `docker pull`
- ⬜ **Scheduled backups**: keep the last N backups automatically, optionally on another disk
