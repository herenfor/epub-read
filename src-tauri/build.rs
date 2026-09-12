#[path = "src/build_info_contract.rs"]
mod build_info_contract;

use std::env;

fn main() {
    println!("cargo:rerun-if-changed=src/build_info_contract.rs");
    println!("cargo:rerun-if-env-changed=EPUB_READER_EXPECTED_EDITION");
    println!("cargo:rerun-if-env-changed=CARGO_FEATURE_AI");
    println!("cargo:rerun-if-env-changed=CARGO_FEATURE_CORE");
    println!("cargo:rerun-if-env-changed=PROFILE");
    println!("cargo:rerun-if-env-changed=TARGET");
    println!("cargo:rerun-if-env-changed=DEBUG");

    let ai = env::var_os("CARGO_FEATURE_AI").is_some();
    let core = env::var_os("CARGO_FEATURE_CORE").is_some();
    let profile = env::var("PROFILE").unwrap_or_else(|_| "dev".into());
    let debug = if profile == "release" {
        false
    } else {
        env::var("DEBUG")
            .map(|value| value.eq_ignore_ascii_case("true"))
            .unwrap_or(true)
    };
    let expected = env::var("EPUB_READER_EXPECTED_EDITION").ok();
    let edition =
        build_info_contract::resolve_backend_edition(ai, core, debug, expected.as_deref())
            .unwrap_or_else(|error| panic!("invalid EPUB Reader edition build: {error}"));

    println!(
        "cargo:rustc-env=EPUB_READER_BACKEND_EDITION={}",
        edition.as_str()
    );
    println!("cargo:rustc-env=EPUB_READER_BUILD_PROFILE={profile}");
    println!(
        "cargo:rustc-env=EPUB_READER_BUILD_TARGET={}",
        env::var("TARGET").unwrap_or_else(|_| "unknown".into())
    );
    println!(
        "cargo:rustc-env=EPUB_READER_BUILD_DEBUG={}",
        if debug { "1" } else { "0" }
    );

    tauri_build::build()
}
