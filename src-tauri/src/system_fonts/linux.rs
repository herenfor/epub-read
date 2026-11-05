//! Fontconfig's metadata API matches the font configuration used by WebKitGTK.
//! Link the existing system library; do not shell out to an optional fc-list tool.
use super::{
    sort_and_deduplicate_system_fonts, system_font_family_from_localized_names, LocalizedFontName,
    SystemFontFamily,
};
use std::ffi::{c_char, c_int, c_void, CStr};
use std::ptr;

#[repr(C)]
struct FontSet {
    count: c_int,
    capacity: c_int,
    fonts: *mut *mut c_void,
}

#[link(name = "fontconfig")]
unsafe extern "C" {
    fn FcInitLoadConfigAndFonts() -> *mut c_void;
    fn FcConfigDestroy(config: *mut c_void);
    fn FcPatternCreate() -> *mut c_void;
    fn FcPatternDestroy(pattern: *mut c_void);
    fn FcObjectSetCreate() -> *mut c_void;
    fn FcObjectSetAdd(objects: *mut c_void, name: *const c_char) -> c_int;
    fn FcObjectSetDestroy(objects: *mut c_void);
    fn FcFontList(config: *mut c_void, pattern: *mut c_void, objects: *mut c_void) -> *mut FontSet;
    fn FcFontSetDestroy(fonts: *mut FontSet);
    fn FcPatternGetString(
        pattern: *const c_void,
        name: *const c_char,
        index: c_int,
        value: *mut *mut u8,
    ) -> c_int;
}

#[derive(Default)]
struct Query {
    config: *mut c_void,
    pattern: *mut c_void,
    objects: *mut c_void,
    fonts: *mut FontSet,
}

impl Drop for Query {
    fn drop(&mut self) {
        // All four handles are owned by this query, never by WebKitGTK.
        unsafe {
            if !self.fonts.is_null() {
                FcFontSetDestroy(self.fonts);
            }
            if !self.objects.is_null() {
                FcObjectSetDestroy(self.objects);
            }
            if !self.pattern.is_null() {
                FcPatternDestroy(self.pattern);
            }
            if !self.config.is_null() {
                FcConfigDestroy(self.config);
            }
        }
    }
}

unsafe fn string(pattern: *const c_void, property: &CStr, index: c_int) -> Option<String> {
    let mut value = ptr::null_mut();
    // FcResultMatch == 0. Strings belong to the pattern and must be copied
    // before the query's FontSet is released.
    if unsafe { FcPatternGetString(pattern, property.as_ptr(), index, &mut value) } != 0
        || value.is_null()
    {
        return None;
    }
    Some(
        unsafe { CStr::from_ptr(value.cast()) }
            .to_string_lossy()
            .into_owned(),
    )
}

pub(super) fn list() -> Result<Vec<SystemFontFamily>, String> {
    let mut query = Query::default();
    // The ABI comes from fontconfig/fontconfig.h. No pointers escape this
    // function; Query releases every successful allocation on all return paths.
    unsafe {
        query.config = FcInitLoadConfigAndFonts();
        query.pattern = FcPatternCreate();
        query.objects = FcObjectSetCreate();
        if query.config.is_null() || query.pattern.is_null() || query.objects.is_null() {
            return Err("无法初始化 Fontconfig 字体查询".into());
        }
        if FcObjectSetAdd(query.objects, c"family".as_ptr()) == 0
            || FcObjectSetAdd(query.objects, c"familylang".as_ptr()) == 0
        {
            return Err("无法创建 Fontconfig 字体属性集合".into());
        }
        query.fonts = FcFontList(query.config, query.pattern, query.objects);
        if query.fonts.is_null() {
            return Err("无法读取 Fontconfig 系统字体集合".into());
        }
        let mut result = Vec::new();
        for i in 0..(*query.fonts).count {
            let pattern = *(*query.fonts).fonts.add(i as usize);
            let mut names = Vec::new();
            let mut index = 0;
            while let Some(name) = string(pattern, c"family", index) {
                names.push(LocalizedFontName {
                    locale: string(pattern, c"familylang", index).unwrap_or_default(),
                    name,
                });
                index += 1;
            }
            if let Some(family) = system_font_family_from_localized_names(names) {
                result.push(family);
            }
        }
        Ok(sort_and_deduplicate_system_fonts(result))
    }
}
