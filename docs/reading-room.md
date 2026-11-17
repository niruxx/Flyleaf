# Your reading room

Flyleaf now connects choosing a read, protecting your place in a series, and keeping
what the experience leaves with you. These features work with your existing library
and personal reading data; they do not call an AI service or an outside recommendation API.

## Fits tonight

Open **Fits tonight** in the navigation menu or Home shortcuts. Choose the time you
have and a format. Flyleaf shows the next unread item in each series that is estimated
to fit, prioritizing books you have started and series on Want to read. An item is a
whole ebook, PDF, audiobook, comic volume, or separately stored chapter file; this
does not estimate individual chapters inside an EPUB.

Estimates use indexed text, known page counts, or an embedded audio duration. Books
without a reliable length are left out rather than guessed from compressed file size.
Text estimates start at roughly 250 words a minute (six characters per word), comics
at two pages a minute, and PDFs at one page a minute. Once a format category has at
least five pages and five minutes of measured reading, Flyleaf uses your aggregate
pace, with bounds to keep navigation jumps from producing extreme results.

Audio estimates use the selected listening speed; the player’s saved speed is
independent. In Anything mode the estimate assumes 1× speed. Multi-track audiobooks
without a known total duration are currently omitted. All estimates are approximate,
and the page explains whether each one uses your pace, a typical pace, or audio duration.

## Spoiler-safe series browsing

Enable **Settings → Preferences → Spoiler-safe series browsing**, or use **Protect
future titles and covers** above a series’ volumes. Titles and covers after the
current item are replaced with neutral placeholders. After finishing an item, the
next one becomes visible. A new series shows its first item. Deliberately starting a
later item moves the visible frontier forward, using the series’ existing reading order.

**Reveal** shows one item for the current visit without marking it read. **Read**
opens it directly. Individual reveals survive switching between grid and list views
during that visit. Placeholder HTML contains neither the real title nor its cover
image URL. The download picker uses a neutral label for protected items. Unstarted
series summaries require an explicit reveal when this preference is enabled.

This protects the series browsing view. It is not a restriction on access to the
book, a filter on full-text search results, or automatic detection of spoilers in
reviews, annotations, external catalogs, and the book itself.

## Private reading journal

Open **Reading journal** in the navigation menu, Home shortcuts, or Reading stats.
Choose a month to see reading days and highlights saved in that month. Add reflections
with an optional book and mood. Reflections are separate from shared reviews: the
API and interface only expose the signed-in account’s entries. Existing library and
age restrictions still apply to linked books and their activity.

You can also choose **Reflect** in a book’s Details dialog, or **Add a private
reflection** under the reader’s Contents & annotations panel. Reflection dialogs
work in fullscreen. Saving, editing, and deleting require a server connection;
failed saves leave your text in the form so you can retry.

**Export month** downloads a Markdown file containing that month’s reading days,
reflections, and saved highlights. The journal shows up to 500 highlights per month;
use Bookmarks & notes for broader annotation exports. Reading-day dates follow the
date sent by the reader; highlight boundaries follow your browser’s local calendar.
Existing daily logs appear immediately—Flyleaf does not invent historical sessions
or reflections. Deleting a book keeps its reflections as general entries.

## E-ink interface

Enable **Settings → Preferences → E-ink interface** for a monochrome, high-contrast
interface with quiet backgrounds, no interface animations, and instant page turns.
It applies across the app and the readers. The mode is saved to your account; your
previous theme, animation preference, reading profiles, and per-series reader
settings remain available when you turn it off. Reader display overrides are
temporary, so changing a font size does not save e-ink’s page-turn or paper settings
into your normal profile.

This is a browser display mode. It cannot control a physical e-reader’s refresh
waveforms, eliminate hardware ghosting, or guarantee compatibility with old browsers.

## Reading positions and sync recovery

Choose **Reading positions** in a book’s Details dialog. The history captures
position changes from progress writes, including supported device sync, and shows
the latest observed Kobo and KOReader position times when available. Plain heartbeats
without a changed location do not create additional history.

Choose **Restore** to make a saved position and read status current. Restoring does
not add reading time, and the position it replaces remains in history. Only your own
accessible books can be restored. A changed file revision or a concurrent progress
update requires a refresh instead of silently overwriting it. Close other active
readers before restoring: a later save from another device can still replace the
restored position. Native anchor observations are retained for device interoperability.

History begins with the current position when this feature is installed and records
subsequent changes. It keeps up to 100 positions per book and 10,000 per account.
File compatibility uses Flyleaf’s modification-time revision. This is recovery
history and recent native-position information; a full per-device sync/conflict
inbox and pending offline-change dashboard remain future work.

## Verification

```sh
node tests/reading-room.test.cjs
node --experimental-vm-modules tests/reading-room-client.test.cjs
node --experimental-vm-modules tests/frontend-modules.test.cjs
node tests/reader-sheet.test.cjs
node tests/ebook-navigation.test.cjs
```

With the fictional screenshot server and a disposable Chromium profile listening
on port 9233, `node scripts/check-reading-room.cjs` checks desktop and phone views,
reflection create/delete, spoiler reveal, e-ink toggling, and the recovery dialog.
Images go to `data/ui-checks/`. Backend checks cover permissions, input bounds,
reading-order selection, retention, and restoration conflicts. Live-server smoke
verification also covers indexing a real TXT file, estimation, journal CRUD, and
restoring progress without increasing recorded reading time.
