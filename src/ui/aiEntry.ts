import type { AppEdition } from "../config/edition";

/** Pure visibility rule used by the toolbar and release-contract tests. */
export function shouldShowAiFoundationEntry(
  edition: AppEdition,
  view: "shelf" | "reader",
): boolean {
  return edition === "ai" && view === "reader";
}
