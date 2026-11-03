//! Source-format inspection and ephemeral TXT reading resources. Original bytes are never rewritten.
use crate::linked_library::ImportedMetadata;
use serde::Serialize;
use std::{
    cmp::Ordering,
    fs::File,
    io::{Read, Seek, SeekFrom, Write},
    path::Path,
};
use zip::{write::SimpleFileOptions, CompressionMethod, ZipArchive, ZipWriter};

// Persisted chapter keys include these source-scalar boundaries; change only with a locator migration.
pub const TEXT_PART_CHARS: usize = 32_768;
pub fn extension(name: &str) -> &str {
    name.rsplit_once('.').map(|(_, e)| e).unwrap_or("")
}
pub fn supported(name: &str) -> bool {
    matches!(
        extension(name).to_ascii_lowercase().as_str(),
        "epub" | "txt" | "cbz" | "zip"
    )
}
pub fn text(name: &str) -> bool {
    extension(name).eq_ignore_ascii_case("txt")
}
pub fn image(name: &str) -> bool {
    !name
        .split('/')
        .any(|s| s.starts_with('.') || s == "__MACOSX")
        && matches!(
            extension(name).to_ascii_lowercase().as_str(),
            "jpg" | "jpeg" | "png" | "webp" | "avif" | "gif"
        )
}
/// Numeric runs compare without integer conversion; ties retain an ordinal spelling order.
pub fn natural_cmp(a: &str, b: &str) -> Ordering {
    let aa: Vec<char> = a.chars().collect();
    let bb: Vec<char> = b.chars().collect();
    let (mut i, mut j) = (0, 0);
    while i < aa.len() && j < bb.len() {
        if aa[i].is_ascii_digit() && bb[j].is_ascii_digit() {
            let (start_i, start_j) = (i, j);
            while i < aa.len() && aa[i].is_ascii_digit() {
                i += 1
            }
            while j < bb.len() && bb[j].is_ascii_digit() {
                j += 1
            }
            let x: String = aa[start_i..i].iter().collect();
            let y: String = bb[start_j..j].iter().collect();
            let (x, y) = (x.trim_start_matches('0'), y.trim_start_matches('0'));
            let order = x.len().cmp(&y.len()).then_with(|| x.cmp(y));
            if order != Ordering::Equal {
                return order;
            }
        } else {
            let order = aa[i].cmp(&bb[j]);
            if order != Ordering::Equal {
                return order;
            }
            i += 1;
            j += 1;
        }
    }
    (aa.len() - i).cmp(&(bb.len() - j)).then_with(|| a.cmp(b))
}
pub fn inspect(path: &Path, file_name: &str) -> Result<ImportedMetadata, String> {
    let title = Path::new(file_name)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("Book")
        .to_owned();
    if text(file_name) {
        // Import never decodes or duplicates a whole text book. The reader builds its resources on demand.
        return Ok(ImportedMetadata {
            title,
            creator: String::new(),
            language: String::new(),
            spine: vec!["text".into()],
            cover_zip_path: None,
            cover_mime: String::new(),
        });
    }
    let mut zip =
        ZipArchive::new(File::open(path).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    if zip.by_name("META-INF/container.xml").is_ok() {
        return crate::linked_library::epub_meta::inspect_epub_package(path);
    }
    if !matches!(
        extension(file_name).to_ascii_lowercase().as_str(),
        "zip" | "cbz"
    ) {
        return Err("不是有效的 EPUB 文件".into());
    }
    let mut names = Vec::new();
    for i in 0..zip.len() {
        let f = zip.by_index_raw(i).map_err(|e| e.to_string())?;
        if !f.is_dir() && image(f.name()) {
            names.push(f.name().to_owned())
        }
    }
    names.sort_by(|a, b| natural_cmp(a, b));
    let cover = names.first().ok_or("漫画压缩包内没有支持的图片")?.clone();
    let mime = match extension(&cover).to_ascii_lowercase().as_str() {
        "jpg" | "jpeg" => "image/jpeg",
        "webp" => "image/webp",
        "avif" => "image/avif",
        "gif" => "image/gif",
        _ => "image/png",
    }
    .to_owned();
    Ok(ImportedMetadata {
        title,
        creator: String::new(),
        language: String::new(),
        spine: names,
        cover_zip_path: Some(cover),
        cover_mime: mime,
    })
}
fn escape(value: &str) -> String {
    value.chars().map(|c| if matches!(c, '\u{0}'..='\u{8}' | '\u{b}' | '\u{c}' | '\u{e}'..='\u{1f}' | '\u{fffe}' | '\u{ffff}') { '\u{fffd}' } else { c }).collect::<String>()
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}
#[derive(Serialize)]
struct Heading {
    label: String,
    offset: usize,
}
#[derive(Serialize)]
struct Part {
    path: String,
    start: usize,
    chars: usize,
    headings: Vec<Heading>,
}
fn write_part(
    zip: &mut ZipWriter<File>,
    encoding: &str,
    start: usize,
    content: &str,
    count: usize,
    parts: &mut Vec<Part>,
) -> Result<(), String> {
    let path = format!("__reader__/txt/{encoding}/s{start}.xhtml");
    zip.start_file(
        &path,
        SimpleFileOptions::default().compression_method(CompressionMethod::Stored),
    )
    .map_err(|e| e.to_string())?;
    let mut headings = Vec::new();
    let mut html = String::new();
    let mut offset = 0;
    for line in content.split_inclusive('\n') {
        let label = line.trim();
        let chinese =
            label.starts_with('第') && label.chars().take(22).any(|c| "章节回卷部".contains(c));
        let heading = label.chars().count() <= 80
            && (chinese
                || label.to_ascii_lowercase().starts_with("chapter ")
                || matches!(
                    label,
                    "序章"
                        | "序言"
                        | "前言"
                        | "楔子"
                        | "尾声"
                        | "尾聲"
                        | "后记"
                        | "後記"
                        | "终章"
                        | "終章"
                        | "Prologue"
                        | "Epilogue"
                ));
        let text = line.strip_suffix('\n').unwrap_or(line);
        let content = if text.trim().is_empty() {
            "<br/>".to_owned()
        } else {
            escape(text)
        };
        if heading {
            html.push_str(&format!("<p id=\"t{offset}\">{content}</p>"));
            headings.push(Heading {
                label: label.to_owned(),
                offset,
            });
        } else {
            html.push_str(&format!("<p>{content}</p>"));
        }
        offset += line.chars().count();
    }
    write!(zip,"<html xmlns=\"http://www.w3.org/1999/xhtml\"><head><meta charset=\"utf-8\"/><style>p{{margin:0;white-space:pre-wrap;overflow-wrap:anywhere;break-inside:auto}}</style></head><body>{}</body></html>",html).map_err(|e|e.to_string())?;
    parts.push(Part {
        path,
        start,
        chars: count,
        headings,
    });
    Ok(())
}
/// Anonymous temporary ZIP is a reading-resource container, not an EPUB or a permanent converted copy.
/// File ownership passes to the existing window-owned ZIP session; close/failure removes it automatically.
pub fn text_archive(
    mut source: File,
    requested: Option<&str>,
    title: &str,
) -> Result<File, String> {
    use encoding_rs::{Encoding, UTF_16BE, UTF_16LE, UTF_8};
    let mut sample = vec![0; 65536];
    let n = source.read(&mut sample).map_err(|e| e.to_string())?;
    sample.truncate(n);
    let encoding = if let Some(label) = requested.filter(|s| *s != "auto") {
        Encoding::for_label(label.as_bytes()).ok_or("不支持的文本编码")?
    } else if sample.starts_with(&[0xff, 0xfe]) {
        UTF_16LE
    } else if sample.starts_with(&[0xfe, 0xff]) {
        UTF_16BE
    } else if sample.starts_with(&[0xef, 0xbb, 0xbf]) {
        UTF_8
    } else if sample.len() > 4
        && sample
            .iter()
            .skip(1)
            .step_by(2)
            .filter(|b| **b == 0)
            .count()
            > sample.len() / 5
    {
        UTF_16LE
    } else if sample.len() > 4
        && sample.iter().step_by(2).filter(|b| **b == 0).count() > sample.len() / 5
    {
        UTF_16BE
    } else {
        let mut detector = chardetng::EncodingDetector::new();
        detector.feed(&sample, n < 65536);
        detector.guess(None, true)
    };
    source.seek(SeekFrom::Start(0)).map_err(|e| e.to_string())?;
    let label = encoding.name().to_ascii_lowercase();
    let mut decoder = encoding.new_decoder_with_bom_removal();
    let mut zip = ZipWriter::new(tempfile::tempfile().map_err(|e| e.to_string())?);
    let mut input = [0u8; 65536];
    let mut decoded = String::with_capacity(262_144);
    let mut content = String::new();
    let (mut count, mut start, mut cr) = (0, 0, false);
    let mut parts = Vec::new();
    let mut replacements = false;
    loop {
        let n = source.read(&mut input).map_err(|e| e.to_string())?;
        let last = n == 0;
        let mut offset = 0;
        loop {
            decoded.clear();
            let (result, read, errors) =
                decoder.decode_to_string(&input[offset..n], &mut decoded, last);
            offset += read;
            replacements |= errors;
            for ch in decoded.chars() {
                if cr && ch == '\n' {
                    cr = false;
                    continue;
                }
                cr = ch == '\r';
                let ch = if cr { '\n' } else { ch };
                content.push(ch);
                count += 1;
                if count == TEXT_PART_CHARS {
                    write_part(&mut zip, &label, start, &content, count, &mut parts)?;
                    start += count;
                    count = 0;
                    content.clear();
                }
            }
            if result == encoding_rs::CoderResult::InputEmpty {
                break;
            }
        }
        if last {
            break;
        }
    }
    if count > 0 || parts.is_empty() {
        write_part(&mut zip, &label, start, &content, count, &mut parts)?
    }
    zip.start_file(
        "__reader__/document.json",
        SimpleFileOptions::default().compression_method(CompressionMethod::Stored),
    )
    .map_err(|e| e.to_string())?;
    serde_json::to_writer(&mut zip,&serde_json::json!({"format":"txt","encoding":label,"title":title,"parts":parts,"replacements":replacements})).map_err(|e|e.to_string())?;
    let mut file = zip.finish().map_err(|e| e.to_string())?;
    file.seek(SeekFrom::Start(0)).map_err(|e| e.to_string())?;
    Ok(file)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn source_text_encoding_stream_boundaries_and_literal_markup() {
        let cases = [
            ("utf-8", "第一章 开始\r\n<script>中文𠮷</script>\0"),
            ("gb18030", "中文文本"),
            ("big5", "繁體中文"),
            ("shift_jis", "日本語の文章"),
            ("windows-1251", "Русский текст"),
        ];
        for (label, value) in cases {
            let encoding = encoding_rs::Encoding::for_label(label.as_bytes()).unwrap();
            let (bytes, _, errors) = encoding.encode(value);
            assert!(!errors, "{label}");
            let mut source = tempfile::tempfile().unwrap();
            source.write_all(&bytes).unwrap();
            source.rewind().unwrap();
            let generated = text_archive(source, Some(label), "Test").unwrap();
            let mut zip = ZipArchive::new(generated).unwrap();
            let mut meta = String::new();
            zip.by_name("__reader__/document.json")
                .unwrap()
                .read_to_string(&mut meta)
                .unwrap();
            let meta: serde_json::Value = serde_json::from_str(&meta).unwrap();
            let path = meta["parts"][0]["path"].as_str().unwrap();
            let mut html = String::new();
            zip.by_name(path)
                .unwrap()
                .read_to_string(&mut html)
                .unwrap();
            for line in value.lines() {
                assert!(html.contains(&escape(line)), "{label}");
            }
            assert!(!html.contains("<script>"));
        }
        let original = format!(
            "{}\r\n𠮷{}",
            "x".repeat(TEXT_PART_CHARS - 1),
            "𠮷".repeat(TEXT_PART_CHARS)
        );
        for (label, little) in [("utf-16le", true), ("utf-16be", false)] {
            let bytes: Vec<u8> = original
                .encode_utf16()
                .flat_map(|u| {
                    if little {
                        u.to_le_bytes()
                    } else {
                        u.to_be_bytes()
                    }
                })
                .collect();
            let mut file = tempfile::tempfile().unwrap();
            file.write_all(&bytes).unwrap();
            file.rewind().unwrap();
            let mut zip =
                ZipArchive::new(text_archive(file, Some(label), "Test").unwrap()).unwrap();
            let mut raw = String::new();
            zip.by_name("__reader__/document.json")
                .unwrap()
                .read_to_string(&mut raw)
                .unwrap();
            let meta: serde_json::Value = serde_json::from_str(&raw).unwrap();
            assert_eq!(
                meta["parts"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|p| p["chars"].as_u64().unwrap())
                    .sum::<u64>(),
                original.replace("\r\n", "\n").chars().count() as u64
            );
            assert_eq!(meta["encoding"], label);
            assert_eq!(meta["replacements"], false);
        }
    }
    #[test]
    fn natural_page_order_and_source_suffixes() {
        let mut pages = vec![
            "10.png",
            "2.png",
            "1.png",
            "99999999999999999999.png",
            "100000000000000000000.png",
        ];
        pages.sort_by(|a, b| natural_cmp(a, b));
        assert_eq!(
            pages,
            vec![
                "1.png",
                "2.png",
                "10.png",
                "99999999999999999999.png",
                "100000000000000000000.png"
            ]
        );
        assert!(supported("book.TXT"));
        assert!(supported("book.cbz"));
        assert!(!supported("file.exe"));
        assert!(!image("__MACOSX/cover.png"));
        assert!(!image("../cover.jpg"));
    }
}
