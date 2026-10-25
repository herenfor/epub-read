//! Device-local linked library store operations.

use super::*;

/// OPF 中保持源顺序的 manifest。封面 fallback 必须按此顺序取首个有效候选，
/// 不能依赖 HashMap 的随机迭代顺序。
pub(super) fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

pub(crate) fn valid_content_hash(hash: &str) -> bool {
    hash.len() == 64
        && hash
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

pub(super) fn valid_optional_ratio(ratio: Option<f64>) -> bool {
    ratio
        .map(|value| value.is_finite() && (0.0..=1.0).contains(&value))
        .unwrap_or(true)
}

pub(super) fn valid_optional_anchor_text(offset: Option<u64>, snippet: &Option<String>) -> bool {
    if offset
        .map(|value| value > MAX_ANCHOR_TEXT_OFFSET)
        .unwrap_or(false)
    {
        return false;
    }
    match (offset, snippet) {
        (None, Some(_)) => false,
        (_, None) => true,
        (_, Some(value)) => {
            !value.is_empty()
                && value.chars().count() <= MAX_ANCHOR_SNIPPET_CODE_POINTS
                && !value.chars().any(char::is_whitespace)
        }
    }
}

pub(super) fn valid_optional_media_anchor(anchor: &Option<LinkedLibraryMediaAnchor>) -> bool {
    match anchor {
        None => true,
        Some(value) => {
            !value.tag.is_empty()
                && !value.signature.is_empty()
                && value.ratio.is_finite()
                && (0.0..=1.0).contains(&value.ratio)
        }
    }
}

pub(super) fn valid_note_snippet(value: &str) -> bool {
    !value.is_empty()
        && value.chars().count() <= MAX_ANCHOR_SNIPPET_CODE_POINTS
        && !value.chars().any(char::is_whitespace)
}

pub(super) fn normalized_code_point_count(value: &str) -> usize {
    value
        .chars()
        .filter(|character| !character.is_whitespace())
        .count()
}

pub(super) fn valid_note(note: &LinkedLibraryNote) -> bool {
    !note.id.trim().is_empty()
        && !note.chapter_path.trim().is_empty()
        && note.start_text_offset <= MAX_ANCHOR_TEXT_OFFSET
        && note.end_text_offset <= MAX_ANCHOR_TEXT_OFFSET
        && note.end_text_offset > note.start_text_offset
        && valid_note_snippet(&note.start_text_snippet)
        && valid_note_snippet(&note.end_text_snippet)
        && !note.selected_text.is_empty()
        && note.selected_text.chars().count() <= MAX_NOTE_SELECTED_CODE_POINTS
        && normalized_code_point_count(&note.selected_text)
            == (note.end_text_offset - note.start_text_offset) as usize
        && !note.content.trim().is_empty()
        && note.content.chars().count() <= MAX_NOTE_CONTENT_CODE_POINTS
        && note.updated_at_ms >= note.created_at_ms
}

pub(super) fn portable_file_name(name: &str) -> bool {
    !name.is_empty()
        && !name.contains('/')
        && !name.contains('\\')
        && !name.to_ascii_lowercase().starts_with("file:")
}

pub(crate) fn library_root(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_local_data_dir()
        .map(|path| path.join("linked-library"))
        .map_err(|error| format!("无法取得应用本地数据目录：{error}"))
}

/// The sole authoritative location for an application-owned EPUB.  A managed
/// binding never stores this path; callers derive it from the library root and
/// the already validated canonical hash.
pub(crate) fn managed_source_path(library_root: &Path, content_hash: &str) -> Result<PathBuf, String> {
    if !valid_content_hash(content_hash) {
        return Err("managed 设备绑定缺少规范小写内容指纹".into());
    }
    Ok(library_root
        .join("books")
        .join(format!("{content_hash}.epub")))
}

/// A library copy with a readable name (A34). The name is a single plain file
/// name ending in `.epub`; anything that could leave `books/` is rejected.
pub(crate) fn managed_named_path(library_root: &Path, file_name: &str) -> Result<PathBuf, String> {
    if !valid_library_file_name(file_name) {
        return Err("托管副本文件名无效".into());
    }
    Ok(library_root.join("books").join(file_name))
}

pub(crate) fn valid_library_file_name(name: &str) -> bool {
    let mut components = Path::new(name).components();
    matches!(components.next(), Some(std::path::Component::Normal(part)) if part == std::ffi::OsStr::new(name))
        && components.next().is_none()
        && !name.contains(['/', '\\', ':'])
        && !name.starts_with('.')
        && name.len() > ".epub".len()
        && name.to_ascii_lowercase().ends_with(".epub")
}

pub(super) fn records_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(records_path_at(&library_root(app)?))
}

