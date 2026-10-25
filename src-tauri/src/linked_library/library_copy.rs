//! A34: copying an imported EPUB into the app's book library on Windows.
//!
//! The copy gets a readable name (the original file name) inside `books/`.
//! It is staged, re-hashed against the import's content hash and only then
//! published, so a short or altered copy never becomes a library book.

use super::*;

/// Bytes kept free on the library drive beyond the books themselves.
const FREE_SPACE_MARGIN: u64 = 64 * 1024 * 1024;
const MAX_NAME_CHARS: usize = 120;
const RESERVED_STEMS: [&str; 22] = [
    "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8",
    "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
];

/// A Windows-safe `<stem>.epub` from the original file name, or the title
/// when the name has nothing usable left.
pub(crate) fn library_file_name(original: &str, title: &str) -> String {
    let stem_of = |raw: &str| {
        let raw = if raw.to_ascii_lowercase().ends_with(".epub") {
            &raw[..raw.len() - 5]
        } else {
            raw
        };
        let cleaned: String = raw
            .chars()
            .map(|c| {
                if c.is_control() || "<>:\"/\\|?*".contains(c) {
                    '_'
                } else {
                    c
                }
            })
            .collect();
        let cleaned: String = cleaned.chars().take(MAX_NAME_CHARS).collect();
        let cleaned = cleaned
            .trim()
            .trim_end_matches(['.', ' '])
            .trim_start_matches('.')
            .to_string();
        if cleaned.is_empty() || cleaned.chars().all(|c| c == '_') {
            None
        } else if RESERVED_STEMS.iter().any(|reserved| {
            reserved.eq_ignore_ascii_case(cleaned.split('.').next().unwrap_or(&cleaned))
        }) {
            Some(match cleaned.split_once('.') {
                Some((stem, rest)) => format!("{stem}_.{rest}"),
                None => format!("{cleaned}_"),
            })
        } else {
            Some(cleaned)
        }
    };
    let stem = stem_of(original)
        .or_else(|| stem_of(title))
        .unwrap_or_else(|| "book".to_string());
    format!("{stem}.epub")
}

/// `name`, or `name (2)`, `name (3)`…: free on disk and not claimed by another
/// binding (case-insensitive, as on Windows).
pub(super) fn allocate_library_file_name(
    books_dir: &Path,
    wanted: &str,
    bindings: &[DeviceBinding],
    skipped: &HashSet<String>,
) -> String {
    let stem = wanted.strip_suffix(".epub").unwrap_or(wanted);
    let taken = |candidate: &str| {
        skipped.contains(candidate)
            || fs::symlink_metadata(books_dir.join(candidate)).is_ok()
            || bindings.iter().any(|binding| {
                binding
                    .managed_file_name
                    .as_deref()
                    .is_some_and(|name| name.eq_ignore_ascii_case(candidate))
            })
    };
    let mut candidate = format!("{stem}.epub");
    let mut index = 2;
    while taken(&candidate) {
        candidate = format!("{stem} ({index}).epub");
        index += 1;
    }
    candidate
}

/// Refuses the whole copy batch up front when the library drive cannot hold it.
pub(crate) fn ensure_library_space(root: &Path, total_bytes: u64) -> Result<(), String> {
    let books = writable_books_directory(root)?;
    let available = fs2::available_space(&books)
        .map_err(|error| format!("无法读取书库所在磁盘的可用空间：{error}"))?;
    if total_bytes.saturating_add(FREE_SPACE_MARGIN) > available {
        return Err(format!(
            "书库所在磁盘空间不足：需要约 {} MiB，可用 {} MiB；可以取消“复制到书库”后再导入",
            total_bytes.div_ceil(1024 * 1024),
            available / (1024 * 1024)
        ));
    }
    Ok(())
}

/// Copies `source` into the library under a readable name after checking the
/// staged bytes still hash to `content_hash`. Returns the name and snapshot.
pub(super) fn copy_into_library(
    root: &Path,
    source: &Path,
    content_hash: &str,
    wanted_name: &str,
    bindings: &[DeviceBinding],
) -> Result<(String, FileSnapshot), String> {
    let staging = new_staging_path(root)?;
    let staged = (|| {
        fs::copy(source, &staging).map_err(|error| format!("无法复制到书库：{error}"))?;
        let (copied_hash, _) = hash_file(&staging)?;
        if copied_hash != content_hash {
            return Err("复制到书库的内容与原文件不一致，未导入".to_string());
        }
        OpenOptions::new()
            .write(true)
            .open(&staging)
            .and_then(|file| file.sync_all())
            .map_err(|error| format!("无法落盘书库副本：{error}"))?;
        publish_staged_copy(root, &staging, wanted_name, bindings)
    })();
    if staged.is_err() {
        let _ = fs::remove_file(&staging);
    }
    staged
}

