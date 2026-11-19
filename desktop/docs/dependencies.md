# Native reader dependencies

The client uses Qt Widgets, not a browser. Python packages are pinned in
`requirements.txt` and `pyproject.toml`; native runtimes require separate packaging
and license review before distributing an installer.

| Component | Purpose | Terms / deployment |
|---|---|---|
| PySide6 Essentials 6.12.0 | Qt Widgets, Network and native drawing | Qt/PySide LGPL/GPL/commercial terms; keep applicable notices and relinking obligations |
| PyMuPDF 1.26.7 / MuPDF | PDF and EPUB rendering | **AGPL or commercial**; choose a compliant distribution model before release |
| Pillow 12.1.0 | Image crop and paper filters | HPND/Pillow terms and bundled codec notices |
| python-vlc 3.0.21203 | Native audio API bindings | LGPL bindings; requires a separately installed libVLC runtime |
| VLC/libVLC | Audio codecs, playback and seeking | Runtime/components have their own LGPL/GPL and codec terms; not bundled in the Python wheel |
| pyttsx3 2.99 | Linux system voice adapter | MPL-2.0; requires installed eSpeak/system voices |
| pywin32 312 | Windows SAPI voice events | PSF-style license; uses installed Windows voices |
| PyWinRT packages (pinned in requirements) | Windows SMTC metadata/transport | MIT bindings; Windows system APIs |
| dbus-next 0.2.3 | Linux MPRIS media session | MIT; requires an existing desktop session bus |
| Roboto Flex | Local UI typography | SIL Open Font License bundled beside the font |
| SecretStorage (optional) | Linux remembered-session vault | BSD-3-Clause adapter; existing unlocked Secret Service required |

MuPDF licensing: [official license statement](https://pymupdf.readthedocs.io/en/latest/about.html#license-and-copyright).
VLC runtime: [VideoLAN developer information](https://www.videolan.org/developers/vlc.html).

The local Windows audio check uses VLC 3.0.24 in the ignored `desktop/build/vlc/`
directory, downloaded from VideoLAN and checked against its published SHA-256.
It is a development dependency, not a shipped installer asset. Clean-machine Windows
and Linux packaging and third-party notice assembly remain roadmap gates.

Documents are limited to 128 MiB downloaded, 256 MiB expanded EPUB content and
20,000 pages/archive entries. Native rendering runs in a disposable process because
MuPDF is not thread-safe. This is crash isolation, not an OS security sandbox.

Converted FB2/MOBI/AZW3/TXT/DOCX/RTF depend on server conversion. A conversion
failure is shown as a reader error. FB2/MOBI/AZW3 use bounded process-isolated
server conversion at `/file?native=epub`, preserving the pinned Foliate section DOM
and CFIs; TXT/DOCX/RTF retain their existing canonical conversion. The native fixtures
pass separately from existing KOReader/device MOBI/KF8 server regressions. Advanced
fixed-layout, embedded-font, vertical-text and publisher CSS corpora remain pending.
Unsupported or ambiguous EPUB positions are never replaced with guessed percentages.
