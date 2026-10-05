import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { DEFAULT_SETTINGS } from "./settings";

const { sanitizeMock } = vi.hoisted(() => ({ sanitizeMock: vi.fn() }));

vi.mock("./sanitize", () => ({
  VIEWER_ID: "epub-viewer",
  sanitizeChapter: sanitizeMock,
}));

import { ChapterPaginator } from "./paginator";

function fakeStyle(): CSSStyleDeclaration {
  const values = new Map<string, string>();
  const priorities = new Map<string, string>();
  return {
    getPropertyValue: (name: string) => values.get(name) ?? "",
    getPropertyPriority: (name: string) => priorities.get(name) ?? "",
    setProperty: (name: string, value: string, priority = "") => {
      values.set(name, value);
      priorities.set(name, priority);
    },
    removeProperty: (name: string) => {
      values.delete(name);
      priorities.delete(name);
      return "";
    },
  } as unknown as CSSStyleDeclaration;
}

function fakeIframe(): HTMLIFrameElement {
  const listeners = new Map<string, EventListener>();
  return {
    style: fakeStyle(),
    src: "about:blank",
    clientWidth: 800,
    clientHeight: 600,
    addEventListener(name: string, listener: EventListener) {
      listeners.set(name, listener);
    },
    removeEventListener(name: string, listener: EventListener) {
      if (listeners.get(name) === listener) listeners.delete(name);
    },
    contentDocument: null,
  } as unknown as HTMLIFrameElement;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("ChapterPaginator CSS Blob URL lifecycle", () => {
  let nextUrl = 0;
  let create: { mockRestore(): void };
  let revoke: { mockRestore(): void };

  beforeEach(() => {
    vi.stubGlobal("window", { clearTimeout: (id: number) => clearTimeout(id) });
    nextUrl = 0;
    create = vi.spyOn(URL, "createObjectURL").mockImplementation(
      () => `blob:test/${++nextUrl}`
    );
    revoke = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    sanitizeMock.mockReset();
    sanitizeMock.mockImplementation(async (_html: string, opts: { makeUrl?: (text: string, mediaType: string) => string }) => {
      opts.makeUrl?.("rewritten css", "text/css");
      return { html: "<html><body><epub-viewer id='epub-viewer'/></body></html>", issues: [], downgraded: false };
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    create.mockRestore();
    revoke.mockRestore();
  });

  function makePaginator(serverOverrides: Record<string, unknown> = {}) {
    const server = {
      textFor: () => "<html><body>chapter</body></html>",
      revokeAll: vi.fn(),
      ...serverOverrides,
    };
    const iframe = fakeIframe();
    const paginator = new ChapterPaginator(
      iframe,
      server as never,
      DEFAULT_SETTINGS,
      true,
      vi.fn()
    );
    return { paginator, server, iframe };
  }

  it("成功换章和 dispose 分别撤销当前/上一章 CSS URL，且不调用 ResourceServer revokeAll", async () => {
    const { paginator, server } = makePaginator();
    await paginator.load("chapter-a.xhtml");
    expect(revoke).not.toHaveBeenCalledWith("blob:test/1");

    await paginator.load("chapter-b.xhtml");
    expect(revoke).toHaveBeenCalledWith("blob:test/1");
    expect(revoke).toHaveBeenCalledWith("blob:test/2");
    expect(server.revokeAll).not.toHaveBeenCalled();

    paginator.dispose();
    expect(revoke).toHaveBeenCalledWith("blob:test/3");
    expect(revoke).toHaveBeenCalledWith("blob:test/4");
    expect(revoke).toHaveBeenCalledTimes(4);
    expect(server.revokeAll).not.toHaveBeenCalled();
  });

  it("sanitize 抛错时撤销已创建的局部 CSS URL，不留下 HTML URL", async () => {
    sanitizeMock.mockImplementationOnce(async (_html: string, opts: { makeUrl?: (text: string, mediaType: string) => string }) => {
      opts.makeUrl?.("failed css", "text/css");
      throw new Error("sanitize failed");
    });
    const { paginator, iframe } = makePaginator();
    await paginator.load("failed.xhtml");
    expect(revoke).toHaveBeenCalledTimes(1);
    expect(revoke).toHaveBeenCalledWith("blob:test/1");
    expect(iframe.style.getPropertyValue("visibility")).toBe("");
    paginator.dispose();
    expect(revoke).toHaveBeenCalledTimes(1);
  });

  it("旧任务过期时不 release 新 load 的 VisibilityGate 代次", async () => {
    const first = deferred<{ html: string; issues: string[]; downgraded: boolean }>();
    sanitizeMock.mockImplementationOnce(async (_html: string, opts: { makeUrl?: (text: string, mediaType: string) => string }) => {
      opts.makeUrl?.("stale css", "text/css");
      return first.promise;
    });
    const { paginator, iframe } = makePaginator();
    const staleLoad = paginator.load("stale.xhtml");
    await Promise.resolve();
    await paginator.load("current.xhtml");
    first.resolve({ html: "<html/>", issues: [], downgraded: false });
    await staleLoad;
    expect(iframe.style.getPropertyValue("visibility")).toBe("hidden");
    paginator.dispose();
  });

  it("过期 acquireChapter 取得的 holder 由原 server 释放", async () => {
    const gate = deferred<number>();
    const acquireChapter = vi.fn()
      .mockImplementationOnce(() => gate.promise)
      .mockImplementation(() => Promise.resolve(2));
    const releaseHolder = vi.fn();
    const { paginator } = makePaginator({ acquireChapter, releaseHolder });

    const staleLoad = paginator.load("stale.xhtml");
    expect(acquireChapter).toHaveBeenCalledWith("stale.xhtml");
    await paginator.load("current.xhtml");
    gate.resolve(1);
    await staleLoad;
    expect(releaseHolder).toHaveBeenCalledWith(1);
    paginator.dispose();
  });

  it("loadSeq 过期时撤销旧任务的局部 CSS URL，并保留新章 URL 到 dispose", async () => {
    const first = deferred<{ html: string; issues: string[]; downgraded: boolean }>();
    sanitizeMock.mockImplementationOnce(async (_html: string, opts: { makeUrl?: (text: string, mediaType: string) => string }) => {
      opts.makeUrl?.("stale css", "text/css");
      return first.promise;
    });
    const { paginator } = makePaginator();
    const staleLoad = paginator.load("stale.xhtml");
    await Promise.resolve();
    await paginator.load("current.xhtml");
    expect(revoke).toHaveBeenCalledWith("blob:test/1");
    first.resolve({ html: "<html/>", issues: [], downgraded: false });
    await staleLoad;
    // current chapter created CSS URL #2 and HTML URL #3; stale completion
    // cannot revoke or replace them.
    expect(revoke).not.toHaveBeenCalledWith("blob:test/2");
    paginator.dispose();
    expect(revoke).toHaveBeenCalledWith("blob:test/2");
    expect(revoke).toHaveBeenCalledWith("blob:test/3");
  });
});
