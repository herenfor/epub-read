//! Generate only reader-owned XHTML/OPF/navigation resources.
use super::*;
use zip::{write::SimpleFileOptions, CompressionMethod, ZipWriter};

// FB2 has semantic tags, rather than author HTML. Emit a small, safe XHTML
// vocabulary; EPUB sanitization/resource rewriting remains the reader's job.
fn html_tag(name: &str) -> &str {
    match name {
        "section" | "title" | "epigraph" | "cite" | "poem" | "stanza" | "annotation" => "div",
        "subtitle" => "h3",
        "strong" => "strong",
        "emphasis" => "em",
        "strikethrough" => "s",
        "code" => "code",
        "sub" => "sub",
        "sup" => "sup",
        "p" | "table" | "tr" | "td" | "th" | "a" => name,
        "v" | "text-author" | "date" => "p",
        "empty-line" => "br",
        "image" => "img",
        _ => "span",
    }
}
struct Renderer<'a> {
    catalog: &'a Catalog,
    zip: &'a mut ZipWriter<File>,
    stack: Vec<(String, bool)>,
    active: bool,
    body: bool,
    next_chapter: usize,
}
impl Renderer<'_> {
    fn close_chapter(&mut self) -> Result<()> {
        if self.active {
            self.zip.write_all(b"</body></html>").map_err(error)?;
            self.active = false;
        }
        Ok(())
    }
}
impl Visitor for Renderer<'_> {
    fn start(&mut self, name: &str, attrs: &Attrs, node: usize) -> Result<()> {
        if name == "body" && self.stack.len() == 1 {
            self.body = true;
        }
        if let Some(chapter) = self
            .catalog
            .chapters
            .get(self.next_chapter)
            .filter(|c| c.node == node)
        {
            self.close_chapter()?;
            self.zip
                .start_file(&chapter.path, options())
                .map_err(error)?;
            self.zip.write_all(b"<html xmlns=\"http://www.w3.org/1999/xhtml\" xmlns:epub=\"http://www.idpf.org/2007/ops\"><head><meta charset=\"utf-8\"/><link rel=\"stylesheet\" href=\"style.css\"/></head><body>").map_err(error)?;
            self.active = true;
            self.next_chapter += 1;
        }
        let emit = self.body && self.active && name != "body";
        if emit {
            let tag = html_tag(name);
            write!(self.zip, "<{tag} class=\"fb2-{}\"", escape(name)).map_err(error)?;
            if let Some(id) = attrs.get("id") {
                write!(self.zip, " id=\"{}\"", anchor(id)).map_err(error)?;
            } else if name == "section" {
                write!(self.zip, " id=\"n{node}\"").map_err(error)?;
            }
            if let Some(lang) = attrs.get("lang") {
                write!(self.zip, " lang=\"{}\"", escape(lang)).map_err(error)?;
            }
            if matches!(name, "td" | "th") {
                for attribute in ["colspan", "rowspan"] {
                    if let Some(value) = attrs.get(attribute).filter(|v| v.parse::<u16>().is_ok()) {
                        write!(self.zip, " {attribute}=\"{value}\"").map_err(error)?;
                    }
                }
            }
            if name == "a" {
                if let Some(href) = attrs.get("href") {
                    let href = if let Some(id) = href.strip_prefix('#') {
                        self.catalog
                            .ids
                            .get(id)
                            .map(|path| format!("{}#{}", path.trim_start_matches(ROOT), anchor(id)))
                    } else if href.starts_with("https://")
                        || href.starts_with("http://")
                        || href.starts_with("mailto:")
                    {
                        Some(href.clone())
                    } else {
                        None
                    };
                    if let Some(href) = href {
                        write!(self.zip, " href=\"{}\"", escape(&href)).map_err(error)?;
                    }
                }
                if attrs.get("type").is_some_and(|s| s == "note") {
                    self.zip
                        .write_all(b" epub:type=\"noteref\"")
                        .map_err(error)?;
                }
            }
            if name == "image" {
                if let Some(id) = attrs.get("href").and_then(|s| s.strip_prefix('#')) {
                    write!(
                        self.zip,
                        " src=\"b/{}\" alt=\"{}\"",
                        key(id),
                        escape(attrs.get("alt").map(String::as_str).unwrap_or(""))
                    )
                    .map_err(error)?;
                }
            }
            self.zip
                .write_all(if tag == "br" || tag == "img" {
                    b"/>"
                } else {
                    b">"
                })
                .map_err(error)?;
        }
        self.stack.push((name.into(), emit));
        Ok(())
    }
    fn text(&mut self, text: &str) -> Result<()> {
        if self.stack.last().is_some_and(|(_, emit)| *emit) {
            self.zip.write_all(escape(text).as_bytes()).map_err(error)?;
        }
        Ok(())
    }
    fn end(&mut self, name: &str) -> Result<()> {
        let (_, emit) = self
            .stack
            .pop()
            .ok_or_else(|| error("结束标签无对应元素"))?;
        if emit && !matches!(html_tag(name), "br" | "img") {
            write!(self.zip, "</{}>", html_tag(name)).map_err(error)?;
        }
        if name == "body" && self.stack.len() == 1 {
            self.close_chapter()?;
            self.body = false;
        }
        Ok(())
    }
    fn binary(&mut self, attrs: &Attrs, reader: &mut dyn BufRead) -> Result<bool> {
        self.zip
            .start_file(
                binary_path(attrs.get("id").ok_or_else(|| error("binary 缺少 id"))?),
                options(),
            )
            .map_err(error)?;
        binary(reader, Some(self.zip))?;
        Ok(false)
    }
}
fn options() -> SimpleFileOptions {
    SimpleFileOptions::default().compression_method(CompressionMethod::Stored)
}
fn entry(zip: &mut ZipWriter<File>, name: &str, contents: &str) -> Result<()> {
    zip.start_file(name, options()).map_err(error)?;
    zip.write_all(contents.as_bytes()).map_err(error)
}
pub(super) fn archive(source: impl Read + Seek, fallback: &str) -> Result<File> {
    let mut source = xml_source(source)?;
    let catalog = catalog(&mut source)?;
    let metadata = catalog.metadata(fallback);
    let mut zip = ZipWriter::new(tempfile::tempfile().map_err(error)?);
    entry(&mut zip, "mimetype", "application/epub+zip")?;
    {
        let mut renderer = Renderer {
            catalog: &catalog,
            zip: &mut zip,
            stack: Vec::new(),
            active: false,
            body: false,
            next_chapter: 0,
        };
        walk(&mut source, &mut renderer)?;
    }
    entry(
        &mut zip,
        "META-INF/container.xml",
        &format!(
            r#"<container xmlns="urn:oasis:names:tc:opendocument:xmlns:container" version="1.0"><rootfiles><rootfile full-path="{ROOT}package.opf" media-type="application/oebps-package+xml"/></rootfiles></container>"#
        ),
    )?;
    entry(&mut zip, &format!("{ROOT}style.css"), "p{margin:.5em 0;text-align:justify}.fb2-title{font-size:1.25em;margin:1em 0;text-align:center}.fb2-title p{margin:0;text-align:inherit}.fb2-epigraph,.fb2-cite{margin:1em 2em}.fb2-v{white-space:pre-wrap;margin:0}.fb2-stanza{margin:1em 0}.fb2-text-author{text-align:right}.fb2-image{max-width:100%;height:auto}.fb2-table{max-width:100%;border-collapse:collapse}td,th{border:1px solid;padding:.2em}")?;
    let mut nav = String::from(
        r#"<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>Contents</title></head><body><nav epub:type="toc"><ol>"#,
    );
    fn items(c: &Catalog, indices: &[usize], output: &mut String) {
        for i in indices {
            let section = &c.sections[*i];
            output.push_str(&format!(
                "<li><a href=\"{}\">{}</a>",
                escape(section.href.trim_start_matches(ROOT)),
                escape(if section.label.trim().is_empty() {
                    "§"
                } else {
                    section.label.trim()
                })
            ));
            if !section.children.is_empty() {
                output.push_str("<ol>");
                items(c, &section.children, output);
                output.push_str("</ol>");
            }
            output.push_str("</li>");
        }
    }
    items(&catalog, &catalog.section_roots, &mut nav);
    if catalog.sections.is_empty() {
        nav.push_str(&format!(
            "<li><a href=\"{}\">{}</a></li>",
            catalog.chapters[0].path.trim_start_matches(ROOT),
            escape(&metadata.title)
        ));
    }
    nav.push_str("</ol></nav></body></html>");
    entry(&mut zip, &format!("{ROOT}nav.xhtml"), &nav)?;
    let mut opf = format!(
        r#"<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="id">{}</dc:identifier><dc:title>{}</dc:title><dc:creator>{}</dc:creator><dc:language>{}</dc:language></metadata><manifest><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/><item id="css" href="style.css" media-type="text/css"/>"#,
        escape(&catalog.identifier),
        escape(&metadata.title),
        escape(&metadata.creator),
        escape(&metadata.language)
    );
    for (i, chapter) in catalog.chapters.iter().enumerate() {
        opf.push_str(&format!(
            "<item id=\"c{i}\" href=\"{}\" media-type=\"application/xhtml+xml\"/>",
            chapter.path.trim_start_matches(ROOT)
        ));
    }
    for (i, (id, mime)) in catalog.images.iter().enumerate() {
        opf.push_str(&format!(
            "<item id=\"b{i}\" href=\"b/{}\" media-type=\"{}\"{}/>",
            key(id),
            escape(mime),
            if catalog.cover.as_ref() == Some(id) {
                " properties=\"cover-image\""
            } else {
                ""
            }
        ));
    }
    opf.push_str("</manifest><spine>");
    for (i, chapter) in catalog.chapters.iter().enumerate() {
        opf.push_str(&format!(
            "<itemref idref=\"c{i}\" linear=\"{}\"/>",
            if chapter.linear { "yes" } else { "no" }
        ));
    }
    opf.push_str("</spine></package>");
    entry(&mut zip, &format!("{ROOT}package.opf"), &opf)?;
    let mut file = zip.finish().map_err(error)?;
    file.rewind().map_err(error)?;
    Ok(file)
}
