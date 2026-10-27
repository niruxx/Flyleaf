# 🧩 Writing Content Finder plugins

Content Finder searches websites for books, manga and comics, and downloads what you pick straight into a Flyleaf library. Every website is handled by a **plugin**: one small [Lua 5.4](https://www.lua.org/manual/5.4/) file. It's the same idea as Mihon/Tachiyomi extensions.

Flyleaf ships with seven plugins in [`plugins/`](../plugins):
- **Project Gutenberg**, **Standard Ebooks** and the **Internet Archive** (a JSON API)
- **Archive of Our Own**, which scrapes HTML and reports age ratings
- **WEBTOON**, which scrapes HTML plus a JSON episode list, downloads `pages` with a `Referer` header, proxies images and sets `layout = "webtoon"
- a generic **OPDS catalog** client
- the **Mihon extensions** bridge for Suwayomi-Server, which shows `sources()`, page downloads and image proxying

They make good starting points.

> ⚖️ Only write or install plugins for sources that let you download what they offer (public-domain libraries, your own servers, stores you've bought from that provide OPDS, and so on).

---

## The shape of a plugin

```lua
plugin = {
  id = "my-source",              -- required: 2–64 chars, lowercase letters, digits, . - _
  name = "My Source",            -- required
  version = "1.0.0",             -- required: bump it so users see updates
  author = "You",
  description = "One sentence shown in the source list.",
  site = "https://example.org",
  icon = "https://example.org/favicon.png",
  kinds = { "books" },           -- any of "books", "manga", "comics"
  language = "en",
  nsfw = false,
  settings = {                   -- optional: shown in Settings → Content Finder plugins
    { key = "token", label = "API token", type = "password", required = true, help = "From your account page" },
  },
}

-- Required: search results.
function search(query, page)
  return { items = { { id = "42", title = "A Book", author = "Someone", cover = "https://…/42.jpg" } }, hasMore = false }
end

-- Optional: what to show before the user searches (popular, latest…).
function latest(page) return search("", page) end

-- Optional: open an item returned with folder = true (catalog sections, author pages…).
function browse(id, page) return { items = {}, hasMore = false } end

-- Required: everything about one item, including the files you can download.
function details(id)
  return {
    title = "A Book", author = "Someone", series = nil,
    cover = "https://…/42-large.jpg", summary = "…", genres = { "Fiction" },
    status = "completed", url = "https://example.org/books/42",
    files = {
      { id = "https://example.org/42.epub", title = "EPUB", format = "epub", size = 512000 },
      -- manga/comics: one entry per chapter or volume, with volume = 1 / chapter = 12
    },
  }
end

-- Required: turn a file id into something to download.
function download(file_id)
  return { url = file_id, filename = "a-book.epub", headers = { Referer = "https://example.org" } }
end
```

### Optional extras

| Field or function | What it does |
|---|---|
| `function sources()` | The plugin provides **several sources** (like the Mihon bridge: one per extension). Return `{ { id, name, icon, language, nsfw, browse }, … }`. Each one is listed separately in Content Finder, and in every other call the global `source` holds the one being used (`source.id`). The list is cached for 10 minutes. |
| `function genres()` + `function genre(id, page, query)` | **Genre / category filters.** `genres()` returns `{ { id, name }, … }` (cached for a day) and Content Finder shows them as chips for your source. `genre(id, page, query)` returns the same `{ items, hasMore }` as `search()`: the genre's books, or, when `query` isn't empty, a search within the genre. Both must be defined. See `gutenberg.lua` and `internet-archive.lua`. |
| `download()` returning `pages` | Return `{ pages = { url1, url2, … }, headers = {…}, filename = "Chapter 12", comicInfo = { Number = 12 } }` instead of `url`. Flyleaf fetches the pages (four at a time, with retries) and builds a CBZ with a `ComicInfo.xml` (series, chapter title, number, writer, page count). |
| `ageRating` in `details()` | `0` Everyone, `1` Teen (13+), `2` Mature (17+), `3` Adults (18+). After the download is scanned, Flyleaf applies it to the series (never lowering an existing rating, and not if the admin locked it), so guests' age restrictions cover downloaded books. |
| `layout` in `details()` | `"webtoon"`, `"single"` or `"double"`: how the series is meant to be read. After the download is scanned, it becomes the downloading user's reader layout for that series, unless they already chose reader settings for it. |
| `proxy_images = true` / `function image(url)` | Covers and icons are served **through Flyleaf**. Use this when the browser can't reach the images directly, or they need a login. `image(url)` may return `{ url, headers }` to add headers; only send credentials to your own server. Proxied URLs are signed, so they only work for URLs your plugin returned. |

`id` values are yours to choose: a number, a URL path, or a JSON string (see `opds-catalog.lua`). Flyleaf passes them back to you unchanged.

### Files and formats

`format` should be one Flyleaf reads: `epub`, `kepub`, `pdf`, `mobi`, `azw3`, `fb2`, `txt`, `docx`, `rtf`, `cbz`, `cbr`, `cb7`, `cbt`. The saved file name comes from the first of these that has a supported extension:

1. `filename` from `download()`
2. the server's `Content-Disposition`
3. the URL

If none of them has one, `format` is used as the extension.

Downloads go into the library the user picks:

| Library type | Saved as |
|---|---|
| Books | `<library>/<Author>/<Title>.<ext>` |
| Manga & comics | `<library>/<Series>/<file>` |

After a download, Flyleaf rescans that library, so the new book appears on its own.

---

## What plugins can use

Plugins run in a sandbox: there is no file access, `os.execute`, `require`, `io` or `debug`. Each call gets a fresh Lua state, must finish within **60 seconds**, and may make up to **60 HTTP requests**. Everything a plugin can reach goes through these helpers:

| Helper | Returns |
|---|---|
| `http.get(url, opts)` / `http.post(url, opts)` | `{ status, ok, body, url, headers }`. `opts`: `headers`, `query` (a table), `timeout` (ms, default 20 000, max 45 000), and for POST `json`, `form` or `body`. Responses are capped at 10 MB. |
| `json.decode(s)` / `json.encode(v)` | Lua tables ⇄ JSON |
| `html.select(markup, css)` | A list of `{ tag, text, html, outer, attrs }` |
| `html.select_one(markup, css)` | One element, or `nil` |
| `url.encode(s)` / `url.decode(s)` | Percent-encoding |
| `url.resolve(base, relative)` | An absolute URL |
| `url.query(t)` | `a=1&b=2` |
| `text.strip_html(s)` / `text.trim(s)` | Clean text |
| `base64.encode(s)` / `base64.decode(s)` | For example, Basic auth headers |
| `settings.<key>` | Values the admin entered for your `settings` |
| `log(...)` | Writes to `data/logs/flyleaf.log` |

`html.select` works on HTML and XML (Atom/OPDS feeds, RSS). Selectors are forgiving:
- Tag names match regardless of case, so `Url` finds `<Url>`.
- Namespaced tags work as written: `entry dc:issued`.
- To read an element's inner markup, pass its `html` back in: `html.select(node.html, "a")`.

Call `error("Message", 0)` to show a friendly message in the UI. Without the `0`, Lua adds the line number, which is handy while developing.

---

## Installing your plugin

In **Settings → Content Finder plugins**:

- **Upload .lua file** – the quickest way to test while you develop.
- **Install from URL** – a link to the raw `.lua` file. **Check for update** re-downloads it from that URL.
- **Add repository** – a list of plugins, described below.

The plugin is checked when it's installed: the manifest and the `search`, `details` and `download` functions must exist, and top-level code must finish within 2 seconds.

## Publishing a repository

A repository is a JSON file you host anywhere (a GitHub raw URL works):

```json
{
  "name": "My Flyleaf sources",
  "plugins": [
    { "id": "my-source", "name": "My Source", "version": "1.0.0", "description": "…", "kinds": ["books"], "icon": "https://…", "url": "my-source.lua" }
  ]
}
```

`url` can be relative to the index. When a listed `version` is newer than the installed one, Flyleaf offers an update.

---

## Using plugins from scripts

Everything in Content Finder is part of the REST API (see **Settings → API & webhooks**):

```bash
KEY=…   # an API key; queueing downloads needs a full-access key
curl -H "Authorization: Bearer $KEY" "http://flyleaf:7878/api/finder/gutenberg/search?q=dracula"
curl -H "Authorization: Bearer $KEY" "http://flyleaf:7878/api/finder/gutenberg/details?id=345"
curl -X POST -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"libraryId":1,"book":{"title":"Dracula","author":"Bram Stoker"},"files":[{"id":"https://www.gutenberg.org/ebooks/345.epub3.images","format":"epub"}]}' \
  http://flyleaf:7878/api/finder/gutenberg/download
```

Subscribe a webhook to `download.completed` to hear when the book has landed.
