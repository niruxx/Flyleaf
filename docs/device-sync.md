# KOReader and Kobo

Open **Settings → API & webhooks** and create a separate **Full access** API key
for each device. Deleting or regenerating that key revokes the device. Device
requests respect library access, age restrictions and API access permissions.
Kobo additionally requires download permission.

## KOReader

In KOReader's **Progress sync** plugin, set the custom server to
`https://your-flyleaf-server/api/kosync`. Log in with your Flyleaf username and
use the **API key as the password**. Create the account in Flyleaf first; the
KOReader Register button does not create Flyleaf accounts.

Use identical original files on the server and device. Both KOReader's default
partial-file checksum and its filename checksum are recognized. Renaming a file
changes the filename checksum. Repacked or converted files can have different
binary checksums. Files not matched to an accessible library book return 404.

Page-based PDF/comic books synchronize page position in both directions.
KOReader ebook progress resumes in the web reader by percentage. For the return
trip, KOReader requires an engine-specific XPointer, not an EPUB CFI or a
percentage. Flyleaf retains up to 500 positions sent by KOReader and returns the
nearest known position to the web reader's percentage. This is approximate and
requires an initial push from KOReader; without one, the server returns 409.
Exact arbitrary ebook position conversion remains unfinished.

The endpoint implements `GET /users/auth`, `PUT /syncs/progress`, and
`GET /syncs/progress/:document`. Authentication uses KOReader's `x-auth-user`
and `x-auth-key` headers; the latter contains the MD5 of the API key, as generated
by KOReader. Account passwords are never converted to or stored as MD5.

Protocol references: [KOReader sync plugin](https://github.com/koreader/koreader/tree/master/plugins/kosync.koplugin)
and [KOReader file checksum](https://github.com/koreader/koreader/blob/master/frontend/util.lua).

## Kobo (experimental)

1. Create a collection and add the series you want on the Kobo.
2. Select it under **Settings → API & webhooks → Kobo shelf**. Only EPUB files
   in this owned collection are offered. Selecting **Sync disabled** stops
   offering files and removes prior entitlements on the next incremental sync.
3. Connect the Kobo over USB and back up `.kobo/Kobo/Kobo eReader.conf`.
4. In its `[OneStoreServices]` section, set
   `api_endpoint=https://your-flyleaf-server/api/kobo/YOUR_FULL_ACCESS_KEY`.
5. Safely eject the Kobo and run its sync.

The endpoint provides initialization, device authentication, EPUB metadata and
downloads, cover images, a collection tag, incremental entitlements and removed
entitlements, plus reading-state GET/PUT. Sync tokens are opaque and scoped to
the API key. Unknown tokens restart a full sync. Files removed from the shelf
or no longer accessible are removed from subsequent incremental results.

Kobo progress updates the same progress used by the web reader; the web reader
resumes ebooks by percentage. Native Kobo bookmark locations are returned only
while they correspond to the latest shared progress; a later web save clears
the stale location in the response and exports the new percentage.

This implementation has automated protocol-route tests but has **not been
validated on a physical Kobo**. Firmware compatibility, shelf editing from the
device, large-library pagination, and precise conversion between native Kobo
locations and web EPUB CFIs remain to be validated or implemented. There is no
proxy to the commercial Kobo store. Restore the original configuration to
return to the store.

Protocol reference: [Calibre-Web Kobo integration](https://github.com/janeczku/calibre-web/wiki/Kobo-Integration).

## Source schedules and automatic offline reading

Under **Content Finder → Following**, open a series' menu → **Source schedule**.
The interval applies to all of your follows on that source. Enter hours (`1`
hourly, `168` weekly), or `0` to pause automatic checks. The API accepts `null`
to restore the server's `FOLLOW_CHECK_HOURS` default. A five-minute scheduler
checks which follows are due; **Check now** bypasses the interval.

Opening a book automatically saves the next unread chapter in that series on
this device. Saved chapters are reused. Disable this under **Saved offline**.
Automatic caching requires HTTPS or localhost, an online connection, Cache
Storage and service workers; it skips connections reporting data saver. Errors
are reported in a snackbar without interrupting reading. Explicit saves remain
available. Reading-list navigation caches its immediate unread successor.

## Bulk editing

On a series grid, choose **Select series**, select individual entries or all
loaded entries, then **Edit selected**. Add the selection to a collection you
own. Admins can also replace genres, tags and age ratings; only checked fields
change. An empty checked genre/tag list clears that field. Shared metadata is
locked against future scanner/provider updates, just like individual edits.
Up to 500 series can be changed in one transaction. Invalid or inaccessible
entries reject the entire batch.
