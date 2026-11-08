//! Safe ownership layer over the opaque C bridge.

use std::ffi::CStr;
use std::marker::PhantomData;
use std::os::raw::{c_char, c_int};
use std::ptr::NonNull;
use std::slice;

use crate::error::{from_c_code, MobiError, Result};
use crate::{Cover, MobiMetadata};

const OK: c_int = 0;
const ERR_BUFFER: c_int = 9;
const NO_COVER: c_int = 10;

#[repr(C)]
#[derive(Clone, Copy, Debug, Default)]
struct RawInfo {
    version: u32,
    compression: u32,
    encryption: u32,
    text_length: u64,
    record_count: u32,
    flags: u32,
}

#[repr(C)]
#[derive(Clone, Copy)]
struct RawPart {
    kind: u32,
    uid: u32,
    size: u64,
    data: *const u8,
    is_opf: u8,
    extension: [c_char; 12],
    mime: [c_char; 64],
}

impl Default for RawPart {
    fn default() -> Self {
        Self {
            kind: 0,
            uid: 0,
            size: 0,
            data: std::ptr::null(),
            is_opf: 0,
            extension: [0; 12],
            mime: [0; 64],
        }
    }
}

enum OpaqueHandle {}

extern "C" {
    fn mobi_adapter_open_handle(handle: isize, error_out: *mut c_int) -> *mut OpaqueHandle;
    fn mobi_adapter_close(adapter: *mut OpaqueHandle);
    fn mobi_adapter_info_get(adapter: *const OpaqueHandle, out: *mut RawInfo) -> c_int;
    fn mobi_adapter_copy_title(
        adapter: *mut OpaqueHandle,
        out: *mut c_char,
        cap: usize,
        needed: *mut usize,
    ) -> c_int;
    fn mobi_adapter_copy_author(
        adapter: *mut OpaqueHandle,
        out: *mut c_char,
        cap: usize,
        needed: *mut usize,
    ) -> c_int;
    fn mobi_adapter_copy_language(
        adapter: *mut OpaqueHandle,
        out: *mut c_char,
        cap: usize,
        needed: *mut usize,
    ) -> c_int;
    fn mobi_adapter_copy_cover(
        adapter: *mut OpaqueHandle,
        out: *mut u8,
        cap: usize,
        needed: *mut usize,
        mime: *mut c_char,
        mime_cap: usize,
    ) -> c_int;
    fn mobi_adapter_parse(adapter: *mut OpaqueHandle) -> c_int;
    fn mobi_adapter_part_count(adapter: *const OpaqueHandle, kind: u32) -> usize;
    fn mobi_adapter_part_get(
        adapter: *const OpaqueHandle,
        kind: u32,
        index: usize,
        out: *mut RawPart,
    ) -> c_int;
    fn mobi_adapter_version() -> *const c_char;
}

/// libmobi version string from the bridge's linked copy.
pub fn libmobi_version() -> &'static str {
    // The C function returns a pointer to a static string literal.
    unsafe {
        let ptr = ffi_version();
        if ptr.is_null() {
            "unknown"
        } else {
            CStr::from_ptr(ptr).to_str().unwrap_or("unknown")
        }
    }
}

fn ffi_version() -> *const c_char {
    unsafe { mobi_adapter_version() }
}

fn into_platform_handle(file: std::fs::File) -> isize {
    #[cfg(unix)]
    {
        use std::os::fd::IntoRawFd;
        file.into_raw_fd() as isize
    }
    #[cfg(windows)]
    {
        use std::os::windows::io::IntoRawHandle;
        file.into_raw_handle() as isize
    }
    #[cfg(not(any(unix, windows)))]
    {
        let _ = file;
        compile_error!("mobi-adapter supports unix and windows targets");
    }
}

/// Owned opaque bridge. Dropping it frees rawml first, then MOBIData.
pub(crate) struct Handle {
    raw: NonNull<OpaqueHandle>,
    // The bridge is a synchronous, single-threaded owner. Keep it !Send/!Sync.
    _not_send: PhantomData<*mut ()>,
}

impl Handle {
    /// Take ownership of `file` and load its PDB/MOBI records.
    pub(crate) fn open(file: std::fs::File) -> Result<Self> {
        let handle = into_platform_handle(file);
        let mut error = 0;
        let raw = unsafe { mobi_adapter_open_handle(handle, &mut error) };
        if raw.is_null() {
            return Err(from_c_code(error));
        }
        Ok(Self {
            raw: NonNull::new(raw).expect("non-null bridge handle"),
            _not_send: PhantomData,
        })
    }

