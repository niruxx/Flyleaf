# Roadmap

Features other self-hosted readers have that Flyleaf doesn't yet, plus a few improvements of
our own. The comparison is with **Kavita**, **Komga**, **Calibre-Web**, **Mihon / Suwayomi**,
**KOReader**, **Readest** and **Audiobookshelf**.

Items are grouped by how much they'd matter to readers, not by how easy they are.

---

## 🔥 High impact

### Sync with tracking sites
Mihon, Kavita and Komga (via plugins) can push reading progress to **AniList**, **MyAnimeList**,
**MangaUpdates** and **Kitsu**. Flyleaf already matches series to AniList, MAL and MangaUpdates
for metadata, so the series IDs are already there.
- Per-user OAuth connection in *Settings → Account*
- Update the chapter/volume count and status (Reading / Completed) when a book is finished
- Optionally pull the score and status back in

### Follow series for new chapters
Mihon and Suwayomi's main loop is "Library updates": check followed series for new chapters
and download them automatically. Flyleaf's Content Finder downloads on demand only.
- **Follow** button on series downloaded through Content Finder or Mihon sources
- Scheduled check, auto-download into the same library, and an **Updates** feed on Home
- Webhook event `series.updated` (fits the existing webhooks)

### Real offline reading in the web app
The service worker only caches the app shell. Readest, Mihon and Komga's apps let you
**download books to the device** to read on a plane.
- "Make available offline" for a book or the next N chapters (Cache Storage / IndexedDB)
- Queue progress updates while offline and sync them when the connection comes back
- Storage usage and a "Remove downloads" list in Settings

### KOReader and Kobo sync
- A **kosync-compatible endpoint** (like Kavita and Calibre-Web), so KOReader progress syncs
  both ways with the web reader, not only through OPDS-PSE
- **Kobo sync** (Komga, Kavita and Calibre-Web have it): the Kobo store API that lets a Kobo
  e-reader sync a shelf and reading progress straight from the server

### Search inside a book
There's no way to search the text of an ebook. foliate-js already supports search, so this is
mostly UI work.
- Search panel in the ebook reader, with results in context and jump-to
- Later: library-wide full-text search with SQLite FTS5 (Calibre-Web and Kavita do metadata
  search; full text would set Flyleaf apart)

---

## 📖 Reader

- **Text-to-speech / read aloud** with the Web Speech API: highlight the current sentence,
  a speed control and a sleep timer (Readest and KOReader have it)
- **Dictionary and lookup** on selected text: built-in definitions, Wikipedia, and
  "translate selection" (KOReader, Readest, Apple Books)
- **Auto-crop page borders** for scanned comics and PDFs (KOReader, Mihon)
- **Image filters** for manga: brightness, contrast, greyscale and invert, plus colour
  correction for yellowed scans (Mihon's custom filter)
- **Proper pinch and double-tap zoom** inside the page reader, not just the browser's own
  zoom, with pan and reset (Mihon, Panels)
- **Auto-scroll** for webtoon mode with adjustable speed
- **Chapter end screen**: "Next chapter" with a cover preview instead of just turning the page
- **Smart dual-page**: detect wide pages and show them alone, keep spreads aligned
  (Kavita, Mihon)
- **Footnote pop-ups** in EPUBs instead of jumping to the notes page
- **Custom fonts**: upload your own TTF/OTF next to the bundled ones
- **Export highlights and notes** as Markdown, CSV, or to Readwise / Obsidian

---

## 🗂️ Library & organisation

- **Smart filters / saved searches**: save a filter (genre + status + unread, …) as a shelf
  on Home or in the drawer (Kavita's Smart Filters, Komga's saved filters)
- **Reading lists across series**: import **ComicRack `.cbl`** files for comic events in
  reading order (Kavita, Komga)
- **Duplicate detection**: the same book in two formats or two libraries, with a merge or
  delete option
- **Missing volumes or chapters**: show gaps in a series ("Volumes 1–4, 6 · 5 is missing")
- **Bulk edit**: select many series and set genres, tags, age rating or collection in one go
- **Watch folders for changes** instead of rescanning every `SCAN_INTERVAL_MINUTES`, so new
  files show up within seconds
- **Calibre library import**: read `metadata.db` to bring over series, tags, ratings and covers
- **Audiobooks** (M4B / MP3 folders) with a player and synced progress, the way Audiobookshelf
  does it, or at least pair an audiobook with its ebook

---

## 👥 Accounts & security

- **Single sign-on** with OpenID Connect (Authelia, Authentik, Keycloak): Kavita and Komga
  have it, and it's the most-requested feature for shared servers
- **Two-factor authentication** (TOTP) for the admin account
- **Failed-login alerts** in the admin panel (login rate limiting is already built in)
- **Activity log**: who logged in, downloaded or deleted what, and when
- **Per-user storage quota** for personal folders

---

## 📊 Stats & social

- **Reading goals**: books or pages per year, with a progress ring on the stats page
- **Year in review**: a shareable summary card for the year
- **Streaks** and a reading-time heat map
- **Ratings and reviews** per series, visible to other users on the server (Kavita)

---

## 🛠️ Platform

- **Official Docker image** and a `docker-compose.yml` with Suwayomi alongside. Every other
  server in this list ships one, and it's the expected install method for self-hosters
- **OPDS 2.0** (JSON) feeds next to OPDS 1.2, for newer reading apps
- **Translations (i18n)**: get the UI strings ready for community translations
- **Web push notifications** for new chapters, finished downloads and invites
- **Backup and restore from the UI**: download a backup with the database and settings,
  restore it during setup (today it's only `update.sh` making automatic backups)
- **Health and metrics endpoint** (`/api/health`, Prometheus) for people who monitor their servers
