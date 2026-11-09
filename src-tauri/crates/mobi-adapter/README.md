# mobi-adapter

Standalone MOBI6 / KF8 (AZW3) parsing and temporary reading-EPUB adapter.
This crate is deliberately independent of the application: ER-0141 owns the
Tauri commands, database/capability versions, routing and UI wiring.

- Input: a bounded Rust source (regular file, explicit `base + length` window,
  or caller-owned reader). No whole-book JavaScript byte array.
- Output: metadata/cover, or one releasable EPUB 2 reading archive for the
  existing EPUB loader.
- Backend: vendored libmobi 0.12 (`9062742`) with bundled miniz, no system
  zlib/libxml2 and no encryption module. See `vendor/libmobi/PATCHES.md`.
- License: crate code GPL-3.0-only; vendored libmobi LGPL-3.0-or-later. See
  `THIRD_PARTY.md` and `vendor/libmobi/COPYING`.

## Public interface

```rust
use mobi_adapter::{convert, inspect, CancelToken, Limits, Source};

let limits = Limits::default();

// Metadata/cover only. Does not reconstruct rawml or write an archive.
let metadata = inspect(Source::from_path("book.mobi")?, &limits)?;
let cover = metadata.cover; // Option<Cover { bytes, mime }>

// Whole conversion. The destination is written atomically.
let cancel = CancelToken::new();
let report = convert(
    Source::from_path("book.azw3")?,
    std::path::Path::new("book.reading.epub"),
    &limits,
    &cancel,
)?;
println!("spine parts: {}", report.markup_parts);
```

Relevant types:

| Item | Contract |
|---|---|
| `Source::from_file(File)` | Owns a whole regular file; its length becomes the source budget check. |
| `Source::from_file_window(File, offset, length)` | Copies only the declared window, verifies `offset + length <= file_len`, and never reads before/after it. This is the Android SAF/base+length shape. |
| `Source::from_path(path)` | Rust Unicode path handling, then the whole-file contract. Windows never passes the path to libmobi. |
| `Source::from_reader(Box<dyn Read + Send>, length)` | Caller-owned bounded stream; exactly `length` bytes are read. |
| `inspect` | Returns `MobiMetadata`; the temporary stream is dropped before return. |
| `convert` | Returns `ConversionReport` (including declared `text_length`); destination replaced only after parsing, budgets and ZIP finalization pass. |
| `CancelToken` | Cloneable external stop flag; checked at phase boundaries and before every part. |
| `Limits` | Per-call source/part/total/output/cover/metadata/part-count budgets. |

`convert` is deterministic for the same source and limits: part names come
from libmobi's fixed `partNNNNN`, `flowNNNNN` and `resourceNNNNN` ids, not from
temporary paths, random ids, font size or pagination. Combo files always use
KF8; a KF8 failure is returned as an error, never a silent MOBI6 fallback.

For MOBI6 only, the temporary reading EPUB normalizes Kindle's legacy
presentational markup in place: nested `<blockquote>` margins are capped at two
indent levels without dropping elements or ids, `<p height>`/`<p width>`
become `margin-top` (with the UA bottom margin cleared) and `text-indent` CSS,
and `<mbp:pagebreak>` becomes a multicolumn break. Tag-only rewriting keeps
every text node, part name and anchor unchanged. KF8/AZW3 parts are copied
byte-for-byte.

## Stable error codes

| `MobiErrorCode::as_str()` | Meaning |
|---|---|
| `mobi.io` | Source/temporary stream I/O failure. |
| `mobi.source` | Empty, disappeared, or short bounded source; window overflow. |
| `mobi.parse` | PalmDB/MOBI records or rawml reconstruction failed. |
| `mobi.unsupported` | Recognized but unsupported version/representation. |
| `mobi.encrypted` | Any non-zero PalmDOC encryption value; decryption is absent. |
| `mobi.replica` | AZW4/Print Replica. |
| `mobi.dictionary` | Dictionary with orthographic index. |
| `mobi.budget` | A `Limits` value was exceeded. |
| `mobi.cancelled` | The token was set at a checkpoint. |
| `mobi.output` | EPUB ZIP writing or final rename failed. |
| `mobi.no_opf` | libmobi reconstructed no OPF package document. |
| `mobi.memory` | C allocation failure. |
| `mobi.internal` | Invariant violation/bug. |

`MobiError::code()` returns the enum and `message()` a detail. Callers must map
the stable string, not parse the message.

## Cancellation, ownership and temporary data

