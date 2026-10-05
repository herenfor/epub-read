# Third-Party Software Notices

EPUB Reader includes third-party open-source software.
Each component remains subject to its respective license.

本项目的原创代码采用 [PolyForm Strict License 1.0.0](LICENSE) 提供，授权说明见
[LICENSING.md](LICENSING.md)。本文件不改变任何第三方组件自身的许可证与版权归属；
下表与 `third-party-licenses/` 中的 Apache-2.0、MIT、MPL-2.0 等许可证文本均属于
第三方组件，仍按其原始条款适用。

## Runtime dependencies

| Component | Version | License | Source |
|---|---:|---|---|
| React | 18.3.1 | MIT | https://github.com/facebook/react |
| React DOM | 18.3.1 | MIT | https://github.com/facebook/react |
| fflate | 0.8.3 | MIT | https://github.com/101arrowz/fflate |
| qrcode | 1.5.4 | MIT | https://github.com/soldair/node-qrcode |
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
| rustls | 0.23.43 | Apache-2.0 OR ISC OR MIT | https://github.com/rustls/rustls |
| tokio-rustls | 0.26.4 | MIT OR Apache-2.0 | https://github.com/rustls/tokio-rustls |
| rcgen | 0.14.10 | MIT OR Apache-2.0 | https://github.com/rustls/rcgen |
| ring | 0.17.14 | Apache-2.0 AND ISC | https://github.com/briansmith/ring |
| subtle | 2.6.1 | BSD-3-Clause | https://github.com/dalek-cryptography/subtle |
| getrandom | 0.3.4 | MIT OR Apache-2.0 | https://github.com/rust-random/getrandom |
| quick-xml | 0.41.0 | MIT | https://github.com/tafia/quick-xml |
| zip | 2.4.2 | MIT | https://github.com/zip-rs/zip2 |
| rusqlite | 0.32.1 | MIT | https://github.com/rusqlite/rusqlite |
| libsqlite3-sys | 0.30.1 | MIT | https://github.com/rusqlite/rusqlite/tree/master/libsqlite3-sys |
| SQLite (bundled) | 3.x | Public Domain | https://www.sqlite.org/copyright.html |
| windows (Windows target) | 0.61.3 | MIT OR Apache-2.0 | https://crates.io/crates/windows |
| reqwest (Rust, blocking + rustls) | 0.13.4 | MIT OR Apache-2.0 | https://github.com/seanmonstar/reqwest |
| fs2 (Rust disk-space checks) | 0.4.3 | MIT OR Apache-2.0 | https://github.com/danburkert/fs2-rs |

The Android target adds `com.journeyapps:zxing-android-embedded:4.3.0`
(Apache-2.0) with its transitive `com.google.zxing:core:3.4.1` (Apache-2.0)
only for the optional camera QR-scan entry. The scanner is offline and does
not require Google Play services; the camera permission is requested only
after the user taps the scan action.

The Windows target dependency `windows` 0.61.3 is used for DirectWrite system
font enumeration and native LAN adapter selection, and is recorded under its MIT OR Apache-2.0 terms. This
feature adds no GPL dependency. Android system-font enumeration is not
implemented in this release; only the frontend interface space is reserved.

The optional AI/RAG derived-data store uses `rusqlite` with its bundled SQLite
feature. `rusqlite` and `libsqlite3-sys` are MIT licensed; the bundled SQLite
amalgamation is dedicated to the public domain. This does not add a GPL
dependency or change the license of the project's original code.

RAG C-57 directly uses `reqwest` 0.13.4 (`MIT OR Apache-2.0`) for the isolated
blocking/rustls download worker and `fs2` 0.4.3 (`MIT/Apache-2.0`, recorded here
as the equivalent dual-license choice) for disk-space checks. The repository
and license values above were checked against the local crate Cargo metadata.
Core and AI also use `fs2` for archive and LAN-transfer disk-space checks.
This is a direct-dependency notice, not a complete Cargo.lock transitive
license, copyright, NOTICE, SBOM, or target-platform audit; that audit remains
explicitly deferred.

### Android runtime (Android build only)

The Android package additionally bundles the following Java/Kotlin libraries,
resolved from the release runtime classpath. All of them are licensed under
Apache-2.0, whose full text is in `third-party-licenses/Apache-2.0.txt`.

