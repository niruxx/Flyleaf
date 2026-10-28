# Reading room UI

Flyleaf's Material 3 Expressive presentation lives in `public/css/expressive.css`, loaded after
its existing component styles. It reuses the dynamic Material color roles, user themes, fonts
and reduced-motion preferences. Reader page transforms and gesture handling stay in `reader.css`.

The shell prioritizes Home, Library, Want to read and Reading lists. Notes, statistics and offline
books remain one click away. Library shortcuts, collections, genres, saved shelves and discovery
use native disclosure groups; the group containing the active destination opens automatically.
The desktop sidebar is persistent. On smaller screens it becomes a keyboard-accessible drawer,
while phones retain bottom navigation. Closed mobile navigation is inert, Escape closes it,
and focus returns to the menu button.

Home leads with the current book and a direct Continue reading action, then reading shortcuts,
other books in progress, reading activity and existing recommendation/library shelves. Its data
continues to come from the existing APIs. A book-free state offers Browse library instead.

Library reading-state tabs and sorting remain visible. Additional publication, personal-status
and genre filters sit in a disclosure, whose label reports the number of active filters. Settings
keep their grouped desktop navigation and use a native grouped section picker on smaller screens.

Shared typography, tonal groups, rounded controls and cover presentation carry through the other
pages. The new stylesheet is included in the offline shell cache; changing that asset also
requires updating the service-worker version.

Browser validation used demo data with the real frontend in Edge: light/dark Home, library,
series and settings layouts; 320, 390, 768, 1024 and 1440-pixel viewports; filter requests;
mobile settings navigation; drawer focus and Escape; and the skip-to-content link. No live library
or account data was changed during preview.
