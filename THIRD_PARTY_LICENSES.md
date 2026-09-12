# Third-Party Software Notices

EPUB Reader includes third-party open-source software.
Each component remains subject to its respective license.

本项目的原创代码采用 [Apache License 2.0](third-party-licenses/Apache-2.0.txt)。
本文件不改变任何第三方组件自身的许可证与版权归属。

## Runtime dependencies

| Component | Version | License | Source |
|---|---:|---|---|
| React | 18.3.1 | MIT | https://github.com/facebook/react |
| React DOM | 18.3.1 | MIT | https://github.com/facebook/react |
| fflate | 0.8.3 | MIT | https://github.com/101arrowz/fflate |
| @tauri-apps/api | 2.11.1 | MIT OR Apache-2.0 | https://github.com/tauri-apps/tauri |
| @tauri-apps/plugin-dialog | 2.7.2 | MIT OR Apache-2.0 | https://github.com/tauri-apps/plugins-workspace |
| @tauri-apps/plugin-fs | 2.5.1 | MIT OR Apache-2.0 | https://github.com/tauri-apps/plugins-workspace |
| @tauri-apps/plugin-opener | 2.5.4 | MIT OR Apache-2.0 | https://github.com/tauri-apps/plugins-workspace |
| Tauri (Rust) | 2.11.5 | MIT OR Apache-2.0 | https://github.com/tauri-apps/tauri |
| tauri-plugin-dialog | 2.7.2 | MIT OR Apache-2.0 | https://github.com/tauri-apps/plugins-workspace |
| tauri-plugin-fs | 2.5.1 | MIT OR Apache-2.0 | https://github.com/tauri-apps/plugins-workspace |
| tauri-plugin-opener | 2.5.4 | MIT OR Apache-2.0 | https://github.com/tauri-apps/plugins-workspace |
| tauri-plugin-single-instance | 2.4.3 | MIT OR Apache-2.0 | https://github.com/tauri-apps/plugins-workspace |
| serde | 1.0.229 | MIT OR Apache-2.0 | https://github.com/serde-rs/serde |
| serde_json | 1.0.151 | MIT OR Apache-2.0 | https://github.com/serde-rs/json |
| sha2 | 0.10.9 | MIT OR Apache-2.0 | https://github.com/RustCrypto/hashes |
| quick-xml | 0.41.0 | MIT | https://github.com/tafia/quick-xml |
| zip | 2.4.2 | MIT | https://github.com/zip-rs/zip2 |
| rusqlite | 0.32.1 | MIT | https://github.com/rusqlite/rusqlite |
| libsqlite3-sys | 0.30.1 | MIT | https://github.com/rusqlite/rusqlite/tree/master/libsqlite3-sys |
| SQLite (bundled) | 3.x | Public Domain | https://www.sqlite.org/copyright.html |
| windows (Windows target) | 0.61.3 | MIT OR Apache-2.0 | https://crates.io/crates/windows |
| reqwest (Rust, blocking + rustls) | 0.13.4 | MIT OR Apache-2.0 | https://github.com/seanmonstar/reqwest |
| fs2 (Rust disk-space checks) | 0.4.3 | MIT OR Apache-2.0 | https://github.com/danburkert/fs2-rs |

The Windows target dependency `windows` 0.61.3 is used for DirectWrite system
font enumeration and is recorded under its MIT OR Apache-2.0 terms. This
feature adds no GPL dependency. Android system-font enumeration is not
implemented in this release; only the frontend interface space is reserved.

The optional AI/RAG derived-data store uses `rusqlite` with its bundled SQLite
feature. `rusqlite` and `libsqlite3-sys` are MIT licensed; the bundled SQLite
amalgamation is dedicated to the public domain. This does not add a GPL
dependency or change the project's Apache-2.0 license.

RAG C-57 directly uses `reqwest` 0.13.4 (`MIT OR Apache-2.0`) for the isolated
blocking/rustls download worker and `fs2` 0.4.3 (`MIT/Apache-2.0`, recorded here
as the equivalent dual-license choice) for disk-space checks. The repository
and license values above were checked against the local crate Cargo metadata.
This is a direct-dependency notice, not a complete Cargo.lock transitive
license, copyright, NOTICE, SBOM, or target-platform audit; that audit remains
explicitly deferred.

## Development dependencies

| Component | Version | License | Source |
|---|---:|---|---|
| TypeScript | 5.9.3 | Apache-2.0 | https://github.com/microsoft/TypeScript |
| Vite | 6.4.3 | MIT | https://github.com/vitejs/vite |
| Vitest | 3.2.7 | MIT | https://github.com/vitest-dev/vitest |
| Playwright | 1.62.1 | Apache-2.0 | https://github.com/microsoft/playwright |
| tsx | 4.23.12 | MIT | https://github.com/privatenumber/tsx |
| linkedom | 0.18.13 | ISC | https://github.com/WebReflection/linkedom |
| @xmldom/xmldom | 0.8.14 | MIT | https://github.com/xmldom/xmldom |

## MPL-2.0 components

The following components are available under the Mozilla Public License 2.0:

- cssparser 0.36.0
- cssparser-macros 0.6.1
- dtoa-short 0.3.5
- option-ext 0.2.0
- selectors 0.36.1

Their corresponding source code is available from crates.io / docs.rs
at the exact versions listed above:

- https://crates.io/crates/cssparser/0.36.0
- https://crates.io/crates/cssparser-macros/0.6.1
- https://crates.io/crates/dtoa-short/0.3.5
- https://crates.io/crates/option-ext/0.2.0
- https://crates.io/crates/selectors/0.36.1

许可证全文见 [third-party-licenses/MPL-2.0.txt](third-party-licenses/MPL-2.0.txt)。

## Alternative-license components

r-efi 5.3.0 and 6.0.0 are licensed under:

    MIT OR Apache-2.0 OR LGPL-2.1-or-later

This distribution relies on the MIT/Apache-2.0 licensing option and
does not rely on the LGPL alternative.

## Copyright notices

The following components carry their own copyright notices, reproduced
from their respective LICENSE files:

- **React / React DOM** — Copyright (c) Facebook, Inc. and its affiliates. (MIT)
- **fflate** — Copyright (c) 2026 Arjun Barrett (MIT)
- **Tauri 及其官方插件** — Copyright (c) 2019-2025 Tauri Programme within The Commons Conservancy (MIT OR Apache-2.0)
- **serde / serde_json** — Copyright (c) 2019 Serde Authors (MIT OR Apache-2.0)
- **quick-xml** — Copyright (c) 2016 the quick-xml authors (MIT)
- **zip** — Copyright (c) 2023 zip-rs team (MIT)
- **rusqlite / libsqlite3-sys** — Copyright (c) 2014 The rusqlite developers (MIT)

## License texts

标准许可证全文位于 [`third-party-licenses/`](third-party-licenses/):

- [Apache-2.0.txt](third-party-licenses/Apache-2.0.txt)
- [MIT.txt](third-party-licenses/MIT.txt)
- [MPL-2.0.txt](third-party-licenses/MPL-2.0.txt)
- [BSD-2-Clause.txt](third-party-licenses/BSD-2-Clause.txt)
- [BSD-3-Clause.txt](third-party-licenses/BSD-3-Clause.txt)
- [ISC.txt](third-party-licenses/ISC.txt)
- [Zlib.txt](third-party-licenses/Zlib.txt)
- [Unicode-3.0.txt](third-party-licenses/Unicode-3.0.txt)
- [CC-BY-4.0.txt](third-party-licenses/CC-BY-4.0.txt)
