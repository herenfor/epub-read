import { parseHTML } from "linkedom";
import { describe, expect, it, vi } from "vitest";
import type { Book } from "../core/types";
import { createChapterCountJob, type IdleScheduler } from "./chapterCountJob";

function book(): Book {
  return {
    version: 3,
    opfPath: "OEBPS/content.opf",
    metadata: { title: "test", identifier: "test", language: "zh" },
    manifest: new Map([
      ["a", { id: "a", href: "a.xhtml", mediaType: "application/xhtml+xml", properties: [] }],
      ["b", { id: "b", href: "b.xhtml", mediaType: "application/xhtml+xml", properties: [] }],
    ]),
    spine: [
      { idref: "a", linear: true },
      { idref: "b", linear: true },
      { idref: "missing", linear: false },
    ],
    guide: [],
    toc: [],
    resources: new Map(),
    fixedLayout: false,
    issues: [],
    drmProtected: false,
  };
}

function bookWithLinearChapters(count: number): Book {
  const result = book();
  const spine = Array.from({ length: count }, (_, index) => {
    const id = index < 2 ? (index === 0 ? "a" : "b") : `chapter-${index}`;
    if (index >= 2) {
      result.manifest.set(id, {
        id,
        href: `${id}.xhtml`,
        mediaType: "application/xhtml+xml",
        properties: [],
      });
    }
    return { idref: id, linear: true };
  });
  result.spine = spine;
  return result;
}

function scheduler(): { scheduler: IdleScheduler; runNext(): void; size(): number; options: Array<{ timeout?: number }> } {
  let next = 0;
  const pending = new Map<number, () => void>();
  const options: Array<{ timeout?: number }> = [];
  return {
    scheduler: {
      request(callback, requestOptions) {
        const id = ++next;
        pending.set(id, callback);
        options.push(requestOptions ?? {});
        return id;
      },
      cancel(id) {
        pending.delete(id);
      },
    },
    runNext() {
      const first = pending.keys().next().value as number | undefined;
      if (first === undefined) throw new Error("no idle callback");
      const callback = pending.get(first)!;
      pending.delete(first);
      callback();
    },
    size: () => pending.size,
    options,
  };
}

