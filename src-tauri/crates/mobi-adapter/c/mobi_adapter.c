/**
 * @file mobi_adapter.c
 * @brief Opaque libmobi bridge for the Rust mobi-adapter crate.
 */

/* fdopen is POSIX; -std=c99 otherwise hides it on glibc. */
#if !defined(_WIN32) && !defined(_POSIX_C_SOURCE)
#define _POSIX_C_SOURCE 200809L
#endif

#if defined(_WIN32)
#define _CRT_SECURE_NO_WARNINGS
#include <windows.h>
#include <fcntl.h>
#include <io.h>
#else
#include <unistd.h>
#endif

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "mobi.h"
#include "mobi_adapter.h"

struct mobi_adapter {
    MOBIData *m;
    MOBIRawml *rawml;
    int parsed;
};

static int map_mobi_ret(MOBI_RET ret) {
    switch (ret) {
        case MOBI_SUCCESS:
            return MOBI_ADAPTER_OK;
        case MOBI_FILE_ENCRYPTED:
            return MOBI_ADAPTER_ERR_ENCRYPTED;
        case MOBI_FILE_UNSUPPORTED:
            return MOBI_ADAPTER_ERR_UNSUPPORTED;
        case MOBI_FILE_NOT_FOUND:
            return MOBI_ADAPTER_ERR_IO;
        case MOBI_MALLOC_FAILED:
            return MOBI_ADAPTER_ERR_MEMORY;
        case MOBI_DATA_CORRUPT:
            return MOBI_ADAPTER_ERR_PARSE;
        default:
            return MOBI_ADAPTER_ERR_PARSE;
    }
}

/**
 * Convert the owned platform handle to a FILE stream. The returned FILE owns
 * the handle; the caller must fclose() it. On failure the handle is closed.
 */
static FILE *adapter_stream(intptr_t handle) {
#if defined(_WIN32)
    const int fd = _open_osfhandle(handle, _O_RDONLY | _O_BINARY);
    if (fd == -1) {
        CloseHandle((HANDLE) handle);
        return NULL;
    }
    FILE *file = _fdopen(fd, "rb");
    if (file == NULL) {
        _close(fd);
        return NULL;
    }
    return file;
#else
    const int fd = (int) handle;
    FILE *file = fdopen(fd, "rb");
    if (file == NULL) {
        close(fd);
        return NULL;
    }
    return file;
#endif
}

static int copy_allocated_string(char *value, char *out, size_t cap, size_t *needed) {
    size_t len = value ? strlen(value) : 0;
    if (needed) {
        *needed = len;
    }
    if (out == NULL || cap <= len) {
        free(value);
        return MOBI_ADAPTER_ERR_BUFFER;
    }
    if (len) {
        memcpy(out, value, len);
    }
    out[len] = '\0';
    free(value);
    return MOBI_ADAPTER_OK;
}

static int validate_mobi(MOBIData *m) {
    if (m == NULL || m->rh == NULL || !mobi_exists_mobiheader(m)) {
        return MOBI_ADAPTER_ERR_UNSUPPORTED;
    }
    /* Any non-zero PalmDOC encryption value is rejected before rawml parse. */
    if (m->rh->encryption_type != 0 || mobi_is_encrypted(m)) {
        return MOBI_ADAPTER_ERR_ENCRYPTED;
    }
    /* Hybrid files carry two Record 0 headers; both must be unencrypted. */
    if (m->next != NULL && m->next->rh != NULL && m->next->rh->encryption_type != 0) {
        return MOBI_ADAPTER_ERR_ENCRYPTED;
    }
    if (mobi_is_replica(m)) {
        return MOBI_ADAPTER_ERR_REPLICA;
    }
    if (mobi_is_dictionary(m)) {
        return MOBI_ADAPTER_ERR_DICTIONARY;
    }
    /* Combo files must use the KF8 representation, never a silent MOBI6 fallback. */
    if (mobi_is_hybrid(m) && !mobi_is_kf8(m)) {
        return MOBI_ADAPTER_ERR_UNSUPPORTED;
    }
    const size_t version = mobi_get_fileversion(m);
    if (version != 6 && version != 8) {
        return MOBI_ADAPTER_ERR_UNSUPPORTED;
    }
    const uint16_t compression = m->rh->compression_type;
    if (compression != MOBI_COMPRESSION_NONE && compression != MOBI_COMPRESSION_PALMDOC
        && compression != MOBI_COMPRESSION_HUFFCDIC) {
        return MOBI_ADAPTER_ERR_UNSUPPORTED;
    }
    return MOBI_ADAPTER_OK;
}

