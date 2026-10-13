//! EPUB metadata and bounded XML/cover entry parsing.

use super::{ImportedMetadata, MAX_XML_BYTES};
use quick_xml::events::Event;
use quick_xml::{Reader, XmlVersion};
use std::collections::HashMap;
use std::fs::File;
use std::io::Read;
use std::path::Path;
use zip::ZipArchive;

#[derive(Debug, Clone)]
struct OpfManifestItem {
    id: String,
    href: String,
    media_type: String,
    properties: String,
}

#[derive(Debug)]
struct ParsedOpfMetadata {
    title: String,
    creator: String,
    language: String,
    spine: Vec<String>,
    manifest: Vec<OpfManifestItem>,
    epub2_cover_id: Option<String>,
    base: String,
}

fn zip_path_from_relative(base: &str, href: &str) -> Option<String> {
    let href = href
        .split('#')
        .next()
        .unwrap_or("")
        .split('?')
        .next()
        .unwrap_or("");
    let href = percent_decode_path(href);
    if href.is_empty() || href.contains('\\') || href.starts_with('/') {
        return None;
    }
    let mut parts: Vec<&str> = base.split('/').filter(|part| !part.is_empty()).collect();
    for part in href.split('/') {
        match part {
            "" | "." => {}
            ".." => {
                if parts.pop().is_none() {
                    return None;
                }
            }
            component => parts.push(component),
        }
    }
    if parts.is_empty() {
        None
    } else {
        Some(parts.join("/"))
    }
}

/// EPUB 内部 URI 使用 UTF-8 百分号编码。错误的转义保留原字节，和前端
/// `decodeURIComponent` 失败时保留原值的容错策略一致。
fn percent_decode_path(value: &str) -> String {
    let bytes = value.as_bytes();
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' && index + 2 < bytes.len() {
            let hi = (bytes[index + 1] as char).to_digit(16);
            let lo = (bytes[index + 2] as char).to_digit(16);
            if let (Some(hi), Some(lo)) = (hi, lo) {
                decoded.push((hi * 16 + lo) as u8);
                index += 3;
                continue;
            }
        }
        decoded.push(bytes[index]);
        index += 1;
    }
    String::from_utf8(decoded).unwrap_or_else(|_| value.to_string())
}

fn xml_name(name: &[u8]) -> &str {
    let text = std::str::from_utf8(name).unwrap_or("");
    text.rsplit(':').next().unwrap_or(text)
}

fn xml_attr(
    reader: &Reader<&[u8]>,
    event: &quick_xml::events::BytesStart<'_>,
    wanted: &str,
) -> Option<String> {
    event.attributes().flatten().find_map(|attribute| {
        (xml_name(attribute.key.as_ref()) == wanted)
            .then(|| {
                attribute
                    // Kept for XML 1.0-compatible EPUB metadata; quick-xml's
                    // replacement additionally requires an explicit version.
                    .decoded_and_normalized_value(XmlVersion::Implicit1_0, reader.decoder())
                    .ok()
                    .map(|value| value.into_owned())
            })
            .flatten()
    })
}

fn parse_container(xml: &[u8]) -> Result<String, String> {
    let mut reader = Reader::from_reader(xml);
    reader.config_mut().trim_text(true);
    let mut buffer = Vec::new();
    loop {
        match reader.read_event_into(&mut buffer) {
            Ok(Event::Start(event)) | Ok(Event::Empty(event))
                if xml_name(event.name().as_ref()) == "rootfile" =>
            {
                return xml_attr(&reader, &event, "full-path")
                    .ok_or_else(|| "EPUB container.xml 缺少 rootfile 路径".into())
            }
            Ok(Event::Eof) => return Err("EPUB container.xml 没有 rootfile".into()),
            Err(error) => return Err(format!("无法解析 EPUB container.xml：{error}")),
            _ => {}
        }
        buffer.clear();
    }
}