/// Only claim a name if it is still free at the filesystem commit point.
/// Never use the replacing helper used for settings and hash-addressed files.
#[cfg(windows)]
fn publish_without_replacing(source: &Path, target: &Path) -> std::io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    unsafe extern "system" {
        fn MoveFileExW(source: *const u16, target: *const u16, flags: u32) -> i32;
    }
    const MOVEFILE_WRITE_THROUGH: u32 = 0x8;
    let source: Vec<u16> = source.as_os_str().encode_wide().chain(Some(0)).collect();
    let target: Vec<u16> = target.as_os_str().encode_wide().chain(Some(0)).collect();
    if unsafe { MoveFileExW(source.as_ptr(), target.as_ptr(), MOVEFILE_WRITE_THROUGH) } == 0 {
        return Err(std::io::Error::last_os_error());
    }
    Ok(())
}

#[cfg(not(windows))]
fn publish_without_replacing(source: &Path, target: &Path) -> std::io::Result<()> {
    // link is atomic and cannot overwrite. Both names must be on the same
    // filesystem; unsupported filesystems fail rather than fall back to replace.
    fs::hard_link(source, target)?;
    let _ = fs::remove_file(source);
    Ok(())
}

pub(crate) fn publish_staged_copy(
    root: &Path,
    staging: &Path,
    wanted_name: &str,
    bindings: &[DeviceBinding],
) -> Result<(String, FileSnapshot), String> {
    publish_staged_copy_using(
        root,
        staging,
        wanted_name,
        bindings,
        publish_without_replacing,
    )
}

