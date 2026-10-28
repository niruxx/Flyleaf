# Tracking accounts

Connect AniList, MyAnimeList, MangaUpdates and Kitsu from **Settings -> Account -> Tracking accounts**.
Connections belong to the signed-in Flyleaf user. Other users cannot see or use their tokens.

## Server setup

For AniList and MyAnimeList, register an application with each service and set these environment
variables before starting Flyleaf:

```dotenv
TRACKING_BASE_URL=https://reader.example.com
ANILIST_CLIENT_ID=...
ANILIST_CLIENT_SECRET=...
MAL_CLIENT_ID=...
MAL_CLIENT_SECRET=...
```

Register these exact redirect URLs, replacing the origin with your own:

- AniList: `https://reader.example.com/api/tracking/anilist/callback`
- MyAnimeList: `https://reader.example.com/api/tracking/mal/callback`

`TRACKING_BASE_URL` is the external origin, without a subpath, query or fragment. HTTPS is required;
`http://localhost:7878` is supported for development. For a reverse proxy, set `TRUST_PROXY=true`
and configure the proxy to forward the original HTTPS protocol. MyAnimeList's client secret can
be omitted for a public application; confidential web applications should supply it.

Kitsu's documented OAuth password grant and MangaUpdates' session login do not need application
keys. Enter the tracker username/email and password in the connection dialog over HTTPS. Flyleaf
exchanges those credentials for a token and does not save the password. These services do not use
the browser authorization-code flow used by AniList and MyAnimeList.

Tokens are stored in the server database and included in database backups, like other account
credentials. They are never returned by the account API. Disconnecting removes the local token,
invalidates pending authorizations and cancels queued delivery. It keeps existing tracker entries.
Use the tracker's own account settings to revoke authorization there too if needed.

## Progress and completion

When a book finishes in the reader, or is marked read, Flyleaf queues updates for connected services.
Marking a whole series read queues one update per connected service. Delivery runs in the background,
survives restarts, respects rate-limit retry timing and retries service failures. Account settings
show pending updates, the last successful sync and connection errors. Use Refresh to check again.
Expired MAL and Kitsu tokens are refreshed automatically when a refresh token is available; revoked
connections or expired MangaUpdates/AniList sessions may require Reconnect.

Only exact metadata provider IDs or recognized numeric tracker links are used; titles are never
guessed. MangaDex metadata imports also retain Kitsu IDs. If a series does not sync, check its
metadata match/links and the volume/chapter numbers in the book editor. Legacy MangaUpdates slugs
must be replaced with a numeric provider ID. Specials, missing files and unnumbered books do not
advance tracker counts.

- The highest finished chapter/volume number advances progress; it is not the number of local files.
  Skipped earlier chapters are not inferred as locally finished. Chapter fractions are rounded down
  because these trackers use integer progress.
- A chapter with a volume number does not mean that the entire volume has been read. Only volume
  files without chapter numbers advance the volume count.
- Remote progress never moves backwards. Reading the last currently downloaded file does not itself
  complete an ongoing series. Known tracker totals determine completion; an already completed entry
  remains completed. MangaUpdates exposes a latest chapter rather than a final count, so that value
  is used only when its series record says publication is complete.
- Kitsu exposes chapter progress and **volumes owned**, not volumes read. Flyleaf updates chapter
  progress and status there and leaves ownership unchanged. Volume-only files cannot establish a
  Kitsu chapter count.
- Sync targets manga list entries; these services do not provide a general audiobook/ebook tracker.

Connecting does not backfill all existing reading history or immediately write to your tracker.
The next book completion for a matched series sends the finished progress available for that series.

## Optional score and status import

**Import score and status** queues an import of matched, accessible series from the selected service.
The confirmation explains that it replaces local ratings and reading statuses. It does not change
book positions, finished flags, review text, spoiler settings or other users' data. An unrated or
missing remote entry leaves the local rating unchanged. Scores are normalized to the local half-star
scale (1..10); finer-grained remote scores are rounded to the nearest half star.

**Import score and status after sync** enables the same import after a successful progress update.
It is off for new/reconnected accounts. If several services are enabled, the most recently processed
service supplies the local values. Choose one source when their ratings/statuses disagree.

## API references

- [AniList authorization code flow](https://docs.anilist.co/guide/auth/authorization-code)
- [AniList list mutations](https://docs.anilist.co/reference/mutation)
- [MyAnimeList authorization](https://myanimelist.net/apiconfig/references/authorization)
- [MyAnimeList API](https://myanimelist.net/apiconfig/references/api/v2)
- [MangaUpdates API](https://mangaupdates.apidocumentation.com/)
- [Kitsu authentication](https://hummingbird-me.github.io/api-docs/)
- [Kitsu library entry schema](https://github.com/hummingbird-me/api-docs/blob/master/apiary.apib)

## Validation

Run `node tests/tracking.test.cjs` and `node tests/tracking-providers.test.cjs`. These use an in-memory
copy of the real migrations and mocked upstream responses; they never contact or update real accounts.
Live connection testing needs the server's registered OAuth applications and consenting tracker accounts.