fn parse_opf(xml: &[u8], opf_path: &str) -> Result<ParsedOpfMetadata, String> {
    let mut reader = Reader::from_reader(xml);
    reader.config_mut().trim_text(true);
    let mut buffer = Vec::new();
    let base = opf_path
        .rsplit_once('/')
        .map(|(parent, _)| parent)
        .unwrap_or("");
    let mut title = String::new();
    let mut creator = String::new();
    let mut language = String::new();
    let mut capture: Option<&str> = None;
    let mut manifest = Vec::new();
    let mut manifest_indexes = HashMap::new();
    let mut spine_ids = Vec::new();
    let mut epub2_cover_id: Option<String> = None;
    loop {
        match reader.read_event_into(&mut buffer) {
            Ok(Event::Start(event)) => {
                let event_name = event.name();
                let name = xml_name(event_name.as_ref());
                capture = match name {
                    "title" if title.is_empty() => Some("title"),
                    "creator" if creator.is_empty() => Some("creator"),
                    "language" if language.is_empty() => Some("language"),
                    _ => None,
                };
                if name == "item" {
                    if let (Some(id), Some(href)) = (
                        xml_attr(&reader, &event, "id"),
                        xml_attr(&reader, &event, "href"),
                    ) {
                        let media = xml_attr(&reader, &event, "media-type").unwrap_or_default();
                        let properties =
                            xml_attr(&reader, &event, "properties").unwrap_or_default();
                        let index = manifest.len();
                        manifest.push(OpfManifestItem {
                            id: id.clone(),
                            href,
                            media_type: media,
                            properties,
                        });
                        manifest_indexes.insert(id, index);
                    }
                } else if name == "itemref" {
                    if let Some(idref) = xml_attr(&reader, &event, "idref") {
                        if xml_attr(&reader, &event, "linear").as_deref() != Some("no") {
                            spine_ids.push(idref);
                        }
                    }
                } else if name == "meta"
                    && xml_attr(&reader, &event, "name").as_deref() == Some("cover")
                {
                    epub2_cover_id = xml_attr(&reader, &event, "content");
                }
            }
            Ok(Event::Empty(event)) => {
                let event_name = event.name();
                let name = xml_name(event_name.as_ref());
                if name == "item" {
                    if let (Some(id), Some(href)) = (
                        xml_attr(&reader, &event, "id"),
                        xml_attr(&reader, &event, "href"),
                    ) {
                        let media = xml_attr(&reader, &event, "media-type").unwrap_or_default();
                        let properties =
                            xml_attr(&reader, &event, "properties").unwrap_or_default();
                        let index = manifest.len();
                        manifest.push(OpfManifestItem {
                            id: id.clone(),
                            href,
                            media_type: media,
                            properties,
                        });
                        manifest_indexes.insert(id, index);
                    }
                } else if name == "itemref" {
                    if let Some(idref) = xml_attr(&reader, &event, "idref") {
                        if xml_attr(&reader, &event, "linear").as_deref() != Some("no") {
                            spine_ids.push(idref);
                        }
                    }
                } else if name == "meta"
                    && xml_attr(&reader, &event, "name").as_deref() == Some("cover")
                {
                    epub2_cover_id = xml_attr(&reader, &event, "content");
                }
            }
            Ok(Event::Text(text)) => {
                if let Some(kind) = capture {
                    let value = text
                        .decode()
                        .map_err(|error| format!("无法解码 OPF 元数据：{error}"))?;
                    if kind == "title" {
                        title = value.trim().to_string();
                    } else if kind == "creator" {
                        creator = value.trim().to_string();
                    } else {
                        language = value.trim().to_string();
                    }
                }
            }
            Ok(Event::End(_)) => capture = None,
            Ok(Event::Eof) => break,
            Err(error) => return Err(format!("无法解析 EPUB OPF：{error}")),
            _ => {}
        }
        buffer.clear();
    }
    let spine = spine_ids
        .into_iter()
        .filter_map(|id| {
            manifest_indexes
                .get(&id)
                .and_then(|index| manifest.get(*index))
        })
        .filter_map(|item| zip_path_from_relative(base, &item.href))
        .collect();
    Ok(ParsedOpfMetadata {
        title,
        creator,
        language,
        spine,
        manifest,
        epub2_cover_id,
        base: base.to_string(),
    })
}

fn inferred_cover_mime(path: &str) -> Option<&'static str> {
    let extension = path.rsplit_once('.')?.1;
    if extension.eq_ignore_ascii_case("jpg") || extension.eq_ignore_ascii_case("jpeg") {
        Some("image/jpeg")
    } else if extension.eq_ignore_ascii_case("png") {
        Some("image/png")
    } else if extension.eq_ignore_ascii_case("webp") {
        Some("image/webp")
    } else if extension.eq_ignore_ascii_case("avif") {
        Some("image/avif")
    } else if extension.eq_ignore_ascii_case("gif") {
        Some("image/gif")
    } else if extension.eq_ignore_ascii_case("svg") {
        Some("image/svg+xml")
    } else {
        None
    }
}

