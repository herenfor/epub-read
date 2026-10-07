# EPUB Reader

[![Latest release](https://img.shields.io/github/v/release/herenfor/epub-read?include_prereleases)](https://github.com/herenfor/epub-read/releases)
![Platforms](https://img.shields.io/badge/platforms-Windows%20%7C%20Android-informational)
[![License](https://img.shields.io/badge/license-PolyForm%20Strict%201.0.0-lightgrey)](LICENSE)

A lightweight EPUB reader for Windows and Android that respects each book's own typography.

EPUB Reader opens EPUB 2.0.1 and EPUB 3.x books as their authors designed them: page width, margins, floats, illustrations and footnotes keep the book's own layout, while the reader only supplies sensible defaults where they are missing.

**Languages:** English | [中文](README.zh.md)

## Contents

- [Platforms](#platforms)
- [Download and install](#download-and-install)
- [Highlights](#highlights)
- [Features](#features)
- [Privacy](#privacy)
- [Building from source](#building-from-source)
- [Roadmap](#roadmap)
- [Feedback](#feedback)
- [License](#license)

## Platforms

| Platform | Requirements | Package |
| --- | --- | --- |
| Windows | Windows 10 / 11 (x64) | Installer (`.exe`) and portable build |
| Android | Android 7.0 or later (arm64) | `.apk` |

## Download and install

Every build is published on the [Releases](https://github.com/herenfor/epub-read/releases) page.

### Windows

Download the installer or the portable build. Windows 10 and 11 already include the required WebView2 runtime; older or trimmed-down systems may need to install the [evergreen WebView2 runtime](https://developer.microsoft.com/microsoft-edge/webview2/) first.

### Android

1. Download the `.apk` file on your phone or tablet.
2. Open it. Android asks you to allow installing unknown apps — allow it for the browser or file manager you are using.
3. Once installed, EPUB Reader appears on your home screen.

The app is not distributed through Google Play, so Play Protect may warn about an unrecognised app the first time; choose *More details → Install anyway*.

To update, download the newer `.apk` and install it over the existing app. Your library and reading progress are kept.

To check for a new version, open the shelf settings, scroll to About and tap *检查更新* (Check for updates); it takes you straight to the releases page.

## Highlights

- **Read the way you prefer** — turn one page or a two-page spread, or scroll continuously from one chapter straight into the next, and switch between them at any time without losing your place
- **A quiet reading interface** — contents, bookmarks and notes share one drawer, and the rest of the reader stays out of the way
- **Layout you adjust as you read** — page colour, font, size, line height, spacing, margins and columns, changed from a small panel over the page
- **Kind to every pair of eyes** — Traditional/Simplified Chinese conversion and custom character replacement, grayscale/invert/dim filters, and assistance for red, green and blue colour weakness; all of them change only how the page is shown, never the book
- **Made for touch too** — swipe to turn pages on phones and tablets, with a slide animation that follows your finger and a library and menus rearranged for small screens
- **Illustrations at full size** — tap or click an image in the text to open it in an overlay, then zoom, pan or view it at its original size; closing returns you exactly where you were
- **Faithful to the book** — percentages, asymmetric margins, floats, full-page illustrations and inline footnote markers keep their intended proportions
- **Bring in a whole folder at once** — pick the folder where you keep your books, and they land on the shelf sorted into folders that follow your own directories, with duplicates recognised
- **Hand over to another device on your Wi‑Fi** — show a QR code on one device and scan it with the other to send books, progress, bookmarks and notes directly between them, without any cloud
- **Local by design** — no account and no upload; your books stay on your device

## Features

### Library

- Import books from a file picker, including batch import; on desktop, drag & drop works too
- Folder import: scan a whole directory and turn its sub-folders into shelf folders; preview the grouping first, stop at any time, and keep whatever was already imported
- Automatic duplicate detection — the same book is never added twice
- Cover grid with generated placeholder covers and a "new" badge
- Folders and favourites to organise the shelf — grouping a book never moves or copies the file
- Search, sort, layout density, theme and interface motion (full or reduced) managed from a single menu
- Reading progress and recently-read tracking; open a book right where you left it
- Portable reading archives to carry progress, bookmarks and safe settings between devices
- Device transfer: on the same Wi‑Fi, pair two devices with a QR code (or by pasting the connection info) and send progress, bookmarks and notes, optionally with the book files — both devices need version 0.2.8 or later, and a version mismatch now says plainly that an update is needed

### Reading

- EPUB 2 and EPUB 3 support, with contents, bookmarks and notes in a single drawer
- Page turning one page or two at a time, or continuous scrolling that carries on from one chapter into the next, chosen per book and remembered
- Layout controls: single or two-page spread, four page colours, font, size, line height, spacing, margins and columns
- Page-turn animation: slide, fade or none; touch page turns can be interrupted and dragged back and forth
- Character display: Traditional/Simplified conversion and custom replacement rules that change only what you see; search and "copy original" still follow the book's own text
- Visual filters: grayscale, invert, dim, saturation and sharpen, with a press-and-hold button to compare against the original
- Colour-weakness assistance for red, green and blue, with adjustable strength
- Long chapters are prepared in the background, so opening a book or reaching a heavy chapter does not hold up what you are reading
- A progress bar for the whole book, with chapter marks you can drag
- Illustrations open in an overlay with zoom, pan, fit-to-window and original-size views
- Footnotes in an overlay: hover to preview on desktop, click to pin and scroll
- Reading position is remembered by content anchor, so font, window and layout changes return you to the same passage
- Search inside the current book, or across the whole library
- Select text to copy it or attach a note; notes can be edited, deleted and jumped back from
- Fixed-layout (pre-paginated) books render as full pages
- A clear notice when a book is protected by DRM

### Per platform

- **Windows** — the system title bar is replaced by a slim frame that follows the app theme, keeps the book title and the window controls in the same bar, and lets you drag the window from it; EPUB files stay where they are, and the library links to them instead of copying
- **Android** — edge-to-edge immersive reading, swipe page turns, a battery indicator while reading, a built-in QR scanner for device transfer, and the system back gesture steps back one layer at a time

### Compatibility

EPUB files vary a great deal, and the reader is built to tolerate that:

- Percentages, asymmetric margins and floats keep their intended proportions
- Full-page illustrations, divider images and inline footnote markers render correctly
- Books that do not follow the specification closely still open and read as well as possible

## Privacy

EPUB Reader needs no account, collects no usage data, and never uploads your books, notes or reading progress anywhere. Everything stays on your device.

Device transfer connects your two devices directly over your local network with an encrypted, one-time pairing; nothing passes through a server. On Android the camera is used only while you scan a pairing QR code, and is requested the first time you do so.

## Building from source

You need [Node.js](https://nodejs.org/), [pnpm](https://pnpm.io/), [Rust](https://www.rust-lang.org/) and the [Tauri 2 prerequisites](https://v2.tauri.app/start/prerequisites/).

```bash
pnpm install
pnpm tauri:dev:core      # run the desktop app in development mode
pnpm test                # run the test suite
```

- Windows installer: run `pnpm build:windows` in PowerShell
- Android package: run `scripts/build-android.sh build` on Linux or WSL with the Android SDK, NDK and a JDK installed (the environment variables it reads are listed at the top of the script)

## Roadmap

- Semantic search that understands meaning, not only exact words
- AI-assisted questions and answers grounded in the book, with citations back to the original text
- Chapter and book summaries
- macOS, Linux and iOS builds

## Feedback

Bugs and suggestions are welcome in [Issues](https://github.com/herenfor/epub-read/issues) — every one of them gets read. Please include your platform and the app version (shown under About), and the book title if the problem only happens with one book.

## License

Copyright © 2026 HeRenFor.

Original code in EPUB Reader is made available under the [PolyForm Strict License 1.0.0](LICENSE) — a source-available license, not an OSI-approved open-source license.

The default license permits certain non-commercial use, but does not grant permission to modify, create derivative works from, or distribute the software.

Commercial use and other uses outside the scope of the PolyForm Strict License require a separate written license from the copyright holder.

For licensing inquiries, contact the repository owner through GitHub.

This repository is public, and GitHub's own Terms of Service allow public repositories to be viewed and forked. Beyond those platform terms and your rights under applicable law, the PolyForm Strict License grants no additional right to modify, create derivative works from, or redistribute the software.

Third-party components remain subject to their respective licenses. The project includes third-party components under MIT, Apache-2.0, MPL-2.0, BSD, ISC, Zlib, Unicode-3.0 and other licenses. Full lists, copyright notices, license texts and source locations are in [THIRD_PARTY_LICENSES.md](THIRD_PARTY_LICENSES.md), and the project license does not change them.

For additional licensing information, see [LICENSING.md](LICENSING.md). Contributions are handled separately — please get in touch first.