mobi_adapter *mobi_adapter_open_handle(intptr_t handle, int *error_out) {
    int err = MOBI_ADAPTER_OK;
    FILE *file = adapter_stream(handle);
    if (file == NULL) {
        if (error_out) {
            *error_out = MOBI_ADAPTER_ERR_IO;
        }
        return NULL;
    }
    MOBIData *m = mobi_init();
    if (m == NULL) {
        fclose(file);
        if (error_out) {
            *error_out = MOBI_ADAPTER_ERR_MEMORY;
        }
        return NULL;
    }
    const MOBI_RET ret = mobi_load_file(m, file);
    /* mobi_load_file has copied every record it needs. */
    fclose(file);
    if (ret != MOBI_SUCCESS) {
        mobi_free(m);
        if (error_out) {
            *error_out = map_mobi_ret(ret);
        }
        return NULL;
    }
    err = validate_mobi(m);
    if (err != MOBI_ADAPTER_OK) {
        mobi_free(m);
        if (error_out) {
            *error_out = err;
        }
        return NULL;
    }
    mobi_adapter *adapter = calloc(1, sizeof(*adapter));
    if (adapter == NULL) {
        mobi_free(m);
        if (error_out) {
            *error_out = MOBI_ADAPTER_ERR_MEMORY;
        }
        return NULL;
    }
    adapter->m = m;
    if (error_out) {
        *error_out = MOBI_ADAPTER_OK;
    }
    return adapter;
}

void mobi_adapter_close(mobi_adapter *adapter) {
    if (adapter == NULL) {
        return;
    }
    /* Resources may borrow MOBIData records: rawml must go first. */
    if (adapter->rawml != NULL) {
        mobi_free_rawml(adapter->rawml);
        adapter->rawml = NULL;
    }
    if (adapter->m != NULL) {
        mobi_free(adapter->m);
        adapter->m = NULL;
    }
    free(adapter);
}

int mobi_adapter_info_get(const mobi_adapter *adapter, mobi_adapter_info *out) {
    if (adapter == NULL || adapter->m == NULL || out == NULL || adapter->m->rh == NULL
        || adapter->m->ph == NULL) {
        return MOBI_ADAPTER_ERR_INTERNAL;
    }
    memset(out, 0, sizeof(*out));
    out->version = (uint32_t) mobi_get_fileversion(adapter->m);
    out->compression = adapter->m->rh->compression_type;
    out->encryption = adapter->m->rh->encryption_type;
    out->text_length = adapter->m->rh->text_length;
    out->record_count = adapter->m->ph->rec_count;
    if (mobi_is_hybrid(adapter->m)) {
        out->flags |= MOBI_ADAPTER_FLAG_HYBRID;
    }
    if (mobi_is_kf8(adapter->m)) {
        out->flags |= MOBI_ADAPTER_FLAG_KF8;
    }
    if (mobi_is_replica(adapter->m)) {
        out->flags |= MOBI_ADAPTER_FLAG_REPLICA;
    }
    if (mobi_is_dictionary(adapter->m)) {
        out->flags |= MOBI_ADAPTER_FLAG_DICTIONARY;
    }
    return MOBI_ADAPTER_OK;
}

int mobi_adapter_copy_title(mobi_adapter *adapter, char *out, size_t cap, size_t *needed) {
    if (adapter == NULL || adapter->m == NULL) {
        return MOBI_ADAPTER_ERR_INTERNAL;
    }
    return copy_allocated_string(mobi_meta_get_title(adapter->m), out, cap, needed);
}

int mobi_adapter_copy_author(mobi_adapter *adapter, char *out, size_t cap, size_t *needed) {
    if (adapter == NULL || adapter->m == NULL) {
        return MOBI_ADAPTER_ERR_INTERNAL;
    }
    return copy_allocated_string(mobi_meta_get_author(adapter->m), out, cap, needed);
}

int mobi_adapter_copy_language(mobi_adapter *adapter, char *out, size_t cap, size_t *needed) {
    if (adapter == NULL || adapter->m == NULL) {
        return MOBI_ADAPTER_ERR_INTERNAL;
    }
    return copy_allocated_string(mobi_meta_get_language(adapter->m), out, cap, needed);
}

static MOBIPdbRecord *cover_record(const MOBIData *m) {
    MOBIExthHeader *exth = mobi_get_exthrecord_by_tag(m, EXTH_COVEROFFSET);
    if (exth == NULL) {
        return NULL;
    }
    const uint32_t offset = mobi_decode_exthvalue(exth->data, exth->size);
    const size_t first_resource = mobi_get_first_resource_record(m);
    if (first_resource == MOBI_NOTSET || (uint64_t) first_resource + offset > SIZE_MAX) {
        return NULL;
    }
    return mobi_get_record_by_seqnumber(m, first_resource + offset);
}

static const char *cover_mime(const unsigned char *data, size_t size) {
    if (size >= 3 && data[0] == 0xff && data[1] == 0xd8 && data[2] == 0xff) {
        return "image/jpeg";
    }
    if (size >= 4 && memcmp(data, "GIF8", 4) == 0) {
        return "image/gif";
    }
    if (size >= 8 && memcmp(data, "\x89PNG\r\n\x1a\n", 8) == 0) {
        return "image/png";
    }
    if (size >= 2 && data[0] == 'B' && data[1] == 'M') {
        return "image/bmp";
    }
    if (size >= 12 && memcmp(data, "RIFF", 4) == 0 && memcmp(data + 8, "WEBP", 4) == 0) {
        return "image/webp";
    }
    return NULL;
}