describe("incremental chapter count job", () => {
  it("does one chapter per slice and excludes structural hidden/footnote text", () => {
    const clock = scheduler();
    const current = vi.fn(() => true);
    const counts: Array<[number, number]> = [];
    const b = book();
    const texts = new Map([
      ["OEBPS/a.xhtml", '<p>甲😀乙</p><p hidden>隐藏</p><script>bad</script><aside epub:type="footnote">脚注</aside>'],
      ["OEBPS/b.xhtml", "第二章"],
    ]);
    createChapterCountJob({
      book: b,
      server: { textFor: (path) => texts.get(path) },
      generation: 4,
      maxPerSlice: 1,
      scheduler: clock.scheduler,
      isCurrent: current,
      parse: (text) => parseHTML(`<html><body>${text}</body></html>`).document as unknown as Document,
      onCount: (index, value) => counts.push([index, value]),
    });
    expect(clock.size()).toBe(1);
    expect(clock.options).toEqual([{ timeout: 100 }]);
    clock.runNext();
    expect(counts).toEqual([[0, 3]]);
    expect(clock.size()).toBe(1);
    clock.runNext();
    expect(counts).toEqual([[0, 3], [1, 3]]);
    expect(clock.size()).toBe(0);
  });

  it("keeps missing resources as error/unknown and aborts stale A→B work", () => {
    const clock = scheduler();
    const counts: Array<[number, number]> = [];
    let live = true;
    const job = createChapterCountJob({
      book: book(),
      server: { textFor: () => undefined },
      generation: 9,
      scheduler: clock.scheduler,
      isCurrent: () => live,
      onCount: (index, value) => counts.push([index, value]),
    });
    job.cancel();
    expect(clock.size()).toBe(0);
    expect(counts).toEqual([]);

    const second = createChapterCountJob({
      book: book(),
      server: { textFor: () => undefined },
      generation: 10,
      scheduler: clock.scheduler,
      isCurrent: () => live,
      onCount: (index, value) => counts.push([index, value]),
    });
    live = false;
    clock.runNext();
    expect(counts).toEqual([]);
    second.cancel();
  });

  it("turns parser failures into error/unknown plus a diagnostic issue", () => {
    const clock = scheduler();
    const issues: string[] = [];
    const counts: Array<[number, number]> = [];
    const errors: number[] = [];
    createChapterCountJob({
      book: book(),
      server: { textFor: () => "<broken>" },
      generation: 1,
      maxPerSlice: 1,
      scheduler: clock.scheduler,
      parse: () => { throw new Error("bad html"); },
      onCount: (index, value) => counts.push([index, value]),
      onError: (index) => errors.push(index),
      onIssue: (issue) => issues.push(issue),
    });
    clock.runNext();
    expect(counts).toEqual([]);
    expect(errors).toEqual([0]);
    expect(issues[0]).toContain("chapter 0");
  });

  it("gives a media-only chapter a bounded positive structural weight", () => {
    const clock = scheduler();
    const counts: Array<[number, number]> = [];
    const b = book();
    createChapterCountJob({
      book: b,
      server: { textFor: (path) => path.endsWith("a.xhtml") ? '<svg><image href="x"/></svg>' : "" },
      generation: 11,
      scheduler: clock.scheduler,
      maxPerSlice: 1,
      parse: (text) => parseHTML(`<html><body>${text}</body></html>`).document as unknown as Document,
      onCount: (index, value) => counts.push([index, value]),
    });
    clock.runNext();
    expect(counts).toEqual([[0, 1000]]);
  });

  it("counts from the same self-closing normalization as the rendered chapter", () => {
    // Real Chrome/WebView2 154 parses this raw markup as text/html with an
    // empty body (text 0, media 0); XML and the normalized markup keep it.
    // linkedom does not swallow the body, so assert what the parser receives.
    const clock = scheduler();
    const counts: Array<[number, number]> = [];
    const seen: string[] = [];
    const raw = '<html xmlns="http://www.w3.org/1999/xhtml"><head><title>p-003</title>' +
      '<link rel="stylesheet" href="a.css"/><script type="text/javascript" src="../Misc/a.js"/></head>' +
      '<body><p>彩页说明</p><img src="p.jpg" alt=""/><span/>后续</body></html>';
    createChapterCountJob({
      book: book(),
      server: { textFor: (path) => path.endsWith("a.xhtml") ? raw : "第二章" },
      generation: 13,
      maxPerSlice: 1,
      scheduler: clock.scheduler,
      parse: (text) => {
        seen.push(text);
        return parseHTML(text).document as unknown as Document;
      },
      onCount: (index, value) => counts.push([index, value]),
    });
    clock.runNext();
    expect(seen[0]).toContain('<script type="text/javascript" src="../Misc/a.js"></script>');
    expect(seen[0]).toContain("<span></span>后续");
    // Void elements keep their original form.
    expect(seen[0]).toContain('<link rel="stylesheet" href="a.css"/>');
    expect(seen[0]).toContain('<img src="p.jpg" alt=""/>');
    expect(counts).toEqual([[0, 6]]);
  });

  it("skips cached chapters and submits one bounded batch per default slice", () => {
    const clock = scheduler();
    const batches: Array<Array<[number, number]>> = [];
    const b = bookWithLinearChapters(6);
    createChapterCountJob({
      book: b,
      server: { textFor: () => "正文" },
      generation: 12,
      scheduler: clock.scheduler,
      parse: (text) => parseHTML(`<html><body>${text}</body></html>`).document as unknown as Document,
      skipIndices: new Set([0]),
      onCount: () => undefined,
      onCounts: (values) => batches.push(values),
    });
    expect(clock.options).toEqual([{ timeout: 100 }]);
    clock.runNext();
    expect(batches).toEqual([[[1, 2], [2, 2], [3, 2], [4, 2]]]);
    expect(clock.size()).toBe(1);
    clock.runNext();
    expect(batches).toEqual([[[1, 2], [2, 2], [3, 2], [4, 2]], [[5, 2]]]);
    expect(clock.size()).toBe(0);
  });
});
