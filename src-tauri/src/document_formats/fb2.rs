//! FB2 -> temporary reading EPUB. The original source and its SHA-256 never change.
//! Two passes keep only the chapter/resource catalog in memory. Binary payloads
//! bypass quick-xml's text-event buffer and are decoded directly into ZIP entries.
use super::escape;
use crate::linked_library::ImportedMetadata;
use std::{
    collections::HashMap,
    fs::File,
    io::{self, BufRead, Read, Seek, Write},
};

mod xhtml;
mod xml;
use xml::{binary, walk, xml_source, Visitor};

pub(super) fn archive(source: impl Read + Seek, fallback: &str) -> Result<File> {
    xhtml::archive(source, fallback)
}

const ROOT: &str = "__reader__/fb2/";
const NS: &str = "http://www.gribuser.ru/xml/fictionbook/2.0";
type Result<T> = std::result::Result<T, String>;
type Attrs = HashMap<String, String>;
fn error(e: impl std::fmt::Display) -> String {
    format!("FB2：{e}")
}
fn local(name: &[u8]) -> Result<String> {
    Ok(std::str::from_utf8(name)
        .map_err(error)?
        .rsplit(':')
        .next()
        .unwrap_or("")
        .into())
}
fn key(value: &str) -> String {
    value
        .as_bytes()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}
fn binary_path(id: &str) -> String {
    format!("{ROOT}b/{}", key(id))
}
fn anchor(id: &str) -> String {
    format!("f{}", key(id))
}
#[derive(Default)]
struct Chapter {
    node: usize,
    path: String,
    linear: bool,
}
struct Section {
    href: String,
    label: String,
    children: Vec<usize>,
}
#[derive(Default)]
struct Catalog {
    stack: Vec<(String, usize)>,
    body: Option<usize>,
    bodies: usize,
    active: Option<usize>,
    chapters: Vec<Chapter>,
    sections: Vec<Section>,
    section_stack: Vec<usize>,
    section_roots: Vec<usize>,
    ids: HashMap<String, String>,
    images: Vec<(String, String)>,
    title: String,
    language: String,
    authors: Vec<String>,
    author: String,
    identifier: String,
    cover: Option<String>,
}
impl Catalog {
    fn chapter(&mut self, node: usize) -> usize {
        if let Some(index) = self.active {
            return index;
        }
        let index = self.chapters.len();
        self.chapters.push(Chapter {
            node,
            path: format!("{ROOT}c{index}.xhtml"),
            linear: self.bodies == 1,
        });
        self.active = Some(index);
        index
    }
    fn metadata(&self, fallback: &str) -> ImportedMetadata {
        ImportedMetadata {
            title: if self.title.trim().is_empty() {
                fallback.into()
            } else {
                self.title.trim().into()
            },
            creator: self.authors.join(", "),
            language: self.language.trim().into(),
            spine: self
                .chapters
                .iter()
                .filter(|c| c.linear)
                .map(|c| c.path.clone())
                .collect(),
            cover_zip_path: self
                .cover
                .as_ref()
                .filter(|id| self.images.iter().any(|(i, _)| i == *id))
                .map(|id| binary_path(id)),
            cover_mime: self
                .cover
                .as_ref()
                .and_then(|id| self.images.iter().find(|(i, _)| i == id))
                .map(|(_, mime)| mime.clone())
                .unwrap_or_default(),
        }
    }
}
impl Visitor for Catalog {
    fn start(&mut self, name: &str, attrs: &Attrs, node: usize) -> Result<()> {
        if name == "body" && self.stack.len() == 1 {
            self.bodies += 1;
            self.body = Some(self.stack.len());
            self.active = None;
        } else if let Some(body) = self.body {
            if self.stack.len() == body + 1 && name == "section" {
                self.active = None;
            }
            let chapter = self.chapter(node);
            let path = self.chapters[chapter].path.clone();
            if let Some(id) = attrs.get("id") {
                if self.ids.insert(id.clone(), path.clone()).is_some() {
                    return Err(error("重复的元素 id"));
                }
            }
            if name == "section" {
                let id = attrs
                    .get("id")
                    .map(|s| anchor(s))
                    .unwrap_or_else(|| format!("n{node}"));
                let index = self.sections.len();
                self.sections.push(Section {
                    href: format!("{path}#{id}"),
                    label: String::new(),
                    children: Vec::new(),
                });
                if let Some(parent) = self.section_stack.last() {
                    self.sections[*parent].children.push(index);
                } else {
                    self.section_roots.push(index);
                }
                self.section_stack.push(index);
            }
        }
        if name == "image"
            && self.stack.last().is_some_and(|(s, _)| s == "coverpage")
            && self.stack.iter().any(|(s, _)| s == "title-info")
        {
            self.cover = attrs
                .get("href")
                .and_then(|s| s.strip_prefix('#'))
                .map(str::to_owned);
        }
        if name == "binary" {
            let id = attrs
                .get("id")
                .filter(|s| !s.is_empty())
                .ok_or_else(|| error("binary 缺少 id"))?;
            if self.images.iter().any(|(i, _)| i == id) {
                return Err(error("重复的 binary id"));
            }
            self.images.push((
                id.clone(),
                attrs
                    .get("content-type")
                    .cloned()
                    .unwrap_or_else(|| "application/octet-stream".into()),
            ));
        }
        self.stack.push((name.into(), node));
        Ok(())
    }
    fn text(&mut self, text: &str) -> Result<()> {
        let tag = self.stack.last().map(|(s, _)| s.as_str()).unwrap_or("");
        if self.stack.iter().any(|(s, _)| s == "title-info") {
            match tag {
                "book-title" => self.title.push_str(text),
                "lang" => self.language.push_str(text),
                "first-name" | "middle-name" | "last-name" | "nickname"
                    if self.stack.iter().any(|(s, _)| s == "author") =>
                {
                    self.author.push_str(text)
                }
                _ => {}
            }
        }
        if tag == "id" && self.stack.iter().any(|(s, _)| s == "document-info") {
            self.identifier.push_str(text);
        }
        if self.body.is_some() && self.stack.iter().any(|(s, _)| s == "title") {
            if let Some(index) = self.section_stack.last() {
                let label = &mut self.sections[*index].label;
                if label.len() < 4096 {
                    label.extend(text.chars().take(1024));
                }
            }
        }
        Ok(())
    }
    fn end(&mut self, name: &str) -> Result<()> {
        if matches!(
            name,
            "first-name" | "middle-name" | "last-name" | "nickname"
        ) && !self.author.ends_with(' ')
        {
            self.author.push(' ');
        }
        if name == "author" && self.stack.iter().any(|(s, _)| s == "title-info") {
            let author = self.author.split_whitespace().collect::<Vec<_>>().join(" ");
            if !author.is_empty() {
                self.authors.push(author);
            }
            self.author.clear();
        }
        if self.body.is_some() && name == "section" {
            self.section_stack.pop();
        }
        self.stack.pop();
        if self.body.is_some_and(|b| self.stack.len() == b) {
            self.body = None;
            self.active = None;
        }
        Ok(())
    }
    fn binary(&mut self, _: &Attrs, reader: &mut dyn BufRead) -> Result<bool> {
        binary(reader, None)?;
        Ok(false)
    }
}

