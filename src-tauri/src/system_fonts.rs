use serde::Serialize;
#[cfg(any(windows, target_os = "linux", test))]
use std::collections::BTreeMap;

#[cfg(any(target_os = "android", test))]
mod android;
#[cfg(target_os = "linux")]
mod linux;
#[cfg(target_os = "macos")]
mod macos;

/// One localized name exposed by the operating system for a font family.
///
/// `locale` is a normalized BCP-47 tag where the OS provides one. No font
/// path, binary data, or other file metadata is exposed through this type.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalizedFontName {
    pub locale: String,
    pub name: String,
}

/// A system font family that can be used as a CSS `font-family` value.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemFontFamily {
    /// A stable preferred family name. English (en-US) is preferred when the
    /// font provides one, then generic English, then the first localized name.
    pub family: String,
    /// All distinct localized names for searching and display.
    pub localized_names: Vec<LocalizedFontName>,
}

/// Lists the installed system font *families*.
///
/// Each platform returns CSS-addressable family names, not font filenames.
/// Enumeration runs off the webview thread and does not copy font binaries.
#[tauri::command]
pub async fn system_fonts_list() -> Result<Vec<SystemFontFamily>, String> {
    tauri::async_runtime::spawn_blocking(list_system_fonts)
        .await
        .map_err(|error| format!("系统字体读取任务失败：{error}"))?
}

#[cfg(windows)]
fn list_system_fonts() -> Result<Vec<SystemFontFamily>, String> {
    use windows::Win32::Graphics::DirectWrite::{
        DWriteCreateFactory, IDWriteFactory, DWRITE_FACTORY_TYPE_SHARED,
    };

    // DirectWrite manages the shared factory internally; this operation only
    // queries its font metadata and does not open individual font files.
    let factory = unsafe { DWriteCreateFactory::<IDWriteFactory>(DWRITE_FACTORY_TYPE_SHARED) }
        .map_err(|error| format!("无法创建 DirectWrite 字体工厂：{error}"))?;
    let mut collection = None;
    unsafe { factory.GetSystemFontCollection(&mut collection, false) }
        .map_err(|error| format!("无法读取 Windows 系统字体集合：{error}"))?;
    let collection = collection.ok_or_else(|| "Windows 未返回系统字体集合".to_string())?;

    let family_count = unsafe { collection.GetFontFamilyCount() };
    let mut fonts = Vec::with_capacity(family_count as usize);
    for index in 0..family_count {
        let font_family = unsafe { collection.GetFontFamily(index) }
            .map_err(|error| format!("无法读取系统字体族：{error}"))?;
        let names = unsafe { font_family.GetFamilyNames() }
            .map_err(|error| format!("无法读取系统字体族名称：{error}"))?;
        if let Some(font) =
            system_font_family_from_localized_names(unsafe { directwrite_localized_names(&names) })
        {
            fonts.push(font);
        }
    }

    Ok(sort_and_deduplicate_system_fonts(fonts))
}

#[cfg(windows)]
unsafe fn directwrite_localized_names(
    names: &windows::Win32::Graphics::DirectWrite::IDWriteLocalizedStrings,
) -> Vec<LocalizedFontName> {
    let count = unsafe { names.GetCount() };
    let mut result = Vec::with_capacity(count as usize);
    for index in 0..count {
        let Ok(locale_length) = (unsafe { names.GetLocaleNameLength(index) }) else {
            continue;
        };
        let Ok(name_length) = (unsafe { names.GetStringLength(index) }) else {
            continue;
        };
        let mut locale = vec![0_u16; locale_length as usize + 1];
        let mut name = vec![0_u16; name_length as usize + 1];
        if unsafe { names.GetLocaleName(index, &mut locale) }.is_err()
            || unsafe { names.GetString(index, &mut name) }.is_err()
        {
            continue;
        }
        result.push(LocalizedFontName {
            locale: String::from_utf16_lossy(&locale[..locale_length as usize]),
            name: String::from_utf16_lossy(&name[..name_length as usize]),
        });
    }
    result
}

#[cfg(target_os = "linux")]
fn list_system_fonts() -> Result<Vec<SystemFontFamily>, String> {
    linux::list()
}

#[cfg(target_os = "macos")]
fn list_system_fonts() -> Result<Vec<SystemFontFamily>, String> {
    macos::list()
}

