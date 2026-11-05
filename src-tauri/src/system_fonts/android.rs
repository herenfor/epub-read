//! Android exposes font files publicly, but not an enumerable map of CSS
//! family names. Read named families/aliases from the system configuration,
//! not filename stems or unnamed language fallback fonts. This file format is
//! an Android implementation detail: unavailable/unknown configs safely leave
//! the three standard families selectable. No hidden API or storage permission.
#[cfg(target_os = "android")]
use super::{sort_and_deduplicate_system_fonts, LocalizedFontName, SystemFontFamily};
use quick_xml::{events::Event, Reader, XmlVersion};
use std::collections::BTreeSet;

fn configured_families(xml: &str, known: &BTreeSet<String>) -> Result<BTreeSet<String>, String> {
    let mut reader = Reader::from_str(xml);
    let mut families = known.clone();
    let mut aliases = Vec::new();
    let mut depth = 0;
    let mut known_root = false;
    loop {
        let event = reader.read_event().map_err(|error| error.to_string())?;
        let empty = matches!(&event, Event::Empty(_));
        match event {
            Event::Start(element) | Event::Empty(element) => {
                if depth == 0 {
                    known_root = matches!(
                        element.name().as_ref(),
                        b"familyset" | b"fonts-modification"
                    );
                    if !known_root {
                        return Err("未知 Android 字体配置格式".into());
                    }
                } else if depth == 1 {
                    let mut name = None;
                    let mut target = None;
                    for attribute in element.attributes() {
                        let attribute = attribute.map_err(|error| error.to_string())?;
                        let value = attribute
                            .decoded_and_normalized_value(XmlVersion::Implicit1_0, reader.decoder())
                            .map_err(|error| error.to_string())?;
                        match attribute.key.as_ref() {
                            b"name" => name = Some(value.trim().to_owned()),
                            b"to" => target = Some(value.trim().to_owned()),
                            _ => {}
                        }
                    }
                    if let Some(name) = name.filter(|name| !name.is_empty()) {
                        match element.name().as_ref() {
                            b"family" => {
                                families.insert(name);
                            }
                            b"alias" => {
                                if let Some(target) = target {
                                    aliases.push((name, target));
                                }
                            }
                            _ => {}
                        }
                    }
                }
                if !empty {
                    depth += 1;
                }
            }
            Event::End(_) => {
                depth -= 1;
            }
            Event::Eof => break,
            _ => {}
        }
    }
    if !known_root || depth != 0 {
        return Err("Android 字体配置不完整".into());
    }
    // Include only aliases that resolve to an actual named family. A bounded
    // fixed point handles ordering/alias chains and excludes cycles/dangling names.
    loop {
        let before = families.len();
        for (name, target) in &aliases {
            if families.contains(target) {
                families.insert(name.clone());
            }
        }
        if families.len() == before {
            break;
        }
    }
    Ok(families)
}

#[cfg(target_os = "android")]
pub(super) fn list() -> Vec<SystemFontFamily> {
    let mut names = BTreeSet::from(["sans-serif".into(), "serif".into(), "monospace".into()]);
    // The base file exists since Android 5; the optional product overlay adds
    // vendor named families. Never crawl system/vendor font directories.
    for path in [
        "/system/etc/fonts.xml",
        "/product/etc/fonts_customization.xml",
    ] {
        if let Ok(xml) = std::fs::read_to_string(path) {
            if let Ok(configured) = configured_families(&xml, &names) {
                names = configured;
            }
        }
    }
    sort_and_deduplicate_system_fonts(
        names
            .into_iter()
            .map(|family| SystemFontFamily {
                localized_names: vec![LocalizedFontName {
                    locale: String::new(),
                    name: family.clone(),
                }],
                family,
            })
            .collect(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn android_lists_named_families_and_valid_aliases_not_font_filenames() {
        let names = configured_families(
            r#"<familyset>
          <family name="sans-serif"><font>Roboto.ttf</font></family>
          <family lang="zh-Hans"><font>NotoSansCJK.ttc</font></family>
          <family name="serif" />
          <alias name="chained" to="light"/><alias name="light" to="sans-serif"/>
          <alias name="missing" to="absent"/><alias name="cycle-a" to="cycle-b"/>
          <alias name="cycle-b" to="cycle-a"/>
        </familyset>"#,
            &BTreeSet::new(),
        )
        .unwrap();
        assert_eq!(
            names,
            BTreeSet::from([
                "sans-serif".into(),
                "serif".into(),
                "light".into(),
                "chained".into()
            ])
        );
        assert!(
            configured_families("<familyset><family name='partial'>", &BTreeSet::new()).is_err()
        );
        assert!(
            configured_families("<unknown><family name='fake'/></unknown>", &BTreeSet::new())
                .is_err()
        );
    }

    #[test]
    fn android_supports_vendor_named_families_and_xml_escaping() {
        let names = configured_families(r#"<fonts-modification>
          <family customizationType="new-named-family" name="A &amp; B"><font>vendor.ttf</font></family>
          <family customizationType="new-locale-family" lang="ja"><font>fallback.ttf</font></family>
          <alias name="vendor-alias" to="sans-serif"/>
        </fonts-modification>"#, &BTreeSet::from(["sans-serif".into()])).unwrap();
        assert_eq!(
            names,
            BTreeSet::from(["A & B".into(), "sans-serif".into(), "vendor-alias".into()])
        );
    }
}
