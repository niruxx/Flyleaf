-- Any OPDS 1.x catalog: your own Calibre-Web, Kavita, Komga, another Flyleaf,
-- a library's public catalog, or a store that offers OPDS.

plugin = {
  id = "opds-catalog",
  name = "OPDS catalog",
  version = "1.0.0",
  author = "Flyleaf",
  description = "Browse and download from any OPDS catalog you have access to (Calibre-Web, Kavita, Komga, public libraries…).",
  kinds = { "books", "manga", "comics" },
  settings = {
    { key = "url", label = "Catalog URL", type = "text", required = true, help = "The OPDS root, e.g. https://calibre.example.com/opds" },
    { key = "username", label = "Username", type = "text", help = "Only if the catalog needs a login" },
    { key = "password", label = "Password", type = "password" },
  },
}

local MIME = {
  ["application/epub+zip"] = "epub",
  ["application/pdf"] = "pdf",
  ["application/x-mobipocket-ebook"] = "mobi",
  ["application/vnd.amazon.ebook"] = "azw3",
  ["application/x-fictionbook+xml"] = "fb2",
  ["application/vnd.comicbook+zip"] = "cbz",
  ["application/x-cbz"] = "cbz",
  ["application/vnd.comicbook-rar"] = "cbr",
  ["application/x-cbr"] = "cbr",
  ["application/x-cb7"] = "cb7",
  ["application/zip"] = "cbz",
}

local function root()
  local u = settings.url
  if not u or u == "" then error("Set the catalog URL in this plugin's settings first.", 0) end
  return u
end

local function headers()
  if settings.username and settings.username ~= "" then
    return { Authorization = "Basic " .. base64.encode(settings.username .. ":" .. (settings.password or "")) }
  end
  return {}
end

local function fetch(u)
  local res = http.get(u, { headers = headers() })
  if res.status == 401 then error("The catalog needs a username and password (see plugin settings).", 0) end
  if not res.ok then error("Catalog returned HTTP " .. res.status, 0) end
  return res.body, res.url
end

local function link(entry_html, base, pred)
  for _, l in ipairs(html.select(entry_html, "link")) do
    if pred(l.attrs) then return url.resolve(base, l.attrs.href), l.attrs end
  end
end

-- Turn a feed into result items. Entries with acquisition links are books;
-- navigation entries (subsections) are listed as folders you can open.
local function parse(body, base)
  local items = {}
  for _, e in ipairs(html.select(body, "entry")) do
    local title = html.select_one(e.html, "title")
    local author = html.select_one(e.html, "author name")
    local cover = link(e.html, base, function(a) return a.rel == "http://opds-spec.org/image/thumbnail" or a.rel == "http://opds-spec.org/image" end)
    local acq = link(e.html, base, function(a) return (a.rel or ""):match("^http://opds%-spec%.org/acquisition") end)
    local nav = link(e.html, base, function(a) return (a.type or ""):match("atom%+xml") end)
    local target = acq and (nav or base) or nav
    if title and target then
      items[#items + 1] = {
        -- The id carries the feed URL plus the entry id so details() can find it again.
        id = json.encode({ feed = acq and base or nav, entry = acq and (html.select_one(e.html, "id") or {}).text or nil }),
        title = title.text,
        author = author and author.text or nil,
        cover = cover,
        folder = not acq,
      }
    end
  end
  local nxt = link(body:match("^(.-)<entry") or body, base, function(a) return a.rel == "next" end)
  return { items = items, hasMore = nxt ~= nil, next = nxt }
end

local function paged(start_url, page)
  local u = start_url
  for _ = 2, (page or 1) do
    local body, base = fetch(u)
    local r = parse(body, base)
    if not r.next then return { items = {}, hasMore = false } end
    u = r.next
  end
  local body, base = fetch(u)
  return parse(body, base)
end

function latest(page)
  return paged(root(), page)
end

function search(query, page)
  local body, base = fetch(root())
  local osd = link(body:match("^(.-)<entry") or body, base, function(a) return a.rel == "search" end)
  if not osd then error("This catalog doesn't support search. Use Browse instead.", 0) end
  local template = osd
  if not osd:find("{searchTerms}", 1, true) then
    -- OpenSearch description document: find the Atom template.
    local desc = fetch(osd)
    local u = html.select_one(desc, 'Url[type*="atom"]') or html.select_one(desc, "Url")
    if not u then error("Couldn't read the catalog's search description.", 0) end
    template = url.resolve(osd, u.attrs.template)
  end
  local search_url = template:gsub("{searchTerms}", url.encode(query)):gsub("{[^}]*%?}", "")
  return paged(search_url, page)
end

-- Open a navigation entry ("folder") from the results.
function browse(id, page)
  return paged(json.decode(id).feed, page)
end

function details(id)
  local ref = json.decode(id)
  if not ref.entry then error("This is a folder; open it to see what's inside.", 0) end
  local body, base = fetch(ref.feed)
  for _, e in ipairs(html.select(body, "entry")) do
    local eid = html.select_one(e.html, "id")
    if eid and eid.text == ref.entry then
      local book = { id = id, files = {}, genres = {} }
      book.title = (html.select_one(e.html, "title") or {}).text
      book.author = (html.select_one(e.html, "author name") or {}).text
      local summary = html.select_one(e.html, "summary") or html.select_one(e.html, "content")
      book.summary = summary and text.strip_html(summary.html) or nil
      book.cover = link(e.html, base, function(a) return a.rel == "http://opds-spec.org/image" end)
      for _, c in ipairs(html.select(e.html, "category")) do book.genres[#book.genres + 1] = c.attrs.label or c.attrs.term end
      for _, l in ipairs(html.select(e.html, "link")) do
        local a = l.attrs
        if (a.rel or ""):match("^http://opds%-spec%.org/acquisition") then
          local fmt = MIME[(a.type or ""):gsub(";.*", "")]
          if fmt then
            book.files[#book.files + 1] = { id = url.resolve(base, a.href), title = a.title or fmt:upper(), format = fmt, size = tonumber(a.length) }
          end
        end
      end
      return book
    end
  end
  error("That entry is no longer in the catalog.", 0)
end

function download(file_id)
  return { url = file_id, headers = headers() }
end
