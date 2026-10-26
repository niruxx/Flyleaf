# Changelog

What's new in each version of Flyleaf. After an update, everyone sees the newest entries once
in a small "What's new" card, and the whole list is under *What's new* in the account menu.

How to write an entry: add a `## [version] – YYYY-MM-DD` heading at the top (and bump
`version` in `package.json`), an optional one-line summary, then `### Added`, `### Changed` or
`### Fixed` with one bullet per change. Start a bullet with **the feature in bold** and say what
it does for readers in a sentence – that's what shows up in the card.

## [2.7.0] – 2026-10-26

Make it feel like a real book.

### Added
- **Book look** – white paper pages with a little grain, page edges, a shadow along the spine and the book resting on a dark table – for ebooks, comics and PDFs alike (*Reader settings → Look*).
- **E-ink look** – a calm grey screen with crisp black text and greyscale pictures, like an e-reader.
- **Book page turns** – pages swing over on their spine in 3D, and in two-page spreads the next page is printed on the back of the turning leaf (*Reader settings → Page turn*: Slide, Book or None).

## [2.6.0] – 2026-10-26

Look words up while you read, and cleaner scans.

### Added
- **Look up** – select a word or phrase in an ebook and tap the dictionary button for a definition, a Wikipedia summary or a translation, without leaving the page.
- **Auto-crop borders** – blank margins around scanned comic and PDF pages are trimmed so the art fills the screen (*Reader settings → Image*).
- **Image filters** – brightness, contrast, greyscale and an invert night mode for comics and manga, plus *Whiten yellowed pages* to turn old, yellowed paper white again.

## [2.5.0] – 2026-10-26

Footnotes that pop up, your own fonts, and your highlights wherever you keep notes.

### Added
- **Footnote pop-ups** – tap a footnote or endnote marker in an ebook and the note opens right there, with *Go to note* to jump to it.
- **Your own fonts** – everyone can upload .ttf, .otf, .woff or .woff2 fonts in *Settings → EPUB fonts*; they're private to you. The admin can still share fonts with everyone.
- **Export highlights & notes** – from *Bookmarks & notes*, as Markdown, a spreadsheet, an Obsidian vault (one note per book) or a Readwise import file – or send them straight to Readwise.
- **What's new** – this card. After an update you'll see what changed, and the full list is in the account menu.

## [2.4.0] – 2026-10-26

Shelves, reading lists and a better reader.

### Added
- **New files show up within seconds** – library folders are watched, so copied, renamed and deleted files appear without waiting for a scan.
- **Smart shelves** – save any set of filters (unread + ongoing + a genre…) as a shelf on Home and in the side menu.
- **Reading lists** – read across series in order, with *Next* following the list. Import and export ComicRack **.cbl** files.
- **Pages-per-year goal** – a page goal next to your books goal; comic pages count as you turn them, ebook pages are estimated.
- **Webtoon auto-scroll** – press play (or P) and the strip scrolls by itself at one of ten speeds; touch to pause.
- **Chapter end screen** – after the last page, the next volume or chapter with its cover; turn the page again to carry on.
- **Smart double pages** – wide two-page scans are shown on their own and the pages after them stay paired correctly.

## [2.3.0] – 2026-10-26

For admins: who did what, failed sign-ins and storage limits.

### Added
- **Activity log** – *Settings → Activity* shows who signed in, downloaded, uploaded or deleted what, and when, with a CSV export.
- **Failed sign-in alerts** – failed sign-ins by address and account, unblocking, and a notification when someone keeps guessing.
- **Storage limits** – a quota for each personal folder, the largest upload, and free disk space to keep.
- **Follow from the series page** – series from Content Finder get a *New chapters* panel with an auto-download switch and live downloads.

## [2.2.0] – 2026-10-26

Audiobooks, searching inside every book, and tidier libraries.

### Added
- **Search inside every book** – the search page also finds words inside EPUB, FB2, TXT, DOCX, RTF and text PDFs.
- **Audiobooks** – M4B, M4A, MP3, OGG, OPUS and FLAC with chapters, speed, a sleep timer and synced progress.
- **Calibre libraries** – titles, series, tags, covers and ratings come along from a Calibre folder.
- **Duplicates** – find identical files and the same book in several places, and merge everyone's progress.
- **Missing volumes** – series pages show gaps like “Volumes 1–4, 6 · missing 5”.
- **Scheduled backups** – daily or weekly, keeping the newest few, optionally on another disk.
- **Translations** – a language setting and a Spanish translation of the main screens.

## [2.1.0] – 2026-10-25

Follow series, read offline and search inside a book.

### Added
- **Follow series** – Flyleaf checks followed series for new chapters and can download them for you.
- **Notifications bell** – new chapters, finished downloads and more, on desktop and phone.
- **Read offline** – save books on your device and keep reading without a connection.
- **Search inside a book** – find every match in the book you're reading.

## [2.0.0] – 2026-10-25

A fresh look, reading goals and a lot more.

### Added
- **New design** – an ambient look across the app, a richer Home and new sign-in pages.
- **Reading goals & year in review** – yearly and daily goals, streaks and a shareable year card.
- **Ratings & reviews** – rate and review series for everyone on your server.
- **Backup & restore**, **push notifications**, a **Docker image**, **OPDS 2.0** and **health & metrics** endpoints.
