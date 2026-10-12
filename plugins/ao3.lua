-- Archive of Our Own (archiveofourown.org): fan fiction, downloaded with AO3's own
-- EPUB/AZW3/MOBI/PDF export.
--
-- Be kind to AO3: it's run by volunteers. Each search, work page or download is one
-- request. Works limited to logged-in AO3 users can't be downloaded.
--
-- Ratings are passed on to Flyleaf (General → Everyone, Teen → 13+, Mature → 17+,
-- Explicit → 18+), so guests' age restrictions apply to downloaded works too.

plugin = {
  id = "ao3",
  name = "Archive of Our Own",
  version = "1.0.0",
  author = "Flyleaf",
  description = "Fan fiction from AO3, downloaded as EPUB with title, author, fandoms and tags.",
  site = "https://archiveofourown.org",
  icon = "https://archiveofourown.org/images/ao3_logos/logo_42.png",
  kinds = { "books" },
  settings = {
    { key = "mature", label = "Show Mature and Explicit works", type = "toggle", default = false,
      help = "Off: only General, Teen and Not Rated works are listed." },
    { key = "language", label = "Language", type = "text", default = "",
      help = "Optional AO3 language code, e.g. en, es, fr, zh" },
    { key = "complete", label = "Complete works only", type = "toggle", default = false },
  },
}

local BASE = "https://archiveofourown.org"
local RATING_AGE = { ["General Audiences"] = 0, ["Teen And Up Audiences"] = 1, ["Mature"] = 2, ["Explicit"] = 3 }

local function get(path)
  -- AO3 can be slow when busy; allow it the longest wait plugins get.
  local res = http.get(BASE .. path, { headers = { Accept = "text/html" }, timeout = 45000 })
  if res.status == 429 or res.status == 503 then error("AO3 is busy or rate-limiting requests. Try again in a minute.", 0) end
  if res.status == 404 then error("That work no longer exists on AO3.", 0) end
  if not res.ok then error("AO3 returned HTTP " .. res.status, 0) end
  return res.body, res.url
end

-- Join the non-empty values with `sep` (table.concat can't skip nils).
local function join(sep, ...)
  local out = {}
  for i = 1, select("#", ...) do
    local v = select(i, ...)
    if v ~= nil and v ~= "" then out[#out + 1] = v end
  end
  return table.concat(out, sep)
end

local function texts(markup, css)
  local out = {}
  for _, n in ipairs(html.select(markup, css)) do out[#out + 1] = n.text end
  return out
end

local function allowed(rating)
  return settings.mature or not (rating == "Mature" or rating == "Explicit")
end

-- Turn a page of work blurbs into results.
local function blurbs(body)
  local items = {}
  for _, li in ipairs(html.select(body, "li.work.blurb")) do
    local link = html.select_one(li.html, "h4.heading a")
    local id = link and link.attrs.href and link.attrs.href:match("^/works/(%d+)")
    local rating = html.select_one(li.html, "span.rating")
    local rtitle = rating and rating.attrs.title or "Not Rated"
    if id and allowed(rtitle) then
      local authors = texts(li.html, 'a[rel="author"]')
      local fandoms = texts(li.html, "h5.fandoms a.tag")
      local words = html.select_one(li.html, "dd.words")
      local summary = html.select_one(li.html, "blockquote.summary")
      items[#items + 1] = {
        id = id,
        title = link.text,
        author = #authors > 0 and table.concat(authors, ", ") or "Anonymous",
        summary = join(" · ", #fandoms > 0 and table.concat(fandoms, ", ") or nil, rtitle, words and (words.text .. " words") or nil)
          .. (summary and ("\n" .. text.trim(summary.text)) or ""),
      }
    end
  end
  local more = body:find('rel="next"', 1, true) ~= nil
  return { items = items, hasMore = more }
end

local function search_path(query, page, sort)
  local q = {
    ["work_search[query]"] = query or "",
    ["work_search[sort_column]"] = sort or "_score",
    page = page or 1,
  }
  if settings.language and settings.language ~= "" then q["work_search[language_id]"] = settings.language end
  if settings.complete then q["work_search[complete]"] = "T" end
  return "/works/search?" .. url.query(q)
end

function search(query, page)
  return blurbs(get(search_path(query, page)))
end

-- Browse: the most-kudosed works.
function latest(page)
  return blurbs(get(search_path("", page, "kudos_count")))
end

function details(id)
  local body = get("/works/" .. id .. "?view_adult=true")
  if body:find('id="loginform"', 1, true) or body:find("only available to registered users", 1, true) then
    error("This work is only available to logged-in AO3 users, so it can't be downloaded here.", 0)
  end
  local title = html.select_one(body, "h2.title")
  local authors = texts(body, 'h3.byline a[rel="author"]')
  local summary = html.select_one(body, "div.summary blockquote.userstuff")
  local rating = html.select_one(body, "dd.rating a.tag")
  local rtitle = rating and rating.text or "Not Rated"
  if not allowed(rtitle) then
    error("This work is rated " .. rtitle .. ". Turn on “Show Mature and Explicit works” in the AO3 plugin settings to see it.", 0)
  end
  local genres = {}
  for _, t in ipairs(texts(body, "dd.fandom a.tag")) do genres[#genres + 1] = t end
  for _, t in ipairs(texts(body, "dd.freeform a.tag")) do
    if #genres < 20 then genres[#genres + 1] = t end
  end
  -- "Part 3 of Some Series"
  local series_link = html.select_one(body, "dd.series span.position a")
  local position = html.select_one(body, "dd.series span.position")
  local status = html.select_one(body, "dd.status")
  local chapters = html.select_one(body, "dd.chapters")
  local words = html.select_one(body, "dd.words")
  local book = {
    id = id,
    title = title and text.trim(title.text) or ("Work " .. id),
    author = #authors > 0 and table.concat(authors, ", ") or "Anonymous",
    series = series_link and series_link.text or nil,
    volume = position and tonumber((position.text or ""):match("Part%s+(%d+)")) or nil,
    summary = summary and text.trim(summary.text) or nil,
    genres = genres,
    status = join(" · ", rtitle, words and (words.text .. " words") or nil, chapters and ("chapters " .. chapters.text) or nil, status and status.text or nil),
    ageRating = RATING_AGE[rtitle],
    url = BASE .. "/works/" .. id,
    files = {},
  }
  local labels = { epub = "EPUB (recommended)", azw3 = "AZW3 (Kindle)", mobi = "MOBI (older Kindles)", pdf = "PDF" }
  local order = { epub = 1, azw3 = 2, mobi = 3, pdf = 4 }
  for _, a in ipairs(html.select(body, "li.download ul a")) do
    local href = a.attrs.href or ""
    local ext = href:match("%.(%w+)%?") or href:match("%.(%w+)$")
    ext = ext and ext:lower()
    if labels[ext] then
      book.files[#book.files + 1] = { id = href, title = labels[ext], format = ext, volume = book.volume }
    end
  end
  table.sort(book.files, function(a, b) return order[a.format] < order[b.format] end)
  return book
end

function download(file_id)
  if not file_id:match("^/downloads/%d+/") then error("Unknown download.", 0) end
  local name = file_id:match("^/downloads/%d+/([^?]+)")
  return { url = BASE .. file_id, filename = name and url.decode(name):gsub("_", " ") or nil }
end
