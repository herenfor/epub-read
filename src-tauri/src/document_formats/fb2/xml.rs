//! Bounded XML decoding and base64 streaming for the FB2 adapter.
use super::*;
use base64::{engine::general_purpose::STANDARD, Engine};
use quick_xml::{events::Event, Reader, XmlVersion};
use std::io::{BufReader, SeekFrom};

fn attrs<R: BufRead>(
    reader: &Reader<R>,
    start: &quick_xml::events::BytesStart<'_>,
) -> Result<Attrs> {
    start
        .attributes()
        .map(|a| {
            let a = a.map_err(error)?;
            Ok((
                local(a.key.as_ref())?,
                a.decoded_and_normalized_value(XmlVersion::Implicit1_0, reader.decoder())
                    .map_err(error)?
                    .into_owned(),
            ))
        })
        .collect()
}

/// Decode XML before parsing so UTF-16 and declared legacy encodings follow
/// exactly the same chapter/character identity as UTF-8, without a full String.
pub(super) enum XmlSource<R> {
    Original(R),
    Converted(File),
}
impl<R: Read> Read for XmlSource<R> {
    fn read(&mut self, bytes: &mut [u8]) -> io::Result<usize> {
        match self {
            Self::Original(source) => source.read(bytes),
            Self::Converted(source) => source.read(bytes),
        }
    }
}
impl<R: Seek> Seek for XmlSource<R> {
    fn seek(&mut self, position: SeekFrom) -> io::Result<u64> {
        match self {
            Self::Original(source) => source.seek(position),
            Self::Converted(source) => source.seek(position),
        }
    }
}
pub(super) fn xml_source<R: Read + Seek>(mut source: R) -> Result<XmlSource<R>> {
    use encoding_rs::{Encoding, UTF_16BE, UTF_16LE, UTF_8};
    let mut sample = [0; 4096];
    let n = source.read(&mut sample).map_err(error)?;
    let encoding = if let Some((encoding, _)) = Encoding::for_bom(&sample[..n]) {
        encoding
    } else if sample[..n].starts_with(&[b'<', 0, b'?', 0]) {
        UTF_16LE
    } else if sample[..n].starts_with(&[0, b'<', 0, b'?']) {
        UTF_16BE
    } else {
        let mut probe = Reader::from_reader(&sample[..n]);
        match probe.read_event() {
            Ok(Event::Decl(d)) => match d.encoding() {
                Some(label) => Encoding::for_label(&label.map_err(error)?)
                    .ok_or_else(|| error("不支持的 XML 编码"))?,
                None => UTF_8,
            },
            _ => UTF_8,
        }
    };
    source.rewind().map_err(error)?;
    // Common UTF-8 books require no extra whole-source copy or temporary XML.
    if encoding == UTF_8 {
        return Ok(XmlSource::Original(source));
    }
    let mut output = tempfile::tempfile().map_err(error)?;
    let mut decoder = encoding.new_decoder_with_bom_removal();
    let mut input = [0; 65536];
    let mut decoded = String::with_capacity(262144);
    loop {
        let n = source.read(&mut input).map_err(error)?;
        let mut offset = 0;
        loop {
            decoded.clear();
            let (status, read, replaced) =
                decoder.decode_to_string(&input[offset..n], &mut decoded, n == 0);
            if replaced {
                return Err(error("XML 编码无效"));
            }
            offset += read;
            output.write_all(decoded.as_bytes()).map_err(error)?;
            if status == encoding_rs::CoderResult::InputEmpty {
                break;
            }
        }
        if n == 0 {
            break;
        }
    }
    output.rewind().map_err(error)?;
    Ok(XmlSource::Converted(output))
}

