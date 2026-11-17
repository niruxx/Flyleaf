# Home customization and activity

Choose **Customize home** at the top of Home to arrange your reading space. Each
account saves its own layout on the server, so it follows you between devices.

- Show or hide the welcome banner, reading shortcuts, and individual sections.
- Use the up and down buttons to put sections in your preferred order. These work
  with a keyboard and touch, as well as a mouse.
- Choose **Shelf default**, **Title A–Z**, **Title Z–A**, **Author A–Z**, or
  **Reading progress**. Progress puts the most complete items first. Alphabetical
  sorting uses the app language and treats numbered titles naturally (2 before 10).
- Enable **Compact cards** to fit more books on the screen.
- **Reset to defaults** resets the draft; **Save** applies it. Cancel leaves the
  saved layout intact. Saving requires a connection to the server.

Sorting changes the order within each shelf's existing selection. Recently added
still contains recent books, recommendations still contain suggested books, and
Continue reading still contains recently read books. Use the Library for sorting
the whole catalog. Empty sections and sections you do not have permission to use
remain absent.

Open **Activity center** in the navigation menu to see background work. Readers
see their uploads and, with Content Finder permission, their downloads. Admins
also see server downloads, library scans, automatic metadata matching, search
indexing, and backups created through the scheduled/stored-backup system.

The center refreshes while open, puts active work first, and offers status and task
type filters. Downloads can be cancelled while queued or running, and retried
after failure or cancellation. Admins can retry failed scans, metadata matching,
indexing, and stored backups. Retrying moves the original failure into history;
the new attempt appears as its own task. Other tasks have no cancellation control.
Upload failures must be uploaded again from the Upload page.

Task history starts when this feature is installed; existing download history is
also shown. Background history retains approximately 500 completed or failed
tasks, plus active work. Download results include up to 1,000 active/failed entries
and the latest 100 completed/cancelled entries. Interrupted background tasks are
marked failed after a server restart. The downloader retains its existing restart
recovery behavior.

Device sync, on-demand reader conversions, backup downloads, and restore operations
are not yet represented in this center. The security audit log remains under
**Settings → Activity**.

Validation includes the home-layout and task tests plus the frontend module check:

```sh
node --experimental-vm-modules tests/home-layout.test.cjs
node tests/tasks.test.cjs
node --experimental-vm-modules tests/frontend-modules.test.cjs
```

For browser verification, run `node scripts/screenshot-server.cjs`, launch a
disposable headless Chromium profile with `--remote-debugging-port=9233`, and run
`node scripts/check-home-activity.cjs`. The script uses fictional task responses
to check desktop and phone layouts, saving customization, filtering, retrying,
and cancelling. Screenshots are written to `data/ui-checks/`.