| Component | Version | License | Source |
|---|---:|---|---|
| AndroidX (activity, annotation, appcompat, core, fragment, lifecycle, webkit and their transitive AndroidX modules) | webkit 1.14.0, appcompat 1.7.1, activity 1.10.1, lifecycle 2.10.0, core 1.13.1 | Apache-2.0 | https://developer.android.com/jetpack/androidx |
| Material Components for Android | 1.13.0 | Apache-2.0 | https://github.com/material-components/material-components-android |
| Kotlin standard library | 2.0.21 | Apache-2.0 | https://github.com/JetBrains/kotlin |
| kotlinx.coroutines | 1.9.0 | Apache-2.0 | https://github.com/Kotlin/kotlinx.coroutines |
| Jackson (core, annotations, databind) | 2.15.3 | Apache-2.0 | https://github.com/FasterXML/jackson |
| JetBrains Java annotations | 23.0.0 | Apache-2.0 | https://github.com/JetBrains/java-annotations |
| JSpecify | 1.0.0 | Apache-2.0 | https://github.com/jspecify/jspecify |
| Guava ListenableFuture | 1.0 | Apache-2.0 | https://github.com/google/guava |
| Error Prone annotations | 2.15.0 | Apache-2.0 | https://github.com/google/error-prone |

The Tauri Android runtime (`tauri-android`) and the Android parts of the
official dialog, fs and opener plugins are covered by the Tauri rows above.

### C-58B local embedding runtime (AI edition only)

The AI edition adds a local ONNX embedding path. Core never enables the `ai`
feature, so it does not compile or link any of the following.

| Component | Version | License | Source |
|---|---:|---|---|
| ort (Rust bindings) | 2.0.0-rc.13 | MIT OR Apache-2.0 | https://github.com/pykeio/ort |
| ort-sys | 2.0.0-rc.13 | MIT OR Apache-2.0 | https://github.com/pykeio/ort |
| ONNX Runtime (prebuilt, linked statically) | 1.28.0 | MIT | https://github.com/microsoft/onnxruntime |
| tokenizers (Rust) | 0.21.4 | Apache-2.0 | https://github.com/huggingface/tokenizers |
| esaxx-rs (tokenizers backend) | 0.1.10 | Apache-2.0 | https://github.com/huggingface/tokenizers |

The Windows DirectML build of ONNX Runtime is fetched at build time by
`ort-sys` from a hash-pinned Microsoft distribution
(`ms@1.28.0/x86_64-pc-windows-msvc+directml.tar.lzma2`, SHA-256
`f7c654b3729cb9e5ad2a36a0c38e5b48e63bf4eed22968931aed33a0ad0b527d`) and linked
statically. `DirectML.dll` is copied next to the executable by the
`copy-dylibs` feature and is redistributed under Microsoft's DirectML terms;
it is not open-source software and its redistribution terms must be confirmed
before any installer ships it. This batch records the dependency and the real
digest instead of asserting a verified redistribution claim.

The first validated model package is BAAI/bge-small-zh-v1.5 (MIT), used through
the pinned ONNX conversion in `Xenova/bge-small-zh-v1.5` revision
`75c43b069aac4d136ba6bc1122f995fedcfd2781` with tokenizer assets from
`BAAI/bge-small-zh-v1.5` revision
`7999e1d3359715c523056ef9478215996d62a620`. Model files are not redistributed
with the application; `scripts/prepare-semantic-model.ps1` downloads them into
the user's model library and records real SHA-256 digests in the package
manifest.

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
- **qrcode** — Copyright (c) 2012 Ryan Day (MIT)
- **ZXing Android Embedded / ZXing core** — Copyright (c) 2012-2024 ZXing authors (Apache-2.0)
- **Tauri 及其官方插件** — Copyright (c) 2019-2025 Tauri Programme within The Commons Conservancy (MIT OR Apache-2.0)
- **serde / serde_json** — Copyright (c) 2019 Serde Authors (MIT OR Apache-2.0)
- **quick-xml** — Copyright (c) 2016 the quick-xml authors (MIT)
- **zip** — Copyright (c) 2023 zip-rs team (MIT)
- **rusqlite / libsqlite3-sys** — Copyright (c) 2014 The rusqlite developers (MIT)
- **rustls / tokio-rustls / rcgen** — Copyright (c) 2016-2026 the rustls and rcgen contributors (Apache-2.0 OR ISC OR MIT / MIT OR Apache-2.0)
- **ring** — Copyright (c) 2015-2026 Brian Smith and contributors (Apache-2.0 AND ISC)
- **subtle** — Copyright (c) 2016-2026 Isis Lovecruft, Henry de Valence (BSD-3-Clause)
- **AndroidX / Material Components for Android** — Copyright (c) The Android Open Source Project (Apache-2.0)
- **Kotlin / kotlinx.coroutines / JetBrains Java annotations** — Copyright (c) JetBrains s.r.o. and Kotlin Programming Language contributors (Apache-2.0)
- **Jackson** — Copyright (c) FasterXML, LLC (Apache-2.0)
- **Guava / Error Prone** — Copyright (c) The Guava Authors / The Error Prone Authors (Apache-2.0)
- **JSpecify** — Copyright (c) The JSpecify Authors (Apache-2.0)

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