pub(super) fn bindings_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(bindings_path_at(&library_root(app)?))
}

pub(super) fn records_path_at(root: &Path) -> PathBuf {
    root.join("library-records.json")
}

pub(super) fn bindings_path_at(root: &Path) -> PathBuf {
    root.join("device-bindings.json")
}

pub(super) fn thumbnails_root_at(root: &Path) -> PathBuf {
    root.join("thumbnails")
}

pub(super) fn thumbnails_root(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(thumbnails_root_at(&library_root(app)?))
}

/// Favorites and folders live in their own file next to the records.  It is
/// intentionally separate from `device-bindings.json` and from the reading
/// timestamps: the organization state is portable, the binding is not.
pub(super) fn organization_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(library_root(app)?.join("library-organization.json"))
}

pub(super) fn thumbnails_index_path_at(root: &Path) -> PathBuf {
    thumbnails_root_at(root).join("index.json")
}

pub(super) fn thumbnails_index_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(thumbnails_index_path_at(&library_root(app)?))
}

pub(super) fn load_json_or_default<T: for<'de> Deserialize<'de> + Default>(
    path: &Path,
    label: &str,
) -> Result<T, String> {
    match fs::read_to_string(path) {
        Ok(text) => serde_json::from_str(&text).map_err(|error| format!("{label}损坏：{error}")),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(T::default()),
        Err(error) => Err(format!("无法读取{label}：{error}")),
    }
}

pub(super) fn portable_u64_to_usize(value: u64) -> usize {
    usize::try_from(value).unwrap_or(0)
}

pub(super) fn portable_media_tag(tag: &MediaTag) -> String {
    match tag {
        MediaTag::Img => "img",
        MediaTag::Svg => "svg",
        MediaTag::Video => "video",
    }
    .to_string()
}

pub(super) fn locator_reading_fields(locator: &Locator) -> LinkedReadingFields {
    match locator {
        Locator::Legacy(legacy) => (
            portable_u64_to_usize(legacy.spine_index),
            portable_u64_to_usize(legacy.page_hint),
            legacy.anchor_index.map(portable_u64_to_usize),
            legacy.anchor_ratio,
            legacy.anchor_text_offset,
            legacy.anchor_text_snippet.clone(),
            legacy.media_anchor.as_ref().map(|media| LinkedLibraryMediaAnchor {
                index: portable_u64_to_usize(media.index),
                tag: media.tag.clone(),
                signature: media.signature.clone(),
                ratio: media.ratio,
            }),
        ),
        Locator::Modern(modern) => {
            let spine = portable_u64_to_usize(modern.spine_index_hint);
            match &modern.target {
                LocatorTarget::ChapterStart => (spine, 0, None, None, None, None, None),
                LocatorTarget::Text { offset, snippet, .. } => (
                    spine,
                    0,
                    None,
                    None,
                    Some(*offset),
                    Some(snippet.clone()),
                    None,
                ),
                LocatorTarget::Media {
                    signature,
                    index_hint,
                    tag,
                    ratio,
                } => (
                    spine,
                    0,
                    None,
                    None,
                    None,
                    None,
                    Some(LinkedLibraryMediaAnchor {
                        index: portable_u64_to_usize(*index_hint),
                        tag: portable_media_tag(tag),
                        signature: signature.clone(),
                        ratio: *ratio,
                    }),
                ),
            }
        }
    }
}

