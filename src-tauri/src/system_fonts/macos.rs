//! CoreText supplies the family names used by WKWebView. No font files are read.
use super::{sort_and_deduplicate_system_fonts, LocalizedFontName, SystemFontFamily};
use std::ffi::{c_char, c_void, CStr};

#[link(name = "CoreText", kind = "framework")]
unsafe extern "C" {
    fn CTFontManagerCopyAvailableFontFamilyNames() -> *const c_void;
}

#[link(name = "CoreFoundation", kind = "framework")]
unsafe extern "C" {
    fn CFRelease(value: *const c_void);
    fn CFArrayGetCount(array: *const c_void) -> isize;
    fn CFArrayGetValueAtIndex(array: *const c_void, index: isize) -> *const c_void;
    fn CFStringGetLength(string: *const c_void) -> isize;
    fn CFStringGetMaximumSizeForEncoding(length: isize, encoding: u32) -> isize;
    fn CFStringGetCString(
        string: *const c_void,
        buffer: *mut c_char,
        size: isize,
        encoding: u32,
    ) -> u8;
}

struct Families(*const c_void);
impl Drop for Families {
    fn drop(&mut self) {
        // The Copy function returns one owned CFArray. Its strings are borrowed.
        unsafe {
            CFRelease(self.0);
        }
    }
}

pub(super) fn list() -> Result<Vec<SystemFontFamily>, String> {
    const UTF8: u32 = 0x0800_0100;
    unsafe {
        let array = CTFontManagerCopyAvailableFontFamilyNames();
        if array.is_null() {
            return Err("无法读取 CoreText 系统字体集合".into());
        }
        let families = Families(array);
        let mut result = Vec::new();
        for i in 0..CFArrayGetCount(families.0) {
            let string = CFArrayGetValueAtIndex(families.0, i);
            let capacity = CFStringGetMaximumSizeForEncoding(CFStringGetLength(string), UTF8);
            if capacity < 0 {
                continue;
            }
            let mut buffer = vec![0_u8; capacity as usize + 1];
            if CFStringGetCString(
                string,
                buffer.as_mut_ptr().cast(),
                buffer.len() as isize,
                UTF8,
            ) == 0
            {
                continue;
            }
            let family = CStr::from_ptr(buffer.as_ptr().cast())
                .to_string_lossy()
                .into_owned();
            result.push(SystemFontFamily {
                localized_names: vec![LocalizedFontName {
                    locale: String::new(),
                    name: family.clone(),
                }],
                family,
            });
        }
        Ok(sort_and_deduplicate_system_fonts(result))
    }
}
