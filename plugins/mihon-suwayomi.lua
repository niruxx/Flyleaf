-- Mihon / Tachiyomi extensions, through Suwayomi-Server.
--
-- Mihon extensions are Android apps, so Flyleaf can't run them itself. Suwayomi-Server
-- (https://github.com/Suwayomi/Suwayomi-Server) runs them on a normal computer; this
-- plugin talks to it. Every extension installed there shows up as its own source in
-- Content Finder, and chapters are downloaded page by page into CBZ files.

plugin = {
  id = "mihon",
  name = "Mihon extensions",
  version = "1.1.1",
  author = "Flyleaf",
  description = "Use Mihon/Tachiyomi extensions as sources, through a Suwayomi-Server you run.",
  site = "https://github.com/Suwayomi/Suwayomi-Server",
  kinds = { "manga", "comics" },
  proxy_images = true,
  settings = {
    { key = "url", label = "Suwayomi URL", type = "text", required = true, default = "http://localhost:4567", help = "Where Suwayomi-Server runs, as seen from the Flyleaf server" },
    { key = "username", label = "Username", type = "text", help = "Only if Suwayomi uses basic authentication" },
    { key = "password", label = "Password", type = "password" },
    { key = "languages", label = "Languages", type = "text", default = "en", help = "Comma-separated language codes to show, e.g. en,ja. Leave empty for all." },
    { key = "nsfw", label = "Show NSFW sources", type = "toggle", default = false },
  },
}

local function base()
  local u = (settings.url or ""):gsub("/+$", "")
  if u == "" then error("Set the Suwayomi URL in this plugin's settings.", 0) end
  return u
end

local function auth()
  if settings.username and settings.username ~= "" then
    return { Authorization = "Basic " .. base64.encode(settings.username .. ":" .. (settings.password or "")) }
  end
  return {}
end

local function api(path)
  local ok, res = pcall(http.get, base() .. "/api/v1" .. path, { headers = auth() })
  if not ok then error("Can't reach Suwayomi at " .. base() .. ". Is it running?", 0) end
  if res.status == 401 then error("Suwayomi rejected the login. Check the username and password (Suwayomi must use basic authentication).", 0) end
  if not res.ok then error("Suwayomi returned HTTP " .. res.status .. " for " .. path, 0) end
  return json.decode(res.body)
end

local function abs(u)
  if not u or u == "" then return nil end
  return url.resolve(base() .. "/", u)
end

local function wanted_languages()
  local set, any = {}, false
  for code in (settings.languages or ""):gmatch("[^,%s]+") do set[code:lower()] = true; any = true end
  return any and set or nil
end

-- One Content Finder source per Mihon source (extension + language).
function sources()
  local langs = wanted_languages()
  local out = {}
  for _, s in ipairs(api("/source/list")) do
    local lang = (s.lang or ""):lower()
    local language_ok = not langs or langs[lang] or lang == "all" or lang == "localsourcelang"
    if language_ok and (settings.nsfw or not s.isNsfw) then
      local label = s.displayName or s.name
      if lang ~= "" and lang ~= "all" and lang ~= "localsourcelang" and not label:lower():find("(" .. lang .. ")", 1, true) then
        label = label .. " (" .. lang .. ")"
      end
      out[#out + 1] = { id = tostring(s.id), name = label, icon = abs(s.iconUrl), language = lang, nsfw = s.isNsfw, browse = true }
    end
  end
  return out
end

local function manga_list(r)
  local items = {}
  for _, m in ipairs(r.mangaList or {}) do
    items[#items + 1] = { id = tostring(m.id), title = m.title, author = m.author, cover = abs(m.thumbnailUrl) }
  end
  return { items = items, hasMore = r.hasNextPage == true }
end

function search(query, page)
  return manga_list(api("/source/" .. source.id .. "/search?searchTerm=" .. url.encode(query) .. "&pageNum=" .. (page or 1)))
end

-- "Popular" from the source.
function latest(page)
  return manga_list(api("/source/" .. source.id .. "/popular/" .. (page or 1)))
end

local STATUS = { ONGOING = "Ongoing", COMPLETED = "Completed", LICENSED = "Licensed", PUBLISHING_FINISHED = "Finished", CANCELLED = "Cancelled", ON_HIATUS = "On hiatus" }

function details(id)
  local m = api("/manga/" .. id .. "?onlineFetch=true")
  local chapters = api("/manga/" .. id .. "/chapters?onlineFetch=true")
  -- Oldest first.
  table.sort(chapters, function(a, b) return (a.index or 0) < (b.index or 0) end)
  local files = {}
  for _, c in ipairs(chapters) do
    local date = c.uploadDate and c.uploadDate > 0 and os.date("!%Y-%m-%d", c.uploadDate // 1000) or nil
    files[#files + 1] = {
      id = id .. ":" .. c.index,
      title = c.name,
      format = "cbz",
      chapter = (c.chapterNumber or -1) >= 0 and c.chapterNumber or nil,
      date = c.scanlator and c.scanlator ~= "" and ((date and date .. " · " or "") .. c.scanlator) or date,
    }
  end
  local people = {}
  if m.author and m.author ~= "" then people[#people + 1] = m.author end
  if m.artist and m.artist ~= "" and m.artist ~= m.author then people[#people + 1] = m.artist end
  return {
    title = m.title,
    series = m.title,
    author = #people > 0 and table.concat(people, ", ") or nil,
    cover = abs(m.thumbnailUrl),
    summary = m.description,
    genres = m.genre or {},
    status = STATUS[m.status],
    url = m.realUrl,
    files = files,
  }
end

function download(file_id)
  local manga, index = file_id:match("^(%d+):(%d+)$")
  if not manga then error("Unknown chapter.", 0) end
  -- Fetching the chapter makes Suwayomi load its page list from the source.
  local c = api("/manga/" .. manga .. "/chapter/" .. index)
  local count = c.pageCount or 0
  if count < 1 then error("Suwayomi couldn't load the pages of this chapter.", 0) end
  local pages = {}
  for i = 0, count - 1 do
    pages[#pages + 1] = base() .. "/api/v1/manga/" .. manga .. "/chapter/" .. index .. "/page/" .. i
  end
  return { pages = pages, headers = auth(), filename = c.name, comicInfo = { Number = (c.chapterNumber or -1) >= 0 and c.chapterNumber or nil } }
end

-- Covers and icons come from Suwayomi, which may need the login. Never send it anywhere else.
function image(u)
  local root = base() .. "/"
  return { url = u, headers = u:sub(1, #root) == root and auth() or {} }
end
