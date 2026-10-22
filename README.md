<div align="center">

<img src="public/icons/icon-192.png" width="96" alt="Flyleaf logo" />

# Flyleaf

**Your self-hosted library for books, manga and comics — with a beautiful Material 3 reader that works in any browser and installs like an app on your iPhone.**

![Node.js 22.13+](https://img.shields.io/badge/node-%E2%89%A522.13-3c873a?logo=node.js&logoColor=white)
![Material 3](https://img.shields.io/badge/design-Material%203-6750a4?logo=materialdesign&logoColor=white)
![PWA](https://img.shields.io/badge/iPhone-web%20app-000000?logo=apple&logoColor=white)
![OPDS](https://img.shields.io/badge/OPDS-1.2%20%2B%20PSE-e86f2b)
![License: MIT](https://img.shields.io/badge/license-MIT-blue)

<img src="docs/screenshots/hero.png" alt="Flyleaf on desktop and iPhone" width="100%" />

</div>

## ✨ Features

<table>
<tr>
<td width="50%" valign="top">

### 📚 Every format you own
- **Ebooks:** EPUB · KEPUB · MOBI · AZW · AZW3 · FB2 · PDF · **DOCX · RTF** · TXT
- **Comics & manga:** CBZ · ZIP · CBR · RAR · CB7 · 7Z · CBT · TAR · plain image folders
- Comic archives are **read in place**: pages come straight out of the CBZ/CBR/CB7/CBT, so nothing is unpacked to disk (solid RAR included)
- Archives are identified by their *contents*, so a `.cbr` that's really a zip still works
- DOCX, RTF and TXT open in the ebook reader with chapters, highlights and notes
- Reads **ComicInfo.xml**, EPUB/Calibre metadata, MOBI EXTH and FB2 headers

### 📖 Readers built for reading
- **Manga & comics:** single page, **dual-page spreads**, **webtoon / continuous scroll**, **right-to-left**, fit screen/width/height/original, **page splitting** for double-page scans, custom background colour
- **Ebooks:** paginated or scrolling, 1–2 columns, themes (Paper, Sepia, Dark, OLED Black), **font family**, size, line spacing, margins, justification & hyphenation
- **Tap to paginate**, swipe, **immersive mode**, **auto-close menu**, fully **customisable key binds**
- **Reading profiles** – save a set of reader settings and assign it to libraries or series

### ✍️ Built-in annotations
- **Highlights** in five colours plus underline, with **notes**
- **Bookmarks** for any page in any format
- A **Bookmarks & notes** page that gathers everything across your library, sorted by newest, oldest, book title or position in the book

</td>
<td width="50%" valign="top">

### 🗂️ Organised your way
- Choose **Regular books** (each book stands alone; series only from embedded metadata), **Kavita-style** (series from file names & metadata) or **Komga-style** (every folder is a series) per library
- **Want to read**, **custom collections**, personal **reading status** & **tags**, **genres**, people pages
- **Related series** (sequels, spin-offs…), age ratings, publication status
- Sort by **title A–Z / Z–A**, **author**, date added, last read, year or last updated, with an **A–Z jump bar**
- **Search that ranks**: exact titles first, words matched from their start (so “it” doesn't find *Kitchen*), accents ignored
- **More like this** on every series page and in each book's Details, from shared genres, tags and creators
- **Recommended for you** on Home: picks from what you read, finish and save, each with a reason (“Because you finished *Berserk*”)
- **Discover in Content Finder**: the same taste searched on your Content Finder sources, so suggestions include books you don't have yet, one tap from downloading

### 🔎 Metadata & artwork
- Scrape from **AniList · MangaDex · MyAnimeList · MangaUpdates · ComicVine · Open Library · Google Books**
- Optional **automatic matching** of new series, including artwork
- Full **metadata editor** – titles, summary, genres, tags, writers & artists, links to MAL/AniList and others, custom artwork
- **Blur artwork** per series for NSFW covers (and auto-blur 18+)

### 🌐 Share & sync
- **Admin + read-only guest accounts** – share over the internet with port forwarding
- Per-user **progress, resume, reading time & stats** and **reading lists**
- Per-user **age limits**, **library access** and **permissions** (downloads, uploads, Content Finder, deleting books, API keys)
- **Delete books** from the ⋮ menu: users can delete books in their own libraries and ones they downloaded, never other books in shared libraries
- **Personal folders**: give a user their own folder on the server, with **private libraries** that their downloads and uploads go into
- **OPDS 1.2 + OPDS-PSE** for Panels, Chunky, KOReader, Moon+ … with progress sync
- **Send to Kindle / Kobo** by email, download single books or whole series

### ⬆️ Upload from any device
- An **Upload** tab: drag and drop files or whole folders, pick the library and folder (or create one), and optionally add the new series to a collection
- Live per-file progress, uploads keep going if you switch pages, and the library rescans when they finish

### 🧭 Content Finder & plugins
- A **Content Finder** tab that searches **Project Gutenberg**, **Standard Ebooks**, the **Internet Archive**, **Archive of Our Own** (fan fiction), **WEBTOON** and any **OPDS catalog**, and downloads straight into a library
- **Lua plugins**, Mihon/Tachiyomi-style: install from repositories, URLs or files, or [write your own](docs/plugins.md)
- **Mihon/Tachiyomi extensions** through a built-in, Flyleaf-managed [Suwayomi-Server](https://github.com/Suwayomi/Suwayomi-Server) (or your own): every extension becomes a source, chapters download as CBZ, and old Tachiyomi **APKs can be installed from a file**

### 🔌 REST API & webhooks
- A full **REST API** with read-only or full-access **API keys**, plus an **OpenAPI 3.1** spec and a built-in endpoint reference
- **Signed webhooks** for new books, finished books, progress, downloads and scans

### 🎨 Feels like an app
- Material 3 throughout: **9 themes** + any custom colour, light/dark/auto
- **Colorscape** – series pages tint themselves from their artwork
- **Profile pictures** and a personal **background** – your own picture, animated GIF or image link, with dim, blur and fit controls
- Smooth, direction-aware **page transitions**, skeleton loading, scroll-in reveals, 3D cover tilt, a circular dark-mode reveal and springy controls (or turn them all off)
- **Book details** for every file: format, pages, size, location, ISBN, publisher, your reading time and an estimate of time left, plus a detailed list view for volumes
- **iPhone/Android web app** – full-screen, home-screen icon, safe-area aware

</td>
</tr>
</table>

---

## 🆕 What's new

- 📜 **WEBTOON downloads** – a WEBTOON source for Content Finder: search Originals and Canvas, download episodes as CBZ, and they open in webtoon (vertical scroll) mode.
- 🧭 **Discover in Content Finder** – recommendations from outside your library: Flyleaf searches your Content Finder sources for the authors and genres you like and suggests what you don't have yet. Pick which sources it uses in *Settings → Preferences*.
- 🧩 **One-click Mihon repositories** from [wotaku.wiki](https://wotaku.wiki/ext/mihon) and [Yūzōnō](https://yuzono.github.io/extensions), support for Mihon's newer `index.pb` repositories (Keiyoushi's full 1,400+ extensions) on Suwayomi v2.3+, and pasted `mihon://` links just work.
- 💡 **Recommendations** – a *Recommended for you* shelf on Home (and a full page) built from your own reading, plus *You might also like* in every book's Details. It all runs on your server, with no AI service or account needed.
- 🖼️ **Make it yours** – profile pictures, and a per-user background picture or GIF behind the whole app (*Settings → Themes → Background*).
- 🔎 **Better search & sorting** – ranked search results, title A–Z / Z–A and author sorts with an A–Z jump bar, bookmark sorting, and **More like this** recommendations on series pages.
- 🔗 **Share links that work at home** – *Send to… → Copy home-network link* gives the server's LAN address (like `http://192.168.1.20:7878`) instead of whatever address your browser used; *Copy internet link* uses your Public URL.
- 🏷️ New genres, libraries and collections appear in the side menu without reloading.
- 📁 **Personal folders** – the admin can give each user a folder on the server. They create private libraries in it, and their Content Finder downloads and uploads go only there.
- ⬆️ **Upload tab** – drag and drop books, comics or whole folders into any library folder from your phone or computer, with live progress, and add the new series straight to a collection.
- ℹ️ **Book details** – a Details panel for every file (format, pages, size, location, ISBN, publisher, your reading time and time left), a detailed list view for volumes, and more facts on series pages.
- ✨ **Smoother motion** – direction-aware page transitions, skeleton loading, scroll-in reveals, 3D cover tilt, a circular dark-mode reveal, and closing animations for dialogs, menus and sheets.
- 🧩 **Mihon/Tachiyomi extensions** through Suwayomi-Server, and the **Content Finder** with Lua plugins.
- 🔌 **REST API & webhooks**, **DOCX/RTF** support, comic archives **read in place**, and per-guest **library access & permissions**.

## 📸 Screenshots

<table>
<tr>
<td colspan="2"><img src="docs/screenshots/desktop-home.png" alt="Home" /><p align="center"><b>Home</b> – continue reading, want to read, collections & genres in the drawer</p></td>
</tr>
<tr>
<td width="50%"><img src="docs/screenshots/desktop-library.png" alt="Library" /><p align="center"><b>Library</b> – filters, genres, sort, ⋮ actions on every card</p></td>
<td width="50%"><img src="docs/screenshots/desktop-series-dark.png" alt="Series overview" /><p align="center"><b>Series overview</b> – artwork, creators, links, status, tags, volumes</p></td>
</tr>
<tr>
<td><img src="docs/screenshots/desktop-reader-ebook.png" alt="Ebook reader with highlights" /><p align="center"><b>Ebook reader</b> – highlights, notes & a selection toolbar</p></td>
<td><img src="docs/screenshots/desktop-reader-settings.png" alt="Manga reader settings" /><p align="center"><b>Manga reader</b> – layout, direction, scaling, page splitting</p></td>
</tr>
<tr>
<td><img src="docs/screenshots/desktop-themes.png" alt="Themes" /><p align="center"><b>Themes</b> – presets or any colour you like</p></td>
<td><img src="docs/screenshots/desktop-add-library.png" alt="Add library" /><p align="center"><b>Add library</b> – Regular books, Kavita or Komga folder structure</p></td>
</tr>
<tr>
<td><img src="docs/screenshots/desktop-finder.png" alt="Content Finder" /><p align="center"><b>Content Finder</b> – search every plugin source at once</p></td>
<td><img src="docs/screenshots/desktop-finder-details.png" alt="Content Finder details" /><p align="center"><b>Download</b> – pick a format and a library</p></td>
</tr>
</table>

<table>
<tr>
<td><img src="docs/screenshots/mobile-home.png" alt="Phone – home" /></td>
<td><img src="docs/screenshots/mobile-series.png" alt="Phone – series" /></td>
<td><img src="docs/screenshots/mobile-drawer.png" alt="Phone – navigation drawer" /></td>
<td><img src="docs/screenshots/mobile-ebook-settings.png" alt="Phone – ebook settings" /></td>
</tr>
</table>

<details>
<summary><b>More screenshots</b></summary>

| | |
|---|---|
| ![Search](docs/screenshots/desktop-search.png) | ![Card actions](docs/screenshots/desktop-actions.png) |
| ![Bookmarks](docs/screenshots/desktop-bookmarks.png) | ![Stats](docs/screenshots/desktop-stats.png) |
| ![Preferences](docs/screenshots/desktop-preferences.png) | ![OPDS](docs/screenshots/desktop-opds.png) |
| ![Manga reader](docs/screenshots/desktop-reader-manga.png) | ![Home (dark)](docs/screenshots/desktop-home-dark.png) |

</details>

> The screenshots use a generated demo library – the series, authors and covers are made up.

---

## 🚀 Installation

### Option 1 — One-command install (recommended)

Works on **Fedora / RHEL**, **Debian / Ubuntu** and **Arch** (plus derivatives). It installs everything, sets up a **systemd service that starts on boot**, and prints the address to open.

```bash
git clone https://github.com/niruxx/Flyleaf.git
cd Flyleaf
sudo ./install.sh
```

Then open **http://localhost:7878** (or `http://<server-ip>:7878` from your phone) and create your admin account.

<details>
<summary><b>What install.sh does</b></summary>

| Step | Details |
|---|---|
| 📦 Packages | `git`, `curl`, `tar`/`xz` via **dnf**, **apt** or **pacman** |
| 🟢 Node.js | Uses the system Node if it's ≥ 22.13, otherwise downloads the official build (checksum-verified) to `/opt/flyleaf-runtime` |
| 📁 App | A git checkout in `/opt/flyleaf` (so `update.sh` can pull updates) |
| 💾 Data | Database, covers and logs in `/opt/flyleaf_data` – kept separate from the code |
| ⚙️ Config | `/etc/flyleaf/flyleaf.env` |
| 🔁 Service | `flyleaf.service`, enabled at boot, runs as **the user who ran sudo** so it can read your home folders |
| 🔥 Firewall | Optionally opens the port in `firewalld` or `ufw` |
| 🧰 CLI | A `flyleaf` command: `status`, `logs`, `restart`, `update`, `allow-write`, `reset-password`, `uninstall` |
| 🧾 Manifest | Everything is recorded in `/etc/flyleaf/install.manifest` for a clean uninstall |

Options: `--port 8080`, `--user someone`, `--dir /srv/flyleaf`, `--data /srv/flyleaf-data`, `--yes` (no prompts).

</details>

### Option 2 — Run it yourself

Requires **Node.js 22.13 or newer**.

```bash
git clone https://github.com/niruxx/Flyleaf.git
cd Flyleaf
npm install
npm start          # → http://localhost:7878
```

### 🔄 Updating

```bash
flyleaf update        # installed with install.sh (same as: sudo /opt/flyleaf/update.sh)
./update.sh           # a manual checkout
```

`update.sh` pulls the latest code, backs up the database first (the last five backups are kept in the data folder under `backups/`), reinstalls dependencies and restarts the service. If anything fails it rolls back to the previous version. Your database, covers and settings are never touched.

### 🗑️ Uninstalling

```bash
flyleaf uninstall                             # asks before deleting your data
sudo /opt/flyleaf/uninstall.sh --keep-data    # keep the database & covers
```

This removes the service, app files, Node runtime, config, firewall rule and system user created by the installer. It asks before removing packages the installer added. **Your book folders are never touched.**

---

## ⚙️ Configuration

### Environment

Set these in `/etc/flyleaf/flyleaf.env` (service install) or a `.env` file next to `package.json` (manual), then restart.

| Variable | Default | Description |
|---|---|---|
| `PORT` | `7878` | Port to listen on |
| `HOST` | `0.0.0.0` | Interface to bind (`127.0.0.1` = this machine only) |
| `FLYLEAF_DATA_DIR` | `./data` | Database, covers, caches and logs |
| `SCAN_INTERVAL_MINUTES` | `60` | Automatic rescans (`0` = only on start / manual) |
| `SESSION_DAYS` | `30` | How long sign-ins last |
| `TRUST_PROXY` | `false` | Set to `true` behind an HTTPS reverse proxy |
| `SECURE_COOKIES` | `false` | Set to `true` when served over HTTPS |
| `LOG_LEVEL` | `info` | Terminal verbosity: `debug`, `info`, `warn`, `error` |
| `MAX_UPLOAD_MB` | `4096` | Largest file the Upload page accepts |

> 🤫 **Quiet console.** The terminal only shows one line per scan and real errors. Everything else (unreadable files, metadata lookups, library noise) goes to `data/logs/flyleaf.log`.

### 📁 Libraries & folder structure

Add libraries in **Settings → Libraries**, using the built-in folder browser or by pasting a path. Pick the type (Books, Manga, Comics) and how series are detected:

<table>
<tr><th>🔤 Kavita style – file names</th><th>📂 Komga style – folders</th></tr>
<tr><td>

Series, volume and chapter come from the **file name** and embedded metadata. Folders don't matter.

```text
Manga/
├── One Piece v01.cbz
├── One Piece v02 (2003) [Group].cbz
├── Berserk - c372.cbr
└── random folder/
    └── Spy x Family 012.cbz
```
→ *One Piece* (2 vols), *Berserk*, *Spy x Family*

</td><td>

Every folder that contains books is **one series**, named after the folder. Nothing to parse and nothing to edit.

```text
Manga/
├── One Piece/
│   ├── 001.cbz
│   └── 002.cbz
└── Solo Leveling/
    ├── Chapter 1/   (images)
    └── Chapter 2/   (images)
```
→ *One Piece*, *Solo Leveling*

</td></tr>
</table>

📚 **Regular books** is the third option and the default for ebook libraries. Every book is its own entry with its own title, author and cover, whatever folders it sits in (Calibre's `Author/Title/` layout works as-is). Books only group together when their EPUB/Calibre metadata names a series, ordered by series index:

```text
Books/
├── Brandon Sanderson/
│   ├── The Final Empire (1)/The Final Empire.epub   ← series "Mistborn" #1 in metadata
│   └── Elantris (12)/Elantris.epub                  ← no series → standalone
└── Dune.epub
```
→ *Mistborn* (1 book), *Elantris*, *Dune*

Comics and manga default to Komga style. You can switch at any time and Flyleaf regroups on the next scan.

### 🔎 Metadata sources

| Source | Best for | Key needed? |
|---|---|---|
| **AniList** | Manga, light novels | No |
| **MangaDex** | Manga (lots of external links) | No |
| **MyAnimeList** | Manga | No (uses Jikan) · optional official Client ID |
| **MangaUpdates** | Manga, manhwa, manhua | No |
| **ComicVine** | Western comics | Yes – free at [comicvine.gamespot.com/api](https://comicvine.gamespot.com/api/) |
| **Open Library** | Books | No |
| **Google Books** | Books | Optional (avoids shared rate limits) |

- **Manual:** on a series page, open **Edit ▾ → Fetch metadata online**, pick a result and tick the fields to apply.
- **Automatic:** in **Settings → Libraries → Edit**, enable *Automatically fetch metadata & artwork*. Only confident title matches are applied.
- Anything you edit by hand is **locked**, so scans and auto-matching never overwrite it.

### 📡 OPDS & reading apps

1. **Settings → OPDS & clients → Create auth key**
2. Copy the **OPDS URL**: `https://your-server/api/opds/<key>`
3. Add it as a catalog in **Panels**, **Chunky**, **KOReader**, **Moon+ Reader**, **Thorium**…

Comics stream page-by-page (OPDS-PSE) and your position syncs back to Flyleaf. Toggle **Embed progress indicator** and **Include "Continue from" entry** to taste. Set a **Public URL** in *Settings → Server* if you use a domain.

### ℹ️ Book details

- **One file:** open **⋮ → Details** on any book or volume. You'll see:
  - your reading: when you started, time spent, reading days, an estimate of time left at your own pace, and highlight and bookmark counts;
  - the book: series, volume or chapter, writers and artists, publisher, year, language, genres and ISBN (linked to Open Library);
  - the file: name, format, size, date added and modified, library, and its full path (admin only).
- **A series:** the series page shows formats, total size and pages, your time spent reading, your notes, when it was added and (admin) its folder.
- **Volumes as a list:** use the **grid / list** toggle next to the volumes heading for one row per file with format, pages, size, date added and progress. Your choice is remembered.

ISBNs are read from EPUB, MOBI/AZW3 and ComicInfo (`GTIN`) metadata. Files added before this update get theirs when the file changes. To pick one up right away, an admin can open **⋮ → Edit volume → Re-read from file**; this replaces manual edits to that volume.

### ✨ Animations & effects

Pages slide in the direction you're navigating, while the top bar and menu stay put. Loading shows placeholder shapes instead of spinners, and content rises in as you scroll to it. Other touches:
- Covers sharpen as they load, then lift, tilt and catch a sheen when you hover with a mouse.
- The dark-mode toggle spreads the new theme out in a circle.
- Buttons and chips squish when pressed.
- Dialogs, menus and sheets animate both in and out.
- The bars turn translucent and blurred as you scroll.

Only transform and opacity are animated, so it stays smooth on phones. To turn it all off, use *Settings → Preferences → Disable animations*. Flyleaf also follows your device's **reduce motion** setting.

### ⬆️ Uploading

**Upload** (left menu) sends files from your phone or computer into a library:

1. Pick the **library** and **folder**; you can also create a new folder. Each library type gets a hint: in Komga-style libraries, put each series in its own folder.
2. Optionally choose a **collection**; the new series are added to it once they're scanned.
3. Drag in files, or a whole folder. A folder of images becomes one chapter, for example `Series/Chapter 1/001.jpg…`. You can also use **Choose files** or **Choose a folder**.

Supported: EPUB, KEPUB, MOBI/AZW3, PDF, DOCX, RTF, FB2, TXT, CBZ, CBR, CB7, CBT and images. The admin can always upload. Guests need **Upload** turned on in *Settings → Users*, and can only upload into libraries they can see. Existing files are never overwritten; a second copy gets a ` (2)` suffix. If Flyleaf runs as a service and the library is under `/home`, run `flyleaf allow-write /path/to/library` first.

Uploading from a script uses a **full-access** API key. Send each file as the raw request body, then finish the batch so the library rescans:

```bash
KEY=…; LIB=1
curl -X PUT -H "Authorization: Bearer $KEY" -H "Content-Type: application/octet-stream" \
  --data-binary @"Dune.epub" "http://localhost:7878/api/uploads/file?library=$LIB&folder=Frank%20Herbert&name=Dune.epub"
curl -X POST -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"libraryId":1,"files":["Frank Herbert/Dune.epub"]}' http://localhost:7878/api/uploads/done
```

### 🧭 Content Finder

**Content Finder** (left menu) searches the sources installed as plugins and downloads what you pick into one of your libraries. Flyleaf then rescans that library so the book appears straight away.

- **Built in:**
  - Project Gutenberg, Standard Ebooks and the **Internet Archive**, installed automatically.
  - **Archive of Our Own** and **WEBTOON**: install them from *Available from repositories*.
  - An **OPDS catalog** plugin for your own Calibre-Web/Kavita/Komga or another Flyleaf: set its URL under *Settings → Content Finder plugins → ⋮ → Settings*.
- **Internet Archive (archive.org):** searches the big library-digitised, public-domain collections by default (Library of Congress, university libraries, Smithsonian, Wellcome, Gutenberg…). Its settings can switch to *Everything downloadable*, which adds user uploads (only download what you're allowed to), show comics, or filter by language. Borrow-only lending-library books are never offered.
- **Archive of Our Own (AO3):** fan fiction, downloaded with AO3's own EPUB/AZW3/MOBI/PDF export.
  - **Ratings:** Mature and Explicit works are hidden until you turn on *Show Mature and Explicit works* in the plugin settings. Each work's rating carries over to Flyleaf (General → Everyone, Teen → 13+, Mature → 17+, Explicit → 18+), so guests' age restrictions apply to downloaded fics.
  - **Other settings:** filter by language and show only complete works.
- **WEBTOON (webtoons.com):** Originals and Canvas (fan-made) series. Pick episodes and each one downloads as a CBZ of the full vertical strip, into `<library>/<Series>/`. No Suwayomi needed.
  - **Opens as a webtoon:** downloaded series open in the reader's *Webtoon* (continuous scroll) layout for whoever downloaded them. Change it any time in the reader settings.
  - **Ratings:** titles WEBTOON marks as unsuitable for children are rated Mature (17+) in Flyleaf, so guests' age restrictions apply. *Hide titles marked unsuitable for children* hides them from results.
  - **Other settings:** language (en, es, fr, de, id, th, zh-hant) and whether to include Canvas.
  - Only episodes that are free on the site are listed; Daily Pass / Fast Pass episodes aren't. Without a search, Content Finder shows what's trending.
  - **Not available:** works limited to logged-in AO3 users.
  - **Speed:** AO3 is volunteer-run and can be slow when busy; Flyleaf waits up to 45 s per page.
- **More sources:** in *Settings → Content Finder plugins*, add a plugin **repository**, install from a **URL**, or **upload** a `.lua` file. Plugins are sandboxed Lua scripts with no access to your files. See **[docs/plugins.md](docs/plugins.md)** to write one.
- **Who can use it:** the admin always can. Turn it on for a guest in *Settings → Users → Edit → Content Finder*. Guests can only save into libraries they can see.
- **Running as a service:** the service can't write under `/home` (`ProtectHome=read-only`). To let downloads into a library folder there, run:

  ```bash
  flyleaf allow-write /home/you/Books
  ```

### 🧩 Mihon / Tachiyomi extensions

Mihon extensions are Android apps, which **[Suwayomi-Server](https://github.com/Suwayomi/Suwayomi-Server)** can run on a normal computer. Every extension you install appears as a source in Content Finder. Chapters download page by page into CBZ files with ComicInfo.xml, so they group and number correctly.

#### The easy way: Flyleaf's extension runtime

*Settings → Content Finder plugins → Mihon & Tachiyomi extensions → **Set up**.* Flyleaf downloads Suwayomi-Server and a Java 21 runtime ([Eclipse Temurin](https://adoptium.net)) into `data/suwayomi` (about 230 MB to download and 340 MB on disk, checksums verified; it uses around 500 MB of memory while running), runs it in the background on `127.0.0.1` only, starts and stops it with Flyleaf, restarts it if it crashes, and sets up the Mihon extensions plugin for you. Then press **Extensions** to add repositories and install extensions (step 3 below). From the card's ⋮ menu you can check for updates, set a memory limit, view its log, or remove it (optionally keeping your installed extensions). It needs `tar` on the server, which every Linux and macOS install has.

**Old Tachiyomi extensions (APKs):** press **Install APK** (on the card, or in the Extensions dialog) and pick one or more `.apk` files. That's handy for extensions that have disappeared from every repository. Very old extensions built for an extension API Suwayomi no longer supports are refused with an explanation.

#### Or run Suwayomi-Server yourself

**1. Run Suwayomi-Server** next to Flyleaf, for example with Docker:

```bash
docker run -d --name suwayomi -p 127.0.0.1:4567:4567 \
  -e KCEF_ENABLED=false -e AUTH_MODE=basic_auth -e AUTH_USERNAME=flyleaf -e AUTH_PASSWORD='choose-one' \
  -v suwayomi:/home/suwayomi/.local/share/Tachidesk \
  ghcr.io/suwayomi/suwayomi-server:stable
```

<details>
<summary>Without Docker (Java 21)</summary>

```bash
java -Dsuwayomi.tachidesk.config.server.kcefEnabled=false \
     -Dsuwayomi.tachidesk.config.server.webUIEnabled=false \
     -Dsuwayomi.tachidesk.config.server.authMode=basic_auth \
     -Dsuwayomi.tachidesk.config.server.authUsername=flyleaf \
     -Dsuwayomi.tachidesk.config.server.authPassword='choose-one' \
     -jar Suwayomi-Server-v2.x.jar
```
`kcefEnabled=false` matters on a server without a screen; otherwise Suwayomi downloads an embedded Chromium that can't start.
</details>

**2. In Flyleaf:** *Settings → Content Finder plugins → Available from repositories → Mihon extensions → Install*. Then open **Set up** and enter:
- the Suwayomi URL (`http://localhost:4567`) and the username and password you chose;
- the languages to show (`en`, `en,ja`…);
- whether to show NSFW sources.

**3. Add extensions:** press **Extensions**. Under **Popular repositories**, Flyleaf lists the Mihon repositories from the community list at [wotaku.wiki/ext/mihon](https://wotaku.wiki/ext/mihon), plus [Yūzōnō](https://yuzono.github.io/extensions); press **Add** next to one (Keiyoushi is the big one, with 1,400+ extensions). You can also paste any repository yourself: an `index.pb` or `index.min.json` URL, or a `mihon://` / `tachiyomi://` “add repo” link from a repository's website. Then install the extensions you want; each one appears in Content Finder straight away. Only add repositories you trust, for sources you're allowed to download from.

**Newer `index.pb` repositories need Suwayomi v2.3 or newer.** Mihon's newer repository format is a compressed `index.pb` file. Keiyoushi, Yūzōnō and FelipeGFA use it, and Keiyoushi's old `index.min.json` is now an empty “Outdated App” stub. Suwayomi v2.3+ reads `index.pb` itself (and follows Keiyoushi's old link to its new index). Older Suwayomi versions only accept GitHub `index.min.json` URLs and reject everything else, so:

| Your Suwayomi | `index.pb` links (Keiyoushi, Yūzōnō…) | GitHub `index.min.json` links |
|---|---|---|
| v2.3 or newer | ✅ | ✅ |
| v2.0 – v2.2 | ❌ update Suwayomi first | ✅ (Keiyoushi's is only a stub) |

The Extensions dialog shows which you have, greys out the repositories your Suwayomi can't use, and explains why if adding one fails. To update a Docker install: `docker pull ghcr.io/suwayomi/suwayomi-server:stable`, then recreate the container (your extensions and settings are kept in the volume).

Pasted a Mihon link into *Add repository* (the box for Flyleaf's own plugin repositories) by mistake? Flyleaf recognises `index.pb`, `index.min.json` and `mihon://` links there and adds them to Suwayomi instead.

Aniyomi (anime) repositories, such as Yūzōnō's anime store, are left out: they're for video, which Suwayomi and Flyleaf don't play.

The list is fetched live (and cached for a day), so new repositories on wotaku.wiki show up on their own. If the site can't be reached, Flyleaf falls back to a built-in copy.

> 💡 Keep Suwayomi private (`127.0.0.1` above, or a password). Flyleaf passes cover images through itself, so phones and remote guests never need to reach Suwayomi directly.

### 🔌 REST API & webhooks

Everything the web app does goes through the same REST API, so scripts can do it too.

1. **Settings → API & webhooks → Create API key**. A **read-only** key can only make GET requests. A **full-access** key can do anything its owner can.
2. Send it as a header:

```bash
curl -H "Authorization: Bearer <key>" http://localhost:7878/api/series?sort=added
```

The same page lists every endpoint (also served as an OpenAPI 3.1 spec at `/api/openapi.json`). The admin can add **webhooks** there too. Flyleaf POSTs JSON for `book.added`, `book.finished`, `progress.updated`, `library.scanned`, `download.completed`, `download.failed`, `upload.completed` and `user.created`, and signs every request with `X-Flyleaf-Signature: sha256=<HMAC>`.

### 📧 Send to Kindle / Kobo

1. Admin: **Settings → Server & email** – add SMTP details (Gmail app password, Fastmail, your provider…) and send a test.
2. Each user: **Settings → Send-to devices** – add your `@kindle.com` address.
3. For Kindle, approve the *From* address in Amazon's **Personal Document Settings**.

Then use **⋮ → Send to…** on any book or series.

### 🖼️ Profile pictures & backgrounds

- **Profile picture:** *Settings → Account → Upload*. It's cropped to a circle around the most interesting part of the picture, and shows in the top bar and the admin's user list.
- **Background:** *Settings → Themes → Background*. Upload a picture or animated GIF (up to 30 MB), or paste a link to one. **Dim** fades it into your theme so text stays readable, **Blur** softens it, and **Size** chooses fill, fit or tile. The bars and side menu turn frosted glass over it. Backgrounds are per user: no one else sees yours.

Pictures are stored in `data/avatars` and `data/backgrounds`. Large still images are resized to 2560 px for phones; GIFs are kept as they are.

### 🔎 Search, sorting & recommendations

- **Search** matches titles, alternative titles, book titles and creators. Every word you type has to start a word in the result, and results are ranked: exact title, then titles starting with your words, then everything else. Accents don't matter (*pokemon* finds *Pokémon*). Search results default to **Best match**; you can still sort them like any list.
- **Sorting:** *Title A–Z*, *Title Z–A* and *Author* ignore a leading “The”, “A” or “An”. While sorting by title, an **A–Z bar** jumps to a letter (“#” is numbers and symbols).
- **Recommended for you** (Home, and *See all*) learns from your reading: finished books count most, then books you're reading, time spent, series you marked *Completed*, *Reading*, *Plan to read* or *On hold*, and *Want to read*. *Dropped* series count against their genres. You never get suggestions for something you've already started, finished, dropped or saved, and each suggestion says which of your books it's based on. Until you've read anything, it shows what other people on the server read most. API: `GET /api/recommendations`.
- **Discover in Content Finder** (Home, and the bottom of *See all*) needs the Content Finder permission. Flyleaf takes your three favourite creators and two most distinctive genres or tags, searches your sources for them, drops anything already in your libraries (subtitles ignored, so *Frankenstein, or, The Modern Prometheus* counts as *Frankenstein*), puts books actually *by* those authors ahead of books *about* them, and mixes the sources so no single site fills the shelf. Tap a suggestion to open it in Content Finder, ready to download.
  - Configure it in *Settings → Preferences → Recommendations*: turn it off, or pick which sources to search. With none picked, Flyleaf chooses up to four that fit what you read and skips 18+ sources unless you allow them.
  - Searches run on the server and are cached for six hours per person (the first load takes a few seconds; *Search again* on the *See all* page refreshes it). API: `GET /api/finder/recommendations?refresh=1`.
- **More like this** at the bottom of a series page (and *You might also like* in a book's Details) suggests series you can see that share genres (rarer genres count more), tags, writers or artists, plus small boosts for the same publisher, type and era. It's also in the API: `GET /api/series/{id}/similar`.

### 👥 Users & sharing outside your network

- The first visit creates the **admin**. Add **guests** in *Settings → Users*. Guests can read, bookmark, highlight and keep their own progress, collections and stats, but can't change libraries, metadata or other users.
- Per guest, set an **age restriction** (Everyone / 13+ / 17+ / 18+), **which libraries** they see, and whether they may **download**, **upload**, use **Content Finder** or create **API keys**. Everything they can't see is hidden everywhere: the app, search, OPDS and the API.
- **Share links:** *Send to… → Copy home-network link* copies the server's address on your LAN, which works for anyone on your Wi-Fi even if you opened Flyleaf as `localhost` or through a public address. If you set a **Public URL** in *Settings → Server*, *Copy internet link* is offered too. (No home-network link is shown when Flyleaf only listens on `127.0.0.1`.)
- To share over the internet, **port-forward** the Flyleaf port on your router, or better, put it behind **HTTPS**:

```bash
# Caddy – automatic HTTPS
caddy reverse-proxy --from books.example.com --to localhost:7878
```

<details>
<summary>nginx example</summary>

```nginx
server {
  server_name books.example.com;
  client_max_body_size 4g;   # match MAX_UPLOAD_MB for the Upload page
  location / {
    proxy_pass http://127.0.0.1:7878;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
  }
  # listen 443 ssl; … (certbot)
}
```
</details>

Then set `TRUST_PROXY=true` and `SECURE_COOKIES=true`.

#### 🔐 Your libraries, shared libraries and users' libraries

The admin is a reader too. Every library has an owner, set under **Who it's for** when you add or edit it in *Settings → Libraries*:

| Who it's for | Who can see it |
|---|---|
| **Only me – private** *(default for new libraries)* | Just you |
| **Shared with users** | You, and the users you allow in *Settings → Users → Edit* |
| **A user's personal library** | Just that user (you can open it from *Settings → Libraries*) |

You can switch a library between these at any time; nothing on disk changes. Libraries created before this update stay **shared**, so nobody loses access. Edit one and choose *Only me* to make it private.

#### 📁 Personal folders & private libraries

Give a user a **personal folder** when they should have their own space instead of (or as well as) the shared libraries:

1. **Admin:** *Settings → Users → Edit* (or *Add guest*) → **Personal folder**. Type an absolute path, e.g. `/srv/flyleaf/alex`, or press *Browse the server*. Flyleaf creates the folder if it doesn't exist.
2. **The user** gets **My libraries** in the menu and in Settings. There they create libraries inside their folder (picking or creating a sub-folder, a type and a folder structure), and can rename, rescan or remove them. Removing one keeps its files.
3. **The admin** can also give someone a library directly: in *Settings → Libraries → Add library*, choose **Who it's for → (user) – their personal library**.

What a personal folder changes for that user:

| | Without a personal folder | With a personal folder |
|---|---|---|
| Libraries they see | Shared libraries you allow | Shared libraries you allow **plus their own** |
| Where **Content Finder downloads** go | Any library they can see | **Only their own libraries** |
| Where **uploads** go | Any library they can see | **Only their own libraries** |
| Their libraries visible to others | – | Never. Only the owner sees them, plus the admin in *Settings → Libraries* |

**Kept separate everywhere:**
- Users see **My libraries** and **Shared libraries** as two sections in the menu, on Home and in library pickers.
- Personal libraries never appear in anyone else's Home, *All series*, search, genres, menu or OPDS feed, and that includes the admin's own reading views.
- The admin manages them in *Settings → Libraries*, under **Users' libraries**, grouped by user. Click one there to look inside. The same page lists your own private libraries under **My libraries**, and shared ones under **Shared libraries**.

The two folder settings work separately. *Settings → Users → Edit → libraries* picks which **shared** libraries a user can read, and the **personal folder** is where their own files go. Deleting a user removes their personal libraries from Flyleaf but leaves the files on disk. Users can't reach anything outside their folder: paths with `..` stay inside it, and libraries can't overlap.

If Flyleaf runs as a service and the folder is under `/home`, allow writes first: `flyleaf allow-write /home/…/alex`. Cloudflare Tunnel and Tailscale Funnel work too.

🔒 Built in: scrypt password hashing, HttpOnly SameSite cookies, CSRF protection, login rate limiting, and server-side read-only enforcement for guests.

### 📱 iPhone & Android

Open Flyleaf in **Safari**, then tap **Share → Add to Home Screen**. It launches full-screen with its own icon, keeps the screen awake while you read and respects the notch. On Android, use *Install app* in Chrome. Offline app-shell caching needs HTTPS. Everything else works over plain HTTP on your LAN.

---

## 🧰 Troubleshooting

| Problem | Fix |
|---|---|
| A library shows **0 items** | The service user must be able to read the folder: `sudo -u <user> ls /path/to/library` |
| **Port already in use** | Change `PORT` in the config and restart |
| **Forgot the admin password** | `flyleaf reset-password admin 'new-password'` (manual install: `npm run reset-password -- admin 'new-password'`) |
| Service status / logs | `flyleaf status` · `flyleaf logs` · `/opt/flyleaf_data/logs/flyleaf.log` |
| A file won't open | Check the log. Damaged archives are skipped during scans and listed there. |
| Metadata source errors | Some sources rate-limit. Wait a minute or add an API key in *Settings → Metadata sources*. |
| Upload fails with **can't write** or **out of disk space** | Run `flyleaf allow-write /path/to/library`, make sure the service user can write there, and check free space with `df -h` |
| A user's personal folder **can't be created** | Create it yourself and give the service user access (`sudo chown <service user>: /srv/flyleaf/alex`; the service user is shown by `flyleaf status`), and for folders under `/home` run `flyleaf allow-write` |
| Upload rejected as **too large** | Raise `MAX_UPLOAD_MB` in `/etc/flyleaf/flyleaf.env`, then `flyleaf restart`. A reverse proxy may have its own limit (nginx: `client_max_body_size`) |
| Content Finder download says it **can't write** | Run `flyleaf allow-write /path/to/library`, and make sure the service user can write there |
| **Mihon extensions** source says it can't reach Suwayomi | Check the URL in the plugin settings from the Flyleaf server (`curl http://localhost:4567/api/v1/settings/about`). If Suwayomi's log ends with a Chromium/`libcef` crash, start it with `kcefEnabled=false` (`KCEF_ENABLED=false` in Docker) |

---

## 🛠️ Under the hood

- **Server:** Node.js + Express 5, built-in `node:sqlite` (no native database to compile), `sharp` for thumbnails
- **Front end:** plain ES modules, no build step, hand-built Material 3 design tokens (OKLCH); motion uses the View Transitions API, IntersectionObserver and CSS transforms
- **Readers:** [foliate-js](https://github.com/johnfactotum/foliate-js) for EPUB/MOBI/FB2, [pdf.js](https://mozilla.github.io/pdf.js/) for PDF, and a custom engine for comics and webtoons
- **Archives (read in place):** yauzl (zip), node-unrar-js WASM (rar, in memory), 7-Zip streaming (7z), a tar indexer (tar)
- **Documents:** mammoth (DOCX), a built-in RTF reader, both converted to EPUB on the fly and cached
- **Plugins:** Lua 5.4 via [wasmoon](https://github.com/ceifa/wasmoon) (WebAssembly sandbox), node-html-parser for scraping; Mihon extensions through [Suwayomi-Server](https://github.com/Suwayomi/Suwayomi-Server)

```text
server/          API, scanner, metadata providers, OPDS
public/          the web app (no build step)
  css/           Material 3 tokens, layout, reader
  js/views/      pages
  js/reader/     page & text engines, tracker
install.sh       update.sh       uninstall.sh
```

## 🙏 Credits

[foliate-js](https://github.com/johnfactotum/foliate-js) (MIT) · [pdf.js](https://github.com/mozilla/pdf.js) (Apache 2.0) · [Material Symbols](https://fonts.google.com/icons) (Apache 2.0) · [Roboto Flex, Literata, Merriweather, Atkinson Hyperlegible, OpenDyslexic](https://fontsource.org) (OFL) · metadata from AniList, MangaDex, MyAnimeList/Jikan, MangaUpdates, ComicVine, Open Library and Google Books.

<div align="center">

Made with 📖 and ☕ · MIT licensed

</div>
