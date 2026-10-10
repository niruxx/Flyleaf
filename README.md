# Flyleaf

A self-hosted reader for your ebooks, manga and comics, with a Material 3 web interface that works on desktop and phones and installs to the iPhone home screen like an app.

- **Formats:** EPUB, PDF, CBZ/ZIP, CBR/RAR, and plain folders of images
- **Libraries:** point Flyleaf at folders on your machine. It indexes them, extracts covers and metadata (EPUB OPF, ComicInfo.xml, PDF info), groups manga and comics into series by sub-folder, and rescans automatically.
- **Readers:**
  - Manga/comics: single page, double-page spread, or vertical scroll (webtoon), right-to-left or left-to-right, fit to screen/width/original, tap zones, swipes and keyboard
  - EPUB: themes (paper, sepia, dark, black), text size, font, spacing, margins, paged or scrolling layout, table of contents
  - PDF: page rendering with outline
- **Progress and resume:** each user's last page is saved continuously. Home shows "Continue reading", and finishing a volume offers the next one in the series.
- **Reading stats:** active reading time (idle time isn't counted), daily chart, streaks, books finished, most-read titles
- **Accounts:** the first visit creates the **admin** account. The admin can add **guest** accounts that can browse and read (with their own progress) but can't change anything.
- **Dark/light mode** (or follow the system) plus selectable accent colours

## Requirements

- Node.js **22.13 or newer** (uses the built-in `node:sqlite`, so there are no native database builds)

## Run it

```bash
npm install
npm start
```

Open http://localhost:7878, create your admin account, then go to **Settings → Add library**. Pick a folder with the built-in folder browser or paste a path, and choose a type:

| Type   | Default reading direction | Series from                 |
| ------ | ------------------------- | --------------------------- |
| Books  | —                         | EPUB metadata (Calibre)     |
| Manga  | right-to-left             | sub-folder or ComicInfo.xml |
| Comics | left-to-right             | sub-folder or ComicInfo.xml |

A typical manga layout:

```
Manga/
  One Piece/
    One Piece v01.cbz
    One Piece v02.cbz
  Some Webtoon/
    Chapter 1/   001.jpg 002.jpg …
```

Configuration is optional. Copy `.env.example` to `.env` to change the port, data directory, scan interval and so on. Everything Flyleaf stores (database, covers, caches) lives in `./data`, and your book files are never modified.

## iPhone / Android

1. Open Flyleaf in **Safari** on the phone.
2. Tap **Share → Add to Home Screen**.

It then launches full-screen with its own icon. The reader keeps the screen awake and respects the notch and home indicator.

> Offline app-shell caching (service worker) needs HTTPS, as browsers require. Everything else works over plain HTTP on your LAN.

## Sharing outside your network

1. In **Settings → Users**, add a guest account for each person.
2. Forward the Flyleaf port (default `7878`) on your router to this machine, and share `http://<your-public-ip>:7878` with them.

**Strongly recommended:** put Flyleaf behind HTTPS rather than exposing plain HTTP. Passwords and session cookies otherwise travel unencrypted. Easy options include Caddy (`caddy reverse-proxy --from books.example.com --to localhost:7878`), a Cloudflare Tunnel, or Tailscale. When you do, set `TRUST_PROXY=true` and `SECURE_COOKIES=true` in `.env`.

Built-in protections: scrypt-hashed passwords, HttpOnly SameSite session cookies, CSRF header checks, login rate limiting (10 failures per 15 minutes per IP), and guest accounts that are read-only on the server side.

## Maintenance

```bash
npm run reset-password -- admin 'new-password'   # if you get locked out
npm run dev                                       # auto-restart on code changes
npm run icons                                     # regenerate app icons (needs sharp)
```

Removing a file from disk marks it as missing, and its progress is kept in case the drive comes back. Use **Settings → Library ⋮ → Remove missing files** to purge those entries.

## Project layout

```
server/            Express API (Node, node:sqlite)
  index.js         app bootstrap, static files
  db.js            schema & migrations
  auth.js          sessions, password hashing, guards
  scanner.js       library indexing & metadata jobs
  archive.js       CBZ / CBR / image-folder page access
  metadata.js      EPUB / PDF / ComicInfo parsing
  routes/          auth+users, library+books, progress+stats
public/            front end (no build step, plain ES modules)
  css/m3.css       Material 3 tokens & components
  js/views/        home, library, book, stats, settings, auth
  js/reader/       page engine (comics/PDF), EPUB engine, time tracker
```

A native app could use the same JSON API under `/api` later.