#[cfg(target_os = "android")]
fn list_system_fonts() -> Result<Vec<SystemFontFamily>, String> {
    Ok(android::list())
}

#[cfg(not(any(
    windows,
    target_os = "linux",
    target_os = "macos",
    target_os = "android"
)))]
fn list_system_fonts() -> Result<Vec<SystemFontFamily>, String> {
    Ok(Vec::new())
}

#[cfg(any(windows, target_os = "linux", test))]
fn system_font_family_from_localized_names(
    names: Vec<LocalizedFontName>,
) -> Option<SystemFontFamily> {
    let localized_names = normalize_localized_names(names);
    let family = localized_names
        .iter()
        .find(|name| name.locale == "en-us")
        .or_else(|| localized_names.iter().find(|name| name.locale == "en"))
        .or_else(|| localized_names.first())?
        .name
        .clone();
    Some(SystemFontFamily {
        family,
        localized_names,
    })
}

#[cfg(any(windows, target_os = "linux", test))]
fn normalize_localized_names(names: Vec<LocalizedFontName>) -> Vec<LocalizedFontName> {
    let mut unique = BTreeMap::new();
    for name in names {
        let locale = name.locale.trim().to_ascii_lowercase();
        let display_name = name.name.trim();
        if display_name.is_empty() {
            continue;
        }
        // BTreeMap provides deterministic sorting as well as case-insensitive
        // de-duplication for data returned by different platform font providers.
        unique
            .entry((locale.clone(), display_name.to_lowercase()))
            .or_insert_with(|| LocalizedFontName {
                locale,
                name: display_name.to_owned(),
            });
    }
    unique.into_values().collect()
}

fn sort_and_deduplicate_system_fonts(mut fonts: Vec<SystemFontFamily>) -> Vec<SystemFontFamily> {
    fonts.sort_by(|left, right| {
        left.family
            .to_lowercase()
            .cmp(&right.family.to_lowercase())
            .then_with(|| left.family.cmp(&right.family))
    });
    fonts.dedup_by(|left, right| left.family.eq_ignore_ascii_case(&right.family));
    fonts
}

#[cfg(test)]
mod tests {
    use super::*;

    fn localized(locale: &str, name: &str) -> LocalizedFontName {
        LocalizedFontName {
            locale: locale.into(),
            name: name.into(),
        }
    }

    #[test]
    fn family_prefers_en_us_and_normalizes_localized_names() {
        let family = system_font_family_from_localized_names(vec![
            localized(" zh-CN ", " 微软雅黑 "),
            localized("EN-us", "Microsoft YaHei"),
            localized("en-US", " microsoft yahei "),
            localized("", "Microsoft YaHei"),
        ])
        .expect("at least one non-empty name should produce a family");

        assert_eq!(family.family, "Microsoft YaHei");
        assert_eq!(
            family.localized_names,
            vec![
                localized("", "Microsoft YaHei"),
                localized("en-us", "Microsoft YaHei"),
                localized("zh-cn", "微软雅黑"),
            ]
        );
    }

    #[test]
    fn family_uses_first_sorted_localized_name_when_english_is_unavailable() {
        let family = system_font_family_from_localized_names(vec![
            localized("zh-CN", "宋体"),
            localized("ja-JP", "ＭＳ 明朝"),
        ])
        .expect("localized names should produce a family");

        assert_eq!(family.family, "ＭＳ 明朝");
    }

    #[test]
    fn system_font_list_is_sorted_and_case_insensitively_deduplicated() {
        let alpha = SystemFontFamily {
            family: "Alpha".into(),
            localized_names: vec![localized("en-us", "Alpha")],
        };
        let duplicate = SystemFontFamily {
            family: "alpha".into(),
            localized_names: vec![localized("en-us", "alpha")],
        };
        let zeta = SystemFontFamily {
            family: "Zeta".into(),
            localized_names: vec![localized("en-us", "Zeta")],
        };

        let fonts = sort_and_deduplicate_system_fonts(vec![zeta, duplicate, alpha]);
        assert_eq!(
            fonts
                .iter()
                .map(|font| font.family.as_str())
                .collect::<Vec<_>>(),
            vec!["Alpha", "Zeta"]
        );
    }
}
