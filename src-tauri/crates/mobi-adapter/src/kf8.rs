//! KF8/AZW3 reading-EPUB cleanup.
//!
//! libmobi rewrites an `<img src>` to the packaged `resourceNNNNN.ext`, but
//! leaves the original Kindle `srcset` unchanged. Those candidates still point
//! at paths such as `../images/titlepage.png`, which do not exist in the
//! converted archive, so a browser prefers the broken candidate over the valid
//! `src`. The temporary reading EPUB has one authoritative packaged resource;
//! remove `srcset` from `img`/`source` tags.
//!
//! This module only edits those tag attributes. Text nodes, part names, ids,
//! spine anchors and every other tag are preserved. A KF8 part without a
//! `srcset` is copied byte-for-byte.

use crate::legacy::{
    find_raw_text_close, find_tag_end, is_raw_text_element, is_self_closing, opening_tag_name,
    parse_tag,
};

/// Remove unresolved `srcset` attributes from one KF8 markup part.
pub(crate) fn strip_srcset(input: &[u8]) -> Vec<u8> {
    match std::str::from_utf8(input) {
        Ok(text) => strip_text(text).into_bytes(),
        Err(_) => input.to_vec(),
    }
}

fn strip_text(text: &str) -> String {
    let mut output = String::with_capacity(text.len());
    let mut cursor = 0usize;

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

        if tag.starts_with("</") || tag.starts_with("<!") || tag.starts_with("<?") {
            output.push_str(tag);
            cursor = tag_end;
            continue;
        }

        let name = opening_tag_name(tag);
        if is_raw_text_element(name) && !is_self_closing(tag) {
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

        let replace = if name.eq_ignore_ascii_case("img") || name.eq_ignore_ascii_case("source") {
            parse_tag(tag).and_then(|mut parsed| {
                let before = parsed.attrs.len();
                parsed
                    .attrs
                    .retain(|attr| !attr.name.eq_ignore_ascii_case("srcset"));
                (parsed.attrs.len() != before).then(|| parsed.render())
            })
        } else {
            None
        };
        output.push_str(replace.as_deref().unwrap_or(tag));
        cursor = tag_end;
    }

    output
}

#[cfg(test)]
mod tests {
    use super::*;

    fn strip(input: &str) -> String {
        String::from_utf8(strip_srcset(input.as_bytes())).unwrap()
    }

    #[test]
    fn removes_srcset_from_img_and_source() {
        let input = concat!(
            r#"<img alt="" src="resource00003.png" "#,
            r#"srcset="../images/titlepage-2x.png 2x, ../images/titlepage.png 1x"/>"#,
            r#"<source src="resource00002.png" srcset="../images/logo.png 1x"/>"#,
        );
        assert_eq!(
            strip(input),
            r#"<img alt="" src="resource00003.png"/><source src="resource00002.png"/>"#
        );
    }

    #[test]
    fn leaves_parts_without_srcset_byte_identical() {
        let input = concat!(
            r#"<?xml version="1.0" encoding="UTF-8"?>"#,
            r#"<html><body><img  alt="x"  src="resource00000.jpg"/>"#,
            r#"<source src="resource00001.png"/><div srcset="not-an-image"></div>"#,
            r#"<img data-srcset="keep" src="resource00002.png"/></body></html>"#,
        );
        assert_eq!(strip(input), input);
    }

    #[test]
    fn raw_text_and_comments_are_not_scanned() {
        let input = concat!(
            r#"<style>img:before{content:'<img srcset="x">'}</style>"#,
            r#"<!-- <img srcset="y"> -->"#,
            r#"<script>const s = '<source srcset="z">'</script>"#,
            r#"<title><img srcset="t"></title>"#,
            r#"<textarea><img srcset="u"></textarea>"#,
            r#"<img src="resource.png" srcset="q"/>"#,
        );
        let output = strip(input);
        assert!(output.starts_with(
            r#"<style>img:before{content:'<img srcset="x">'}</style><!-- <img srcset="y"> -->"#
        ));
        assert!(output.contains(r#"<script>const s = '<source srcset="z">'</script>"#));
        assert!(output.contains(r#"<title><img srcset="t"></title>"#));
        assert!(output.contains(r#"<textarea><img srcset="u"></textarea>"#));
        assert!(output.ends_with(r#"<img src="resource.png"/>"#));
    }

    #[test]
    fn preserves_other_attributes_and_uppercase_tags() {
        let input = r#"<IMG alt="x" SRCSET="q" SRC="resource.png"/>"#;
        assert_eq!(strip(input), r#"<IMG alt="x" SRC="resource.png"/>"#);
    }

    #[test]
    fn conversion_is_deterministic_and_invalid_utf8_passes_through() {
        let input = r#"<img src="resource.png" srcset="a 1x, b 2x"/>"#;
        assert_eq!(strip(input), strip(input));

        let invalid = b"\xff<img srcset=\"x\">";
        assert_eq!(strip_srcset(invalid), invalid);
    }
}
