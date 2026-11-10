//! Readest's own library folder as an import source. It has the backup's
//! layout (`library.json`, `<hash>/config.json`, `<hash>/<title>.<ext>`), but
//! Readest may be running and rewriting it, so JSON is read whole between two
//! snapshots. Nothing here writes to that folder or reads `settings.json`.
use super::{state::*, *};
use std::{
    fs::{self, File},
    io::Read,
    path::{Path, PathBuf},
};

const READEST_ID: &str = "com.bilingify.readest";
const STABLE_READ_ATTEMPTS: usize = 3;

/// A book file Readest stores beside the config: any supported format except
/// its own sidecars. `.zip` is our comic alias, never a Readest book.
pub(super) fn book_file_name(name: &str) -> bool {
    !matches!(name, "config.json" | "cover.png" | "nav.json")
        && !crate::document_formats::extension(name).eq_ignore_ascii_case("zip")
        && crate::document_formats::supported(name)
}

/// The `Books` folder for whatever level the user picked: the data root, the
/// `Readest` folder inside it, or `Books` itself.
pub(super) fn locate(picked: &Path) -> Option<PathBuf> {
    [
        picked.to_path_buf(),
        picked.join("Books"),
        picked.join("Readest").join("Books"),
    ]
    .into_iter()
    .find(|dir| dir.join("library.json").is_file())
}

/// Default data roots of a desktop Readest install, most likely first.
pub(super) fn default_roots(data_dir: Option<PathBuf>, home_dir: Option<PathBuf>) -> Vec<PathBuf> {
    let mut roots = Vec::new();
    if let Some(data) = data_dir {
        roots.push(data.join(READEST_ID));
    }
    if let Some(home) = home_dir {
        // Flatpak keeps its own XDG data home.
        roots.push(
            home.join(".var")
                .join("app")
                .join(READEST_ID)
                .join("data")
                .join(READEST_ID),
        );
    }
    roots
}

pub(super) struct Scan {
    pub library: PathBuf,
    pub library_bytes: u64,
    pub configs: Vec<(String, PathBuf, u64)>,
    pub books: Vec<(String, BookFile)>,
}

/// Lists configs and book files without following links or descending past one level.
pub(super) fn scan(books_dir: &Path, check: &dyn Fn() -> PortableResult<()>) -> PortableResult<Scan> {
    let unreadable = |_| error("source-unavailable", "无法读取 Readest 书库文件夹");
    let library = books_dir.join("library.json");
    let library_bytes = fs::symlink_metadata(&library)
        .ok()
        .filter(|meta| meta.is_file())
        .map(|meta| meta.len())
        .ok_or_else(|| error("not-readest", "未找到 Readest 书目"))?;
    let mut scan = Scan {
        library,
        library_bytes,
        configs: Vec::new(),
        books: Vec::new(),
    };
    for entry in fs::read_dir(books_dir).map_err(unreadable)? {
        check()?;
        let entry = entry.map_err(unreadable)?;
        let Some(hash) = entry.file_name().to_str().map(str::to_owned) else {
            continue;
        };
        if !valid_hash(&hash) || !entry.file_type().is_ok_and(|kind| kind.is_dir()) {
            continue;
        }
        // One unreadable book folder must not hide the rest of the library.
        let Ok(files) = fs::read_dir(entry.path()) else {
            continue;
        };
        let mut book: Option<BookFile> = None;
        for file in files.flatten() {
            let Some(name) = file.file_name().to_str().map(str::to_owned) else {
                continue;
            };
            let Ok(meta) = file.metadata() else { continue };
            if !file.file_type().is_ok_and(|kind| kind.is_file()) {
                continue;
            }
            if name == "config.json" {
                scan.configs.push((hash.clone(), file.path(), meta.len()));
            } else if book_file_name(&name) && book.as_ref().is_none_or(|kept| name < kept.name) {
                book = Some(BookFile {
                    name,
                    bytes: meta.len(),
                    at: BookAt::File(file.path()),
                });
            }
        }
        if let Some(book) = book {
            scan.books.push((hash, book));
        }
    }
    Ok(scan)
}

/// Reads a whole file only if it did not change while being read.
pub(super) fn read_stable(
    path: &Path,
    limit: u64,
    check: &dyn Fn() -> PortableResult<()>,
) -> PortableResult<Vec<u8>> {
    let unavailable = || error("source-unavailable", "无法读取 Readest 资料文件");
    for attempt in 0..STABLE_READ_ATTEMPTS {
        check()?;
        if attempt > 0 {
            std::thread::sleep(std::time::Duration::from_millis(120));
        }
        let file = File::open(path).map_err(|_| unavailable())?;
        let before = crate::linked_library::snapshot_file(&file).map_err(|_| unavailable())?;
        let size = file.metadata().map_err(|_| unavailable())?.len();
        if size > limit {
            return Err(error("too-large", "JSON 条目超出读取上限"));
        }
        let mut bytes = Vec::with_capacity(size as usize);
        if (&file).take(limit + 1).read_to_end(&mut bytes).is_err() {
            continue;
        }
        let after = crate::linked_library::snapshot_file(&file).map_err(|_| unavailable())?;
        if after == before && bytes.len() as u64 == size {
            return Ok(bytes);
        }
    }
    Err(error("source-changed", "Readest 正在改动这份资料，请稍后重试"))
}
