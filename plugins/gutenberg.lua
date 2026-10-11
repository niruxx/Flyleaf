-- Project Gutenberg: 75,000+ free public-domain ebooks.
-- Uses Gutenberg's official OPDS catalog.

plugin = {
  id = "gutenberg",
  name = "Project Gutenberg",
  version = "1.0.1",
  author = "Flyleaf",
  description = "Over 75,000 free public-domain ebooks: classics, poetry, history and more.",
  site = "https://www.gutenberg.org",
  icon = "https://www.gutenberg.org/gutenberg/favicon.ico",
  kinds = { "books" },
  language = "en",
}

local BASE = "https://www.gutenberg.org"

local function feed(path)
  local res = http.get(url.resolve(BASE, path))
  if not res.ok then error("Gutenberg returned HTTP " .. res.status) end
  return res.body
end

-- Book entries in a search/list feed link to /ebooks/<number>.opds.
local function entries(body)
  local items = {}
  for _, entry in ipairs(html.select(body, "entry")) do
    local id = entry.html:match("/ebooks/(%d+)%.opds")
    if id then
      local title = html.select_one(entry.html, "title")
      local who = html.select_one(entry.html, "content")
      items[#items + 1] = {
        id = id,
        title = title and title.text or ("Book " .. id),
        author = who and who.text or nil,
        cover = BASE .. "/cache/epub/" .. id .. "/pg" .. id .. ".cover.medium.jpg",
      }
    end
  end
  return items
end

local function page_of(path, page)
  local start = ((page or 1) - 1) * 25 + 1
  local sep = path:find("?", 1, true) and "&" or "?"
  local body = feed(path .. sep .. "start_index=" .. start)
  return { items = entries(body), hasMore = body:find('rel="next"', 1, true) ~= nil }
end

function search(query, page)
  return page_of("/ebooks/search.opds/?query=" .. url.encode(query), page)
end

-- "Browse" shows the most downloaded books.
function latest(page)
  return page_of("/ebooks/search.opds/?sort_order=downloads", page)
end

function details(id)
  local body = feed("/ebooks/" .. id .. ".opds")
  local files, seen = {}, {}
  local book = { id = id, url = BASE .. "/ebooks/" .. id, genres = {} }
  for _, entry in ipairs(html.select(body, "entry")) do
    local title = html.select_one(entry.html, "title")
    if title and not book.title then book.title = title.text end
    local author = html.select_one(entry.html, "author name")
    if author and not book.author then
      -- "Shelley, Mary Wollstonecraft" → "Mary Wollstonecraft Shelley"
      local last, first = author.text:match("^([^,]+),%s*(.+)$")
      book.author = last and (first .. " " .. last) or author.text
    end
    for _, link in ipairs(html.select(entry.html, "link")) do
      local a = link.attrs
      if a.rel == "http://opds-spec.org/image" and not book.cover then book.cover = a.href end
      if a.rel == "related" and a.title and a.title:match("^On ") then
        book.genres[#book.genres + 1] = a.title:gsub("^On ", ""):gsub("…$", "")
      end
      if a.rel == "http://opds-spec.org/acquisition" and not seen[a.href] then
        local format = (a.type == "application/epub+zip" and "epub") or (a.type == "application/x-mobipocket-ebook" and (a.href:match("kf8") and "azw3" or "mobi")) or nil
        if format then
          seen[a.href] = true
          files[#files + 1] = { id = a.href, title = a.title or format:upper(), format = format, size = tonumber(a.length) }
        end
      end
    end
  end
  -- Recommend the modern EPUB with images first.
  table.sort(files, function(x, y)
    local function rank(f) return (f.id:match("epub3") and 0) or (f.format == "epub" and not f.id:match("noimages") and 1) or (f.format == "epub" and 2) or 3 end
    return rank(x) < rank(y)
  end)
  book.files = files
  -- The OPDS entry only has file notes; the book page has the real summary.
  local page = http.get(BASE .. "/ebooks/" .. id)
  if page.ok then
    local box = html.select_one(page.body, ".summary-text-container")
    if box then
      book.summary = text.trim(box.text:gsub("%s+", " "):gsub("%s*%(This is an automatically generated summary%.%).*$", ""):gsub("%s*Show [Mm]ore.*$", ""))
    end
  end
  return book
end

function download(file_id)
  local name = file_id:match("/ebooks/(%d+)")
  local ext = file_id:match("kf8") and "azw3" or file_id:match("kindle") and "mobi" or "epub"
  return { url = file_id, filename = "pg" .. (name or "book") .. "." .. ext }
end