fn cover_mime(item: &OpfManifestItem, zip_path: &str) -> Option<String> {
    let declared = item.media_type.trim();
    if declared
        .get(..6)
        .map(|prefix| prefix.eq_ignore_ascii_case("image/"))
        .unwrap_or(false)
    {
        return Some(declared.to_ascii_lowercase());
    }
    inferred_cover_mime(zip_path).map(str::to_string)
}

fn is_cover_filename(path: &str) -> bool {
    let Some(file_name) = path.rsplit('/').next() else {
        return false;
    };
    let Some((stem, _)) = file_name.rsplit_once('.') else {
        return false;
    };
    stem.eq_ignore_ascii_case("cover")
}

/// 产生封面候选的优先级：EPUB3 → EPUB2 → 精确的 `cover.*` 文件名。
/// `exists` 只查询 ZIP 中央目录，不读取、解压或解码图片。
fn select_cover<F>(parsed: &ParsedOpfMetadata, mut exists: F) -> (Option<String>, String)
where
    F: FnMut(&str) -> bool,
{
    let mut candidate_indexes = Vec::new();
    candidate_indexes.extend(
        parsed
            .manifest
            .iter()
            .enumerate()
            .filter(|(_, item)| {
                item.properties
                    .split_ascii_whitespace()
                    .any(|property| property == "cover-image")
            })
            .map(|(index, _)| index),
    );
    if let Some(cover_id) = &parsed.epub2_cover_id {
        candidate_indexes.extend(
            parsed
                .manifest
                .iter()
                .enumerate()
                .filter(|(_, item)| item.id == *cover_id)
                .map(|(index, _)| index),
        );
    }
    candidate_indexes.extend(
        parsed
            .manifest
            .iter()
            .enumerate()
            .filter(|(_, item)| {
                zip_path_from_relative(&parsed.base, &item.href)
                    .as_deref()
                    .map(is_cover_filename)
                    .unwrap_or(false)
            })
            .map(|(index, _)| index),
    );

    for index in candidate_indexes {
        let Some(item) = parsed.manifest.get(index) else {
            continue;
        };
        let Some(path) = zip_path_from_relative(&parsed.base, &item.href) else {
            continue;
        };
        let Some(mime) = cover_mime(item, &path) else {
            continue;
        };
        if exists(&path) {
            return (Some(path), mime);
        }
    }
    (None, String::new())
}

pub(super) fn read_zip_entry_bounded<R: Read>(
    entry: &mut R,
    limit: u64,
    label: &str,
) -> Result<Vec<u8>, String> {
    let mut bytes = Vec::new();
    entry
        .take(limit.saturating_add(1))
        .read_to_end(&mut bytes)
        .map_err(|error| format!("无法读取 EPUB {label}：{error}"))?;
    if bytes.len() as u64 > limit {
        return Err(format!("EPUB {label} 解压后超过允许大小"));
    }
    Ok(bytes)
}

pub(crate) fn inspect_epub(path: &Path) -> Result<ImportedMetadata, String> {
    let file = File::open(path).map_err(|error| format!("无法打开 EPUB ZIP：{error}"))?;
    let mut archive =
        ZipArchive::new(file).map_err(|error| format!("EPUB 不是有效 ZIP：{error}"))?;
    let mut container_entry = archive
        .by_name("META-INF/container.xml")
        .map_err(|_| "EPUB 缺少 META-INF/container.xml".to_string())?;
    let container = read_zip_entry_bounded(&mut container_entry, MAX_XML_BYTES, "container.xml")?;
    drop(container_entry);
    // Touch the declaration only.  Rendering remains responsible for its DRM
    // policy; import must not unpack the book or pretend encrypted content is plain.
    if let Ok(mut encryption) = archive.by_name("META-INF/encryption.xml") {
        let _declaration = read_zip_entry_bounded(&mut encryption, MAX_XML_BYTES, "加密声明")?;
    }
    let opf_path = parse_container(&container)?;
    let mut opf_entry = archive
        .by_name(&opf_path)
        .map_err(|_| "EPUB container.xml 指向的 OPF 不存在".to_string())?;
    let opf = read_zip_entry_bounded(&mut opf_entry, MAX_XML_BYTES, "OPF")?;
    drop(opf_entry);
    let parsed = parse_opf(&opf, &opf_path)?;
    let (cover_zip_path, cover_mime) =
        select_cover(&parsed, |candidate| archive.by_name(candidate).is_ok());
    Ok(ImportedMetadata {
        title: parsed.title,
        creator: parsed.creator,
        language: parsed.language,
        spine: parsed.spine,
        cover_zip_path,
        cover_mime,
    })
}