    pub(crate) fn info(&self) -> Result<Info> {
        let mut raw = RawInfo::default();
        let result = unsafe { mobi_adapter_info_get(self.raw.as_ptr(), &mut raw) };
        if result != OK {
            return Err(from_c_code(result));
        }
        Ok(Info {
            version: raw.version,
            compression: raw.compression,
            text_length: raw.text_length,
            record_count: raw.record_count,
            hybrid: raw.flags & 0x01 != 0,
            kf8: raw.flags & 0x02 != 0,
        })
    }

    pub(crate) fn title(&self, max: usize) -> Result<Option<String>> {
        self.copy_string(mobi_adapter_copy_title, max, "title")
    }

    pub(crate) fn author(&self, max: usize) -> Result<Option<String>> {
        self.copy_string(mobi_adapter_copy_author, max, "author")
    }

    pub(crate) fn language(&self, max: usize) -> Result<Option<String>> {
        self.copy_string(mobi_adapter_copy_language, max, "language")
    }

    fn copy_string(
        &self,
        copy: unsafe extern "C" fn(*mut OpaqueHandle, *mut c_char, usize, *mut usize) -> c_int,
        max: usize,
        field: &str,
    ) -> Result<Option<String>> {
        let mut needed = 0usize;
        let query = unsafe { copy(self.raw.as_ptr(), std::ptr::null_mut(), 0, &mut needed) };
        if query != ERR_BUFFER {
            return Err(from_c_code(query));
        }
        if needed == 0 {
            return Ok(None);
        }
        if needed > max {
            return Err(MobiError::new(
                crate::MobiErrorCode::Budget,
                format!("{field} metadata is {needed} bytes, limit is {max}"),
            ));
        }
        let mut buffer = vec![0u8; needed + 1];
        let mut written = 0usize;
        let result = unsafe {
            copy(
                self.raw.as_ptr(),
                buffer.as_mut_ptr().cast::<c_char>(),
                buffer.len(),
                &mut written,
            )
        };
        if result != OK {
            return Err(from_c_code(result));
        }
        let end = buffer.iter().position(|byte| *byte == 0).unwrap_or(written);
        let text = String::from_utf8_lossy(&buffer[..end]).into_owned();
        Ok((!text.is_empty()).then_some(text))
    }

    pub(crate) fn cover(&self, max: u64) -> Result<Option<Cover>> {
        let mut needed = 0usize;
        let mut mime = [0 as c_char; 64];
        let query = unsafe {
            mobi_adapter_copy_cover(
                self.raw.as_ptr(),
                std::ptr::null_mut(),
                0,
                &mut needed,
                mime.as_mut_ptr(),
                mime.len(),
            )
        };
        if query == NO_COVER {
            return Ok(None);
        }
        if query != ERR_BUFFER {
            return Err(from_c_code(query));
        }
        if needed as u128 > max as u128 {
            return Err(MobiError::new(
                crate::MobiErrorCode::Budget,
                format!("cover is {needed} bytes, limit is {max}"),
            ));
        }
        if needed == 0 {
            return Ok(None);
        }
        let mut bytes = vec![0u8; needed];
        let mut written = 0usize;
        let mut mime = [0 as c_char; 64];
        let result = unsafe {
            mobi_adapter_copy_cover(
                self.raw.as_ptr(),
                bytes.as_mut_ptr(),
                bytes.len(),
                &mut written,
                mime.as_mut_ptr(),
                mime.len(),
            )
        };
        if result != OK {
            return Err(from_c_code(result));
        }
        bytes.truncate(written);
        let mime = unsafe { CStr::from_ptr(mime.as_ptr()) }
            .to_string_lossy()
            .into_owned();
        Ok(Some(Cover { bytes, mime }))
    }

    /// Run the synchronous rawml reconstruction. There is no cancel callback;
    /// callers check their token immediately after this returns.
    pub(crate) fn parse(&mut self) -> Result<()> {
        let result = unsafe { mobi_adapter_parse(self.raw.as_ptr()) };
        if result != OK {
            return Err(from_c_code(result));
        }
        Ok(())
    }

    pub(crate) fn part_count(&self, kind: PartKind) -> usize {
        unsafe { mobi_adapter_part_count(self.raw.as_ptr(), kind.raw()) }
    }

    pub(crate) fn part(&self, kind: PartKind, index: usize) -> Result<PartView<'_>> {
        let mut raw = RawPart::default();
        let result =
            unsafe { mobi_adapter_part_get(self.raw.as_ptr(), kind.raw(), index, &mut raw) };
        if result != OK {
            return Err(from_c_code(result));
        }
        let size = usize::try_from(raw.size)
            .map_err(|_| MobiError::internal("part size does not fit usize"))?;
        if size > 0 && raw.data.is_null() {
            return Err(MobiError::internal("bridge part has null data"));
        }
        let data = if size == 0 {
            &[][..]
        } else {
            unsafe { slice::from_raw_parts(raw.data, size) }
        };
        Ok(PartView {
            kind,
            uid: raw.uid,
            data,
            extension: c_array_string(&raw.extension),
            is_opf: raw.is_opf != 0,
        })
    }
}

