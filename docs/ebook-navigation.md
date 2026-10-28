# Ebook navigation reliability

Two problems could leave the mobile ebook reader blank or unable to navigate:

1. The Book animation left the live `foliate-view` at 90 degrees while navigation measured
   `getBoundingClientRect()`. Its viewport width was effectively zero. The lift is now cancelled
   before the renderer advances, and is also cancelled in `finally` if a turn fails.
2. Foliate's touch settling could start a second chapter load during a programmatic turn,
   destroying the iframe whose load event the first turn awaited. This reproduces
   [upstream issue #149](https://github.com/johnfactotum/foliate-js/issues/149).

`server/foliate-patch.js` applies narrowly checked fixes to the pinned renderer when the server
serves `/vendor/foliate/paginator.js`. It does not modify `node_modules`. Snap and direct navigation
share a lock; failures release that lock; iframe load errors, cancellation and rendering exceptions
reject instead of silently hanging. A section iframe load timeout cancels that operation before
releasing the lock, rather than unlocking an operation that might later mutate the reader.
Queued resize/font callbacks ignore disconnected or bodyless documents.

`TextEngine` ignores overlapping page taps, keeps controls reachable during slow turns, reports
navigation failures and tries to restore the saved location. Taps on the surrounding stage also
reach the reader controls. Written annotations and reading position formats are unchanged.

Restart Flyleaf and reopen the reader after updating. The patched vendor module is served with
revalidation, and the service-worker cache version is bumped so updated reader code is loaded.
When updating foliate-js, review the compatibility patch: it deliberately rejects unexpected source
instead of silently applying a partial fix.

## Tests

```text
node tests/ebook-navigation.test.cjs
node --experimental-vm-modules tests/frontend-modules.test.cjs
```

For browser regression checks, start `node tests/ebook-browser-server.cjs`. It generates a five-chapter
EPUB in memory and serves the real reader and vendor modules, without opening a database or accessing
real books. In an isolated Chromium/Edge profile, enable remote debugging on port 9227, then run:

```text
node tests/ebook-browser-check.cjs
```

Use `EBOOK_TEST_CDP` to change the debugging endpoint. The test reproduces the race in the original
paginator, verifies the patched operation settles and later navigation reaches its target, checks
retry after a failed chapter load, and reads across all five chapters with both Book and Slide
animations while repeatedly checking center-tap controls. Browser validation uses mobile emulation;
physical iOS/Safari devices are not covered by that test.
