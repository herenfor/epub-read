import { describe, expect, it, vi } from "vitest";
import { parseHTML } from "linkedom";
import { detectArchiveReferences } from "../core/archiveReferences";
import type { Book } from "../core/types";
import { guessMediaType } from "../core/mime";
import { sanitizeChapter } from "./sanitize";
import { DEFAULT_SETTINGS } from "./settings";
import { ResourceServer } from "./resources";
import { installChapterMediaPlayback, type MediaResourceLease, type MediaResourceSource } from "./mediaPlayback";

const chapter = "OEBPS/Text/media.xhtml";
const audioPath = "OEBPS/Media/a?b#c%20.wav";
const markup = `<html><head></head><body><p>Before</p>
<audio autoplay="autoplay" src="../Media/a%3Fb%23c%2520.wav"></audio>
<video autoplay="autoplay" poster="../poster.png"><source src="../Media/clip.webm" type="video/webm"/>
<track src="../Media/captions.vtt" kind="subtitles" srclang="en"/></video>
<audio src="https://example.invalid/remote.mp3" data-reader-media-path="OEBPS/Media/fake.mp3"></audio><p>After</p></body></html>`;

function book(): Book {
  const entries = new Map([
    [chapter, new TextEncoder().encode(markup)], [audioPath, new Uint8Array([1, 2, 3])],
    ["OEBPS/Media/clip.webm", new Uint8Array([4, 5, 6])],
    ["OEBPS/Media/captions.vtt", new TextEncoder().encode("WEBVTT\n")], ["OEBPS/poster.png", new Uint8Array([7])],
  ]);
  const resources = new Map([...entries.keys()].map(path => [path, {
    path, data: new Uint8Array(0), loaded: false, mediaType: guessMediaType(path),
  }]));
  return {
    version: 3, opfPath: "OEBPS/content.opf", metadata: { title: "media", identifier: "test", language: "en" },
    manifest: new Map(), spine: [], guide: [], toc: [], fixedLayout: false, issues: [], drmProtected: false,
    resources, archiveReferences: detectArchiveReferences(entries),
    ensureResources: vi.fn(async paths => {
      for (const path of paths) {
        const resource = resources.get(path);
        if (resource) { resource.data = entries.get(path)!; resource.loaded = true; }
      }
    }),
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

function fixture(path = "clip.wav", tag = "audio") {
  const { document, window } = parseHTML(`<html><head></head><body><p>Before</p><${tag} controls data-reader-media-path="${path}"></${tag}><p>After</p></body></html>`);
  Object.defineProperties(window, { innerWidth: { value: 600, configurable: true }, innerHeight: { value: 800, configurable: true } });
  Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
  const media = document.querySelector(tag)! as unknown as HTMLMediaElement;
  media.getBoundingClientRect = () => ({ left: 20, top: 20, right: 320, bottom: 90, width: 300, height: 70 }) as DOMRect;
  media.canPlayType = vi.fn(() => "probably" as const);
  media.pause = vi.fn();
  media.load = vi.fn();
  media.play = vi.fn(async () => { media.dispatchEvent(new window.Event("play")); });
  return { doc: document as unknown as Document, media };
}

function resources() {
  const leases: Array<MediaResourceLease & { release: ReturnType<typeof vi.fn> }> = [];
  const source: MediaResourceSource = {
    resourceMediaType: () => "audio/wav",
    acquireResource: vi.fn(async path => {
      const lease = { url: `blob:test/${path}`, release: vi.fn() };
      leases.push(lease);
      return lease;
    }),
  };
  return { source, leases };
}

describe("embedded media playback", () => {
  it("defers media but prepares posters, keeps exact archive names, controls and blob-only CSP", async () => {
    const b = book();
    const server = new ResourceServer(b);
    const holder = await server.acquireChapter(chapter);
    expect(b.resources.get("OEBPS/poster.png")!.loaded).toBe(true);
    for (const path of [audioPath, "OEBPS/Media/clip.webm", "OEBPS/Media/captions.vtt"]) {
      expect(b.resources.get(path)!.loaded).toBe(false);
    }
    const output = await sanitizeChapter(markup, {
      basePath: chapter, archiveReferences: b.archiveReferences, strictXml: true,
      settings: DEFAULT_SETTINGS, urlFor: path => server.urlFor(path),
    });
    const { document } = parseHTML(output.html);
    const audio = document.querySelector("audio")!;
    expect(audio.getAttribute("data-reader-media-path")).toBe(audioPath);
    expect(audio.hasAttribute("src")).toBe(false);
    expect(audio.hasAttribute("controls")).toBe(true);
    expect(audio.hasAttribute("autoplay")).toBe(false);
    expect(audio.getAttribute("preload")).toBe("none");
    expect(document.querySelector("video")!.hasAttribute("playsinline")).toBe(true);
    expect(document.querySelector("video")!.getAttribute("controlslist")).toContain("nofullscreen");
    expect(document.querySelector("source")!.getAttribute("data-reader-media-path")).toBe("OEBPS/Media/clip.webm");
    expect(document.querySelector("track")!.getAttribute("data-reader-media-path")).toBe("OEBPS/Media/captions.vtt");
    expect(document.querySelectorAll("audio")[1].hasAttribute("data-reader-media-path")).toBe(false);
    const csp = document.querySelector('meta[http-equiv="Content-Security-Policy"]')!.getAttribute("content")!;
    expect(csp).toContain("media-src blob:");
    expect(csp).toContain("script-src 'none'; connect-src 'none'");
    expect(output.unresolvedResources).toEqual([]);
    expect(guessMediaType("captions.vtt")).toBe("text/vtt");
    server.releaseHolder(holder);
    server.revokeAll();
  });

  it("pins a requested entry until its decoder releases it, then allows byte-budget eviction", async () => {
    const b = book();
    const server = new ResourceServer(b, { mediaCacheMaxBytes: 1 });
    const lease = await server.acquireResource(audioPath);
    expect(lease.url).toMatch(/^blob:/);
    expect(b.resources.get(audioPath)!.loaded).toBe(true);
    expect(server.mediaCacheStats.overBudget).toBe(true);
    lease.release();
    lease.release();
    expect(b.resources.get(audioPath)!.loaded).toBe(false);
    expect(server.mediaCacheStats.holders).toBe(0);
    server.revokeAll();
    const pendingBook = book();
    const pending = deferred<void>();
    pendingBook.ensureResources = () => pending.promise;
    const closing = new ResourceServer(pendingBook);
    const late = closing.acquireResource(audioPath);
    closing.revokeAll();
    pending.resolve();
    await expect(late).rejects.toThrow();
    expect(closing.mediaCacheStats.holders).toBe(0);
    expect(closing.mediaCacheStats.urls).toBe(0);
  });

  it("loads only on request, collapses repeated clicks, and releases a late result after disposal", async () => {
    const { doc, media } = fixture();
    const { source } = resources();
    const pending = deferred<MediaResourceLease>();
    source.acquireResource = vi.fn(() => pending.promise);
    const originalText = doc.body.textContent;
    const controller = installChapterMediaPlayback(doc, source);
    expect(source.acquireResource).not.toHaveBeenCalled();
    expect(doc.body.textContent).toBe(originalText);
    const button = doc.querySelector("button")! as HTMLButtonElement;
    button.click();
    button.click();
    expect(source.acquireResource).toHaveBeenCalledTimes(1);
    controller.dispose();
    const release = vi.fn();
    pending.resolve({ url: "blob:late", release });
    await vi.waitFor(() => expect(release).toHaveBeenCalledOnce());
    expect(media.play).not.toHaveBeenCalled();
    expect(media.hasAttribute("src")).toBe(false);
  });

  it("shares one owner between chapter documents, stops off-page/background playback and detaches sources", async () => {
    const first = fixture("first.wav");
    const second = fixture("second.wav");
    const { source, leases } = resources();
    const a = installChapterMediaPlayback(first.doc, source);
    const b = installChapterMediaPlayback(second.doc, source);
    (first.doc.querySelector("button")! as HTMLButtonElement).click();
    await vi.waitFor(() => expect(first.media.play).toHaveBeenCalledOnce());
    (second.doc.querySelector("button")! as HTMLButtonElement).click();
    await vi.waitFor(() => expect(second.media.play).toHaveBeenCalledOnce());
    expect(first.media.pause).toHaveBeenCalledOnce();
    expect(leases[0].release).toHaveBeenCalledOnce();
    Object.defineProperty(second.doc, "visibilityState", { value: "hidden", configurable: true });
    second.doc.dispatchEvent(new second.doc.defaultView!.Event("visibilitychange"));
    expect(second.media.pause).toHaveBeenCalledOnce();
    expect(leases[1].release).toHaveBeenCalledOnce();
    Object.defineProperty(second.doc, "visibilityState", { value: "visible", configurable: true });
    (second.doc.querySelector("button")! as HTMLButtonElement).click();
    await vi.waitFor(() => expect(second.media.play).toHaveBeenCalledTimes(2));
    second.media.getBoundingClientRect = () => ({ left: 700, right: 1000, top: 20, bottom: 90 }) as DOMRect;
    b.stopIfOutsideViewport();
    expect(leases[2].release).toHaveBeenCalledOnce();
    a.dispose(); b.dispose();
  });

  it("offers retry for read errors and a new gesture after autoplay denial without loading a second copy", async () => {
    const { doc, media } = fixture();
    const { source } = resources();
    const acquire = vi.mocked(source.acquireResource);
    acquire.mockRejectedValueOnce(new Error("read failure"));
    const controller = installChapterMediaPlayback(doc, source);
    const button = doc.querySelector("button")! as HTMLButtonElement;
    button.click();
    await vi.waitFor(() => expect(button.getAttribute("aria-label")).toContain("retry"));
    vi.mocked(media.play).mockRejectedValueOnce(new DOMException("gesture required", "NotAllowedError"));
    button.click();
    await vi.waitFor(() => expect(button.getAttribute("aria-label")).toBe("Tap to play"));
    button.click();
    await vi.waitFor(() => expect(button.hidden).toBe(true));
    expect(acquire).toHaveBeenCalledTimes(2);
    expect(media.play).toHaveBeenCalledTimes(2);
    controller.dispose();
  });
});