pub(super) fn linked_record_from_projection(book: &ShelfBookProjection, is_new: bool) -> LinkedLibraryRecord {
    let (last_read_at_ms, progress_pct, fields) = match &book.progress.display {
        Some(version) => {
            let (progress_pct, fields) = match &version.value {
                Some(progress) => (
                    u32::try_from(progress.progress_pct_hint).unwrap_or(u32::MAX),
                    locator_reading_fields(&progress.locator),
                ),
                None => (0, (0, 0, None, None, None, None, None)),
            };
            (version.updated_at_ms, progress_pct, fields)
        }
        None => (0, 0, (0, 0, None, None, None, None, None)),
    };
    let (spine_index, page, anchor_index, anchor_ratio, anchor_text_offset, anchor_text_snippet, media_anchor) = fields;
    LinkedLibraryRecord {
        content_hash: book.book_hash.clone(),
        title: book.metadata.title.clone(),
        creator: book.metadata.creator.clone(),
        language: book.metadata.language.clone().unwrap_or_default(),
        file_name: book.metadata.file_name.clone(),
        added_at_ms: book.metadata.added_at_ms,
        last_read_at_ms,
        spine_index,
        page,
        progress_pct,
        anchor_index,
        anchor_ratio,
        anchor_text_offset,
        anchor_text_snippet,
        media_anchor,
        bookmarks: book
            .bookmarks
            .iter()
            .map(|annotation| {
                let value = &annotation.display.value;
                let (spine_index, page, anchor_index, anchor_ratio, anchor_text_offset, anchor_text_snippet, media_anchor) =
                    locator_reading_fields(&value.locator);
                LinkedLibraryBookmark {
                    id: annotation.id.clone(),
                    spine_index,
                    page,
                    anchor_index,
                    anchor_ratio,
                    anchor_text_offset,
                    anchor_text_snippet,
                    media_anchor,
                    text: value.text.clone(),
                    created_at_ms: value.created_at_ms,
                }
            })
            .collect(),
        notes: book
            .notes
            .iter()
            .map(|annotation| {
                let value = &annotation.display.value;
                LinkedLibraryNote {
                    id: annotation.id.clone(),
                    spine_index: portable_u64_to_usize(value.spine_index_hint),
                    chapter_path: value.chapter_path.clone(),
                    start_text_offset: value.start_text_offset,
                    end_text_offset: value.end_text_offset,
                    start_text_snippet: value.start_text_snippet.clone(),
                    end_text_snippet: value.end_text_snippet.clone(),
                    selected_text: value.selected_text.clone(),
                    content: value.content.clone(),
                    created_at_ms: value.created_at_ms,
                    updated_at_ms: annotation.display.updated_at_ms,
                }
            })
            .collect(),
        is_new,
    }
}

pub(super) fn linked_records_from_projection(
    projection: &ShelfProjection,
    visible: &HashSet<String>,
    binding_hashes: &HashSet<String>,
    is_new: &HashSet<String>,
) -> Vec<LinkedLibraryRecord> {
    projection
        .books
        .iter()
        .filter(|book| {
            visible.contains(&book.book_hash) || binding_hashes.contains(&book.book_hash)
        })
        .map(|book| {
            linked_record_from_projection(book, is_new.contains(&book.book_hash))
        })
        .collect()
}

pub(super) fn portable_store_active(app: &AppHandle) -> Result<bool, String> {
    crate::portable_state_commands::with_existing_store(app, |_store| Ok(()))
        .map(|result| result.is_some())
        .map_err(|error| error.to_string())
}

