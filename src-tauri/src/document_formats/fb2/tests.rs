use super::*;
use base64::{engine::general_purpose::STANDARD, Engine};
use std::io::{BufReader, Cursor};
fn sample(encoding: &str) -> String {
    format!(
        r##"<?xml version="1.0" encoding="{encoding}"?>
<FictionBook xmlns="http://www.gribuser.ru/xml/fictionbook/2.0" xmlns:l="http://www.w3.org/1999/xlink">
<description><title-info><book-title>Test &amp; Книга</book-title><author><first-name>Jane</first-name><last-name>Doe</last-name></author><lang>ru</lang><coverpage><image l:href="#cover"/></coverpage></title-info><document-info><id>sample</id></document-info></description>
<body><section id="s1"><title><p>One</p></title><p>Repeat 𠮷 repeat <a l:href="#n1" type="note">1</a>.</p><section id="nested"><title><p>Nested</p></title><poem><stanza><v>Verse</v></stanza></poem></section><image l:href="#cover"/></section><section id="s2"><title><p>Two</p></title><table><tr><td colspan="2">Cell</td></tr></table><empty-line/></section></body>
<body name="notes"><section id="n1"><title><p>Note</p></title><p>Explanation</p></section></body><binary id="cover" content-type="image/png">AQID BA==</binary></FictionBook>"##
    )
}
#[test]
fn fb2_archive_preserves_sections_notes_images_and_original_bytes() {
    let bytes = sample("UTF-8")
        .replace("<poem>", "<poem><title><p>Poem title</p></title>")
        .into_bytes();
    let before = bytes.clone();
    let metadata = inspect(Cursor::new(&bytes), "Fallback").unwrap();
    assert_eq!(metadata.title, "Test & Книга");
    assert_eq!(metadata.creator, "Jane Doe");
    assert_eq!(
        metadata.spine,
        [format!("{ROOT}c0.xhtml"), format!("{ROOT}c1.xhtml")]
    );
    let mut file = archive(Cursor::new(&bytes), "Fallback").unwrap();
    // Optional one-off cross-language evidence; never required by CI.
    if let Ok(path) = std::env::var("FB2_TEST_ARCHIVE") {
        io::copy(&mut file, &mut File::create(path).unwrap()).unwrap();
        file.rewind().unwrap();
    }
    let mut zip = zip::ZipArchive::new(file).unwrap();
    let mut read = |path: &str| {
        let mut text = String::new();
        zip.by_name(path)
            .unwrap()
            .read_to_string(&mut text)
            .unwrap();
        text
    };
    let first = read(&format!("{ROOT}c0.xhtml"));
    assert!(first.contains("Repeat 𠮷 repeat"));
    assert!(first.contains(&format!(
        "href=\"c2.xhtml#{}\" epub:type=\"noteref\"",
        anchor("n1")
    )));
    assert!(first.contains("class=\"fb2-poem\""));
    assert!(first.contains(&format!("src=\"b/{}\"", key("cover"))));
    assert!(read(&format!("{ROOT}c1.xhtml")).contains("colspan=\"2\""));
    let nav = read(&format!("{ROOT}nav.xhtml"));
    assert!(nav.contains("One</a><ol><li>"));
    assert!(nav.contains(">Nested</a>"));
    assert!(!nav.contains("Poem title"));
    assert!(read(&format!("{ROOT}package.opf")).contains("idref=\"c2\" linear=\"no\""));
    let mut image = Vec::new();
    zip.by_name(&binary_path("cover"))
        .unwrap()
        .read_to_end(&mut image)
        .unwrap();
    assert_eq!(image, [1, 2, 3, 4]);
    assert_eq!(
        cover(Cursor::new(&bytes), &binary_path("cover"), 4).unwrap(),
        image
    );
    assert_eq!(
        super::super::read_cover(Cursor::new(&bytes), &binary_path("cover"), 4).unwrap(),
        image
    );
    assert!(cover(Cursor::new(&bytes), &binary_path("cover"), 3).is_err());
    assert_eq!(bytes, before);
    let parsed = crate::linked_library::epub_meta::inspect_epub_archive(zip).unwrap();
    assert_eq!(parsed.title, metadata.title);
    assert_eq!(parsed.spine, metadata.spine);
}
#[test]
fn fb2_declared_encodings_keep_the_same_chapter_identity_and_fail_invalid_xml() {
    let value = sample("windows-1251").replace('𠮷', "X");
    let (bytes, _, failed) = encoding_rs::WINDOWS_1251.encode(&value);
    assert!(!failed);
    let legacy = inspect(Cursor::new(bytes), "Fallback").unwrap();
    let value = sample("UTF-16");
    let mut bytes = vec![0xff, 0xfe];
    bytes.extend(value.encode_utf16().flat_map(u16::to_le_bytes));
    let utf16 = inspect(Cursor::new(bytes), "Fallback").unwrap();
    assert_eq!(legacy.title, utf16.title);
    assert_eq!(legacy.spine, utf16.spine);
    for value in [
        sample("UTF-8").replace("id=\"s2\"", "id=\"s1\""),
        sample("UTF-8").replace("</body>", ""),
        "<!DOCTYPE FictionBook SYSTEM 'file:///etc/passwd'><FictionBook/>".into(),
        "<not-a-book/>".into(),
    ] {
        assert!(archive(Cursor::new(value), "Fallback").is_err());
    }
}
#[test]
fn fb2_binary_decoding_is_chunked_across_whitespace_and_rejects_trailing_data() {
    let bytes: Vec<u8> = (0..50000).map(|n| n as u8).collect();
    let encoded = STANDARD.encode(&bytes);
    let encoded = encoded
        .as_bytes()
        .chunks(61)
        .map(|s| std::str::from_utf8(s).unwrap())
        .collect::<Vec<_>>()
        .join("\r\n")
        + "<";
    let mut input = BufReader::with_capacity(11, Cursor::new(encoded));
    let mut output = Vec::new();
    binary(&mut input, Some(&mut output)).unwrap();
    assert_eq!(output, bytes);
    assert_eq!(input.fill_buf().unwrap()[0], b'<');
    assert!(binary(&mut Cursor::new(b"AQ==AQ==<"), Some(&mut Vec::new())).is_err());
}
