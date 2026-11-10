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
Valid EPUB XPointers convert into web CFIs, allowing the web reader to resume
at the corresponding text position. For the return trip, Flyleaf converts a
saved web EPUB CFI into a normalized KOReader XPointer
using the original EPUB package, spine and chapter markup. This supports new
positions within chapters without an initial KOReader push; range CFIs use their
start. The response retains the latest shared percentage and timestamp.

FB2 positions use the same pinned Foliate converter as the web reader, isolated
in bounded background workers. Source text is mapped into Foliate sections in
both directions, including nested inline markup, notes bodies, poem verses and
declared legacy encodings. Text that cannot be mapped safely uses the native
anchor fallback. This still requires CREngine/device validation.

Other ebook formats, percentage-only progress, unreadable EPUBs and unresolvable
CFIs fall back to the nearest of up to 500 positions previously sent by KOReader.
That fallback reports the anchor's percentage, and returns 409 if no anchor exists.
Publisher whitespace overrides and differences in CREngine's rendered DOM can
affect conversion; inline `white-space` overrides explicitly use the fallback.
Conversion targets current CREngine spine ordering (including non-linear items).
Older device DOM versions, publisher CSS and physical-device behavior still need
validation. MOBI conversion is limited to the supported legacy layouts described below.

Legacy MOBI6 now supports two-way text mapping through the pinned Foliate reader,
including UTF-8, uncompressed/PalmDOC-compressed records, nested inline markup
and pagebreak-based sections. Mapping requires exact agreement between original
text runs and Foliate's section documents. Files with filepos/NCX anchors, tables,
preformatted blocks or publisher whitespace styles retain native-anchor fallback:
CREngine may alter their DOM differently. Cached binary-checksum bindings are
revalidated so replacing a file cannot silently bind the old digest to a new edition.