impl Drop for Handle {
    fn drop(&mut self) {
        unsafe { mobi_adapter_close(self.raw.as_ptr()) };
    }
}

#[derive(Clone, Copy, Debug)]
pub(crate) struct Info {
    pub version: u32,
    pub compression: u32,
    /// PalmDOC header's declared uncompressed text length.
    pub text_length: u64,
    pub record_count: u32,
    pub hybrid: bool,
    pub kf8: bool,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum PartKind {
    Markup,
    Flow,
    Resource,
}

impl PartKind {
    fn raw(self) -> u32 {
        match self {
            Self::Markup => 0,
            Self::Flow => 1,
            Self::Resource => 2,
        }
    }

    pub(crate) fn name(self) -> &'static str {
        match self {
            Self::Markup => "markup",
            Self::Flow => "flow",
            Self::Resource => "resource",
        }
    }
}

pub(crate) struct PartView<'a> {
    pub kind: PartKind,
    pub uid: u32,
    pub data: &'a [u8],
    pub extension: String,
    pub is_opf: bool,
}

fn c_array_string(value: &[c_char]) -> String {
    let bytes = value.iter().map(|byte| *byte as u8).collect::<Vec<_>>();
    let end = bytes
        .iter()
        .position(|byte| *byte == 0)
        .unwrap_or(bytes.len());
    String::from_utf8_lossy(&bytes[..end]).into_owned()
}

/// Kept separate so `inspect` can fill metadata without depending on C layout.
pub(crate) fn metadata_from_info(
    info: Info,
    title: Option<String>,
    creator: Option<String>,
    language: Option<String>,
    cover: Option<Cover>,
) -> MobiMetadata {
    MobiMetadata {
        title: title.unwrap_or_default(),
        creator: creator.unwrap_or_default(),
        language: language.unwrap_or_default(),
        format_version: info.version,
        compression: info.compression,
        hybrid: info.hybrid,
        kf8: info.kf8,
        cover,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs::{self, File};
    use std::io::{Seek, SeekFrom, Write};

    /// Exercise the patched 64-bit PDB record seek without materializing a
    /// multi-GB copy through the public Source budget. Sparse allocation keeps
    /// this cheap on ext4; the test is opt-in because not every CI filesystem
    /// supports a 3 GiB sparse file.
    #[test]
    fn sparse_large_offset_record_uses_64_bit_seek() {
        if std::env::var_os("MOBI_ADAPTER_LARGE_OFFSET").is_none() {
            eprintln!("skip: MOBI_ADAPTER_LARGE_OFFSET is not set");
            return;
        }
        let Some(path) = std::env::var_os("MOBI_ADAPTER_MOBI6") else {
            eprintln!("skip: MOBI_ADAPTER_MOBI6 is not set");
            return;
        };
        let bytes = fs::read(path).unwrap();
        let record0_offset = u32::from_be_bytes(bytes[78..82].try_into().unwrap()) as u64;
        let record1_offset = u32::from_be_bytes(bytes[86..90].try_into().unwrap()) as u64;
        let record0_len = record1_offset - record0_offset;
        let record0 = &bytes[record0_offset as usize..record1_offset as usize];

        let dir = tempfile::tempdir().unwrap();
        let sparse = dir.path().join("large-offset.mobi");
        let huge_offset: u64 = 3 * 1024 * 1024 * 1024;
        {
            let mut file = File::create(&sparse).unwrap();
            file.set_len(huge_offset + record0_len).unwrap();
            let mut header = vec![0u8; 78];
            header[60..68].copy_from_slice(b"BOOKMOBI");
            header[76..78].copy_from_slice(&1u16.to_be_bytes());
            file.write_all(&header).unwrap();
            file.seek(SeekFrom::Start(78)).unwrap();
            file.write_all(&(huge_offset as u32).to_be_bytes()).unwrap();
            file.write_all(&[0u8; 4]).unwrap();
            file.seek(SeekFrom::Start(huge_offset)).unwrap();
            file.write_all(record0).unwrap();
        }
        let handle = Handle::open(File::open(&sparse).unwrap()).expect("64-bit seek open");
        let info = handle.info().unwrap();
        assert_eq!(info.version, 6);
        assert_eq!(info.compression, 2);
    }
}
