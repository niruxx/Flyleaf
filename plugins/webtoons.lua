-- WEBTOON (webtoons.com): Originals and Canvas series. Each episode downloads as a CBZ of
-- its vertical strip; downloaded series open in Flyleaf's webtoon (continuous scroll) mode.
--
-- Only episodes that are free to read on the site are listed; Daily Pass / Fast Pass
-- episodes aren't. webtoons.com refuses images without a Referer from its own site, so
-- covers go through Flyleaf (proxy_images) and downloads send that header.
--
-- Titles WEBTOON marks as unsuitable for children are passed on as Mature (17+), so
-- guests' age restrictions apply to them.

plugin = {
  id = "webtoons",
  name = "WEBTOON",
  version = "1.0.0",
  author = "Flyleaf",
  description = "Webtoons from webtoons.com (Originals and Canvas), one CBZ per episode.",
  site = "https://www.webtoons.com",
  icon = "https://webtoons-static.pstatic.net/image/favicon/favicon.ico",
  kinds = { "manga", "comics" },
  proxy_images = true,
  settings = {
    { key = "language", label = "Language", type = "text", default = "en",
      help = "en, es, fr, de, id, th or zh-hant" },
    { key = "canvas", label = "Include Canvas (fan-made) series", type = "toggle", default = true },
    { key = "hideMature", label = "Hide titles marked unsuitable for children", type = "toggle", default = false },
  },
}

local BASE = "https://www.webtoons.com"
local MOBILE = "https://m.webtoons.com"
local REFERER = { Referer = "https://www.webtoons.com/" }
local LANGS = { en = true, es = true, fr = true, de = true, id = true, th = true, ["zh-hant"] = true }

local function lang()
  local l = (settings.language or "en"):lower():gsub("%s", "")
  return LANGS[l] and l or "en"
end

local function get(u, headers)
  local res = http.get(u, { headers = headers or { Accept = "text/html", ["Accept-Language"] = "en" } })
  if res.status == 404 then error("WEBTOON couldn't find that page.", 0) end
  if not res.ok then error("webtoons.com returned HTTP " .. res.status, 0) end
  return res.body
end

local function clean(s)
  return text.trim(((s or ""):gsub("%s+", " ")))
end

-- Cover URLs can contain spaces and brackets.
local function fixUrl(u)
  if not u or u == "" then return nil end
  return (u:gsub(" ", "%%20"))
end

-- "…/list?title_no=6417" → its path, which is our item id (plus "|m" when flagged mature).
local function pathOf(href)
  return (href or ""):gsub("^https?://[^/]+", "")
end

local function titleNo(id)
  return id:match("title_no=(%d+)")
end

local function isCanvas(id)
  return id:find("/canvas/", 1, true) ~= nil or id:find("/challenge/", 1, true) ~= nil
end

-- Search results and rankings share the same card markup.
local function cards(markup)
  local items = {}
  for _, a in ipairs(html.select(markup, "a[data-title-no]")) do
    local href = a.attrs.href
    if href and href:find("title_no=", 1, true) then
      local wrap = html.select_one(a.html, "div.image_wrap")
      local mature = wrap and wrap.attrs["data-title-unsuitable-for-children"] == "true"
      if not (mature and settings.hideMature) then
        local img = html.select_one(a.html, "img")
        local title = html.select_one(a.html, ".title")
        local author = html.select_one(a.html, ".author")
        local genre = html.select_one(a.html, ".genre")
        items[#items + 1] = {
          id = pathOf(href) .. (mature and "|m" or ""),
          title = clean(title and title.text or (img and img.attrs.alt) or "Untitled"),
          author = author and clean(author.text) or (genre and clean(genre.text)) or nil,
          cover = img and fixUrl(img.attrs.src) or nil,
        }
      end
    end
  end
  return items
end