pub(super) fn delete_records_portable(app: &AppHandle, content_hashes: &[String]) -> Result<(), String> {
    let records = load_records(app)?;
    let mut target_hashes = Vec::new();
    let mut seen = HashSet::new();
    for hash in content_hashes {
        if records.iter().any(|record| &record.content_hash == hash) && seen.insert(hash.clone()) {
            target_hashes.push(hash.clone());
        }
    }
    if target_hashes.is_empty() {
        return Ok(());
    }

    let bindings = load_bindings(app)?;
    let root = library_root(app)?;
    let mut managed_paths = Vec::new();
    for hash in &target_hashes {
        for binding in bindings
            .iter()
            .filter(|binding| &binding.content_hash == hash)
        {
            if let BindingSource::Managed(path) = binding.resolve_source(&root)? {
                managed_paths.push(path);
            }
        }
    }

    app.state::<AiState>()
        .cleanup_books_if_present(app, &target_hashes)?;

    for path in managed_paths {
        match fs::remove_file(&path) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(format!("无法删除托管书籍源文件：{error}")),
        }
    }

    let mut thumbnails = load_thumbnail_index(app)?;
    for hash in &target_hashes {
        remove_thumbnail(app, &mut thumbnails, hash)?;
    }
    save_thumbnail_index(app, &thumbnails)?;
    crate::portable_state_commands::with_existing_store(app, |store| {
        store.hide_linked_records(&target_hashes)
    })
    .map_err(|error| error.to_string())?
    .ok_or_else(|| "可移植资料仓储未激活".to_string())
}

pub(super) fn load_portable_records(app: &AppHandle) -> Result<Option<Vec<LinkedLibraryRecord>>, String> {
    crate::portable_state_commands::with_existing_store(app, |store| {
        let projection = store.project_shelf()?;
        let visible: HashSet<String> = store.local_visible_hashes()?.into_iter().collect();
        let binding_hashes: HashSet<String> = store.bindings_raw()?.into_keys().collect();
        let is_new: HashSet<String> = store.local_is_new_hashes()?.into_iter().collect();
        Ok(linked_records_from_projection(
            &projection,
            &visible,
            &binding_hashes,
            &is_new,
        ))
    })
    .map_err(|error| error.to_string())
}

pub(super) fn load_portable_bindings(app: &AppHandle) -> Result<Option<Vec<DeviceBinding>>, String> {
    crate::portable_state_commands::with_existing_store(app, |store| {
        let root = library_root(app).map_err(PortableError::storage_error)?;
        let raw_bindings = store.bindings_raw()?;
        let mut bindings = Vec::with_capacity(raw_bindings.len());
        for (hash, raw) in raw_bindings {
            let binding: DeviceBinding = serde_json::from_str(&raw).map_err(|error| {
                PortableError::storage_error(format!("设备绑定损坏：{error}"))
            })?;
            if binding.content_hash != hash {
                return Err(PortableError::storage_error(
                    "device_bindings 行内容指纹与键不一致",
                ));
            }
            bindings.push(binding);
        }
        validate_binding_sources(&bindings, &root).map_err(PortableError::storage_error)?;
        Ok(bindings)
    })
    .map_err(|error| error.to_string())
}

pub(super) fn save_portable_bindings(app: &AppHandle, bindings: &[DeviceBinding]) -> Result<Option<()>, String> {
    let rows: Vec<(String, String)> = bindings
        .iter()
        .map(|binding| {
            serde_json::to_string(binding)
                .map(|raw| (binding.content_hash.clone(), raw))
                .map_err(|error| format!("无法序列化设备绑定：{error}"))
        })
        .collect::<Result<_, _>>()?;
    crate::portable_state_commands::with_existing_store(app, |store| {
        store.replace_bindings_snapshot(rows)
    })
    .map(|result| result.map(|_| ()))
    .map_err(|error| error.to_string())
}

