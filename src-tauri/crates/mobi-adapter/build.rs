//! Compile the pinned libmobi C sources, bundled miniz and the thin bridge.
//!
//! The layout mirrors ER-0104's validated build: explicit source lists,
//! bundled miniz on its own object with its own macros, no encryption module,
//! and PIC on every object for Android shared-library embedding.

use std::env;
use std::path::PathBuf;

const LIBMOBI_SOURCES: &[&str] = &[
    "buffer",
    "compression",
    "debug",
    "index",
    "memory",
    "meta",
    "opf",
    "parse_rawml",
    "read",
    "structure",
    "util",
    "write",
    "xmlwriter",
];

fn main() {
    let manifest = PathBuf::from(env::var("CARGO_MANIFEST_DIR").unwrap());
    let vendor = manifest.join("vendor/libmobi/src");
    let bridge = manifest.join("c");
    let target_os = env::var("CARGO_CFG_TARGET_OS").unwrap_or_default();
    let target_env = env::var("CARGO_CFG_TARGET_ENV").unwrap_or_default();
    let is_msvc = target_env == "msvc";
    let is_android = target_os == "android";

    let mut libmobi = cc::Build::new();
    libmobi
        .include(&vendor)
        .include(&bridge)
        .define("USE_XMLWRITER", None)
        .define("USE_MINIZ", None)
        .define("PACKAGE_VERSION", Some("\"0.12\""))
        .define("_CRT_SECURE_NO_WARNINGS", None)
        .define("_CRT_NONSTDC_NO_WARNINGS", None)
        .flag_if_supported("-std=c99")
        .opt_level(2);
    if is_android {
        libmobi.pic(true).flag("-fPIC").flag("-fno-common");
    } else if !is_msvc {
        libmobi.pic(true).flag_if_supported("-fPIC");
    }
    for name in LIBMOBI_SOURCES {
        libmobi.file(vendor.join(format!("{name}.c")));
    }
    libmobi.file(bridge.join("mobi_adapter.c"));
    libmobi.compile("mobi_core");

    // miniz macros must not leak into libmobi. This is the same split used by
    // the platform probe; the upstream CMake USE_ZLIB=OFF path alone omits it.
    let mut miniz = cc::Build::new();
    miniz
        .include(&vendor)
        .define("MINIZ_NO_STDIO", None)
        .define("MINIZ_NO_ZLIB_COMPATIBLE_NAMES", None)
        .define("MINIZ_NO_TIME", None)
        .define("MINIZ_NO_ARCHIVE_APIS", None)
        .define("MINIZ_NO_ARCHIVE_WRITING_APIS", None)
        .define("_CRT_SECURE_NO_WARNINGS", None)
        .flag_if_supported("-std=c99")
        .opt_level(2);
    if is_android {
        miniz.pic(true).flag("-fPIC").flag("-fno-common");
    } else if !is_msvc {
        miniz.pic(true).flag_if_supported("-fPIC");
    }
    miniz.file(vendor.join("miniz.c"));
    miniz.compile("mobi_miniz");

    println!("cargo:rerun-if-changed=c/mobi_adapter.c");
    println!("cargo:rerun-if-changed=c/mobi_adapter.h");
    for name in LIBMOBI_SOURCES {
        println!("cargo:rerun-if-changed=vendor/libmobi/src/{name}.c");
    }
    println!("cargo:rerun-if-changed=vendor/libmobi/src/miniz.c");
    println!("cargo:rerun-if-changed=vendor/libmobi/src/portable_io.h");
}