-- Page 1: every matching Original, then Canvas; later pages continue the Canvas results.
function search(query, page)
  if not query or query == "" then return latest(page) end
  local q = url.encode(query)
  local items = {}
  if page == 1 then
    for _, it in ipairs(cards(get(BASE .. "/" .. lang() .. "/search/originals?keyword=" .. q))) do items[#items + 1] = it end
  end
  local more = false
  if settings.canvas ~= false then
    local canvas = cards(get(BASE .. "/" .. lang() .. "/search/canvas?keyword=" .. q .. "&page=" .. page))
    for _, it in ipairs(canvas) do items[#items + 1] = it end
    more = #canvas >= 30
  end
  return { items = items, hasMore = more }
end

-- What's trending, before you search.
function latest(page)
  if page > 1 then return { items = {}, hasMore = false } end
  return { items = cards(get(BASE .. "/" .. lang() .. "/ranking/trending")), hasMore = false }
end

local function episodes(id)
  local kind = isCanvas(id) and "canvas" or "webtoon"
  local res = http.get(MOBILE .. "/api/v1/" .. kind .. "/" .. titleNo(id) .. "/episodes?pageSize=99999",
    { headers = { Referer = MOBILE .. "/", Accept = "application/json" } })
  if not res.ok then error("Couldn't load the episode list (HTTP " .. res.status .. ").", 0) end
  local data = json.decode(res.body)
  return (data and data.result and data.result.episodeList) or {}
end

function details(id)
  local path, flag = id:match("^([^|]+)|?(.*)$")
  local page = get(BASE .. path)
  local function meta(prop)
    local m = html.select_one(page, 'meta[property="og:' .. prop .. '"]')
    return m and m.attrs.content or nil
  end
  local header = html.select_one(page, ".detail_header") or { html = page }
  local authorArea = html.select_one(header.html, ".author_area")
  local author = authorArea and clean(authorArea.text:gsub("[Aa]uthor info", "")):gsub("%s*,%s*", ", ") or nil
  local summary = html.select_one(page, "p.summary")
  local genres = {}
  for _, g in ipairs(html.select(header.html, ".genre")) do
    local name = clean(g.text)
    if name ~= "" then genres[#genres + 1] = name end
  end
  local day = html.select_one(page, ".day_info")
  local dayText = day and clean(day.text) or ""
  local status = dayText:upper():find("COMPLETED") and "completed" or (dayText ~= "" and dayText:gsub("^UP%s*", "") or "ongoing")

  local files = {}
  local list = episodes(path)
  -- Newest first, like the site.
  for i = #list, 1, -1 do
    local e = list[i]
    files[#files + 1] = {
      id = e.viewerLink,
      title = clean(e.episodeTitle),
      format = "cbz",
      chapter = e.episodeNo,
    }
  end

  local title = clean(meta("title") or "Untitled")
  return {
    title = title,
    series = title,
    author = author,
    cover = fixUrl(meta("image")),
    summary = summary and clean(summary.text) or nil,
    genres = genres,
    status = status,
    ageRating = flag == "m" and 2 or nil,
    layout = "webtoon",
    url = BASE .. path,
    files = files,
  }
end

function download(file_id)
  local page = get(BASE .. file_id)
  local pages = {}
  for _, img in ipairs(html.select(page, "#_imageList img")) do
    local src = img.attrs["data-url"] or img.attrs.src
    if src and src:find("pstatic.net", 1, true) and not src:find("bg_transparency", 1, true) then
      pages[#pages + 1] = fixUrl(src)
    end
  end
  if #pages == 0 then
    error("This episode has no pages to download. It may be locked (Daily Pass) or a motion comic.", 0)
  end
  local t = html.select_one(page, "h1.subj_episode") or html.select_one(page, ".subj_episode")
  return {
    pages = pages,
    headers = REFERER,
    filename = t and clean(t.text) or nil,
    comicInfo = { Manga = "No", Format = "Webtoon" },
  }
end

-- Covers need webtoons.com as the Referer.
function image(u)
  return { url = u, headers = REFERER }
end
