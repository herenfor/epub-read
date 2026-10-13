//! Device-local linked library thumbnails operations.

use super::*;

pub(super) fn thumbnail_path_at(root: &Path, hash: &str) -> Result<PathBuf, String> {
    if !valid_content_hash(hash) {
        return Err("无效的书籍内容指纹".into());
    }
    Ok(thumbnails_root_at(root).join(format!("{hash}.thumb")))
}

pub(super) fn thumbnail_path(app: &AppHandle, hash: &str) -> Result<PathBuf, String> {
    thumbnail_path_at(&library_root(app)?, hash)
}

pub(super) fn remove_thumbnail_at(root: &Path, index: &mut ThumbnailIndex, hash: &str) -> Result<(), String> {
    let path = thumbnail_path_at(root, hash)?;
    if path.exists() {
        fs::remove_file(path).map_err(|error| format!("无法删除封面缓存：{error}"))?;
    }
    index.entries.retain(|entry| entry.content_hash != hash);
    Ok(())
}

pub(super) fn remove_thumbnail(app: &AppHandle, index: &mut ThumbnailIndex, hash: &str) -> Result<(), String> {
    remove_thumbnail_at(&library_root(app)?, index, hash)
}

pub(super) fn prune_thumbnail_cache(app: &AppHandle, index: &mut ThumbnailIndex) -> Result<(), String> {
    index.entries.sort_by_key(|entry| entry.last_accessed_at_ms);
    let mut bytes: u64 = index.entries.iter().map(|entry| entry.size).sum();
    let mut evict = Vec::new();
    for entry in &index.entries {
        if bytes <= MAX_THUMBNAIL_CACHE_BYTES {
            break;
        }
        bytes = bytes.saturating_sub(entry.size);
        evict.push(entry.content_hash.clone());
    }
    for hash in evict {
        remove_thumbnail(app, index, &hash)?;
    }
    Ok(())
}

pub(super) fn thumbnail_hash_from_file_name(name: &str) -> Option<&str> {
    let hash = name.strip_suffix(".thumb")?;
    valid_content_hash(hash).then_some(hash)
}

/// Repair the regenerable cache after an interrupted file/index commit.
/// Unindexed `.thumb` files and atomic-write `.tmp` leftovers must not escape
/// the 100 MiB accounting boundary across restarts.
pub(super) fn reconcile_thumbnail_cache(app: &AppHandle, index: &mut ThumbnailIndex) -> Result<bool, String> {
    let root = thumbnails_root(app)?;
    let mut changed = false;
    let mut retained = Vec::with_capacity(index.entries.len());
    let mut indexed_hashes = HashSet::new();

    for entry in std::mem::take(&mut index.entries) {
        let structurally_valid = valid_content_hash(&entry.content_hash)
            && matches!(entry.mime.as_str(), "image/jpeg" | "image/webp")
            && entry.size > 0
            && entry.size <= MAX_THUMBNAIL_BYTES as u64
            && indexed_hashes.insert(entry.content_hash.clone());
        if !structurally_valid {
            changed = true;
            continue;
        }
        let path = root.join(format!("{}.thumb", entry.content_hash));
        let valid_file = fs::symlink_metadata(&path)
            .map(|metadata| {
                metadata.file_type().is_file()
                    && !metadata.file_type().is_symlink()
                    && metadata.len() == entry.size
            })
            .unwrap_or(false);
        if valid_file {
            retained.push(entry);
        } else {
            indexed_hashes.remove(&entry.content_hash);
            if path.exists() {
                fs::remove_file(&path).map_err(|error| format!("无法清理异常封面缓存：{error}"))?;
            }
            changed = true;
        }
    }
    index.entries = retained;

    match fs::read_dir(&root) {
        Ok(entries) => {
            for item in entries {
                let item = item.map_err(|error| format!("无法扫描封面缓存：{error}"))?;
                let file_type = item
                    .file_type()
                    .map_err(|error| format!("无法读取封面缓存类型：{error}"))?;
                if !file_type.is_file() && !file_type.is_symlink() {
                    continue;
                }
                let name = item.file_name();
                let name = name.to_string_lossy();
                if name == "index.json" {
                    continue;
                }
                let is_indexed = thumbnail_hash_from_file_name(&name)
                    .map(|hash| indexed_hashes.contains(hash))
                    .unwrap_or(false);
                if !is_indexed {
                    fs::remove_file(item.path())
                        .map_err(|error| format!("无法清理孤立封面缓存：{error}"))?;
                    changed = true;
                }
            }
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(format!("无法扫描封面缓存：{error}")),
    }

    let before_prune = index.entries.len();
    prune_thumbnail_cache(app, index)?;
    Ok(changed || index.entries.len() != before_prune)
}