fn publish_staged_copy_using(
    root: &Path,
    staging: &Path,
    wanted_name: &str,
    bindings: &[DeviceBinding],
    mut publish: impl FnMut(&Path, &Path) -> std::io::Result<()>,
) -> Result<(String, FileSnapshot), String> {
    let mut skipped = HashSet::new();
    loop {
        let name = allocate_library_file_name(
            &writable_books_directory(root)?,
            wanted_name,
            bindings,
            &skipped,
        );
        let target = managed_named_path(root, &name)?;
        match publish(staging, &target) {
            Ok(()) => return Ok((name, snapshot(&target)?)),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                skipped.insert(name);
            }
            Err(error) => return Err(format!("无法安全发布书库副本：{error}")),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn meta() -> ImportedMetadata {
        ImportedMetadata {
            title: String::new(),
            creator: String::new(),
            language: String::new(),
            spine: Vec::new(),
            cover_zip_path: None,
            cover_mime: String::new(),
        }
    }

    fn temp_root(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "library-copy-{name}-{}-{}",
            std::process::id(),
            now_ms()
        ));
        fs::create_dir_all(dir.join("books")).unwrap();
        dir
    }

    #[test]
    fn c1_racing_name_is_preserved_and_copy_gets_a_new_name() {
        let root = temp_root("name-race");
        let staging = new_staging_path(&root).unwrap();
        fs::write(&staging, b"our book").unwrap();
        let mut raced = false;
        let (name, _) =
            publish_staged_copy_using(&root, &staging, "book.epub", &[], |source, target| {
                if !raced {
                    fs::write(target, b"someone else's book").unwrap();
                    raced = true;
                }
                publish_without_replacing(source, target)
            })
            .unwrap();
        assert_eq!(name, "book (2).epub");
        assert_eq!(
            fs::read(root.join("books/book.epub")).unwrap(),
            b"someone else's book"
        );
        assert_eq!(
            fs::read(root.join("books").join(name)).unwrap(),
            b"our book"
        );
        assert!(!staging.exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn c1_unobservable_collision_advances_to_the_next_name() {
        let root = temp_root("hidden-collision");
        let staging = new_staging_path(&root).unwrap();
        fs::write(&staging, b"ours").unwrap();
        let mut collided = false;
        let (name, _) =
            publish_staged_copy_using(&root, &staging, "book.epub", &[], |source, target| {
                if !collided {
                    collided = true;
                    return Err(std::io::ErrorKind::AlreadyExists.into());
                }
                publish_without_replacing(source, target)
            })
            .unwrap();
        assert_eq!(name, "book (2).epub");
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink("missing.epub", root.join("dangling.epub")).unwrap();
            assert_eq!(
                allocate_library_file_name(&root, "dangling.epub", &[], &HashSet::new()),
                "dangling (2).epub"
            );
        }
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn library_names_keep_the_original_file_name_and_stay_windows_safe() {
        assert_eq!(
            library_file_name("贵族千金只愿意亲近我。02.epub", "x"),
            "贵族千金只愿意亲近我。02.epub"
        );
        assert_eq!(
            library_file_name("a<b>:c\"d|e?f*.EPUB", "x"),
            "a_b__c_d_e_f_.epub"
        );
        assert_eq!(library_file_name("  .hidden. .epub", "x"), "hidden.epub");
        assert_eq!(library_file_name("con.epub", "x"), "con_.epub");
        assert_eq!(library_file_name("CON.notes.epub", "x"), "CON_.notes.epub");
        assert_eq!(library_file_name("???.epub", "书名"), "书名.epub");
        assert_eq!(library_file_name("", ""), "book.epub");
        let long = "长".repeat(300);
        assert_eq!(
            library_file_name(&format!("{long}.epub"), "x")
                .chars()
                .count(),
            MAX_NAME_CHARS + ".epub".len()
        );
        for name in ["a.epub", "贵族 01 (2).epub"] {
            assert!(valid_library_file_name(name), "{name}");
        }
        for name in [
            "../a.epub",
            "sub/a.epub",
            "sub\\a.epub",
            "C:a.epub",
            ".epub",
            "a.txt",
            ".hidden.epub",
        ] {
            assert!(!valid_library_file_name(name), "{name}");
        }
    }

    #[test]
    fn copies_are_verified_and_numbered_instead_of_overwriting() {
        let root = temp_root("copy");
        let source = root.join("原书.epub");
        fs::write(&source, b"epub bytes").unwrap();
        let (hash, _) = hash_file(&source).unwrap();

        let (first, snapshot) = copy_into_library(&root, &source, &hash, "原书.epub", &[]).unwrap();
        assert_eq!(first, "原书.epub");
        assert_eq!(snapshot.size, 10);
        assert_eq!(
            fs::read(root.join("books").join(&first)).unwrap(),
            b"epub bytes"
        );

        // Another binding already claims the name (case-insensitively): the next copy is numbered.
        let claimed = make_managed_binding("f".repeat(64), snapshot.clone(), &meta())
            .with_managed_file_name("原书 (2).EPUB".into());
        let (second, _) =
            copy_into_library(&root, &source, &hash, "原书.epub", &[claimed]).unwrap();
        assert_eq!(second, "原书 (3).epub");

        // A copy that no longer matches the import's hash is refused and leaves nothing behind.
        let error =
            copy_into_library(&root, &source, &"0".repeat(64), "别的.epub", &[]).unwrap_err();
        assert!(error.contains("不一致"));
        assert!(!root.join("books").join("别的.epub").exists());
        let staging = root.join("books").join(".staging");
        assert_eq!(
            fs::read_dir(&staging)
                .map(|entries| entries.count())
                .unwrap_or(0),
            0
        );
    }

    #[test]
    fn a_named_managed_binding_resolves_to_its_copy_and_old_ones_to_the_hash_name() {
        let root = temp_root("resolve");
        let snapshot = FileSnapshot {
            size: 1,
            mtime_ns: 2,
        };
        let named = make_managed_binding("a".repeat(64), snapshot.clone(), &meta())
            .with_managed_file_name("原书.epub".into());
        assert_eq!(
            named.resolve_source(&root).unwrap().path(),
            root.join("books").join("原书.epub").as_path()
        );
        let legacy = make_managed_binding("b".repeat(64), snapshot.clone(), &meta());
        assert_eq!(
            legacy.resolve_source(&root).unwrap().path(),
            root.join("books")
                .join(format!("{}.epub", "b".repeat(64)))
                .as_path()
        );
        let hostile = make_managed_binding("c".repeat(64), snapshot, &meta())
            .with_managed_file_name("../escape.epub".into());
        assert!(hostile.resolve_source(&root).is_err());
        // The field survives a JSON round trip and stays absent for old bindings.
        let json = serde_json::to_value(&named).unwrap();
        assert_eq!(json["managedFileName"], "原书.epub");
        assert!(serde_json::to_value(&legacy)
            .unwrap()
            .get("managedFileName")
            .is_none());
    }
}