- The source is streamed into an owned anonymous temporary file. No whole-book
  `Vec` is created; libmobi reads the stream, then the file descriptor is
  closed before parsing continues.
- One opaque C handle owns `MOBIData` and `MOBIRawml`. `Drop` frees rawml first,
  then `MOBIData`. Part slices are borrowed only while the handle is alive and
  are written one at a time into the ZIP.
- The PalmDOC header's declared uncompressed text length is checked against
  `max_total_bytes` before `mobi_parse_rawml_opt`, before decompression. Part
  sizes are then checked while each part is written.
- `mobi_parse_rawml_opt` is synchronous and has no cancel callback. The token
  is checked before and after it, and before each part, before ZIP
  finalization and before the final rename. A token set during the C parse is
  observed immediately after it returns, so no EPUB is published.
- Cancellation/failure drops the destination temporary file. An existing
  destination is replaced only after a fully finalized ZIP passes all budgets.
- No permanent conversion cache, background service or watch dog is created.
  The temporary EPUB lifecycle belongs to the caller (ER-0141).

## Large offsets and platform stream boundaries

The vendored `read.c`/`write.c` patches use `_fseeki64`/`_ftelli64` on Windows
and `fseeko`/`ftello` elsewhere. The last record size is validated before
narrowing to `size_t`; equal adjacent offsets are a legal zero-length record,
while descending offsets and a last record beyond EOF are rejected. Zero-length
records keep a valid one-byte buffer and skip the zero-byte `fread`, avoiding
platform-dependent `malloc(0)` behavior. Write-side offsets are checked against
`UINT32_MAX` instead of wrapping.
`max_source_bytes` still applies; an oversized source is rejected, never
truncated and parsed.

`mobi_adapter_open_handle` takes an owned POSIX fd or Windows HANDLE. Windows
therefore uses Rust's Unicode path opening plus a handle, not libmobi's narrow
`mobi_load_filename`. The C bridge takes ownership in all cases and closes the
stream after `mobi_load_file` has copied the records.

## Building and targeted verification

```sh
cd src-tauri/crates/mobi-adapter
cargo build --offline
cargo test --offline
```

Real samples are supplied out of band so public books/upstream fixtures do not
enter the product Git tree:

| Variable | Fixture |
|---|---|
| `MOBI_ADAPTER_MOBI6` | public MOBI6 sample |
| `MOBI_ADAPTER_KF8` | public KF8/AZW3 sample |
| `MOBI_ADAPTER_COMBO` | KF7/KF8 combo sample |
| `MOBI_ADAPTER_DRM` | encryption=2 sample |
| `MOBI_ADAPTER_FONTS` | KF8 sample with an obfuscated font |

Example:

```sh
MOBI_ADAPTER_MOBI6=/path/alice.mobi \
MOBI_ADAPTER_KF8=/path/pride.azw3 \
MOBI_ADAPTER_COMBO=/path/combo.mobi \
MOBI_ADAPTER_DRM=/path/drm.mobi \
MOBI_ADAPTER_FONTS=/path/fonts.mobi \
cargo test --offline -- --nocapture
```

The 3 GiB sparse large-offset check is opt-in because not every filesystem
supports sparse files:

```sh
MOBI_ADAPTER_MOBI6=/path/alice.mobi MOBI_ADAPTER_LARGE_OFFSET=1 \
  cargo test --offline sparse_large_offset_record_uses_64_bit_seek
```

Android arm64 (NDK r28c/API 24) was built with the same explicit PIC source
split as ER-0104. The Windows x64 MSVC build and the Unicode-path/handle run
were also exercised for this module; see the ER-0140 ledger record for actual
commands and evidence paths.

## Known limits

- No DRM decryption. Every non-zero encryption type is rejected before parse.
- No dictionary, Print Replica/AZW4, KFX or fixed-layout AZW4 support.
- libmobi loads the PDB records and reconstructs the whole rawml in memory;
  the byte budgets are defenses, not a lazy parser. `inspect` avoids rawml but
  still pays libmobi's record load.
- MOBI6 is reconstructed as one spine part; libmobi's NCX/guide is preserved,
  but the adapter does not claim a per-chapter split.
- The source and output are read/written through Rust; no second Kindle
  pagination/rendering engine is implemented.

## Integration handoff (ER-0141)

Add this crate as a path dependency and own the application root `Cargo.toml`/
`Cargo.lock`, build wiring, format enum, capability version, source/URI
binding and command/UI routing. Do not edit `vendor/libmobi` or the adapter's
C ABI here; update the root third-party notice with the `THIRD_PARTY.md`
content when the dependency actually enters the product.
