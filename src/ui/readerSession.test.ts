import { describe, expect, it } from "vitest";
import {
  INITIAL_READER_SESSION,
  reduceReaderSession,
  type ReaderSessionEvent,
  type ReaderSessionFlags,
} from "./readerSession";

const ALL_FALSE: ReaderSessionFlags = {
  displayReady: false, displayedOnce: false, navigationPending: false, historyCaptureAllowed: false, suppressProgress: false,
};
const ALL_TRUE: ReaderSessionFlags = {
  displayReady: true, displayedOnce: true, navigationPending: true, historyCaptureAllowed: true, suppressProgress: true,
};

// 每个事件写哪些标志、写成什么；没列出的标志必须原样保留。与 App 现有成组写入逐条对应。
const WRITES: Record<ReaderSessionEvent["type"], Partial<ReaderSessionFlags>> = {
  "open": { displayReady: false, displayedOnce: false, navigationPending: true, historyCaptureAllowed: true },
  "display-ready": { displayReady: true, displayedOnce: true, navigationPending: false, historyCaptureAllowed: true, suppressProgress: false },
  "navigation-unresolved": { displayReady: true, navigationPending: false, historyCaptureAllowed: true, suppressProgress: true },
  "user-position-committed": { suppressProgress: false },
  "begin-explicit": { displayReady: false, navigationPending: true, historyCaptureAllowed: false },
  "begin-scrub": { navigationPending: true, historyCaptureAllowed: false },
  "scrub-local-settled": { navigationPending: false, historyCaptureAllowed: true },
  "scrub-reader-settled": { displayReady: true, navigationPending: false, historyCaptureAllowed: true },
  "scrub-reader-aborted": { navigationPending: false },
  "history-captured": { historyCaptureAllowed: false },
  "direct-settled": { displayReady: true, historyCaptureAllowed: true },
  "leave": { displayReady: false, displayedOnce: false, navigationPending: false, historyCaptureAllowed: true },
};

describe("reader session flags (B3)", () => {
  it.each(Object.entries(WRITES))("%s writes only its own flags", (type, writes) => {
    const event = { type } as ReaderSessionEvent;
    expect(reduceReaderSession(ALL_FALSE, event)).toEqual({ ...ALL_FALSE, ...writes });
    expect(reduceReaderSession(ALL_TRUE, event)).toEqual({ ...ALL_TRUE, ...writes });
  });

  it("keeps the intentional variants of the current code", () => {
    const reading = reduceReaderSession(reduceReaderSession(INITIAL_READER_SESSION, { type: "open" }), { type: "display-ready" });
    // 拖动不让正文失去就绪，快捷键与同章直达照常可用。
    expect(reduceReaderSession(reading, { type: "begin-scrub" }).displayReady).toBe(true);
    // 阅读器异步取消/失败只清“导航中”，记历史等下一次就绪或本地结算恢复。
    const aborted = reduceReaderSession(reduceReaderSession(reading, { type: "begin-scrub" }), { type: "scrub-reader-aborted" });
    expect(aborted).toMatchObject({ navigationPending: false, historyCaptureAllowed: false });
    // 开书时允许记历史，首个跳转自己捕获开书位置。
    expect(reduceReaderSession(INITIAL_READER_SESSION, { type: "open" })).toMatchObject({ navigationPending: true, historyCaptureAllowed: true });
  });

  it("guards progress after an unresolved anchor until the reader really moves or redisplays", () => {
    const unresolved = reduceReaderSession(INITIAL_READER_SESSION, { type: "navigation-unresolved" });
    expect(unresolved.suppressProgress).toBe(true);
    const afterJump = reduceReaderSession(unresolved, { type: "begin-explicit" });
    expect(afterJump.suppressProgress).toBe(true);
    expect(reduceReaderSession(afterJump, { type: "display-ready" }).suppressProgress).toBe(false);
    expect(reduceReaderSession(unresolved, { type: "user-position-committed" }).suppressProgress).toBe(false);
  });
});
