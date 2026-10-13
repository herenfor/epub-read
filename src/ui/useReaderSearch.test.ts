import { createElement } from "react";
import { describe, expect, it, vi } from "vitest";
import type { Book } from "../core/types";
import type { SearchQueryOptions, SearchResult, SearchSession } from "../core/search";
import type { ResourceServer } from "../render/resources";
import type { CompiledTextProjection } from "../render/textProjection/compile";
import { createReactDomHarness } from "../test/reactDomHarness";
import { useReaderSearchView, useReaderSearchState, useReaderSearchRefs,
  useReaderSearchSession, useReaderSearchQuery, useReaderSearchPanel } from "./useReaderSearch";

const ports = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock("../render/textProjection/displaySearch", () => ({ createTextSearchSession: ports.create }));

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}
const hit: SearchResult = {
  spineIndex: 1, chapterPath: "c.xhtml", chapterTitle: "Chapter", snippet: "Alice",
  snippetMatchRanges: [{ start: 0, end: 5 }], originalRange: { start: 20, end: 25 },
  textOffset: 20, textSnippet: "Alice", matchedText: "Alice", matchType: "phrase",
};
function setup() {
  const dom = createReactDomHarness();
  vi.useFakeTimers();
  const requests: Array<ReturnType<typeof deferred<SearchResult[]>> & { options: SearchQueryOptions }> = [];
  const sessions: Array<SearchSession & { search: ReturnType<typeof vi.fn>; dispose: ReturnType<typeof vi.fn> }> = [];
  ports.create.mockReset().mockImplementation(() => {
    const session = {
      search: vi.fn((_query: string, options: SearchQueryOptions) => {
        const request = { ...deferred<SearchResult[]>(), options };
        requests.push(request);
        return request.promise;
      }), dispose: vi.fn(),
    };
    sessions.push(session);
    return session;
  });
  let context = {
    view: "reader" as "reader" | "shelf", searchOpen: true,
    book: { fixedLayout: false, spine: [{ linear: true }, { linear: false }, { linear: true }] } as Book,
    server: {} as ResourceServer, compiledTextProjection: null as CompiledTextProjection | null,
  };
  function useHost() {
    const searchView = useReaderSearchView();
    const state = useReaderSearchState();
    const refs = useReaderSearchRefs();
    const options = { ...context, ...searchView, ...state, ...refs };
    useReaderSearchSession(options);
    useReaderSearchQuery(options);
    const panel = useReaderSearchPanel(options);
    return { ...searchView, ...state, ...refs, ...panel };
  }
  let api!: ReturnType<typeof useHost>;
  function Host() { api = useHost(); return createElement("div", {}, api.searchStatus); }
  return { dom, requests, sessions, current: () => api,
    render: () => dom.render(createElement(Host)),
    change: async (next: Partial<typeof context>) => { context = { ...context, ...next }; await dom.render(createElement(Host)); },
    advance: (ms: number) => dom.run(async () => { await vi.advanceTimersByTimeAsync(ms); }),
    dispose: async () => { await dom.dispose(); vi.useRealTimers(); },
  };
}

describe("current-book search host extraction", () => {
  it("cancels immediately on input, debounces only new work and ignores late completion/progress", async () => {
    const t = setup();
    try {
      await t.render();
      expect(t.sessions[0].search).not.toHaveBeenCalled();
      await t.dom.run(() => t.current().setSearchQuery(" Alice "));
      await t.advance(179);
      expect(t.sessions[0].search).not.toHaveBeenCalled();
      await t.advance(1);
      const first = t.requests[0];
      expect(t.sessions[0].search.mock.calls[0][0]).toBe("Alice");
      expect(first.options.maxResults).toBe(101);
      await t.dom.run(() => t.current().setSearchQuery("Rabbit"));
      expect(first.options.signal!.aborted).toBe(true);
      await t.advance(180);
      const second = t.requests[1];
      await t.dom.run(() => { first.options.onProgress!({ completed: 2, total: 2, spineIndex: 1 }); first.resolve([hit]); });
      expect(t.current().searchResults).toEqual([]);
      expect(t.current().searchProgress).toEqual({ processed: 0, total: 2 });
      expect(t.current().searchAbortRef.current!.signal).toBe(second.options.signal);
      await t.dom.run(() => { second.options.onProgress!({ completed: 1, total: 2, spineIndex: 0 }); second.resolve([hit]); });
      expect(t.current().searchStatus).toBe("complete");
      expect(t.current().searchResults).toEqual([hit]);
      expect(t.current().searchPanelResults[0].id).toBe("1:20:25:-1:-1:phrase");
    } finally { await t.dispose(); }
  });

  it("retains the session across panel closure but disposes it on projection change and book exit", async () => {
    const t = setup();
    try {
      await t.render();
      await t.dom.run(() => t.current().setSearchQuery("Alice"));
      await t.advance(180);
      await t.change({ searchOpen: false });
      expect(t.requests[0].options.signal!.aborted).toBe(true);
      expect(t.sessions[0].dispose).not.toHaveBeenCalled();
      await t.change({ searchOpen: true });
      await t.advance(180);
      expect(t.sessions).toHaveLength(1);
      const projection = { version: "projection-1" } as CompiledTextProjection;
      await t.change({ compiledTextProjection: projection });
      expect(t.requests[1].options.signal!.aborted).toBe(true);
      expect(t.sessions[0].dispose).toHaveBeenCalledTimes(1);
      expect(ports.create.mock.calls[1][2]).toBe(projection);
      await t.dom.run(() => t.current().handleSearchViewChange("original"));
      expect(t.sessions[1].dispose).toHaveBeenCalledTimes(1);
      expect(ports.create.mock.calls[2][2]).toBeNull();
      await t.change({ view: "shelf" });
      expect(t.sessions[2].dispose).toHaveBeenCalledTimes(1);
      expect(t.current().searchSessionRef.current).toBeNull();
      expect(t.current().searchStatus).toBe("idle");
      await t.change({ view: "reader", book: { fixedLayout: true, spine: [] } as unknown as Book });
      expect(t.sessions).toHaveLength(3);
    } finally { await t.dispose(); }
  });

  it("keeps cancel and view-change resets distinct, without restarting a cancelled query on re-render", async () => {
    const t = setup();
    try {
      await t.render();
      await t.dom.run(() => t.current().setSearchQuery("Alice"));
      await t.advance(180);
      await t.dom.run(() => t.requests[0].reject(new Error("failed")));
      expect(t.current().searchStatus).toBe("error");
      const cancel = t.current().handleSearchCancel;
      await t.dom.run(cancel);
      expect(t.current().searchStatus).toBe("idle");
      expect(t.current().searchError).toBe("Error: failed");
      await t.render();
      await t.advance(400);
      expect(t.requests).toHaveLength(1);
      expect(t.current().handleSearchCancel).toBe(cancel);
      await t.dom.run(() => t.current().handleSearchViewChange("original"));
      expect(t.current().searchError).toBeUndefined();
      await t.advance(180);
      const pending = t.requests[1];
      await t.dom.run(cancel);
      expect(pending.options.signal!.aborted).toBe(true);
      await t.dom.run(() => pending.resolve([hit]));
      expect(t.current().searchResults).toEqual([]);
    } finally { await t.dispose(); }
  });
});
