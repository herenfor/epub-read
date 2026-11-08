import { uiText } from "./localization/UiLanguageProvider";

/**
 * MOBI/AZW3 import and open failures that the user must be able to tell apart
 * (ER-0142). The UI projects only these kinds. The native error codes that map
 * onto them are frozen by ER-0141 and mapped at wiring time. Never infer a kind
 * from a Chinese message.
 */
export type KindleFailureKind =
  | "encrypted"
  | "unsupported-variant"
  | "corrupt"
  | "source-unavailable"
  | "cancelled"
  | "budget";

export interface KindleFailureNotice {
  /** Cancelling is the user's own choice, not an error. */
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
} as const satisfies Record<KindleFailureKind, string>;

export function kindleFailureNotice(failure: KindleFailureKind): KindleFailureNotice {
  return { kind: failure === "cancelled" ? "warn" : "error", text: uiText(KEYS[failure]) };
}