pub(super) fn save_portable_records(app: &AppHandle, records: &[LinkedLibraryRecord]) -> Result<Option<()>, String> {
    let values: Vec<serde_json::Value> = records
        .iter()
        .map(|record| serde_json::to_value(record))
        .collect::<Result<_, _>>()
        .map_err(|error| format!("无法序列化书库记录：{error}"))?;
    let visible_hashes: Vec<String> = records
        .iter()
        .map(|record| record.content_hash.clone())
        .collect();
    let is_new_hashes: Vec<String> = records
        .iter()
        .filter(|record| record.is_new)
        .map(|record| record.content_hash.clone())
        .collect();
    crate::portable_state_commands::with_existing_store(app, |store| {
        store
            .publish_linked_records_snapshot(values, visible_hashes, is_new_hashes)
            .map(|_| ())
    })
    .map(|result| result.map(|_| ()))
    .map_err(|error| error.to_string())
}

/// Import adds bindings and visibility without replacing concurrently imported
/// local rows. SQLite owns the entire metadata/binding publication transaction.
pub(super) fn save_portable_import(
    app: &AppHandle,
    records: &[LinkedLibraryRecord],
    bindings: &[DeviceBinding],
) -> Result<Option<()>, String> {
    let values = records
        .iter()
        .map(serde_json::to_value)
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("无法序列化书库记录：{error}"))?;
    let rows = bindings
        .iter()
        .map(|binding| {
            serde_json::to_string(binding).map(|raw| (binding.content_hash.clone(), raw))
        })
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("无法序列化设备绑定：{error}"))?;
    let visible = records
        .iter()
        .map(|record| record.content_hash.clone())
        .collect();
    let is_new = records
        .iter()
        .filter(|record| record.is_new)
        .map(|record| record.content_hash.clone())
        .collect();
    crate::portable_state_commands::with_existing_store(app, |store| {
        store
            .publish_linked_imports(values, rows, visible, is_new)
            .map(|_| ())
    })
    .map_err(|error| error.to_string())
}

pub(super) fn load_records_at(root: &Path) -> Result<Vec<LinkedLibraryRecord>, String> {
    load_json_or_default(&records_path_at(root), "书库记录")
}

pub(super) fn load_records(app: &AppHandle) -> Result<Vec<LinkedLibraryRecord>, String> {
    if let Some(records) = load_portable_records(app)? {
        observe_records_read("v3", records.len());
        return Ok(records);
    }
    let records: Vec<LinkedLibraryRecord> = load_json_or_default(&records_path(app)?, "书库记录")?;
    observe_records_read("legacy-json", records.len());
    Ok(records)
}

pub(super) fn load_bindings_at(root: &Path) -> Result<Vec<DeviceBinding>, String> {
    let bindings = load_json_or_default::<Vec<DeviceBinding>>(&bindings_path_at(root), "设备绑定")?;
    validate_binding_sources(&bindings, root)?;
    Ok(bindings)
}

pub(crate) fn load_bindings(app: &AppHandle) -> Result<Vec<DeviceBinding>, String> {
    if let Some(bindings) = load_portable_bindings(app)? {
        return Ok(bindings);
    }
    let root = library_root(app)?;
    let bindings = load_json_or_default::<Vec<DeviceBinding>>(&bindings_path(app)?, "设备绑定")?;
    validate_binding_sources(&bindings, &root)?;
    Ok(bindings)
}

/// Validate every binding once at the JSON/file boundary.  Missing
/// `storageKind` is already defaulted to linked by serde; explicit null and
/// unknown values fail during deserialization.  The remaining shape checks are
/// kind-specific so a malformed binding can never be silently downgraded.
pub(super) fn validate_binding_sources(bindings: &[DeviceBinding], library_root: &Path) -> Result<(), String> {
    for binding in bindings {
        binding
            .resolve_source(library_root)
            .map_err(|error| format!("设备绑定损坏：{error}"))?;
    }
    Ok(())
}

pub(super) fn load_thumbnail_index_at(root: &Path) -> Result<ThumbnailIndex, String> {
    load_json_or_default(&thumbnails_index_path_at(root), "缩略图索引")
}

pub(super) fn load_thumbnail_index(app: &AppHandle) -> Result<ThumbnailIndex, String> {
    load_json_or_default(&thumbnails_index_path(app)?, "缩略图索引")
}