int mobi_adapter_copy_cover(mobi_adapter *adapter, uint8_t *out, size_t cap, size_t *needed,
                            char *mime, size_t mime_cap) {
    if (adapter == NULL || adapter->m == NULL || needed == NULL) {
        return MOBI_ADAPTER_ERR_INTERNAL;
    }
    *needed = 0;
    MOBIPdbRecord *record = cover_record(adapter->m);
    const char *mime_type = NULL;
    if (record != NULL && record->size >= 4 && record->data != NULL) {
        mime_type = cover_mime(record->data, record->size);
    }
    if (mime_type == NULL) {
        if (mime != NULL && mime_cap > 0) {
            mime[0] = '\0';
        }
        return MOBI_ADAPTER_NO_COVER;
    }
    const size_t mime_len = strlen(mime_type);
    if (mime == NULL || mime_cap <= mime_len) {
        return MOBI_ADAPTER_ERR_BUFFER;
    }
    memcpy(mime, mime_type, mime_len + 1);
    *needed = record->size;
    if (out == NULL || cap < record->size) {
        return MOBI_ADAPTER_ERR_BUFFER;
    }
    memcpy(out, record->data, record->size);
    return MOBI_ADAPTER_OK;
}

int mobi_adapter_parse(mobi_adapter *adapter) {
    if (adapter == NULL || adapter->m == NULL) {
        return MOBI_ADAPTER_ERR_INTERNAL;
    }
    if (adapter->parsed) {
        return MOBI_ADAPTER_OK;
    }
    MOBIRawml *rawml = mobi_init_rawml(adapter->m);
    if (rawml == NULL) {
        return MOBI_ADAPTER_ERR_MEMORY;
    }
    /* Keep TOC/guide reconstruction; skip dictionary parsing; rebuild source. */
    const MOBI_RET ret = mobi_parse_rawml_opt(rawml, adapter->m, true, false, true);
    if (ret != MOBI_SUCCESS) {
        mobi_free_rawml(rawml);
        return map_mobi_ret(ret);
    }
    if (rawml->markup == NULL) {
        mobi_free_rawml(rawml);
        return MOBI_ADAPTER_ERR_PARSE;
    }
    adapter->rawml = rawml;
    adapter->parsed = 1;
    return MOBI_ADAPTER_OK;
}

static size_t list_count(const MOBIPart *part) {
    size_t count = 0;
    while (part != NULL) {
        count++;
        part = part->next;
    }
    return count;
}

static const MOBIPart *list_at(const MOBIPart *part, size_t index) {
    while (part != NULL && index > 0) {
        part = part->next;
        index--;
    }
    return part;
}

size_t mobi_adapter_part_count(const mobi_adapter *adapter, uint32_t kind) {
    if (adapter == NULL || adapter->rawml == NULL) {
        return 0;
    }
    switch (kind) {
        case MOBI_ADAPTER_PART_MARKUP:
            return list_count(adapter->rawml->markup);
        case MOBI_ADAPTER_PART_FLOW: {
            const size_t count = list_count(adapter->rawml->flow);
            /* The first flow part is the hidden full raw HTML source. */
            return count > 0 ? count - 1 : 0;
        }
        case MOBI_ADAPTER_PART_RESOURCE:
            return list_count(adapter->rawml->resources);
        default:
            return 0;
    }
}

int mobi_adapter_part_get(const mobi_adapter *adapter, uint32_t kind, size_t index,
                          mobi_adapter_part *out) {
    if (adapter == NULL || adapter->rawml == NULL || out == NULL) {
        return MOBI_ADAPTER_ERR_INTERNAL;
    }
    const MOBIPart *part = NULL;
    switch (kind) {
        case MOBI_ADAPTER_PART_MARKUP:
            part = list_at(adapter->rawml->markup, index);
            break;
        case MOBI_ADAPTER_PART_FLOW:
            part = list_at(adapter->rawml->flow, index + 1);
            break;
        case MOBI_ADAPTER_PART_RESOURCE:
            part = list_at(adapter->rawml->resources, index);
            break;
        default:
            return MOBI_ADAPTER_ERR_NOT_FOUND;
    }
    if (part == NULL) {
        return MOBI_ADAPTER_ERR_NOT_FOUND;
    }
    memset(out, 0, sizeof(*out));
    out->kind = kind;
    out->uid = (uint32_t) part->uid;
    out->size = (uint64_t) part->size;
    out->data = part->data;
    out->is_opf = (part->type == T_OPF) ? 1 : 0;
    const MOBIFileMeta meta = mobi_get_filemeta_by_type(part->type);
    snprintf(out->extension, sizeof(out->extension), "%s", meta.extension);
    snprintf(out->mime, sizeof(out->mime), "%s", meta.mime_type);
    return MOBI_ADAPTER_OK;
}

const char *mobi_adapter_version(void) {
    return mobi_version();
}
