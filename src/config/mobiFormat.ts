declare const __MOBI_FORMAT__: boolean;

/**
 * Build switch for MOBI (MOBI6) books (ER-0150). Off by default until the
 * MOBI6 layout issues are fixed; `VITE_MOBI_FORMAT=on` restores the entry.
 * AZW3 (KF8) is not behind this switch. Off only hides the `.mobi` import
 * entry points and refuses to open: the converter, stored records and save
 * data stay untouched, so turning it back on is enough.
 */
export const MOBI_FORMAT_ENABLED: boolean = typeof __MOBI_FORMAT__ !== "undefined" && __MOBI_FORMAT__ === true;