Pure KF8/AZW3 is not assigned invented native pointers. CREngine's
[MOBI importer explicitly notes that it does not support KF8](https://github.com/koreader/crengine/blob/master/crengine/src/pdbfmt.cpp).
Hybrid/KF8 files and unsupported structures therefore retain observed-native-anchor
fallback. Use an identical EPUB on both clients for the supported EPUB position path.

Implementation reference: [CREngine EPUB spine assembly](https://github.com/koreader/crengine/blob/master/crengine/src/epubfmt.cpp)
and [normalized XPointers and text offsets](https://github.com/koreader/crengine/blob/master/crengine/src/lvtinydom.cpp).

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
the API key. Responses contain at most 100 change records. `x-kobo-sync: continue`
asks for another page with the returned `x-kobo-synctoken`. Checkpoints record only
delivered entries, support retries, expire after 24 hours and retain at most 128
tokens per key. Each page rechecks access. Unknown tokens restart a full sync.
Files removed from the shelf
or no longer accessible are removed from subsequent incremental results.

Devices can create, rename and delete owned collections, and add or remove
individual books. Web collections still supply the base series membership;
device edits are stored as per-book inclusions/exclusions. Removing one device
book therefore leaves its series siblings alone. These overrides also apply to
the selected delivery collection. Collection tags contain only books offered by
that collection. Deleting it stops delivery until another collection is selected.
Other users' collections cannot be edited; invalid batches make no partial changes.

Ordinary EPUBs get a separate cached `.kepub.epub` rendition with native Kobo
sentence spans and reading-flow containers. Originals stay byte-for-byte intact,
including their KOReader checksums. Existing Kobo span IDs are preserved. A
sidecar maps each span back to a CFI in the original EPUB. Web progress exports
the corresponding native span, and device progress imports its original CFI.
Kobo resumes at sentence/span granularity, rather than arbitrary character offsets.

Download URLs identify the rendition revision. A changed source file gets a new
rendition; old URLs return 409 and require another sync. Successfully completed
downloads record the revision per API key. Incoming native spans from an outdated
or unrecorded rendition do not become positions in the current edition; percentage
progress remains available. Statistics-only updates preserve the reading position.
Metadata and reading-state GETs support up to 100 comma-separated entitlement IDs.
Progress PUTs support the same batches: each ReadingState must identify its
requested EntitlementId. Single-book requests can omit that field. All entries
are authorized, validated and converted before one database transaction writes
the batch. Invalid or duplicate IDs reject the batch without partial writes.

Reflowable chapters use derived stylesheets that adapt explicit body-child and
body-descendant selectors to the pagination wrappers using universal selector
steps, preserving publisher specificity. Stylesheet imports retain their media
conditions and relative resource paths. Each chapter gets its own derivatives,
allowing class/ID/attribute selectors to be adapted when they uniquely identify
that chapter's body. The same class on a normal element in another chapter is
left alone. Ambiguous or dynamic selectors are not guessed. Fixed-layout chapters
keep their original, unchanged stylesheets. Inline rules receive the same adjustment.
Derived CSS files are declared in the EPUB manifest; generated resource URLs
encode special path characters. Legacy cover metadata is normalized to the Kobo
cover-image property while preserving the original book.
Unreadable/unsupported EPUBs fall back to original EPUB downloads and percentage
progress. Fixed-layout declarations and per-spine layout overrides are honored:
fixed-layout chapters are left byte-identical, without inserted flow wrappers or
text spans. Image-only/SVG-only chapters are also preserved unchanged. Mixed
content retains SVG/MathML markup, links, tables, ruby and language/direction
attributes. UTF-16 and declared legacy XML encodings are decoded before mapping;
modified chapters are emitted as UTF-8 with matching XML declarations.

This implementation has automated protocol-route tests but has **not been
validated on a physical Kobo**. Firmware compatibility, publisher styling and
non-text/fixed-layout rendering still need validation. There is no
proxy to the commercial Kobo store. Restore the original configuration to
return to the store.

Protocol reference: [Calibre-Web Kobo integration](https://github.com/janeczku/calibre-web/wiki/Kobo-Integration).

## Compatibility validation

The roadmap remains partial until the missing format conversions and client
validation are complete. Automated tests establish server behavior, not full
compatibility with every firmware or CREngine DOM version.

Run the regression checks with:

```sh
node tests/library-sync.test.cjs
node tests/kosync-position.test.cjs
node tests/kepub.test.cjs
node tests/kepub-rendering.test.cjs
node tests/kepub-css.test.cjs
node tests/fb2-position.test.cjs
node tests/mobi-position.test.cjs
```

Before marking either integration complete, record client/firmware versions and
results for these checks:

1. KOReader: log in, push and pull PDF/comic pages and EPUB positions in both
   directions, including Unicode, nested markup, publisher whitespace styles
   and an older saved DOM version. Verify key revocation and restricted books.
2. Kobo: sync more than 100 books, interrupt and resume, download an ordinary
   EPUB, and verify covers, layout, text selection and bookmarks on the device.
3. Read in the web reader and sync to Kobo, then read on Kobo and sync back.
   Confirm the actual sentence reached, as well as the displayed percentage.
4. Create/rename/delete a shelf and add/remove a single book among siblings in
   the same series. Verify that unrelated books and other users' shelves remain intact.
5. Replace a source EPUB after downloading it. Confirm that a resync downloads
   the new rendition and that old native spans are not applied to the new edition.

The structural corpus checks nested preformatted markup, RTL Arabic/Hebrew,
bidirectional text, CJK/ruby, emoji, footnotes, tables, SVG, MathML, prefixed XML
namespaces, UTF-16, Windows-1251 and mixed fixed/reflowable layouts. It validates
output XML with an independent XML parser, verifies text/resource preservation
and exercises position round trips. These checks do not compare rendered pixels
or establish firmware compatibility. Ambiguous/dynamic publisher selectors,
fixed-layout appearance, DRM-protected titles and guarded MOBI/KF8 layouts remain
validation/implementation gaps. FB2 and supported MOBI6 have converter and route-level
tests but are not yet verified against a real CREngine client.

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
