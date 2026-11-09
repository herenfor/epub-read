//! Deterministic normalization of MOBI6 rawml legacy presentation markup.
//!
//! MOBI6 books commonly use Kindle-specific presentational tags and attributes
//! that modern browsers do not implement:
//!
//! - deeply nested `<blockquote>` elements encode indentation, so the browser
//!   applies its default 40 px margin at every level and can consume the whole
//!   text column;
//! - `<p height="...">` and `<p width="...">` encode paragraph spacing and
//!   first-line indent, but browsers ignore those attributes;
//! - `<mbp:pagebreak>` encodes forced page breaks, but it is not HTML.
//!
//! KF8/AZW3 is not passed through this module: its reconstructed CSS is already
//! standard. The rewrite is intentionally tag-only. Text nodes, element ids and
//! part names are preserved so the converted EPUB keeps the same canonical
//! reading identity as the source.

const MAX_QUOTE_INDENT_LEVELS: usize = 2;
const PAGEBREAK_STYLE: &str = "page-break-before:always;break-before:column;-webkit-column-break-before:always;height:0;margin:0;padding:0";
const RAW_TEXT_ELEMENTS: &[&str] = &["style", "script", "title", "textarea"];

/// Normalize one MOBI6 markup part. Invalid UTF-8 is copied unchanged rather
/// than risk corrupting a book; libmobi normally emits UTF-8.
pub(crate) fn normalize_markup(input: &[u8]) -> Vec<u8> {
    match std::str::from_utf8(input) {
        Ok(text) => normalize_text(text).into_bytes(),
        Err(_) => input.to_vec(),
    }
}

fn normalize_text(text: &str) -> String {
    let mut output = String::with_capacity(text.len() + text.len() / 32);
    let mut cursor = 0usize;
    let mut quote_depth = 0usize;
    let mut pending_pagebreak_closes = 0usize;

    while cursor < text.len() {
        let Some(relative) = text[cursor..].find('<') else {
            output.push_str(&text[cursor..]);
            break;
        };
        let tag_start = cursor + relative;
        output.push_str(&text[cursor..tag_start]);

        if text[tag_start..].starts_with("<!--") {
            let end = text[tag_start + 4..]
                .find("-->")
                .map(|offset| tag_start + 4 + offset + 3)
                .unwrap_or(text.len());
            output.push_str(&text[tag_start..end]);
            cursor = end;
            continue;
        }

        if text[tag_start..].starts_with("<![CDATA[") {
            let end = text[tag_start + 9..]
                .find("]]>")
                .map(|offset| tag_start + 9 + offset + 3)
                .unwrap_or(text.len());
            output.push_str(&text[tag_start..end]);
            cursor = end;
            continue;
        }

        let Some(tag_end) = find_tag_end(text, tag_start) else {
            output.push_str(&text[tag_start..]);
            break;
        };
        let tag = &text[tag_start..tag_end];

        if tag.starts_with("</") {
            let name = closing_tag_name(tag);
            if name.eq_ignore_ascii_case("blockquote") {
                quote_depth = quote_depth.saturating_sub(1);
                output.push_str(tag);
            } else if name.eq_ignore_ascii_case("mbp:pagebreak") {
                // The paired close belongs to the div emitted for the open tag.
                pending_pagebreak_closes = pending_pagebreak_closes.saturating_sub(1);
            } else {
                output.push_str(tag);
            }
            cursor = tag_end;
            continue;
        }

        if tag.starts_with("<!") || tag.starts_with("<?") {
            output.push_str(tag);
            cursor = tag_end;
            continue;
        }

        let name = opening_tag_name(tag);
        if is_raw_text_element(name) && !is_self_closing(tag) {
            // CSS/JS and escapable-raw-text contents are not markup. Copy them
            // verbatim so a literal `<p height=...>` inside a style or script
            // cannot be rewritten into live CSS.
            output.push_str(tag);
            let Some(close_start) = find_raw_text_close(text, tag_end, name) else {
                output.push_str(&text[tag_end..]);
                break;
            };
            output.push_str(&text[tag_end..close_start]);
            let close_end = find_tag_end(text, close_start).unwrap_or(text.len());
            output.push_str(&text[close_start..close_end]);
            cursor = close_end;
            continue;
        }
        if name.eq_ignore_ascii_case("blockquote") {
            let self_closing = is_self_closing(tag);
            if !self_closing {
                quote_depth += 1;
            }
            let level = if self_closing {
                quote_depth + 1
            } else {
                quote_depth
            };
            output.push_str(&rewrite_blockquote(tag, level));
        } else if name.eq_ignore_ascii_case("mbp:pagebreak") {
            output.push_str(&rewrite_pagebreak(tag));
            if !is_self_closing(tag) {
                pending_pagebreak_closes += 1;
            }
        } else if name.eq_ignore_ascii_case("p") {
            output.push_str(&rewrite_paragraph(tag));
        } else {
            output.push_str(tag);
        }
        cursor = tag_end;
    }

    output
}

