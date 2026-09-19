# EPUB Reader

A lightweight desktop EPUB reader that respects each book's own typography.

EPUB Reader opens EPUB 2.0.1 and EPUB 3.x books as their authors designed them: page width, margins, floats, illustrations and footnotes keep the book's own layout, while the reader only supplies sensible defaults where they are missing.

**Languages:** English | [中文](README.zh.md)

## Highlights

- **Read the way you prefer** — turn pages or scroll continuously through the current chapter, and switch between the two at any time without losing your place
- **Page layout you control** — four-sided margins, one or two columns per screen and the column gap, adjustable without leaving the page
- **Illustrations at full size** — click an image in the text to open it in an overlay, then zoom, pan or view it at its original size; closing returns you exactly where you were
- **Faithful to the book** — percentages, asymmetric margins, floats, full-page illustrations and inline footnote markers keep their intended proportions
- **Local by design** — no account and no upload; books are read from where they already are

## Features

### Library

- Import books by file dialog or drag & drop, including batch import
- Automatic duplicate detection — the same book is never added twice
- Cover grid with generated placeholder covers and a "new" badge
- Search, sort, layout density and theme managed from a single menu
- Reading progress and recently-read tracking; open a book right where you left it
- Portable reading archives to carry progress, bookmarks and safe settings between devices
- Your EPUB files stay where they are — the library links to them instead of copying

### Reading

- EPUB 2 and EPUB 3 support with table-of-contents navigation
- Page turning or per-chapter scrolling, chosen per book and remembered
- Page options: four-sided margins, one or two columns per screen, and the column gap
- Illustrations open in an overlay with zoom, pan, fit-to-window and original-size views
- Footnotes in an overlay: hover to preview, click to pin and scroll
- Themes — light, dark and parchment — shared between the library and the reader
- Typography controls: font size, font weight, line height, letter and word spacing
- Reading position is remembered by content anchor, so font, window and layout changes return you to the same passage
- Search inside the current book, or across the whole library
- Select text to copy it or attach a note; notes can be edited, deleted and jumped back from
- Fixed-layout (pre-paginated) books render as full pages
- A clear notice when a book is protected by DRM

### Compatibility

EPUB files vary a great deal, and the reader is built to tolerate that:

- Percentages, asymmetric margins and floats keep their intended proportions
- Full-page illustrations, divider images and inline footnote markers render correctly
- Books that do not follow the specification closely still open and read as well as possible

## Download

Windows installers and portable builds are published on the [Releases](https://github.com/herenfor/eupb-read/releases) page.

Windows 10 and 11 already include the required WebView2 runtime; older or trimmed-down systems may need to install the evergreen WebView2 runtime first.

## Roadmap

- Semantic search that understands meaning, not only exact words
- AI-assisted questions and answers grounded in the book, with citations back to the original text
- Chapter and book summaries
- macOS and Linux builds

## License

Original code in this project is licensed under the [Apache License 2.0](LICENSE).

The project includes third-party components under MIT, Apache-2.0, MPL-2.0, BSD, ISC, Zlib, Unicode-3.0 and other licenses. Full lists, copyright notices, license texts and source locations are in [THIRD_PARTY_LICENSES.md](THIRD_PARTY_LICENSES.md).

The project license does not change the licenses of third-party components.
