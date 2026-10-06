import { describe, expect, it } from "vitest";
import {
  beginRestoreCommit,
  mayCommitRestoredProgress,
  reduceRestoreCommit,
  type RestoreTicket,
} from "./restoreCommitGate";
import { hasSemanticRestoreTarget, type ReadingAnchor } from "../render/paginator";

const ticket: RestoreTicket = { session: 1, request: 1, chapterPath: "a.xhtml" };

describe("restore commit gate", () => {
  it("a located target may write once displayed; an unresolved one may not, even after display-ready", () => {
    let located = reduceRestoreCommit(beginRestoreCommit(ticket), { type: "resolved", ticket, located: true });
    expect(mayCommitRestoredProgress(located)).toBe(false);
    located = reduceRestoreCommit(located, { type: "display-ready", ticket });
    expect(mayCommitRestoredProgress(located)).toBe(true);

    let failed = reduceRestoreCommit(beginRestoreCommit(ticket), { type: "resolved", ticket, located: false });
    failed = reduceRestoreCommit(failed, { type: "display-ready", ticket });
    expect(mayCommitRestoredProgress(failed)).toBe(false);
    // A late success for the same restore cannot rewrite the settled failure.
    failed = reduceRestoreCommit(failed, { type: "resolved", ticket, located: true });
    expect(mayCommitRestoredProgress(failed)).toBe(false);
  });

  it("an old request's callbacks cannot unlock a newer request", () => {
    const newer: RestoreTicket = { ...ticket, request: 2 };
    let state = beginRestoreCommit(newer);
    state = reduceRestoreCommit(state, { type: "resolved", ticket, located: true });
    state = reduceRestoreCommit(state, { type: "display-ready", ticket });
    state = reduceRestoreCommit(state, { type: "user-position-committed", ticket });
    expect(state.phase).toBe("resolving");
    expect(mayCommitRestoredProgress(state)).toBe(false);
  });

  it("only a real user commit after display releases a failed restore", () => {
    let state = reduceRestoreCommit(beginRestoreCommit(ticket), { type: "resolved", ticket, located: false });
    state = reduceRestoreCommit(state, { type: "user-position-committed", ticket });
    expect(mayCommitRestoredProgress(state)).toBe(false); // not displayed yet
    state = reduceRestoreCommit(state, { type: "display-ready", ticket });
    state = reduceRestoreCommit(state, { type: "user-position-committed", ticket });
    expect(mayCommitRestoredProgress(state)).toBe(true);
  });

  it("treats only text/element/media targets as semantic", () => {
    const base = { index: -1, ratio: 0, charsRead: 0, totalChars: 0, textOffset: null, textSnippet: null } as unknown as ReadingAnchor;
    expect(hasSemanticRestoreTarget(null)).toBe(false);
    expect(hasSemanticRestoreTarget(base)).toBe(false);
    expect(hasSemanticRestoreTarget({ ...base, textOffset: 301 })).toBe(true);
    expect(hasSemanticRestoreTarget({ ...base, index: 12 })).toBe(true);
  });
});
