import { MOBI_FORMAT_ENABLED } from "../config/mobiFormat";
import { mobiBookName } from "../core/documentFormats";
import { uiText } from "./localization/UiLanguageProvider";

/**
 * MOBI/AZW3 import and open failures that the user must be able to tell apart.
 * Only the native `mobi.*` machine codes decide the kind (plan §12.3); the
 * backend's Chinese detail is never parsed.
 */
export type KindleFailureKind =
  | "encrypted"
  | "unsupported-variant"
  | "corrupt"
  | "source-unavailable"
  | "cancelled"
  | "budget"
  /** ER-0150: this build has MOBI (MOBI6) switched off. */
  | "disabled";

export interface KindleFailureNotice {
  /** Cancelling is not an error. */
  readonly kind: "warn" | "error";
  readonly text: string;
}

const KEYS = {
  "encrypted": "notice.kindle.encrypted",
  "unsupported-variant": "notice.kindle.unsupportedVariant",
  "corrupt": "notice.kindle.corrupt",
  "source-unavailable": "notice.kindle.sourceUnavailable",
  "cancelled": "notice.kindle.cancelled",
  "budget": "notice.kindle.budget",
  "disabled": "notice.kindle.mobiDisabled",
} as const satisfies Record<KindleFailureKind, string>;

// mobi.output / mobi.memory / mobi.internal stay unmapped: they keep the
// generic failure text with the raw detail.
const CODES: Readonly<Record<string, KindleFailureKind>> = {
  "mobi.encrypted": "encrypted",
  "mobi.dictionary": "unsupported-variant",
  "mobi.replica": "unsupported-variant",
  "mobi.unsupported": "unsupported-variant",
  "mobi.parse": "corrupt",
  "mobi.no_opf": "corrupt",
  "mobi.io": "source-unavailable",
  "mobi.source": "source-unavailable",
  "mobi.budget": "budget",
  "mobi.cancelled": "cancelled",
  "mobi.disabled": "disabled",
};

export function kindleFailureKind(code: unknown): KindleFailureKind | null {
  return typeof code === "string" && Object.hasOwn(CODES, code) ? CODES[code] : null;
}

/** Open failures carry `{code, message}`; the code alone decides. */
export function kindleOpenFailureKind(error: unknown): KindleFailureKind | null {
  if (typeof error !== "object" || error === null || !("code" in error)) return null;
  return kindleFailureKind(error.code);
}

/** Import items carry `"mobi.<code>: <detail>"`; classify by the prefix before the first ": ". */
export function kindleImportFailureKind(error: string | null | undefined): KindleFailureKind | null {
  if (!error) return null;
  const end = error.indexOf(": ");
  return end > 0 ? kindleFailureKind(error.slice(0, end)) : null;
}

export function kindleFailureNotice(failure: KindleFailureKind): KindleFailureNotice {
  return { kind: failure === "cancelled" || failure === "disabled" ? "warn" : "error", text: uiText(KEYS[failure]) };
}

/** Copying the file cannot fix these, so an "import as copy" retry is not offered. */
export function kindleFailureIsFileProblem(failure: KindleFailureKind): boolean {
  return failure !== "source-unavailable" && failure !== "cancelled";
}

/** ER-0150: true when this build has MOBI off and the file is `.mobi`. AZW3 always opens. */
export function mobiBookBlocked(fileName: string, mobi: boolean = MOBI_FORMAT_ENABLED): boolean {
  return !mobi && mobiBookName(fileName);
}

