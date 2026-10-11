-- Standard Ebooks: carefully produced, free public-domain ebooks.
-- Reads the public website (the OPDS feeds are for Patrons Circle members).

plugin = {
  id = "standard-ebooks",
  name = "Standard Ebooks",
  version = "1.0.0",
  author = "Flyleaf",
  description = "Beautifully typeset public-domain classics with proofread text and modern covers.",
  site = "https://standardebooks.org",
  icon = "https://standardebooks.org/images/favicons/favicon-64x64.png",
  kinds = { "books" },
  language = "en",
}

local BASE = "https://standardebooks.org"

local function get(path)
  local res = http.get(url.resolve(BASE, path))
  if not res.ok then error("Standard Ebooks returned HTTP " .. res.status) end
  return res.body
end

local function list(path, page)
  local sep = path:find("?", 1, true) and "&" or "?"
  local body = get(path .. sep .. "page=" .. (page or 1) .. "&per-page=24")
  local items = {}
  for _, li in ipairs(html.select(body, 'li[typeof="schema:Book"]')) do
    local href = li.attrs.about
    local name = html.select_one(li.html, 'span[property="schema:name"]')
    local author = html.select_one(li.html, '.author span[property="schema:name"]')
    local img = html.select_one(li.html, "img")
    if href and name then
      items[#items + 1] = {
        id = href,
        title = name.text,
        author = author and author.text or nil,
        cover = img and url.resolve(BASE, img.attrs.src) or nil,
      }
    end
  end
  local more = body:find('rel="next"', 1, true) ~= nil
  return { items = items, hasMore = more }
end

function search(query, page)
  return list("/ebooks?query=" .. url.encode(query), page)
end

function latest(page)
  return list("/ebooks?sort=newest", page)
end

function details(id)
  local body = get(id)
  local book = { id = id, url = BASE .. id, genres = {}, files = {} }
  local title = html.select_one(body, 'h1[property="schema:name"]')
  book.title = title and title.text or id:match("[^/]+$")
  local author = html.select_one(body, 'a[property="schema:author"] span[property="schema:name"]')
    or html.select_one(body, '[property="schema:author"] [property="schema:name"]')
  book.author = author and author.text or nil
  local desc = html.select_one(body, 'meta[name="description"]')
  if desc then book.summary = desc.attrs.content:gsub("^Free epub ebook download of the Standard Ebooks edition of [^:]+:%s*", "") end
  local cover = html.select_one(body, 'meta[property="og:image"]')
  book.cover = cover and cover.attrs.content or nil
  for _, tag in ipairs(html.select(body, 'ul.tags a')) do book.genres[#book.genres + 1] = tag.text end
  local labels = { epub = "Compatible EPUB (recommended)", kobo = "Kobo KEPUB", amazon = "Kindle AZW3" }
  local formats = { epub = "epub", kobo = "epub", amazon = "azw3" }
  for _, a in ipairs(html.select(body, '#download a[property="schema:contentUrl"]')) do
    local class = a.attrs.class
    if formats[class] and not a.attrs.href:match("_advanced%.epub$") then
      book.files[#book.files + 1] = { id = a.attrs.href, title = labels[class], format = formats[class] }
    end
  end
  return book
end

function download(file_id)
  -- "?source=download" skips the thank-you page and serves the file directly.
  return { url = url.resolve(BASE, file_id) .. "?source=download", filename = file_id:match("[^/]+$") }
end
