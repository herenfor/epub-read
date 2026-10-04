import { describe, it, expect, vi } from "vitest";
import { zipSync, strToU8 } from "fflate";
import {
  ArchiveClosedError,
  SelectiveEpubArchive,
  WorkerArchiveClient,
  takeArchiveBatch,
  outputTransferList,
} from "./selectiveArchive";
import { ChapterPreparationRegistry } from "../render/chapterPreparation";

describe("SelectiveEpubArchive & ArchiveClient", () => {
  function makeMockEpub(): Uint8Array {
    return zipSync({
      mimetype: strToU8("application/epub+zip"),
      "META-INF/container.xml": strToU8(
        '<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>'
      ),
      "OEBPS/content.opf": strToU8(
        '<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0"><metadata></metadata><manifest><item id="c1" href="ch1.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="c1"/></spine></package>'
      ),
      "OEBPS/ch1.xhtml": strToU8("<html xmlns=\"http://www.w3.org/1999/xhtml\"><body>Hello</body></html>"),
      "OEBPS/large-image.jpg": new Uint8Array(1024 * 100), // 100KB mock image
    });
  }

  it("正确读取目录，且不提前解压未请求的资源", () => {
    const bytes = makeMockEpub();
    const archive = new SelectiveEpubArchive(bytes);

    expect(archive.directory.has("mimetype")).toBe(true);
    expect(archive.directory.has("META-INF/container.xml")).toBe(true);
    expect(archive.directory.has("OEBPS/ch1.xhtml")).toBe(true);
    expect(archive.directory.has("OEBPS/large-image.jpg")).toBe(true);

    // 仅解压指定路径
    const extracted = archive.extract(["OEBPS/ch1.xhtml"]);
    expect(extracted.has("OEBPS/ch1.xhtml")).toBe(true);
    // 未请求的资源不出现在提取结果中
    expect(extracted.has("OEBPS/large-image.jpg")).toBe(false);

    archive.close();
  });

  it("请求不存在的资源时应抛出明确错误", () => {
    const bytes = makeMockEpub();
    const archive = new SelectiveEpubArchive(bytes);

    expect(() => archive.extract(["OEBPS/non-existent.xhtml"])).toThrow(/EPUB 资源不存在/);
    archive.close();
  });

  it("mimetype 内容非法时应拒绝加载", () => {
    const brokenBytes = zipSync({
      mimetype: strToU8("text/plain"),
      "META-INF/container.xml": strToU8("<xml/>"),
    });
    expect(() => new SelectiveEpubArchive(brokenBytes)).toThrow(/mimetype 内容错误/);
  });

  it("takeArchiveBatch 依据展开字节预算分批", () => {
    const bytes = makeMockEpub();
    const archive = new SelectiveEpubArchive(bytes);

    // 预算设为 50KB，遇到 100KB 的大图片应作为独立批次
    const batch1 = takeArchiveBatch(["OEBPS/ch1.xhtml", "OEBPS/large-image.jpg"], archive.directory, 500);
    expect(batch1).toEqual(["OEBPS/ch1.xhtml"]);

    const batch2 = takeArchiveBatch(["OEBPS/large-image.jpg"], archive.directory, 500);
    expect(batch2).toEqual(["OEBPS/large-image.jpg"]);

    archive.close();
  });

  it("outputTransferList 对输出 buffer 去重", () => {
    const u1 = new Uint8Array([1, 2, 3]);
    const u2 = new Uint8Array([4, 5, 6]);
    const map = new Map<string, Uint8Array>([
      ["a", u1],
      ["b", u2],
      ["c", new Uint8Array(u1.buffer, 1, 1)], // 共享同一 ArrayBuffer
    ]);
    const list = outputTransferList(map);
    expect(list.length).toBe(2);
  });
});

describe("ChapterPreparationRegistry", () => {
  it("同一目标复用 pending 并提升优先级", async () => {
    const released: string[] = [];
    const registry = new ChapterPreparationRegistry<string>((val) => released.push(val));

    let prepareCount = 0;
    let finishPrepare!: (val: string) => void;
    const preparePromise = new Promise<string>((resolve) => {
      finishPrepare = resolve;
    });

    const p1 = registry.request("ch1.xhtml", 2, (ctx) => {
      prepareCount++;
      return preparePromise.then((val) => {
        expect(ctx.priority()).toBe(0); // 应该已被提升为 0
        return val;
      });
    });

    // 等待 microtask 触发 prepare 执行
    await Promise.resolve();

    // 此时前台以高优先级 0 再次请求同一章节
    const p2 = registry.request("ch1.xhtml", 0, () => Promise.resolve("other"));

    // 复用同一个 Promise，不触发第二次 prepare
    expect(prepareCount).toBe(1);
    expect(p1).toBe(p2);

    finishPrepare("done-ch1");
    const result = await p1;
    expect(result).toBe("done-ch1");
    expect(registry.isReady("ch1.xhtml")).toBe(true);
  });

  it("已失效/取消的准备任务晚到结果会被 release 释放", async () => {
    const released: string[] = [];
    const registry = new ChapterPreparationRegistry<string>((val) => released.push(val));

    let finishPrepare!: (val: string) => void;
    const preparePromise = new Promise<string>((resolve) => {
      finishPrepare = resolve;
    });

    const p = registry.request("ch2.xhtml", 1, () => preparePromise);
    // 等待 prepare 真正开始执行
    await Promise.resolve();

    // 布局发生重排或重置，取消旧任务
    registry.reset();

    // 晚完成
    finishPrepare("late-ch2");

    await expect(p).rejects.toThrow();
    // 确保晚到结果被 release 销毁
    expect(released).toContain("late-ch2");
  });

  it("takeReady 转交所有权，retainReady 降为缓存", () => {
    const released: string[] = [];
    const registry = new ChapterPreparationRegistry<string>((val) => released.push(val));

    expect(registry.retainReady("ch3.xhtml", "val-ch3")).toBe(true);
    expect(registry.isReady("ch3.xhtml")).toBe(true);

    // takeReady 成功交出所有权
    const taken = registry.takeReady("ch3.xhtml", "val-ch3");
    expect(taken).toBe("val-ch3");
    expect(registry.isReady("ch3.xhtml")).toBe(false);

    // 再次 reset 不会释放已被宿主接管的 value
    registry.reset();
    expect(released).not.toContain("val-ch3");
  });
});

describe("ArchiveClient close convergence", () => {
  it("rejects pending worker requests with a unified closed error", async () => {
    const worker = {
      postMessage: vi.fn(),
      terminate: vi.fn(),
      onmessage: null,
      onerror: null,
    } as unknown as Worker;
    const client = new WorkerArchiveClient(worker, []);
    const pending = client.extract(["OEBPS/late.xhtml"]);
    expect(worker.postMessage).toHaveBeenCalledWith({
      id: 1,
      type: "extract",
      paths: ["OEBPS/late.xhtml"],
    });

    client.close();
    await expect(pending).rejects.toThrow(ArchiveClosedError);
    await expect(pending).rejects.toThrow("归档已关闭");
    expect(worker.terminate).toHaveBeenCalledTimes(1);
  });
});
