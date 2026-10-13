import { uiText } from "./localization/UiLanguageProvider";

/** Native commands may reject with a string rather than an Error. */
export function bookOpenErrorMessage(error: unknown): string {
  if (typeof error === "string" && error.trim()) return error;
  if (typeof error === "object" && error !== null &&
      "message" in error && typeof error.message === "string" && error.message.trim()) {
    return error.message;
  }
  return uiText("notice.openFailure.noReason");
}

// Machine codes from the source commands' {code, message} rejection (C3a).
// Only these codes decide the notice; the backend message is never parsed.
const SOURCE_FAILURES = {
  "source-unbound": { key: "notice.openFailure.unbound", sourceUnavailable: true },
  "source-missing": { key: "notice.openFailure.missing", sourceUnavailable: true },
  "source-changed": { key: "notice.openFailure.changed", sourceUnavailable: true },
  "source-unavailable": { key: "notice.openFailure.unavailable", sourceUnavailable: true },
  "relink-mismatch": { key: "notice.openFailure.relinkMismatch", sourceUnavailable: false },
} as const;

function sourceFailureCode(error: unknown): keyof typeof SOURCE_FAILURES | null {
  if (typeof error !== "object" || error === null || !("code" in error)) return null;
  const { code } = error;
  return typeof code === "string" && Object.hasOwn(SOURCE_FAILURES, code)
    ? code as keyof typeof SOURCE_FAILURES
    : null;
}

export function describeBookOpenFailure(error: unknown): {
  message: string;
  sourceUnavailable: boolean;
} {
  const code = sourceFailureCode(error);
  if (code) {
    const failure = SOURCE_FAILURES[code];
    return { message: uiText(failure.key), sourceUnavailable: failure.sourceUnavailable };
  }
  // `failed`, unknown codes, repository, permission and transient IPC errors
  // are not proof of a lost source.
  return { message: bookOpenErrorMessage(error), sourceUnavailable: false };
}
