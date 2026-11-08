# mobi-adapter third-party notice

This crate is part of SeLis (GPL-3.0-only). It vendors libmobi 0.12,
commit `906274205c11944b628da1c553b255acb1af7c55`, which is licensed under
**LGPL-3.0-or-later**. The complete upstream license text is in
`vendor/libmobi/COPYING`; upstream attribution is in
`vendor/libmobi/AUTHORS` and `vendor/libmobi/README.md`.

Local source modifications are documented in `vendor/libmobi/PATCHES.md`.
The vendored source is compiled into the application as a static Rust/C
library. The libmobi source, this notice, the license and the build script are
kept in the source tree so the library can be rebuilt and relinked.

The crate itself contains original SeLis code under GPL-3.0-only.
