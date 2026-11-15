# 🌿 Flyleaf — Your library. Your happy little place.

A warm, expressive showcase for **[Flyleaf](https://github.com/niruxx/Flyleaf)**, the self-hosted library and reader for books, manga and comics.

![Flyleaf desktop library](assets/desktop-home.png)

## ✨ What’s inside

- Material Design 3 Expressive inspired styling: soft green surfaces, playful shapes, generous typography and rounded controls.
- Real, locally hosted desktop and mobile screenshots from Flyleaf.
- Interactive reader illustration with three sample pages, paper/sepia/dark themes, font sizing and session bookmarks.
- Product overview and reasons to choose a self-hosted library.
- Responsive layouts, keyboard controls, visible focus, skip link and reduced-motion support.
- Static HTML, CSS and JavaScript. No dependencies or build step.

## 🚀 Run locally

Open `index.html` directly, or serve the repository:

```sh
python -m http.server 8000
```

Visit **http://localhost:8000**. Google Fonts is optional; system fonts provide an offline fallback.

## 🌐 Publish on GitHub Pages

1. Push the `website` branch to `niruxx/Flyleaf` on GitHub.
2. Open **Settings → Pages → Build and deployment**.
3. Choose **GitHub Actions** as the source.
4. Push a commit to `website` to trigger **Deploy to GitHub Pages**. If the `github-pages` environment restricts deployment branches, allow `website` in Settings → Environments.

The workflow uploads only public website files. The live URL appears in the deployment and Pages settings. Relative assets support project sites and custom domains.

Alternatively, choose **Deploy from a branch → website → / (root)**. Use either branch publishing or the Actions workflow above. The expected project URL is https://niruxx.github.io/Flyleaf/ unless a custom domain is configured.

## 🛠️ Make it yours

| File | Purpose |
| --- | --- |
| `index.html` | Content and screenshot layout |
| `styles.css` | Colour tokens, typography and responsive styling |
| `script.js` | Reader illustration and controls |
| `assets/` | Screenshots, icon and upstream license |
| `.github/workflows/pages.yml` | GitHub Pages deployment |

Edit the tokens in `styles.css` to change the palette. Refresh images in `assets/` and check product copy against the upstream README as Flyleaf evolves.

## 📖 About the demo

The embedded reader is an illustration, **not the Flyleaf application**. It does not upload books, connect to a server or persist data. Install the full app using the [official instructions](https://github.com/niruxx/Flyleaf#readme). GitHub Pages hosts this showcase; Flyleaf itself needs its own server.

## 💚 Credits

Product details, screenshots and icon: [niruxx/Flyleaf](https://github.com/niruxx/Flyleaf), described as MIT licensed in its README. Asset sources and licensing notes are in [`assets/ATTRIBUTION.md`](assets/ATTRIBUTION.md). Cover artwork visible in upstream screenshots retains its respective rights. Reader excerpt: Lewis Carroll’s *Alice’s Adventures in Wonderland* (public domain). DM Sans and Manrope are served through Google Fonts.


## Repository layout

The service lives on the `main` branch of `niruxx/Flyleaf`. This independent `website` branch preserves the history imported from `niruxx/Flyleaf-website`. Keep website changes on this branch; do not merge it into `main`.

To edit in a separate checkout:

```sh
git fetch origin website
git worktree add ../Flyleaf-site website
```

The previous project address (https://niruxx.github.io/Flyleaf-website/) will not automatically redirect to the new address. Keep the old repository available until the new deployment is verified and any old links are updated.