pub(crate) fn atomic_write_bytes(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| "缓存路径没有父目录".to_string())?;
    fs::create_dir_all(parent).map_err(|error| format!("无法创建本地书库目录：{error}"))?;
    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("data");
    let nonce = TEMP_FILE_NONCE.fetch_add(1, Ordering::Relaxed);
    let temporary = parent.join(format!(
        ".{file_name}.{}.{}.{}.tmp",
        std::process::id(),
        now_ms(),
        nonce
    ));
    {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)
            .map_err(|error| format!("无法创建临时索引：{error}"))?;
        file.write_all(bytes)
            .and_then(|_| file.sync_all())
            .map_err(|error| format!("无法写入临时索引：{error}"))?;
    }
    // Unix rename is atomic in one directory.  Windows needs MoveFileEx with
    // REPLACE_EXISTING because std::fs::rename cannot replace an existing file.
    replace_file_atomically(&temporary, path).map_err(|error| {
        let _ = fs::remove_file(&temporary);
        format!("无法原子替换索引：{error}")
    })
}

#[cfg(not(windows))]
pub(crate) fn replace_file_atomically(source: &Path, target: &Path) -> std::io::Result<()> {
    fs::rename(source, target)
}

#[cfg(windows)]
pub(crate) fn replace_file_atomically(source: &Path, target: &Path) -> std::io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    #[link(name = "kernel32")]
    extern "system" {
        fn MoveFileExW(
            existing_file_name: *const u16,
            new_file_name: *const u16,
            flags: u32,
        ) -> i32;
    }
    const MOVEFILE_REPLACE_EXISTING: u32 = 0x1;
    const MOVEFILE_WRITE_THROUGH: u32 = 0x8;
    let source_wide: Vec<u16> = source.as_os_str().encode_wide().chain(Some(0)).collect();
    let target_wide: Vec<u16> = target.as_os_str().encode_wide().chain(Some(0)).collect();
    // SAFETY: both paths are NUL-terminated UTF-16 buffers alive for the call.
    let ok = unsafe {
        MoveFileExW(
            source_wide.as_ptr(),
            target_wide.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    };
    if ok == 0 {
        Err(std::io::Error::last_os_error())
    } else {
        Ok(())
    }
}

pub(super) fn atomic_write_json<T: Serialize + ?Sized>(path: &Path, value: &T) -> Result<(), String> {
    let bytes = serde_json::to_vec_pretty(value)
        .map_err(|error| format!("无法序列化本地书库索引：{error}"))?;
    atomic_write_bytes(path, &bytes)
}

pub(super) fn save_records(app: &AppHandle, records: &[LinkedLibraryRecord]) -> Result<(), String> {
    if save_portable_records(app, records)?.is_some() {
        return Ok(());
    }
    save_records_at(&library_root(app)?, records)
}

pub(super) fn save_bindings(app: &AppHandle, bindings: &[DeviceBinding]) -> Result<(), String> {
    if save_portable_bindings(app, bindings)?.is_some() {
        return Ok(());
    }
    save_bindings_at(&library_root(app)?, bindings)
}

pub(super) fn save_records_at(root: &Path, records: &[LinkedLibraryRecord]) -> Result<(), String> {
    atomic_write_json(&records_path_at(root), records)
}

pub(super) fn save_bindings_at(root: &Path, bindings: &[DeviceBinding]) -> Result<(), String> {
    atomic_write_json(&bindings_path_at(root), bindings)
}

pub(super) fn save_thumbnail_index_at(root: &Path, index: &ThumbnailIndex) -> Result<(), String> {
    atomic_write_json(&thumbnails_index_path_at(root), index)
}

pub(super) fn save_thumbnail_index(app: &AppHandle, index: &ThumbnailIndex) -> Result<(), String> {
    save_thumbnail_index_at(&library_root(app)?, index)
}