fn rewrite_blockquote(tag: &str, level: usize) -> String {
    let Some(mut parsed) = parse_tag(tag) else {
        return tag.to_string();
    };
    parsed.attrs.retain(|attr| {
        !attr.name.eq_ignore_ascii_case("height") && !attr.name.eq_ignore_ascii_case("width")
    });
    let margin = if level <= MAX_QUOTE_INDENT_LEVELS {
        "margin:0 1em"
    } else {
        // Keep the element (and any id/name) but stop its margin accumulating.
        "margin:0"
    };
    append_style(&mut parsed.attrs, &[margin]);
    parsed.render()
}

fn rewrite_paragraph(tag: &str) -> String {
    let Some(mut parsed) = parse_tag(tag) else {
        return tag.to_string();
    };
    let mut margin_top = None;
    let mut text_indent = None;
    parsed.attrs.retain(|attr| {
        if attr.name.eq_ignore_ascii_case("height") {
            margin_top = attr.value.as_deref().and_then(css_length);
            false
        } else if attr.name.eq_ignore_ascii_case("width") {
            text_indent = attr.value.as_deref().and_then(css_length);
            false
        } else {
            true
        }
    });

    let mut declarations = Vec::with_capacity(3);
    let has_height = margin_top.is_some();
    if let Some(value) = margin_top {
        declarations.push(format!("margin-top:{value}"));
    }
    if let Some(value) = text_indent {
        declarations.push(format!("text-indent:{value}"));
    }
    if has_height {
        // The legacy height is the paragraph's only controlled gap. Without
        // this reset the UA's one-em bottom margin collapses with small
        // heights and `height="3pt"` would have no visible effect.
        declarations.push("margin-bottom:0".to_string());
    }
    append_style(&mut parsed.attrs, &declarations);
    parsed.render()
}

fn rewrite_pagebreak(tag: &str) -> String {
    let Some(mut parsed) = parse_tag(tag) else {
        return fallback_pagebreak();
    };
    // `mbp:pagebreak` becomes a real block, but its id/name/class and other
    // attributes stay on that block so a TOC or internal link to the break
    // still resolves. The page-break declarations are merged last so authored
    // dimensions cannot undo the forced column break.
    parsed.name = "div".to_string();
    parsed.self_closing = false;
    append_class(&mut parsed.attrs, "mobi6-pagebreak");
    append_style(&mut parsed.attrs, &[PAGEBREAK_STYLE]);
    let mut output = parsed.render();
    output.push_str("</div>");
    output
}

