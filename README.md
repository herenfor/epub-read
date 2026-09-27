# EPUB Reader

A lightweight desktop EPUB reader that respects each book's own typography.

EPUB Reader opens EPUB 2.0.1 and EPUB 3.x books as their authors designed them: page width, margins, floats, illustrations and footnotes keep the book's own layout, while the reader only supplies sensible defaults where they are missing.

**Languages:** English | [中文](README.zh.md)

## Highlights

- **Read the way you prefer** — turn pages, or scroll continuously from one chapter straight into the next, and switch between the two at any time without losing your place
- **A quiet reading surface** — contents, bookmarks and notes share one drawer, which can float over the page or sit pinned beside it, and the footer stays out of the way until you reach for it
- **Typography you can see while you change it** — page colour, font, size, line height, margins and columns live in one small panel over the page instead of a settings window
- **Illustrations at full size** — click an image in the text to open it in an overlay, then zoom, pan or view it at its original size; closing returns you exactly where you were
- **Faithful to the book** — percentages, asymmetric margins, floats, full-page illustrations and inline footnote markers keep their intended proportions
- **One clean window** — the system title bar is replaced by a slim frame that follows the app theme, keeps the book title and the window controls in the same bar, and lets you drag the window from it
- **Local by design** — no account and no upload; books are read from where they already are

## Features

### Library

- Import books by file dialog or drag & drop, including batch import
- Automatic duplicate detection — the same book is never added twice
- Cover grid with generated placeholder covers and a "new" badge
- Folders and favourites to organise the shelf — grouping a book never moves or copies the file
- Search, sort, layout density and theme managed from a single menu
- Reading progress and recently-read tracking; open a book right where you left it
- Portable reading archives to carry progress, bookmarks and safe settings between devices
- Your EPUB files stay where they are — the library links to them instead of copying

### Reading

- EPUB 2 and EPUB 3 support, with contents, bookmarks and notes in one drawer you can pin beside the page or let float over it
- Page turning, or continuous scrolling that carries on from one chapter into the next, chosen per book and remembered
- One typography panel: four page colours — white, parchment, gray and night — with font size, font family, line height, margins and columns, and letter and word spacing under the advanced options
- Optional instant page turns, with no transition to wait for
- A whisper footer showing the page, the time left in the chapter and the whole book's progress; reach for it and it opens into a chapter scrubber with tick marks you can drag
- Illustrations open in an overlay with zoom, pan, fit-to-window and original-size views
- Footnotes in an overlay: hover to preview, click to pin and scroll
- Bookmarks remember the reading line they were taken on, so jumping back lands the same passage in the same place, and each one shows when it was added
- Search inside the current book, or across the whole library
- Select text to copy it or attach a note; notes can be edited, deleted and jumped back from in the same drawer
- Reading position is remembered by content anchor, so font, window and layout changes return you to the same passage
- Fixed-layout (pre-paginated) books render as full pages
- A clear notice when a book is protected by DRM

### Compatibility

EPUB files vary a great deal, and the reader is built to tolerate that:

- Percentages, asymmetric margins and floats keep their intended proportions
- Full-page illustrations, divider images and inline footnote markers render correctly
- Books that do not follow the specification closely still open and read as well as possible

## Download

Windows installers and portable builds are published on the [Releases](https://github.com/herenfor/epub-read/releases) page.

Windows 10 and 11 already include the required WebView2 runtime; older or trimmed-down systems may need to install the evergreen WebView2 runtime first.

## Roadmap

- Semantic search that understands meaning, not only exact words
- AI-assisted questions and answers grounded in the book, with citations back to the original text
- Chapter and book summaries
- macOS and Linux builds

## License

Copyright © 2026 HeRenFor.

Original code in EPUB Reader is made available under the [PolyForm Strict License 1.0.0](LICENSE) — a source-available license, not an OSI-approved open-source license.

The default license permits certain non-commercial use, but does not grant permission to modify, create derivative works from, or distribute the software.

Commercial use and other uses outside the scope of the PolyForm Strict License require a separate written license from the copyright holder.

For licensing inquiries, contact the repository owner through GitHub.

This repository is public, and GitHub's own Terms of Service allow public repositories to be viewed and forked. Beyond those platform terms and your rights under applicable law, the PolyForm Strict License grants no additional right to modify, create derivative works from, or redistribute the software.

Third-party components remain subject to their respective licenses. The project includes third-party components under MIT, Apache-2.0, MPL-2.0, BSD, ISC, Zlib, Unicode-3.0 and other licenses. Full lists, copyright notices, license texts and source locations are in [THIRD_PARTY_LICENSES.md](THIRD_PARTY_LICENSES.md), and the project license does not change them.

For additional licensing information, see [LICENSING.md](LICENSING.md). Contributions are handled separately — please get in touch first.
