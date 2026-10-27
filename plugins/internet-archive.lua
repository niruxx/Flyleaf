-- Internet Archive (archive.org): millions of digitised books and texts.
--
-- By default only the big library-digitised, public-domain collections are searched
-- (Library of Congress, university libraries, Smithsonian, Project Gutenberg…).
-- "Everything downloadable" widens that to all freely downloadable uploads – whether
-- those are legal to download is up to you. Borrow-only lending-library books
-- (encrypted, "access restricted") are never offered.

plugin = {
  id = "internet-archive",
  name = "Internet Archive",
  version = "1.1.0",
  author = "Flyleaf",
  description = "Public-domain books and texts digitised by libraries, from archive.org.",
  site = "https://archive.org",
  icon = "https://archive.org/images/glogo.png",
  kinds = { "books", "comics" },
  settings = {
    { key = "scope", label = "Search", type = "select", default = "Public-domain library collections",
      options = { "Public-domain library collections", "Everything downloadable" },
      help = "Library collections are digitised public-domain books. “Everything” includes user uploads – only download what you're allowed to." },
    { key = "content", label = "Show", type = "select", default = "Books & texts",
      options = { "Books & texts", "Comics only", "Both" } },
    { key = "language", label = "Language", type = "text", default = "",
      help = "Optional, e.g. eng, fre, ger (MARC codes as archive.org uses them)" },
  },
}

local BASE = "https://archive.org"
local LIBRARY = "collection:(americana OR toronto OR gutenberg OR library_of_congress OR cdl OR smithsonian OR biodiversity OR wellcomelibrary OR universallibrary OR pulpmagazinearchive)"
local BOOK_FORMATS = 'format:(EPUB OR "Text PDF" OR "Additional Text PDF")'
local COMIC_FORMATS = 'format:("Comic Book ZIP" OR "Comic Book RAR" OR "Comic Book 7Z")'

-- Files Flyleaf can read, best first.
local RANK = { epub = 1, cbz = 2, cbr = 3, cb7 = 4, mobi = 5, azw3 = 6, pdf = 7 }

