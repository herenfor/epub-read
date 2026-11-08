# Vendored libmobi and local patches

Upstream: <https://github.com/bfabiszewski/libmobi>

- Version: 0.12 (commit `906274205c11944b628da1c553b255acb1af7c55`)
- License: LGPL-3.0-or-later, see `COPYING`
- Source: `src/` is copied from the pinned checkout used by ER-0068/ER-0104
  (`.development/er0068-platform-probe/source/libmobi-9062742`). The upstream
  README/AUTHORS/ChangeLog/NEWS are kept for provenance.
- Not copied: upstream build systems, tools, tests and samples. The Rust
  crate's `build.rs` lists the C sources explicitly; only unencrypted reading
  and rawml reconstruction are enabled.

## Local patches

The only source changes are in `src/read.c`, `src/write.c` and the added
`src/portable_io.h`:

1. `read.c` uses `mobi_fseek64`/`mobi_ftell64` for the last-record size and for
   record data seeks. The original used 32-bit `long`, which truncates on
   Windows x64. The end offset is checked to be non-negative and no larger than
   `SIZE_MAX`; a negative end-minus-offset (last record beyond EOF) is rejected.
2. Adjacent non-last record offsets must be nondecreasing. Equal offsets are a
   legal zero-length record; only a truly descending offset is rejected. The
   last record may end exactly at EOF as an empty record.
   `mobi_load_recdata` gives an empty record a valid one-byte buffer and skips
   the zero-byte `fread`, avoiding platform-dependent `malloc(0)` behavior
   while keeping the record size at zero.
3. `write.c` uses the same 64-bit helpers and checks the record-table offset
   and every record payload against `UINT32_MAX` before narrowing. The original
   comparison was against a `uint32_t` and could wrap.
4. `portable_io.h` maps to `_fseeki64`/`_ftelli64` on Windows and to
   `fseeko`/`ftello` (with `_FILE_OFFSET_BITS=64` on 32-bit POSIX) elsewhere.

Markup, metadata, file naming, compression and encryption behavior is unchanged;
only the stream boundary repair and zero-length record handling differ.
Encryption remains compiled out (`encryption.c`, `sha1.c` and `randombytes.c`
are not built); the adapter still rejects every non-zero PalmDOC encryption
value before `mobi_parse_rawml_opt`.

The Linux/Windows/Android build flags are in `../build.rs`. The Android build
must keep `-fPIC` on every libmobi object and on miniz, as established by
ER-0104.