pub(super) fn list_records_blocking(app: AppHandle) -> Result<Vec<LinkedLibraryRecordView>, String> {
    let state = app.state::<LinkedLibraryWriteState>();
    let _guard = state
        .0
        .lock()
        .map_err(|_| "链接书库写入锁已损坏".to_string())?;
    let root = library_root(&app)?;
    let records = load_records(&app)?;
    let known_hashes: HashSet<&str> = records
        .iter()
        .map(|record| record.content_hash.as_str())
        .collect();
    let mut bindings = load_bindings(&app)?;
    let before_prune = bindings.len();
    bindings.retain(|binding| known_hashes.contains(binding.content_hash.as_str()));
    let mut bindings_changed = bindings.len() != before_prune;
    for binding in &mut bindings {
        // Managed sources stay stat-only until an explicit open verifies or
        // reimport replaces them.  Linked sources keep the existing rehash-on-
        // signature-change semantics.
        if let Ok(verification) = verify_binding_for_list_refresh(binding, &root) {
            if verification.available {
                bindings_changed |= verification.changed;
            }
        }
    }
    if bindings_changed {
        save_bindings(&app, &bindings)?;
    }
    let mut thumbnails = load_thumbnail_index(&app)?;
    if reconcile_thumbnail_cache(&app, &mut thumbnails)? {
        save_thumbnail_index(&app, &thumbnails)?;
    }
    Ok(records
        .into_iter()
        .map(|record| {
            let hash = record.content_hash.clone();
            binding_view(
                record,
                bindings.iter().find(|binding| binding.content_hash == hash),
                thumbnails
                    .entries
                    .iter()
                    .find(|entry| entry.content_hash == hash)
                    .map(|entry| entry.mime.clone())
                    .unwrap_or_default(),
                &root,
            )
        })
        .collect())
}

pub(super) fn apply_progress_update(
    record: &mut LinkedLibraryRecord,
    last_read_at_ms: u64,
    spine_index: usize,
    page: usize,
    progress_pct: u32,
    anchor_index: Option<usize>,
    anchor_ratio: Option<f64>,
    anchor_text_offset: Option<u64>,
    anchor_text_snippet: Option<String>,
    media_anchor: Option<LinkedLibraryMediaAnchor>,
) {
    record.last_read_at_ms = last_read_at_ms;
    record.spine_index = spine_index;
    record.page = page;
    record.progress_pct = progress_pct.min(100);
    record.anchor_index = anchor_index;
    record.anchor_ratio = anchor_ratio;
    record.anchor_text_offset = anchor_text_offset;
    record.anchor_text_snippet = anchor_text_snippet;
    record.media_anchor = media_anchor;
    record.is_new = false;
}

pub(super) fn validate_portable_records(records: &[LinkedLibraryRecord]) -> Result<(), String> {
    let mut seen = HashSet::with_capacity(records.len());
    for record in records {
        if !valid_content_hash(&record.content_hash) {
            return Err("存档含有无效的书籍内容指纹".into());
        }
        if !portable_file_name(&record.file_name) {
            return Err("存档文件名提示不得包含设备路径".into());
        }
        if !seen.insert(record.content_hash.to_ascii_lowercase()) {
            return Err("存档含有重复的书籍内容指纹".into());
        }
        if record.progress_pct > 100 {
            return Err("存档含有无效阅读百分比".into());
        }
        if !valid_optional_ratio(record.anchor_ratio) {
            return Err("存档含有无效阅读锚点比例".into());
        }
        if !valid_optional_anchor_text(record.anchor_text_offset, &record.anchor_text_snippet) {
            return Err("存档含有无效阅读文本锚点".into());
        }
        if !valid_optional_media_anchor(&record.media_anchor) {
            return Err("存档含有无效阅读媒体锚点".into());
        }
        for bookmark in &record.bookmarks {
            if !valid_optional_ratio(bookmark.anchor_ratio)
                || !valid_optional_anchor_text(
                    bookmark.anchor_text_offset,
                    &bookmark.anchor_text_snippet,
                )
                || !valid_optional_media_anchor(&bookmark.media_anchor)
            {
                return Err("存档含有无效书签锚点比例".into());
            }
        }
        let mut note_ids = HashSet::with_capacity(record.notes.len());
        for note in &record.notes {
            if !valid_note(note) {
                return Err("存档含有无效笔记".into());
            }
            if !note_ids.insert(note.id.clone()) {
                return Err("存档含有重复笔记 ID".into());
            }
        }
    }
    Ok(())
}

