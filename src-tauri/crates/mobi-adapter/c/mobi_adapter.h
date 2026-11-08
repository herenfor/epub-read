/**
 * @file mobi_adapter.h
 * @brief Small opaque C bridge between libmobi and the Rust adapter.
 *
 * This header is crate-internal. The Rust side owns the source stream and
 * passes a platform stream handle; the bridge takes ownership of that handle.
 * All MOBIData/MOBIRawml pointers stay private to the bridge.
 */

#ifndef MOBI_ADAPTER_H
#define MOBI_ADAPTER_H

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

typedef struct mobi_adapter mobi_adapter;

enum {
    MOBI_ADAPTER_OK = 0,
    MOBI_ADAPTER_ERR_IO = 1,
    MOBI_ADAPTER_ERR_MEMORY = 2,
    MOBI_ADAPTER_ERR_PARSE = 3,
    MOBI_ADAPTER_ERR_UNSUPPORTED = 4,
    MOBI_ADAPTER_ERR_ENCRYPTED = 5,
    MOBI_ADAPTER_ERR_REPLICA = 6,
    MOBI_ADAPTER_ERR_DICTIONARY = 7,
    MOBI_ADAPTER_ERR_NOT_FOUND = 8,
    MOBI_ADAPTER_ERR_BUFFER = 9,
    MOBI_ADAPTER_NO_COVER = 10,
    MOBI_ADAPTER_ERR_INTERNAL = 11
};

enum {
    MOBI_ADAPTER_PART_MARKUP = 0,
    MOBI_ADAPTER_PART_FLOW = 1,
    MOBI_ADAPTER_PART_RESOURCE = 2
};

#define MOBI_ADAPTER_FLAG_HYBRID 0x01u
#define MOBI_ADAPTER_FLAG_KF8 0x02u
#define MOBI_ADAPTER_FLAG_REPLICA 0x04u
#define MOBI_ADAPTER_FLAG_DICTIONARY 0x08u

typedef struct {
    uint32_t version;
    uint32_t compression;
    uint32_t encryption;
    uint64_t text_length;
    uint32_t record_count;
    uint32_t flags;
} mobi_adapter_info;

typedef struct {
    uint32_t kind;
    uint32_t uid;
    uint64_t size;
    const uint8_t *data;
    uint8_t is_opf;
    char extension[12];
    char mime[64];
} mobi_adapter_part;

/**
 * Open a PalmDB/MOBI stream from an owned platform handle.
 *
 * POSIX: handle is an owned file descriptor (int).
 * Windows: handle is an owned HANDLE cast to intptr_t.
 *
 * The bridge takes ownership of the handle in every case and closes it after
 * mobi_load_file has copied the records. Returns NULL on failure and writes
 * one of the MOBI_ADAPTER_* codes to error_out.
 */
mobi_adapter *mobi_adapter_open_handle(intptr_t handle, int *error_out);

/** Free MOBIRawml first, then MOBIData, then the bridge. NULL is accepted. */
void mobi_adapter_close(mobi_adapter *adapter);

int mobi_adapter_info_get(const mobi_adapter *adapter, mobi_adapter_info *out);

/**
 * Copy an owned metadata string as UTF-8. Call with out == NULL to query the
 * required size (excluding the trailing NUL). Returns MOBI_ADAPTER_ERR_BUFFER
 * when out is NULL or cap <= needed. `needed` is always written.
 */
int mobi_adapter_copy_title(mobi_adapter *adapter, char *out, size_t cap, size_t *needed);
int mobi_adapter_copy_author(mobi_adapter *adapter, char *out, size_t cap, size_t *needed);
int mobi_adapter_copy_language(mobi_adapter *adapter, char *out, size_t cap, size_t *needed);

/**
 * Query/copy the EXTH cover record. The MIME type is copied as a NUL
 * terminated string. Returns MOBI_ADAPTER_NO_COVER when no usable image cover
 * exists, MOBI_ADAPTER_ERR_BUFFER for a size query or a too-small buffer.
 */
int mobi_adapter_copy_cover(mobi_adapter *adapter, uint8_t *out, size_t cap, size_t *needed,
                            char *mime, size_t mime_cap);

/**
 * Reconstruct rawml parts. This is the synchronous heavy phase; it has no
 * cancel callback. Callers check cancellation before and after it.
 */
int mobi_adapter_parse(mobi_adapter *adapter);

/** Number of parts after the hidden first flow raw-html part is removed. */
size_t mobi_adapter_part_count(const mobi_adapter *adapter, uint32_t kind);

/**
 * Borrow one part. `out->data` is valid until mobi_adapter_close. Callers must
 * not retain it after close and must write it before freeing the bridge.
 */
int mobi_adapter_part_get(const mobi_adapter *adapter, uint32_t kind, size_t index,
                          mobi_adapter_part *out);

const char *mobi_adapter_version(void);

#ifdef __cplusplus
}
#endif

#endif