/// Derived local cover metadata; never part of portable book identity/state.
pub(crate) fn inspect_epub_cover(path: &Path) -> Result<(Option<String>, String), String> {
    let metadata = inspect_epub(path)?;
    Ok((metadata.cover_zip_path, metadata.cover_mime))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn zip_relative_path_stays_inside_archive() {
        assert_eq!(
            zip_path_from_relative("OPS", "text/chapter.xhtml"),
            Some("OPS/text/chapter.xhtml".into())
        );
        assert_eq!(
            zip_path_from_relative("OPS", "../cover.jpg"),
            Some("cover.jpg".into())
        );
        assert_eq!(zip_path_from_relative("OPS", "../../escape.jpg"), None);
        assert_eq!(zip_path_from_relative("OPS", "/absolute.jpg"), None);
    }

    #[test]
    fn bounded_zip_reads_reject_inflated_entries() {
        assert_eq!(
            read_zip_entry_bounded(&mut std::io::Cursor::new(b"abc"), 3, "test").unwrap(),
            b"abc".to_vec()
        );
        assert!(read_zip_entry_bounded(&mut std::io::Cursor::new(b"abcd"), 3, "test").is_err());
    }

    #[test]
    fn opf_parser_finds_metadata_spine_and_epub3_cover() {
        let opf = br#"<package><metadata><dc:title xmlns:dc='x'>Title</dc:title><dc:creator xmlns:dc='x'>Author</dc:creator><dc:language xmlns:dc='x'>zh-CN</dc:language></metadata><manifest><item id='c' href='cover.jpg' media-type='image/jpeg' properties='cover-image'/><item id='a' href='text/a.xhtml' media-type='application/xhtml+xml'/></manifest><spine><itemref idref='a'/></spine></package>"#;
        let parsed = parse_opf(opf, "OPS/book.opf").unwrap();
        assert_eq!(parsed.title, "Title");
        assert_eq!(parsed.creator, "Author");
        assert_eq!(parsed.language, "zh-CN");
        assert_eq!(parsed.spine, vec!["OPS/text/a.xhtml"]);
        let (cover_path, cover_mime) = select_cover(&parsed, |_| true);
        assert_eq!(cover_path.as_deref(), Some("OPS/cover.jpg"));
        assert_eq!(cover_mime, "image/jpeg");
    }

    #[test]
    fn opf_parser_falls_back_to_cover_filename_in_manifest_order() {
        let opf = br#"<package><metadata><dc:title xmlns:dc='x'>Title</dc:title></metadata><manifest><item id='image001' href='Images/Cover%2EWEBP?cache=1#preview' media-type=''/><item id='cover-css' href='Styles/cover.css' media-type='text/css'/></manifest><spine/></package>"#;
        let parsed = parse_opf(opf, "OPS/book.opf").unwrap();
        let (cover_path, cover_mime) =
            select_cover(&parsed, |path| path == "OPS/Images/Cover.WEBP");
        assert_eq!(cover_path.as_deref(), Some("OPS/Images/Cover.WEBP"));
        assert_eq!(cover_mime, "image/webp");
    }

    #[test]
    fn cover_selection_skips_invalid_standard_candidates_before_filename_fallback() {
        let opf = br#"<package><metadata><meta name='cover' content='cover-css'/></metadata><manifest><item id='missing' href='missing.jpg' media-type='image/jpeg' properties='cover-image'/><item id='cover-css' href='Styles/cover.css' media-type='text/css'/><item id='image001' href='Images/cover.webp' media-type='text/plain'/></manifest><spine/></package>"#;
        let parsed = parse_opf(opf, "OPS/book.opf").unwrap();
        let (cover_path, cover_mime) =
            select_cover(&parsed, |path| path == "OPS/Images/cover.webp");
        assert_eq!(cover_path.as_deref(), Some("OPS/Images/cover.webp"));
        assert_eq!(cover_mime, "image/webp");
    }
}
