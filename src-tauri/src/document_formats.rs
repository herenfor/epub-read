//! Source-format inspection and ephemeral reading resources. Original bytes are never rewritten.
mod fb2;
pub(crate) mod kindle;
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
        "epub" | "txt" | "cbz" | "zip" | "fb2" | "mobi" | "azw3"
    )
}
pub fn text(name: &str) -> bool {
    extension(name).eq_ignore_ascii_case("txt")
}
pub fn fictionbook(name: &str) -> bool {
    extension(name).eq_ignore_ascii_case("fb2")
}
pub fn kindle(name: &str) -> bool {
    matches!(
        extension(name).to_ascii_lowercase().as_str(),
        "mobi" | "azw3"
    )
}
pub fn virtual_archive(name: &str) -> bool {
    text(name) || fictionbook(name)
}
/// Source guards remain owned by the caller and cover the whole conversion.
pub fn reading_archive(
    source: impl Read + Seek, name: &str, encoding: Option<&str>, title: &str,
) -> Result<File, String> {
    if kindle(name) {
        // MOBI/AZW3 needs the opaque libmobi adapter, not a Rust text/XML
        // reimplementation. Callers own the conversion and its temp file.
        return Err("MOBI/AZW3 需要原生转换路径".into());
    }
    if fictionbook(name) {
        fb2::archive(source, title)
    } else {
        text_archive(source, encoding, title)
    }
}
/// FB2 cover paths name generated binary resources; detect the source container
/// rather than reserving those paths in genuine EPUBs.
pub(crate) fn read_cover(
    mut source: impl Read + Seek,
    path: &str,
    limit: u64,
) -> Result<Vec<u8>, String> {
    if path == kindle::COVER_PATH {
        let length = source.seek(SeekFrom::End(0)).map_err(|e| e.to_string())?;
        source.rewind().map_err(|e| e.to_string())?;
        return kindle::cover_reader(source, length, limit)
            .map_err(|error| error.import_message());
    }
    source.rewind().map_err(|e| e.to_string())?;
    let mut magic = [0; 2];
    let n = source.read(&mut magic).map_err(|e| e.to_string())?;
    source.rewind().map_err(|e| e.to_string())?;
    if n == 2 && magic == *b"PK" {
        let mut zip = ZipArchive::new(source).map_err(|e| format!("EPUB 不是有效 ZIP：{e}"))?;
        let mut entry = zip.by_name(path).map_err(|_| "EPUB 中找不到封面条目".to_string())?;
        crate::linked_library::epub_meta::read_zip_entry_bounded(&mut entry, limit, "封面")
    } else {
        fb2::cover(source, path, limit)
    }
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
    if text(file_name) {
        return inspect_reader(std::io::Cursor::new([]), file_name);
    }
    if kindle(file_name) {
        let title = Path::new(file_name)
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("Book");
        return kindle::inspect_path(path, title).map_err(|error| error.import_message());
    }
    inspect_reader(File::open(path).map_err(|e| e.to_string())?, file_name)
}

pub(crate) fn inspect_reader<R: Read + Seek + Send>(
    reader: R,
    file_name: &str,
) -> Result<ImportedMetadata, String> {
    let title = Path::new(file_name)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("Book")
        .to_owned();
    if kindle(file_name) {
        return kindle::inspect_reader(reader, &title).map_err(|error| error.import_message());
    }
    if fictionbook(file_name) { return fb2::inspect(reader, &title); }
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
    let mut zip = ZipArchive::new(reader).map_err(|e| e.to_string())?;
    if zip.by_name("META-INF/container.xml").is_ok() {
        return crate::linked_library::epub_meta::inspect_epub_archive(zip);
    }
    if !matches!(
        extension(file_name).to_ascii_lowercase().as_str(),
        "zip" | "cbz"
    ) {
        return Err("不是有效的 EPUB 文件".into());
    }
    // The shelf only needs a cover and proof of a readable image. The reader
    // builds its own ordered catalog when opened.
    let mut cover: Option<String> = None;
    for i in 0..zip.len() {
        let file = zip.by_index_raw(i).map_err(|error| error.to_string())?;
        if !file.is_dir() && image(file.name())
            && cover.as_ref().is_none_or(|first| natural_cmp(file.name(), first).is_lt())
        {
            cover = Some(file.name().to_owned());
        }
    }
    let cover = cover.ok_or("漫画压缩包内没有支持的图片")?;
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
        spine: vec![cover.clone()],
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
// Keep these title rules in sync with the Web TXT generator.
fn text_heading(line: &str) -> Option<&str> {
    let label = line.trim();
    if label.chars().take(81).count() > 80 {
        return None;
    }
    let lower = label.to_ascii_lowercase();
    if matches!(lower.as_str(), "prologue" | "epilogue")
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
                | "番外"
                | "番外篇"
                | "附录"
                | "附錄"
        )
    {
        return Some(label);
    }
    let number = |c: char| {
        c.is_ascii_digit() || "０１２３４５６７８９〇零一二三四五六七八九十百千万萬两兩壹贰貳叁參肆伍陆陸柒捌玖拾佰仟".contains(c)
    };
    let separator = |c: char| c.is_whitespace() || ":：.．、-—".contains(c);
    if let Some(rest) = label.strip_prefix('第') {
        let rest = rest.trim_start();
        let rest_after_number = rest.trim_start_matches(number);
        if rest.len() != rest_after_number.len()
            && rest_after_number
                .trim_start()
                .starts_with(['章', '节', '節', '回', '卷', '部', '話', '话'])
        {
            return Some(label);
        }
    }
    if let Some(rest) = lower
        .strip_prefix("chapter")
        .and_then(|rest| rest.starts_with(char::is_whitespace).then_some(rest))
    {
        let token = rest
            .trim_start()
            .split(separator)
            .next()
            .unwrap_or_default();
        if !token.is_empty()
            && (token.bytes().all(|c| c.is_ascii_digit())
                || token.bytes().all(|c| b"ivxlcdm".contains(&c)))
        {
            return Some(label);
        }
    }
    if let Some(rest) = label
        .strip_prefix("番外篇")
        .or_else(|| label.strip_prefix("番外"))
    {
        if rest.starts_with(separator) || rest.starts_with(number) {
            return Some(label);
        }
    }
    None
}