fn catalog(source: &mut (impl Read + Seek)) -> Result<Catalog> {
    let mut catalog = Catalog::default();
    walk(source, &mut catalog)?;
    if !catalog.chapters.iter().any(|c| c.linear) {
        return Err(error("没有可阅读的 body"));
    }
    Ok(catalog)
}

pub(super) fn inspect(source: impl Read + Seek, fallback: &str) -> Result<ImportedMetadata> {
    let mut source = xml_source(source)?;
    Ok(catalog(&mut source)?.metadata(fallback))
}

struct Cover<'a> {
    target: &'a str,
    limit: u64,
    bytes: Vec<u8>,
    found: bool,
}
impl Write for Cover<'_> {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        if self.bytes.len() as u64 + bytes.len() as u64 > self.limit {
            return Err(io::Error::other("封面超出允许大小"));
        }
        self.bytes.extend_from_slice(bytes);
        Ok(bytes.len())
    }
    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}
impl Visitor for Cover<'_> {
    fn start(&mut self, _: &str, _: &Attrs, _: usize) -> Result<()> {
        Ok(())
    }
    fn text(&mut self, _: &str) -> Result<()> {
        Ok(())
    }
    fn end(&mut self, _: &str) -> Result<()> {
        Ok(())
    }
    fn binary(&mut self, attrs: &Attrs, reader: &mut dyn BufRead) -> Result<bool> {
        if attrs
            .get("id")
            .is_some_and(|id| binary_path(id) == self.target)
        {
            binary(reader, Some(self))?;
            self.found = true;
            Ok(true)
        } else {
            binary(reader, None)?;
            Ok(false)
        }
    }
}
pub(super) fn cover(source: impl Read + Seek, path: &str, limit: u64) -> Result<Vec<u8>> {
    let mut source = xml_source(source)?;
    let mut cover = Cover {
        target: path,
        limit,
        bytes: Vec::new(),
        found: false,
    };
    walk(&mut source, &mut cover)?;
    if !cover.found {
        return Err(error("找不到封面 binary"));
    }
    Ok(cover.bytes)
}

#[cfg(test)]
mod tests;