local function filters()
  local parts = { "mediatype:texts", "NOT access-restricted-item:true" }
  local content = settings.content or "Books & texts"
  if content == "Comics only" then
    parts[#parts + 1] = COMIC_FORMATS
  elseif content == "Both" then
    parts[#parts + 1] = "(" .. BOOK_FORMATS .. " OR " .. COMIC_FORMATS .. ")"
  else
    parts[#parts + 1] = BOOK_FORMATS
  end
  if (settings.scope or "") ~= "Everything downloadable" then parts[#parts + 1] = LIBRARY end
  if settings.language and settings.language ~= "" then parts[#parts + 1] = "language:(" .. settings.language .. ")" end
  return table.concat(parts, " AND ")
end

local ROWS = 30

-- advancedsearch takes repeated fl[] parameters, so the URL is built by hand.
local function search_docs(q, page, sort)
  local u = BASE .. "/advancedsearch.php?q=" .. url.encode(q)
    .. "&fl%5B%5D=identifier&fl%5B%5D=title&fl%5B%5D=creator&fl%5B%5D=year&fl%5B%5D=description"
    .. "&rows=" .. ROWS .. "&page=" .. (page or 1) .. "&output=json"
  if sort then u = u .. "&sort%5B%5D=" .. url.encode(sort) end
  local res = http.get(u)
  if not res.ok then error("archive.org search returned HTTP " .. res.status, 0) end
  local r = json.decode(res.body).response
  local items = {}
  for _, d in ipairs(r.docs or {}) do
    local creator = type(d.creator) == "table" and d.creator[1] or d.creator
    local desc = type(d.description) == "table" and d.description[1] or d.description
    items[#items + 1] = {
      id = d.identifier,
      title = type(d.title) == "table" and d.title[1] or d.title or d.identifier,
      author = creator,
      cover = BASE .. "/services/img/" .. d.identifier,
      summary = desc and text.strip_html(desc):sub(1, 300) or nil,
    }
  end
  return { items = items, hasMore = (r.start or 0) + #items < (r.numFound or 0) }
end

function search(q, page)
  return search_docs("(" .. q .. ") AND " .. filters(), page, nil)
end

-- Genres: archive.org subject searches.
local GENRES = {
  { id = "adventure", name = "Adventure", q = 'subject:(adventure)' },
  { id = "biography", name = "Biography", q = 'subject:(biography OR autobiography)' },
  { id = "children", name = "Children’s", q = 'subject:("juvenile fiction" OR "children\'s stories" OR "children\'s literature")' },
  { id = "comics", name = "Comics", q = 'subject:("comic books" OR comics OR "graphic novels")' },
  { id = "cooking", name = "Cooking", q = 'subject:(cooking OR cookery OR recipes)' },
  { id = "fantasy", name = "Fantasy", q = 'subject:(fantasy)' },
  { id = "history", name = "History", q = 'subject:(history)' },
  { id = "horror", name = "Horror", q = 'subject:(horror OR "ghost stories")' },
  { id = "mystery", name = "Mystery & detective", q = 'subject:(mystery OR detective)' },
  { id = "philosophy", name = "Philosophy", q = 'subject:(philosophy)' },
  { id = "poetry", name = "Poetry", q = 'subject:(poetry OR poems)' },
  { id = "pulp", name = "Pulp magazines", q = 'collection:(pulpmagazinearchive)' },
  { id = "religion", name = "Religion", q = 'subject:(religion OR theology)' },
  { id = "romance", name = "Romance", q = 'subject:(romance OR "love stories")' },
  { id = "science", name = "Science", q = 'subject:(science)' },
  { id = "scifi", name = "Science fiction", q = 'subject:("science fiction")' },
  { id = "travel", name = "Travel", q = 'subject:(travel OR voyages)' },
  { id = "war", name = "War", q = 'subject:(war OR military)' },
}

function genres()
  local out = {}
  for _, g in ipairs(GENRES) do out[#out + 1] = { id = g.id, name = g.name } end
  return out
end

-- A genre's most downloaded items, or a text search within it.
function genre(id, page, query)
  for _, g in ipairs(GENRES) do
    if g.id == id then
      local q = g.q .. " AND " .. filters()
      if query and query ~= "" then return search_docs("(" .. query .. ") AND " .. q, page, nil) end
      return search_docs(q, page, "downloads desc")
    end
  end
  error("Unknown genre", 0)
end

-- Browse: the most downloaded items in scope.
function latest(page)
  return search_docs(filters(), page, "downloads desc")
end

local function first(v)
  if type(v) == "table" then return v[1] end
  return v
end

function details(id)
  local res = http.get(BASE .. "/metadata/" .. url.encode(id))
  if not res.ok then error("archive.org returned HTTP " .. res.status, 0) end
  local d = json.decode(res.body)
  if not d.metadata then error("That item doesn't exist or isn't public.", 0) end
  local m = d.metadata
  local book = {
    id = id,
    title = first(m.title) or id,
    author = first(m.creator),
    cover = BASE .. "/services/img/" .. id,
    summary = m.description and text.strip_html(type(m.description) == "table" and table.concat(m.description, "\n\n") or m.description) or nil,
    url = BASE .. "/details/" .. id,
    status = m.date and ("Published " .. tostring(first(m.date))) or nil,
    genres = {},
    files = {},
  }
  local subjects = type(m.subject) == "table" and m.subject or (m.subject and { m.subject } or {})
  for i = 1, math.min(#subjects, 10) do book.genres[#book.genres + 1] = subjects[i] end
  if m["access-restricted-item"] == "true" or m["access-restricted-item"] == true then
    -- Lending-library books can only be borrowed on archive.org, not downloaded.
    return book
  end
  for _, f in ipairs(d.files or {}) do
    local name = f.name or ""
    local ext = name:match("%.([%w]+)$")
    ext = ext and ext:lower() or ""
    local fmt = tostring(f.format or "")
    local encrypted = name:match("_encrypted") or name:match("_lcp%.") or fmt:match("Encrypted")
    if RANK[ext] and not encrypted and f.private ~= "true" then
      book.files[#book.files + 1] = {
        id = id .. "/" .. name,
        title = fmt ~= "" and (fmt .. " – " .. name) or name,
        format = ext,
        size = tonumber(f.size),
      }
    end
  end
  table.sort(book.files, function(a, b)
    if RANK[a.format] ~= RANK[b.format] then return RANK[a.format] < RANK[b.format] end
    return (a.size or 0) < (b.size or 0)
  end)
  return book
end

function download(file_id)
  local id, name = file_id:match("^([^/]+)/(.+)$")
  if not id then error("Unknown file.", 0) end
  local path = {}
  for part in name:gmatch("[^/]+") do path[#path + 1] = url.encode(part) end
  return { url = BASE .. "/download/" .. url.encode(id) .. "/" .. table.concat(path, "/"), filename = name:match("[^/]+$") }
end