/// FB2 base64 contains XML whitespace, but no markup. Stop before the closing
/// '<' so the normal XML parser still checks the matching </binary>.
pub(super) fn binary(reader: &mut dyn BufRead, mut output: Option<&mut dyn Write>) -> Result<()> {
    let mut encoded = Vec::with_capacity(8192);
    let mut decoded = [0; 6144];
    let mut padded = false;
    loop {
        let input = reader.fill_buf().map_err(error)?;
        if input.is_empty() {
            return Err(error("binary 未结束"));
        }
        let count = input.iter().position(|b| *b == b'<').unwrap_or(input.len());
        if output.is_some() {
            for b in &input[..count] {
                if b.is_ascii_whitespace() {
                    continue;
                }
                if padded {
                    return Err(error("binary 的 base64 填充无效"));
                }
                encoded.push(*b);
                if encoded.len() == 8192 {
                    padded = encoded.ends_with(b"=");
                    let n = STANDARD
                        .decode_slice(&encoded, &mut decoded)
                        .map_err(error)?;
                    output
                        .as_deref_mut()
                        .unwrap()
                        .write_all(&decoded[..n])
                        .map_err(error)?;
                    encoded.clear();
                }
            }
        }
        let end = count < input.len();
        reader.consume(count);
        if end {
            break;
        }
    }
    if let Some(output) = output {
        let n = STANDARD
            .decode_slice(&encoded, &mut decoded)
            .map_err(error)?;
        output.write_all(&decoded[..n]).map_err(error)?;
    }
    Ok(())
}

pub(super) trait Visitor {
    fn start(&mut self, name: &str, attrs: &Attrs, node: usize) -> Result<()>;
    fn text(&mut self, text: &str) -> Result<()>;
    fn end(&mut self, name: &str) -> Result<()>;
    fn binary(&mut self, attrs: &Attrs, reader: &mut dyn BufRead) -> Result<bool>;
}
pub(super) fn walk(source: &mut (impl Read + Seek), visitor: &mut impl Visitor) -> Result<()> {
    source.rewind().map_err(error)?;
    let mut reader = Reader::from_reader(BufReader::new(source));
    let mut buffer = Vec::new();
    let (mut depth, mut node, mut roots) = (0usize, 0usize, 0usize);
    let mut binary_end = false;
    loop {
        let event = reader.read_event_into(&mut buffer).map_err(error)?;
        if binary_end && !matches!(&event, Event::End(e) if e.local_name().as_ref() == b"binary") {
            return Err(error("binary 内含非 base64 标记"));
        }
        let empty = matches!(event, Event::Empty(_));
        match event {
            Event::Start(e) | Event::Empty(e) => {
                if binary_end {
                    return Err(error("binary 内含非 base64 标记"));
                }
                let name = local(e.name().as_ref())?;
                let attributes = attrs(&reader, &e)?;
                if depth == 0 {
                    roots += 1;
                    if roots != 1 || name != "FictionBook" {
                        return Err(error("缺少 FictionBook 根元素"));
                    }
                    if attributes.get("xmlns").is_some_and(|ns| ns != NS) {
                        return Err(error("不是 FB2 命名空间"));
                    }
                }
                node += 1;
                visitor.start(&name, &attributes, node)?;
                depth += 1;
                if name == "binary" {
                    if depth != 2 {
                        return Err(error("binary 必须位于根元素下"));
                    }
                    let stop = if empty {
                        visitor.binary(&attributes, &mut io::Cursor::new(b"<"))?
                    } else {
                        visitor.binary(&attributes, reader.get_mut())?
                    };
                    if stop {
                        return Ok(());
                    }
                    binary_end = !empty;
                }
                if empty {
                    visitor.end(&name)?;
                    depth -= 1;
                }
            }
            Event::End(e) => {
                let name = local(e.name().as_ref())?;
                if binary_end && name != "binary" {
                    return Err(error("binary 未结束"));
                }
                binary_end = false;
                depth = depth
                    .checked_sub(1)
                    .ok_or_else(|| error("多余的结束标签"))?;
                visitor.end(&name)?;
            }
            Event::Text(e) => {
                visitor.text(&e.xml_content(XmlVersion::Implicit1_0).map_err(error)?)?
            }
            Event::CData(e) => {
                visitor.text(&e.xml_content(XmlVersion::Implicit1_0).map_err(error)?)?
            }
            Event::GeneralRef(e) => {
                if let Some(ch) = e.resolve_char_ref().map_err(error)? {
                    visitor.text(&ch.to_string())?;
                } else {
                    let entity = e.decode().map_err(error)?;
                    visitor.text(
                        quick_xml::escape::resolve_xml_entity(&entity)
                            .ok_or_else(|| error("不支持的 XML 实体"))?,
                    )?;
                }
            }
            Event::DocType(_) => return Err(error("不支持 DTD/外部实体")),
            Event::Eof => break,
            _ => {}
        }
        buffer.clear();
    }
    if depth != 0 || roots != 1 {
        return Err(error("XML 未完整结束"));
    }
    Ok(())
}
