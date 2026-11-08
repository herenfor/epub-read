//! Small command-line probe used by ER-0140 validation.
//!
//! Usage:
//!   cargo run --example probe -- inspect <book.mobi|book.azw3>
//!   cargo run --example probe -- convert <book.mobi|book.azw3> <out.epub>

use std::path::Path;
use std::process::ExitCode;

use mobi_adapter::{convert, inspect, libmobi_version, CancelToken, Limits, MobiErrorCode, Source};

fn main() -> ExitCode {
    let args = std::env::args().collect::<Vec<_>>();
    if args.len() < 3 {
        eprintln!("usage: probe inspect <source> | probe convert <source> <dest>");
        return ExitCode::from(2);
    }
    match run(&args) {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!(
                "error code={} detail={}",
                error.code().as_str(),
                error.message()
            );
            ExitCode::from(1)
        }
    }
}

fn run(args: &[String]) -> mobi_adapter::Result<()> {
    let limits = Limits::default();
    match args[1].as_str() {
        "inspect" => {
            let metadata = inspect(Source::from_path(&args[2])?, &limits)?;
            println!("libmobi={}", libmobi_version());
            println!("title={:?}", metadata.title);
            println!("creator={:?}", metadata.creator);
            println!("language={:?}", metadata.language);
            println!("version={}", metadata.format_version);
            println!("compression={}", metadata.compression);
            println!("hybrid={}", metadata.hybrid);
            println!("kf8={}", metadata.kf8);
            match metadata.cover {
                Some(cover) => {
                    println!("cover_mime={:?}", cover.mime);
                    println!("cover_bytes={}", cover.bytes.len());
                }
                None => println!("cover=none"),
            }
        }
        "convert" => {
            let cancel = CancelToken::new();
            let report = convert(
                Source::from_path(&args[2])?,
                Path::new(&args[3]),
                &limits,
                &cancel,
            )?;
            println!("format_version={}", report.format_version);
            println!("compression={}", report.compression);
            println!("hybrid={}", report.hybrid);
            println!("kf8={}", report.kf8);
            println!("record_count={}", report.record_count);
            println!("text_length={}", report.text_length);
            println!("markup_parts={}", report.markup_parts);
            println!("flow_parts={}", report.flow_parts);
            println!("resource_parts={}", report.resource_parts);
            println!("uncompressed_part_bytes={}", report.uncompressed_part_bytes);
            println!("source_bytes={}", report.source_bytes);
            println!("epub_bytes={}", report.epub_bytes);
        }
        "drm-test" => {
            // Prove the stable encrypted code without requiring a caller path.
            let error = inspect(Source::from_path(&args[2])?, &limits).unwrap_err();
            if error.code() != MobiErrorCode::Encrypted {
                return Err(error);
            }
            println!("encrypted_rejected={}", error.code().as_str());
        }
        other => {
            eprintln!("unknown mode {other}");
            std::process::exit(2);
        }
    }
    Ok(())
}