pub(super) fn delete_records_at<F>(
    root: &Path,
    content_hashes: &[String],
    cleanup_derived_data: F,
) -> Result<(), String>
where
    F: FnOnce(&[String]) -> Result<(), String>,
{
    let records = load_records_at(root)?;

    // Deduplicate while keeping the caller's order.  It is not enough to see
    // one hash once in a HashSet: the file-deletion loop below must be
    // deterministic so a partially deleted batch can be retried predictably.
    let mut target_hashes = Vec::new();
    let mut seen = HashSet::new();
    for hash in content_hashes {
        if records.iter().any(|record| &record.content_hash == hash) && seen.insert(hash.clone()) {
            target_hashes.push(hash.clone());
        }
    }
    if target_hashes.is_empty() {
        // Every requested record is already gone.  Missing targets are a
        // no-op on retry, not a reason to reject the whole batch.
        return Ok(());
    }

    let mut bindings = load_bindings_at(root)?;

    // Resolve ownership before deleting anything.  A record without a binding
    // is still cleaned up later, but a managed path is derived only from an
    // actual managed binding; never from a bare hash and never by scanning
    // the books directory.
    let mut managed_paths = Vec::new();
    for hash in &target_hashes {
        for binding in bindings
            .iter()
            .filter(|binding| &binding.content_hash == hash)
        {
            if let BindingSource::Managed(path) = binding.resolve_source(root)? {
                managed_paths.push(path);
            }
        }
    }

    // Reuse the existing derived-data cleanup and keep the existing lock
    // order: the library write lock is already held by the caller.
    cleanup_derived_data(&target_hashes)
        .map_err(|error| format!("删除书籍前清理派生数据失败：{error}"))?;

    // Files first: remove owned copies before any index commit.  NotFound is
    // completion (a previous attempt may have deleted the file already); all
    // other I/O errors keep the indexes for a retry.
    for path in managed_paths {
        match fs::remove_file(&path) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => {
                return Err(format!("无法删除托管书籍源文件：{error}"));
            }
        }
    }

    let mut thumbnails = load_thumbnail_index_at(root)?;
    let target_set: HashSet<&str> = target_hashes.iter().map(String::as_str).collect();
    let mut remaining_records = records;
    remaining_records.retain(|record| !target_set.contains(record.content_hash.as_str()));
    bindings.retain(|binding| !target_set.contains(binding.content_hash.as_str()));
    for hash in &target_hashes {
        remove_thumbnail_at(root, &mut thumbnails, hash)?;
    }

    // Keep the existing commit order: bindings / thumbnail index / records.
    // A crash or I/O failure after bindings are saved leaves a record without
    // a binding; the next retry removes that record without touching a file.
    save_bindings_at(root, &bindings)?;
    save_thumbnail_index_at(root, &thumbnails)?;
    save_records_at(root, &remaining_records)
}

pub(super) fn delete_records(app: &AppHandle, content_hashes: Vec<String>) -> Result<(), String> {
    if content_hashes.iter().any(|hash| !valid_content_hash(hash)) {
        return Err("无效的书籍内容指纹".into());
    }
    if content_hashes.is_empty() {
        return Ok(());
    }
    let state = app.state::<LinkedLibraryWriteState>();
    let _guard = state
        .0
        .lock()
        .map_err(|_| "链接书库写入锁已损坏".to_string())?;
    ensure_import_idle(app)?;
    if portable_store_active(app)? {
        return delete_records_portable(app, &content_hashes);
    }
    let root = library_root(app)?;
    delete_records_at(&root, &content_hashes, |target_hashes| {
        app.state::<AiState>()
            .cleanup_books_if_present(app, target_hashes)
    })
}