fn write_part(
    zip: &mut ZipWriter<File>,
    encoding: &str,
    start: usize,
    content: &str,
    count: usize,
    parts: &mut Vec<Part>,
    continuation: bool,
    next: Option<&str>,
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
    let mut has_text = false;
    for line in content.split_inclusive('\n') {
        let text = line.strip_suffix('\n').unwrap_or(line);
        let starts_line = offset != 0 || !continuation;
        let mut joined = String::new();
        let heading = if !starts_line {
            None
        } else if line.ends_with('\n') || next.is_none() {
            text_heading(text)
        } else {
            // A bounded look-ahead only for a possible heading split by a technical boundary.
            joined.extend(
                text.chars()
                    .chain(next.unwrap_or_default().chars().take_while(|c| *c != '\n'))
                    .take(121),
            );
            if joined.chars().count() <= 120 {
                text_heading(&joined)
            } else {
                None
            }
        };
        let blank = text.trim().is_empty();
        let content = if blank {
            "<br/>".to_owned()
        } else {
            escape(text)
        };
        if let Some(label) = heading {
            let page_break = if has_text {
                " data-txt-chapter-break=\"true\""
            } else {
                ""
            };
            html.push_str(&format!("<p id=\"t{offset}\"{page_break}>{content}</p>"));
            headings.push(Heading {
                label: label.to_owned(),
                offset,
            });
        } else if starts_line && !blank && !text.starts_with([' ', '\t', '\u{3000}', '\u{a0}']) {
            html.push_str(&format!("<p data-txt-indent=\"true\">{content}</p>"));
        } else {
            html.push_str(&format!("<p>{content}</p>"));
        }
        has_text |= !blank;
        offset += line.chars().count();
    }
    write!(zip,"<html xmlns=\"http://www.w3.org/1999/xhtml\"><head><meta charset=\"utf-8\"/><style>p{{margin:0;text-align:justify;white-space:pre-wrap;overflow-wrap:anywhere;break-inside:auto}}p[data-txt-indent]{{text-indent:var(--reader-txt-indent,0em)}}p[data-txt-chapter-break]{{break-before:column}}</style></head><body>{}</body></html>",html).map_err(|e|e.to_string())?;
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
    mut source: impl Read + Seek,
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
    let mut pending = None::<String>;
    let mut continuation = false;
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
                    if let Some(previous) = pending.replace(std::mem::take(&mut content)) {
                        write_part(
                            &mut zip,
                            &label,
                            start,
                            &previous,
                            TEXT_PART_CHARS,
                            &mut parts,
                            continuation,
                            pending.as_deref(),
                        )?;
                        start += TEXT_PART_CHARS;
                        continuation = !previous.ends_with('\n');
                        content = previous;
                        content.clear();
                    }
                    count = 0;
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
    if let Some(previous) = pending {
        write_part(
            &mut zip,
            &label,
            start,
            &previous,
            TEXT_PART_CHARS,
            &mut parts,
            continuation,
            (count > 0).then_some(content.as_str()),
        )?;
        start += TEXT_PART_CHARS;
        continuation = !previous.ends_with('\n');
    }
    if count > 0 || parts.is_empty() {
        write_part(
            &mut zip,
            &label,
            start,
            &content,
            count,
            &mut parts,
            continuation,
            None,
        )?;
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
            assert!(html.contains("text-align:justify"), "{label}");
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
    fn text_indent_and_toc_keep_split_heading_on_original_part() {
        let first = "正文\n　已有缩进\n\nChapter IV: Start\n第一个人回到家\n番外：之后\n";
        let text = format!(
            "{first}{}\n第十二章 远方\n下一段",
            "x".repeat(TEXT_PART_CHARS - first.chars().count() - 3)
        );
        let mut source = tempfile::tempfile().unwrap();
        source.write_all(text.as_bytes()).unwrap();
        source.rewind().unwrap();
        let mut archive =
            ZipArchive::new(text_archive(source, Some("utf-8"), "Test").unwrap()).unwrap();
        let manifest: serde_json::Value =
            serde_json::from_reader(archive.by_name("__reader__/document.json").unwrap()).unwrap();
        let first = &manifest["parts"][0];
        let second = &manifest["parts"][1];
        let headings = first["headings"].as_array().unwrap();
        assert_eq!(
            headings
                .iter()
                .map(|h| h["label"].as_str().unwrap())
                .collect::<Vec<_>>(),
            ["Chapter IV: Start", "番外：之后", "第十二章 远方"]
        );
        assert_eq!(headings[2]["offset"], TEXT_PART_CHARS - 2);
        assert_eq!(second["start"], TEXT_PART_CHARS);
        assert_eq!(second["headings"], serde_json::json!([]));
        let mut read = |part: &serde_json::Value| {
            let mut html = String::new();
            archive
                .by_name(part["path"].as_str().unwrap())
                .unwrap()
                .read_to_string(&mut html)
                .unwrap();
            html
        };
        assert!(read(first)
            .contains(r#"<p data-txt-indent="true">正文</p><p>　已有缩进</p><p><br/></p>"#));
        assert!(read(second).contains(r#"<p>二章 远方</p><p data-txt-indent="true">下一段</p>"#));
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
