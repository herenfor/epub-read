//! Strict, bounded DAV multistatus parsing. A partial/foreign listing must never
//! be mistaken for an empty directory by the state planner.
use super::remote::{RemoteEntry, RemoteError, RemoteErrorCode};
use quick_xml::{events::Event, name::ResolveResult, reader::NsReader};
use reqwest::Url;
use std::collections::BTreeMap;

fn invalid() -> RemoteError {
    RemoteError::new(RemoteErrorCode::InvalidResponse)
}

#[derive(Default)]
struct Node {
    name: String,
    text: String,
    children: Vec<Node>,
}

impl Node {
    fn children(&self, name: &'static str) -> impl Iterator<Item = &Node> {
        self.children.iter().filter(move |node| node.name == name)
    }

    fn one(&self, name: &'static str) -> Result<Option<&Node>, RemoteError> {
        let mut nodes = self.children(name);
        let first = nodes.next();
        if nodes.next().is_some() {
            return Err(invalid());
        }
        Ok(first)
    }

    fn value(&self) -> Result<&str, RemoteError> {
        if !self.children.is_empty() {
            return Err(invalid());
        }
        Ok(self.text.trim())
    }
}

fn xml_tree(bytes: &[u8]) -> Result<Node, RemoteError> {
    let mut reader = NsReader::from_reader(bytes);
    reader.config_mut().expand_empty_elements = true;
    let mut stack = vec![Node::default()];
    let mut count = 0;
    loop {
        let (namespace, event) = reader.read_resolved_event().map_err(|_| invalid())?;
        match event {
            Event::Start(event) => {
                count += 1;
                if stack.len() >= 32 || count > 16_384 {
                    return Err(invalid());
                }
                let name = match namespace {
                    ResolveResult::Bound(namespace) if namespace.as_ref() == b"DAV:" => {
                        std::str::from_utf8(event.local_name().as_ref())
                            .map_err(|_| invalid())?
                            .to_owned()
                    }
                    ResolveResult::Unknown(_) => return Err(invalid()),
                    _ => String::new(),
                };
                stack.push(Node {
                    name,
                    ..Default::default()
                });
            }
            Event::End(_) => {
                if stack.len() <= 1 {
                    return Err(invalid());
                }
                let node = stack.pop().unwrap();
                stack.last_mut().unwrap().children.push(node);
            }
            Event::Text(text) => stack
                .last_mut()
                .unwrap()
                .text
                .push_str(&text.decode().map_err(|_| invalid())?),
            Event::CData(text) => stack
                .last_mut()
                .unwrap()
                .text
                .push_str(&text.decode().map_err(|_| invalid())?),
            Event::GeneralRef(reference) => {
                let ch = reference
                    .resolve_char_ref()
                    .map_err(|_| invalid())?
                    .or_else(|| match &reference[..] {
                        b"amp" => Some('&'),
                        b"lt" => Some('<'),
                        b"gt" => Some('>'),
                        b"quot" => Some('"'),
                        b"apos" => Some('\''),
                        _ => None,
                    })
                    .ok_or_else(invalid)?;
                stack.last_mut().unwrap().text.push(ch);
            }
            Event::DocType(_) => return Err(invalid()),
            Event::Eof => break,
            _ => {}
        }
    }
    if stack.len() != 1 {
        return Err(invalid());
    }
    let mut outer = stack.pop().unwrap();
    if !outer.text.trim().is_empty() || outer.children.len() != 1 {
        return Err(invalid());
    }
    let root = outer.children.pop().unwrap();
    if root.name != "multistatus" {
        return Err(invalid());
    }
    Ok(root)
}

fn status(node: &Node) -> Result<u16, RemoteError> {
    let text = node.value()?;
    let mut fields = text.split_whitespace();
    if !fields
        .next()
        .is_some_and(|version| version.starts_with("HTTP/"))
    {
        return Err(invalid());
    }
    fields
        .next()
        .and_then(|value| value.parse().ok())
        .ok_or_else(invalid)
}

fn decoded_segments(url: &Url) -> Result<Vec<String>, RemoteError> {
    url.path_segments()
        .ok_or_else(invalid)?
        .filter(|s| !s.is_empty())
        .map(|segment| {
            let bytes = segment.as_bytes();
            let mut output = Vec::new();
            let mut i = 0;
            while i < bytes.len() {
                if bytes[i] == b'%' {
                    let hex = bytes
                        .get(i + 1..i + 3)
                        .and_then(|value| std::str::from_utf8(value).ok())
                        .ok_or_else(invalid)?;
                    output.push(u8::from_str_radix(hex, 16).map_err(|_| invalid())?);
                    i += 3;
                } else {
                    output.push(bytes[i]);
                    i += 1;
                }
            }
            let result = String::from_utf8(output).map_err(|_| invalid())?;
            if matches!(result.as_str(), "." | "..")
                || result
                    .chars()
                    .any(|c| c.is_control() || c == '/' || c == '\\')
            {
                return Err(invalid());
            }
            Ok(result)
        })
        .collect()
}

pub(super) fn listing(bytes: &[u8], directory: &Url) -> Result<Vec<RemoteEntry>, RemoteError> {
    let root = xml_tree(bytes)?;
    let expected = decoded_segments(directory)?;
    let mut found_self = false;
    let mut entries = BTreeMap::new();
    for response in root.children("response") {
        if entries.len() >= 1024 {
            return Err(RemoteError::new(RemoteErrorCode::SizeLimit));
        }
        let href = response.one("href")?.ok_or_else(invalid)?.value()?;
        let url = directory.join(href).map_err(|_| invalid())?;
        if url.origin() != directory.origin()
            || !url.username().is_empty()
            || url.password().is_some()
            || url.query().is_some()
            || url.fragment().is_some()
        {
            return Err(invalid());
        }
        let parts = decoded_segments(&url)?;
        if !parts.starts_with(&expected) || parts.len() > expected.len() + 1 {
            return Err(invalid());
        }
        if let Some(node) = response.one("status")? {
            let code = status(node)?;
            if !(200..300).contains(&code) {
                return Err(RemoteError::status(code));
            }
        }
        let mut entry = RemoteEntry {
            name: parts.last().cloned().ok_or_else(invalid)?,
            is_collection: false,
            etag: None,
            size: None,
        };
        let mut resource_type = false;
        for propstat in response.children("propstat") {
            let code = status(propstat.one("status")?.ok_or_else(invalid)?)?;
            if code == 404 {
                continue;
            } // Unsupported optional properties.
            if !(200..300).contains(&code) {
                return Err(RemoteError::status(code));
            }
            let properties = propstat.one("prop")?.ok_or_else(invalid)?;
            if let Some(kind) = properties.one("resourcetype")? {
                resource_type = true;
                entry.is_collection = kind.one("collection")?.is_some();
            }
            if let Some(node) = properties.one("getetag")? {
                let value = node.value()?;
                if !value.is_empty() {
                    entry.etag = Some(value.to_owned());
                }
            }
            if let Some(node) = properties.one("getcontentlength")? {
                let value = node.value()?;
                if !value.is_empty() {
                    entry.size = Some(value.parse().map_err(|_| invalid())?);
                }
            }
        }
        if !resource_type {
            return Err(invalid());
        }
        if parts == expected {
            if found_self || !entry.is_collection {
                return Err(invalid());
            }
            found_self = true;
        } else if entries.insert(entry.name.clone(), entry).is_some() {
            return Err(invalid());
        }
    }
    if !found_self {
        return Err(invalid());
    }
    Ok(entries.into_values().collect())
}