fn fallback_pagebreak() -> String {
    format!(r#"<div class="mobi6-pagebreak" style="{PAGEBREAK_STYLE};"></div>"#)
}

fn append_class(attrs: &mut Vec<Attr>, class: &str) {
    if let Some(attr) = attrs
        .iter_mut()
        .find(|attr| attr.name.eq_ignore_ascii_case("class"))
    {
        let existing = attr.value.take().unwrap_or_default();
        let mut classes = existing.split_whitespace().collect::<Vec<_>>();
        if !classes
            .iter()
            .any(|candidate| candidate.eq_ignore_ascii_case(class))
        {
            classes.push(class);
        }
        attr.value = Some(classes.join(" "));
        if attr.quote.is_none() {
            attr.quote = Some('"');
        }
    } else {
        attrs.push(Attr {
            name: "class".to_string(),
            value: Some(class.to_string()),
            quote: Some('"'),
        });
    }
}

pub(crate) fn is_raw_text_element(name: &str) -> bool {
    RAW_TEXT_ELEMENTS
        .iter()
        .any(|candidate| name.eq_ignore_ascii_case(candidate))
}

pub(crate) fn find_raw_text_close(text: &str, from: usize, name: &str) -> Option<usize> {
    let bytes = text.as_bytes();
    let name = name.as_bytes();
    let mut cursor = from;
    while cursor < bytes.len() {
        let relative = text[cursor..].find('<')?;
        let start = cursor + relative;
        let name_start = start + 2;
        if bytes.get(start + 1) == Some(&b'/')
            && name_start + name.len() <= bytes.len()
            && bytes[name_start..name_start + name.len()].eq_ignore_ascii_case(name)
            && bytes
                .get(name_start + name.len())
                .is_some_and(|byte| matches!(*byte, b'>' | b' ' | b'\t' | b'\r' | b'\n' | b'/'))
        {
            return Some(start);
        }
        cursor = start + 1;
    }
    None
}

/// Accept only the CSS lengths seen in MOBI6 paragraph attributes. This keeps
/// arbitrary attribute text out of the generated style attribute.
fn css_length(raw: &str) -> Option<String> {
    let value = raw.trim();
    if value.is_empty() || value.len() > 24 {
        return None;
    }
    let bytes = value.as_bytes();
    let mut index = 0usize;
    if matches!(bytes.get(index), Some(b'+') | Some(b'-')) {
        index += 1;
    }
    let integer_start = index;
    while bytes.get(index).is_some_and(u8::is_ascii_digit) {
        index += 1;
    }
    let mut has_digit = index > integer_start;
    if bytes.get(index) == Some(&b'.') {
        index += 1;
        let fraction_start = index;
        while bytes.get(index).is_some_and(u8::is_ascii_digit) {
            index += 1;
        }
        has_digit |= index > fraction_start;
    }
    if !has_digit {
        return None;
    }
    let number = &value[..index];
    let unit = &value[index..];
    let unit_ok = unit.is_empty()
        || ["em", "ex", "pt", "px", "pc", "in", "cm", "mm", "%"]
            .iter()
            .any(|candidate| unit.eq_ignore_ascii_case(candidate));
    if !unit_ok {
        return None;
    }
    if unit.is_empty() && number.parse::<f64>().ok()? != 0.0 {
        return None;
    }
    Some(value.to_string())
}

fn append_style<T: AsRef<str>>(attrs: &mut Vec<Attr>, declarations: &[T]) {
    if declarations.is_empty() {
        return;
    }
    let addition = declarations
        .iter()
        .map(AsRef::as_ref)
        .collect::<Vec<_>>()
        .join(";");
    if let Some(attr) = attrs
        .iter_mut()
        .find(|attr| attr.name.eq_ignore_ascii_case("style"))
    {
        let mut value = attr.value.take().unwrap_or_default().trim_end().to_string();
        if !value.is_empty() {
            value.push(';');
        }
        value.push_str(&addition);
        value.push(';');
        attr.value = Some(value);
        if attr.quote.is_none() {
            attr.quote = Some('"');
        }
    } else {
        attrs.push(Attr {
            name: "style".to_string(),
            value: Some(format!("{addition};")),
            quote: Some('"'),
        });
    }
}

pub(crate) struct Attr {
    pub(crate) name: String,
    pub(crate) value: Option<String>,
    pub(crate) quote: Option<char>,
}

pub(crate) struct ParsedTag {
    pub(crate) name: String,
    pub(crate) attrs: Vec<Attr>,
    pub(crate) self_closing: bool,
}

impl ParsedTag {
    pub(crate) fn render(self) -> String {
        let mut output = String::with_capacity(32);
        output.push('<');
        output.push_str(&self.name);
        for attr in &self.attrs {
            output.push(' ');
            output.push_str(&attr.name);
            if let Some(value) = &attr.value {
                output.push('=');
                match attr.quote {
                    Some(quote) => {
                        output.push(quote);
                        output.push_str(value);
                        output.push(quote);
                    }
                    None => {
                        output.push('"');
                        // Keep existing entities intact; only an unquoted value
                        // can need a fresh quote escape.
                        output.push_str(&value.replace('"', "&quot;"));
                        output.push('"');
                    }
                }
            }
        }
        output.push_str(if self.self_closing { "/>" } else { ">" });
        output
    }
}

pub(crate) fn parse_tag(tag: &str) -> Option<ParsedTag> {
    let inner = tag.strip_prefix('<')?.strip_suffix('>')?;
    if inner.starts_with('/') || inner.starts_with('!') || inner.starts_with('?') {
        return None;
    }
    let inner = inner.trim_end();
    let (inner, self_closing) = match inner.strip_suffix('/') {
        Some(body) => (body.trim_end(), true),
        None => (inner, false),
    };
    let bytes = inner.as_bytes();
    let mut index = 0usize;
    while bytes
        .get(index)
        .is_some_and(|byte| !byte.is_ascii_whitespace() && *byte != b'/')
    {
        index += 1;
    }
    if index == 0 {
        return None;
    }
    let name = inner[..index].to_string();
    let mut attrs = Vec::new();

    while index < bytes.len() {
        while bytes
            .get(index)
            .is_some_and(|byte| byte.is_ascii_whitespace())
        {
            index += 1;
        }
        if index >= bytes.len() {
            break;
        }
        if bytes[index] == b'/' {
            index += 1;
            continue;
        }
        let name_start = index;
        while bytes
            .get(index)
            .is_some_and(|byte| !byte.is_ascii_whitespace() && *byte != b'=' && *byte != b'/')
        {
            index += 1;
        }
        if index == name_start {
            return None;
        }
        let attr_name = inner[name_start..index].to_string();
        while bytes
            .get(index)
            .is_some_and(|byte| byte.is_ascii_whitespace())
        {
            index += 1;
        }
        let mut value = None;
        let mut quote = None;
        if bytes.get(index) == Some(&b'=') {
            index += 1;
            while bytes
                .get(index)
                .is_some_and(|byte| byte.is_ascii_whitespace())
            {
                index += 1;
            }
            match bytes.get(index).copied() {
                Some(mark @ (b'"' | b'\'')) => {
                    let mark = mark as char;
                    index += 1;
                    let value_start = index;
                    while bytes.get(index).is_some_and(|byte| *byte != mark as u8) {
                        index += 1;
                    }
                    if index >= bytes.len() {
                        return None;
                    }
                    value = Some(inner[value_start..index].to_string());
                    quote = Some(mark);
                    index += 1;
                }
                Some(_) => {
                    let value_start = index;
                    while bytes
                        .get(index)
                        .is_some_and(|byte| !byte.is_ascii_whitespace())
                    {
                        index += 1;
                    }
                    value = Some(inner[value_start..index].to_string());
                }
                None => value = Some(String::new()),
            }
        }
        attrs.push(Attr {
            name: attr_name,
            value,
            quote,
        });
    }

    Some(ParsedTag {
        name,
        attrs,
        self_closing,
    })
}

pub(crate) fn find_tag_end(text: &str, start: usize) -> Option<usize> {
    let bytes = text.as_bytes();
    let mut quote = None;
    let mut index = start + 1;
    while index < bytes.len() {
        let byte = bytes[index];
        if let Some(mark) = quote {
            if byte == mark {
                quote = None;
            }
        } else if matches!(byte, b'"' | b'\'') {
            quote = Some(byte);
        } else if byte == b'>' {
            return Some(index + 1);
        }
        index += 1;
    }
    None
}

pub(crate) fn opening_tag_name(tag: &str) -> &str {
    tag_name(tag.strip_prefix('<').unwrap_or(tag))
}

fn closing_tag_name(tag: &str) -> &str {
    tag_name(tag.strip_prefix("</").unwrap_or(tag))
}

fn tag_name(rest: &str) -> &str {
    rest.split(|character: char| character.is_ascii_whitespace() || matches!(character, '>' | '/'))
        .next()
        .unwrap_or("")
}

pub(crate) fn is_self_closing(tag: &str) -> bool {
    tag.strip_suffix('>')
        .is_some_and(|body| body.trim_end().ends_with('/'))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn visible_text(text: &str) -> String {
        let mut output = String::new();
        let mut cursor = 0usize;
        while cursor < text.len() {
            let Some(relative) = text[cursor..].find('<') else {
                output.push_str(&text[cursor..]);
                break;
            };
            let tag_start = cursor + relative;
            output.push_str(&text[cursor..tag_start]);
            let Some(tag_end) = find_tag_end(text, tag_start) else {
                output.push_str(&text[tag_start..]);
                break;
            };
            cursor = tag_end;
        }
        output
    }

    fn sample() -> String {
        let mut nested = String::new();
        for _ in 0..11 {
            nested.push_str("<blockquote>");
        }
        nested.push_str(" *      *      *<br></br> ");
        for _ in 0..11 {
            nested.push_str("</blockquote>");
        }
        format!(
            "<html><head><guide><reference href=\"#x\"/></guide></head><body>\
             <p height=\"1em\" width=\"1em\" align=\"justify\"> “What a curious feeling!” </p>\
             {nested}\
             <mbp:pagebreak></mbp:pagebreak>\
             <p height=\"3pt\" width=\"-24pt\"><a id=\"x\" href=\"#x\">Chapter</a></p>\
             <mbp:pagebreak/>\
             <font size=\"7\">Title</font></body></html>"
        )
    }

    #[test]
    fn caps_nested_quote_indent_without_dropping_elements() {
        let output = normalize_text(&sample());
        assert_eq!(output.matches("<blockquote").count(), 11);
        assert_eq!(output.matches("</blockquote>").count(), 11);
        assert_eq!(output.matches("style=\"margin:0 1em;\"").count(), 2);
        assert_eq!(output.matches("style=\"margin:0;\"").count(), 9);
        assert!(!output.contains("height=\""));
        assert!(!output.contains("width=\""));
        assert_eq!(visible_text(&output), visible_text(&sample()));
    }

    #[test]
    fn maps_paragraph_height_and_width_to_css() {
        let output = normalize_text(&sample());
        assert!(output.contains("margin-top:1em;text-indent:1em;margin-bottom:0;"));
        assert!(output.contains("margin-top:3pt;text-indent:-24pt;margin-bottom:0;"));
        assert!(output.contains("<a id=\"x\" href=\"#x\">Chapter</a>"));
        assert!(output.contains("<font size=\"7\">Title</font>"));
    }

    #[test]
    fn turns_both_pagebreak_spellings_into_column_breaks() {
        let output = normalize_text(&sample());
        assert!(!output.contains("mbp:pagebreak"));
        assert_eq!(output.matches("class=\"mobi6-pagebreak\"").count(), 2);
        assert_eq!(output.matches("break-before:column").count(), 2);
        assert_eq!(visible_text(&output), visible_text(&sample()));
    }

    #[test]
    fn pagebreak_keeps_anchor_attributes_and_merges_style() {
        let output = normalize_text(
            r#"<p>A</p><mbp:pagebreak id="ch2" name="ch2" class="chapter" style="color:red"/><p>B</p>"#,
        );
        assert_eq!(
            output,
            format!(
                r#"<p>A</p><div id="ch2" name="ch2" class="chapter mobi6-pagebreak" style="color:red;{PAGEBREAK_STYLE};"></div><p>B</p>"#
            )
        );

        let paired = normalize_text(r#"<mbp:pagebreak id="ch3"></mbp:pagebreak><p>C</p>"#);
        assert_eq!(
            paired,
            format!(
                r#"<div id="ch3" class="mobi6-pagebreak" style="{PAGEBREAK_STYLE};"></div><p>C</p>"#
            )
        );
        assert!(!paired.contains("mbp:pagebreak"));
    }

    #[test]
    fn raw_text_contexts_are_not_rewritten() {
        let input = concat!(
            r#"<STYLE>p:before{content:'<p height="1em">';}</STYLE>"#,
            r#"<p height="1em">X</p>"#,
            r#"<script>const s = '<mbp:pagebreak id="x"/>';</script>"#,
            r#"<title><p height="3pt"></title>"#,
            r#"<textarea><p width="1em"></textarea>"#,
        );
        let output = normalize_text(input);
        assert_eq!(
            output,
            concat!(
                r#"<STYLE>p:before{content:'<p height="1em">';}</STYLE>"#,
                r#"<p style="margin-top:1em;margin-bottom:0;">X</p>"#,
                r#"<script>const s = '<mbp:pagebreak id="x"/>';</script>"#,
                r#"<title><p height="3pt"></title>"#,
                r#"<textarea><p width="1em"></textarea>"#,
            )
        );
        assert!(!output.contains("mobi6-pagebreak"));
    }

    #[test]
    fn conversion_is_deterministic() {
        let first = normalize_text(&sample());
        let second = normalize_text(&sample());
        assert_eq!(first, second);
    }

    #[test]
    fn extends_an_existing_style_instead_of_duplicating_it() {
        let output = normalize_text(r#"<p style="color:red" height="2em" width="1em">x</p>"#);
        assert_eq!(
            output,
            r#"<p style="color:red;margin-top:2em;text-indent:1em;margin-bottom:0;">x</p>"#
        );
    }

    #[test]
    fn drops_invalid_legacy_lengths_but_keeps_the_text() {
        let output = normalize_text(
            r#"<p height="auto" width="1em">x</p><p width="calc(1em)" height="0">y</p>"#,
        );
        assert_eq!(
            output,
            r#"<p style="text-indent:1em;">x</p><p style="margin-top:0;margin-bottom:0;">y</p>"#
        );
    }

    #[test]
    fn preserves_unquoted_unrelated_attributes() {
        let output = normalize_text(r#"<p data-url=foo/bar height="1em">x</p>"#);
        assert_eq!(
            output,
            r#"<p data-url="foo/bar" style="margin-top:1em;margin-bottom:0;">x</p>"#
        );
    }

    #[test]
    fn comments_and_invalid_utf8_are_preserved() {
        let html = r#"<!-- <p height="1em"> --><p height="1em">x</p>"#;
        let output = normalize_text(html);
        assert!(output.starts_with("<!-- <p height=\"1em\"> -->"));
        assert!(output.contains("<p style=\"margin-top:1em;margin-bottom:0;\">x</p>"));

        let invalid = b"\xff<p height=\"1em\">x</p>";
        assert_eq!(normalize_markup(invalid), invalid);
    }
}
