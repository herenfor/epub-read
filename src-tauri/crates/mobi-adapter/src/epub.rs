//! EPUB 2 writing from libmobi's reconstructed rawml parts.
//!
//! libmobi reconstructs the source parts already named `partNNNNN`,
//! `flowNNNNN` and `resourceNNNNN`, and emits an OPF/NCX that reference those
//! names. This writer mirrors the proven `mobitool -e` layout, but consumes one
//! C-owned part at a time directly into the ZIP so the whole book is never
//! copied into a Rust `Vec`.

use std::io::Write;
use std::path::{Path, PathBuf};

use tempfile::NamedTempFile;
use zip::write::SimpleFileOptions;
use zip::{CompressionMethod, ZipWriter};

use crate::error::{MobiError, Result};
use crate::ffi::{Handle, PartKind, PartView};
use crate::legacy;
use crate::source::CancelToken;
use crate::{ConversionReport, Limits};

const MIMETYPE: &[u8] = b"application/epub+zip";
const CONTAINER: &[u8] = br#"<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>
"#;

pub(crate) fn write_epub(
    handle: &Handle,
    dest: &Path,
    limits: &Limits,
    cancel: &CancelToken,
) -> Result<ConversionReport> {
    let info = handle.info()?;
    // MOBI6 rawml keeps Kindle's presentational markup. KF8/AZW3 already
    // carries standard CSS and must be copied byte-for-byte.
    let normalize_legacy = !info.kf8 && info.version < 8;
    let counts = [
        (PartKind::Markup, handle.part_count(PartKind::Markup)),
        (PartKind::Flow, handle.part_count(PartKind::Flow)),
        (PartKind::Resource, handle.part_count(PartKind::Resource)),
    ];
    let total_parts: usize = counts.iter().map(|(_, count)| *count).sum();
    if total_parts > limits.max_parts {
        return Err(MobiError::budget(format!(
            "reconstructed archive has {total_parts} parts, limit is {}",
            limits.max_parts
        )));
    }

    let parent = dest
        .parent()
        .filter(|path| !path.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    let mut output = NamedTempFile::new_in(parent)
        .map_err(|error| MobiError::output("create temporary EPUB", error))?;

    let mut written = Written::default();
    {
        let mut zip = ZipWriter::new(output.as_file_mut());
        // EPUB requires the mimetype entry first and uncompressed.
        zip.start_file(
            "mimetype",
            SimpleFileOptions::default()
                .compression_method(CompressionMethod::Stored)
                .unix_permissions(0o644),
        )
        .map_err(|error| MobiError::output("start EPUB mimetype", error))?;
        zip.write_all(MIMETYPE)
            .map_err(|error| MobiError::output("write EPUB mimetype", error))?;
        write_part(
            &mut zip,
            "META-INF/container.xml",
            CONTAINER,
            CompressionMethod::Deflated,
        )?;

        for (kind, count) in counts {
            for index in 0..count {
                cancel.check()?;
                let part = handle.part(kind, index)?;
                // libmobi emits empty resource placeholders; mobitool omits them.
                if kind == PartKind::Resource && part.data.is_empty() {
                    continue;
                }
                let normalized = (normalize_legacy && kind == PartKind::Markup && !part.is_opf)
                    .then(|| legacy::normalize_markup(part.data));
                let data = normalized.as_deref().unwrap_or(part.data);
                check_size(&part, data.len() as u64, limits)?;
                let name = part_name(&part)?;
                if part.is_opf {
                    if written.opf {
                        return Err(MobiError::parse(
                            "reconstructed archive has more than one OPF part",
                        ));
                    }
                    written.opf = true;
                }
                write_part(&mut zip, &name, data, CompressionMethod::Deflated)?;
                written.part_bytes = written
                    .part_bytes
                    .checked_add(data.len() as u64)
                    .ok_or_else(|| MobiError::budget("part byte total overflow"))?;
                if written.part_bytes > limits.max_total_bytes {
                    return Err(MobiError::budget(format!(
                        "reconstructed parts total {} bytes, limit is {}",
                        written.part_bytes, limits.max_total_bytes
                    )));
                }
                match kind {
                    PartKind::Markup => written.markup += 1,
                    PartKind::Flow => written.flow += 1,
                    PartKind::Resource => {
                        if !part.is_opf {
                            written.resources += 1;
                        }
                    }
                }
            }
        }
        cancel.check()?;
        zip.finish()
            .map_err(|error| MobiError::output("finalize EPUB", error))?;
    }

    if !written.opf {
        return Err(MobiError::no_opf());
    }
    let epub_bytes = output
        .as_file()
        .metadata()
        .map_err(|error| MobiError::output("read EPUB size", error))?
        .len();
    if epub_bytes > limits.max_output_bytes {
        return Err(MobiError::budget(format!(
            "EPUB is {epub_bytes} bytes, limit is {}",
            limits.max_output_bytes
        )));
    }
    cancel.check()?;
    let resulting_path: PathBuf = dest.to_path_buf();
    output
        .persist(&resulting_path)
        .map_err(|error| MobiError::output("persist EPUB", error.error))?;

    Ok(ConversionReport {
        format_version: info.version,
        compression: info.compression,
        hybrid: info.hybrid,
        kf8: info.kf8,
        record_count: info.record_count,
        text_length: info.text_length,
        markup_parts: written.markup,
        flow_parts: written.flow,
        resource_parts: written.resources,
        uncompressed_part_bytes: written.part_bytes,
        source_bytes: 0,
        epub_bytes,
    })
}

#[derive(Default)]
struct Written {
    opf: bool,
    markup: usize,
    flow: usize,
    resources: usize,
    part_bytes: u64,
}

fn check_size(part: &PartView<'_>, size: u64, limits: &Limits) -> Result<()> {
    if size > limits.max_part_bytes {
        return Err(MobiError::budget(format!(
            "{} part {} is {size} bytes, limit is {}",
            part.kind.name(),
            part.uid,
            limits.max_part_bytes
        )));
    }
    if size > limits.max_total_bytes {
        return Err(MobiError::budget(format!(
            "{} part {} exceeds the total byte budget",
            part.kind.name(),
            part.uid
        )));
    }
    Ok(())
}

fn part_name(part: &PartView<'_>) -> Result<String> {
    if part.is_opf {
        return Ok("OEBPS/content.opf".to_string());
    }
    let extension = part.extension.trim();
    if extension.is_empty()
        || extension.len() > 8
        || !extension.bytes().all(|byte| byte.is_ascii_alphanumeric())
    {
        return Err(MobiError::parse(format!(
            "{} part {} has an invalid extension {:?}",
            part.kind.name(),
            part.uid,
            part.extension
        )));
    }
    let prefix = match part.kind {
        PartKind::Markup => "part",
        PartKind::Flow => "flow",
        PartKind::Resource => "resource",
    };
    Ok(format!("OEBPS/{prefix}{:05}.{extension}", part.uid))
}

fn write_part(
    zip: &mut ZipWriter<&mut std::fs::File>,
    name: &str,
    data: &[u8],
    compression: CompressionMethod,
) -> Result<()> {
    let options = SimpleFileOptions::default()
        .compression_method(compression)
        .unix_permissions(0o644);
    zip.start_file(name, options)
        .map_err(|error| MobiError::output(&format!("start EPUB entry {name}"), error))?;
    zip.write_all(data)
        .map_err(|error| MobiError::output(&format!("write EPUB entry {name}"), error))?;
    Ok(())
}
