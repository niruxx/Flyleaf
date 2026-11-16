# Roadmap


### 🟨 KOReader and Kobo sync

Both integrations are implemented and covered by automated tests; full device compatibility
is still being verified. [Setup, supported formats and limitations](docs/device-sync.md)

- 🟨 **KOReader** (`/api/kosync`): revocable API-key login, checksum matching and two-way
  progress for pages, EPUB, FB2 and supported legacy MOBI6 layouts, with native-anchor fallback.
  MOBI/KF8/AZW3 can also download a position-preserving EPUB for KOReader; device validation
  targets **2026.07.1** and remains pending.
- 🟨 **Kobo sync** (`/api/kobo/<key>`): collection delivery, covers, cached KEPUB downloads,
  two-way reading progress, individual-book shelf edits, resumable pagination and batch updates.

**Remaining work**

- ✅ **Complex MOBI positions**: two-way mapping for filepos/NCX targets, including mid-text
  splits, nested tables with explicit or implicit row groups, and preformatted Unicode text.
  Native observations distinguish legacy/modern anchor DOMs; ambiguous or malformed layouts
  keep compatible native-anchor fallback. Physical-device validation remains separate below.
- ✅ **KF8/AZW3 interoperability**: cached EPUB downloads for reflowable, unencrypted books,
  preserving Foliate section/text CFI paths and matching the generated binary checksum back
  to the original library book. Unsupported conversions fail explicitly; originals stay intact.
- ✅ **Publisher CSS compatibility**: specificity-preserving body/non-body branches for
  ambiguous and stateful selectors, including functional selectors and imported stylesheets.
  EPUB positions resolve the static whitespace cascade; device-dependent or unsupported
  whitespace uses native-anchor fallback. Firmware/rendering validation remains below.
- 🟨 **Device validation**: test actual KOReader and Kobo versions for rendering, fixed-layout
  books, bookmarks, interrupted sync and shelf edits, then document supported versions.
  [Validation checklist](docs/device-sync.md#compatibility-validation)

---

## 📖 Reader

- ✅ **Text-to-speech / read aloud** with the Web Speech API: current-sentence highlighting,
  play/pause/stop, 0.5–2× speed, a sleep timer and automatic chapter continuation for reflowable
  ebooks. Uses browser voices; navigation and closing the reader stop playback.
  [Usage and browser limits](docs/read-aloud.md)

---

## 👥 Accounts & security

- ⬜ **Single sign-on** with OpenID Connect (Authelia, Authentik, Keycloak): Kavita and Komga
  have it, and it's the most-requested feature for shared servers
- ⬜ **Two-factor authentication** (TOTP) for the admin account
---

## 🛠️ Platform

- ⬜ **Publish the Docker image** to a registry (GitHub Container Registry) from CI, for `docker pull`
