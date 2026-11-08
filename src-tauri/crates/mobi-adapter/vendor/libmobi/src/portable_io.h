/** @file portable_io.h
 *  @brief Local patch: 64-bit stream offsets instead of 32-bit long.
 *
 *  Part of the vendored libmobi copy, not upstream. See ../../PATCHES.md.
 *  On Windows x64 long is still 32-bit; use the CRT 64-bit seek/fell calls.
 *  On POSIX use fseeko/ftello with _FILE_OFFSET_BITS=64 where needed.
 */

#ifndef libmobi_portable_io_h
#define libmobi_portable_io_h

/* fseeko/ftello are POSIX; -std=c99 otherwise hides them on glibc. */
#if !defined(_WIN32) && !defined(_POSIX_C_SOURCE)
#define _POSIX_C_SOURCE 200809L
#endif

#include <stdint.h>
#include <stdio.h>

#if defined(_WIN32)
#include <io.h>
static inline int mobi_fseek64(FILE *file, int64_t offset, int whence) {
    return _fseeki64(file, (__int64) offset, whence);
}
static inline int64_t mobi_ftell64(FILE *file) {
    return (int64_t) _ftelli64(file);
}
#else
#include <sys/types.h>
static inline int mobi_fseek64(FILE *file, int64_t offset, int whence) {
    return fseeko(file, (off_t) offset, whence);
}
static inline int64_t mobi_ftell64(FILE *file) {
    return (int64_t) ftello(file);
}
#endif

#endif
