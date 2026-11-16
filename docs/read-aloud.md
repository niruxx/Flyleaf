# Read aloud

Open a reflowable ebook and choose **Read aloud** (the speaking-person icon) in
the reader toolbar. Press Play to start from the current visible sentence.
Playback follows the highlighted sentence across pages and chapters, skips empty
and non-linear successor sections, and stops at the end of the book.

The controls offer pause/resume, stop, **0.5–2×** speed, and a **5, 10, 15, 30 or
60 minute** sleep timer. Pausing or changing speed repeats the current sentence
when playback resumes. Long sentences use short speech chunks while the whole
sentence remains highlighted. A timer continues while paused; stop clears it.
Manual navigation, interacting with the ebook, closing the panel or leaving the
reader stops playback. Highlights are temporary overlays: no annotations, ebook
text or CFI paths are changed. Normal reader progress follows the spoken text.

This uses the browser's [Web Speech API](https://developer.mozilla.org/en-US/docs/Web/API/SpeechSynthesis).
The browser chooses an available voice for the book/sentence language. Voice
availability, pronunciation, offline support and background playback depend on
the browser and installed voices; some browser voices use a network service.
Flyleaf does not request microphone access or upload text to its own speech
service. If speech is unavailable, the toolbar button is hidden. If a voice
fails, playback stops with a message.

Supported formats are the reflowable text reader's EPUB, FB2, MOBI/AZW3 and
TXT/DOCX/RTF conversions. Scanned pages, PDFs, comics and fixed-layout ebooks do
not currently offer these controls. Audio files retain their audiobook controls.

## Verification

```text
node tests/read-aloud.test.cjs
node --experimental-vm-modules tests/frontend-modules.test.cjs
```

The Chromium regression uses the real reader/iframe DOM with mocked speech
utterances. It checks sentence ranges across inline markup, hidden text and line
breaks, overlay highlighting without DOM mutation, speed changes, stale callback
cancellation, chapter continuation, stop/close and mobile control bounds.
Controller tests cover pause/resume, sleep expiry, errors and asynchronous loading
cancellation. These checks do not verify physical audio output or installed voices.

Start `node tests/ebook-browser-server.cjs` and an isolated headless Chromium with
remote debugging on port 9227, then run:

```text
node tests/ebook-browser-check.cjs --speech
```
