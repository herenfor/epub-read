import { useEffect, useRef, useState } from "react";
import type { Book } from "../../../core/types";
import type { DocumentChunk } from "../../../core/chunking";
import type { SearchResult } from "../../../core/search";
import { iterateBookChunkBatches, textForBookResource } from "../../../core/bookCorpusIndex";
import { createMockProvider } from "../registry/mockProvider";
import { MOCK_PROBE, mockIndexManifest, type PreparationStatus } from "../preparation/contracts";
import { ResourceGovernor } from "../preparation/resourceGovernor";
import { createPreparationStore } from "../preparation/nativeStore";
import { getAppBuildSession } from "../../../config/appBuildSession";
import { runMockIndex } from "../preparation/mockIndexer";
import { preparationCitation } from "../preparation/citation";

export interface PreparationSectionProps {
  book: Book;
  fingerprint: string;
  readingBusy: boolean;
  onNavigate(result: SearchResult): void;
}

// Keep one admission budget across panel closures and book changes, including pending disposal.
const preparationGovernor = new ResourceGovernor(MOCK_PROBE);

/** Explicit debug harness; mounting/reading a book does not open a database or start a job. */
export function PreparationSection({ book, fingerprint, readingBusy, onNavigate }: PreparationSectionProps) {
  const governor = preparationGovernor;
  const [store] = useState(createPreparationStore);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("尚未运行；只使用确定性假向量，没有语义搜索能力。");
  const [status, setStatus] = useState<PreparationStatus | null>(null);
  const [citations, setCitations] = useState<DocumentChunk[]>([]);
  const [fault, setFault] = useState<"none" | "oom" | "crash">("none");
  const abort = useRef<AbortController | null>(null);
  const locked = useRef(false);
  const generation = useRef(0);
  useEffect(() => { governor.setReadingBusy(readingBusy); }, [governor, readingBusy]);
  useEffect(() => () => { generation.current++; abort.current?.abort(); }, [fingerprint]);

  const execute = async (action: "run" | "rebuild" | "status" | "clear") => {
    if (locked.current) return;
    locked.current = true; setBusy(true);
    const seq = ++generation.current;
    const current = () => seq === generation.current;
    const controller = new AbortController(); abort.current = controller;
    try {
      if (action === "run" || action === "rebuild") {
        setMessage("正在准备 mock 索引；取消或关闭面板会保留恢复点。");
        const result = await runMockIndex({
          manifest: mockIndexManifest(fingerprint), store, governor, force: action === "rebuild", signal: controller.signal,
          onProgress: (value) => { if (current()) setStatus(value); },
          yieldToReader: () => new Promise((resolve) => setTimeout(resolve, 0)),
          chunks: async function* (signal) {
            for await (const batch of iterateBookChunkBatches(book, {
              bookFingerprint: fingerprint, signal,
              textFor: async (path) => { await governor.waitUntilRunnable(signal); return textForBookResource(book, path); },
            })) { yield batch.chunks; }
          },
          createProvider: () => {
            const provider = createMockProvider();
            if (fault !== "none") {
              const embed = provider.embed.bind(provider);
              let calls = 0;
              provider.embed = async (...args) => {
                if (++calls === 2) throw new Error(fault === "oom" ? "模拟内存不足" : "模拟 Provider 崩溃");
                return embed(...args);
              };
            }
            return provider;
          },
        });
        if (current()) { setStatus(result); setMessage("mock 索引已完成。下面仅显示前 20 个原文引用，用于核对跳转。"); }
      } else {
        const response = await store.request(action === "clear"
          ? { action: "clear", book: fingerprint, owner: crypto.randomUUID() }
          : { action: "status", book: fingerprint });
        if (current()) { setStatus(response.status); setMessage(action === "clear" ? "本书 mock 索引已清理，全文搜索与模型文件保留。" : "状态已读取；不会自动开始建库。"); }
      }
      if (current() && !controller.signal.aborted) {
        const response = await store.request({ action: "citations", book: fingerprint });
        if (current()) setCitations(response.citations);
      }
    } catch (error) {
      if (current()) setMessage(controller.signal.aborted ? "已取消；再次继续将校验并复用已保存批次。" : String(error));
    } finally {
      if (current()) { locked.current = false; abort.current = null; setBusy(false); }
    }
  };
  const disabled = busy || book.fixedLayout || !/^[a-f0-9]{64}$/.test(fingerprint);
  return <section className="model-assets-section" aria-label="可恢复 mock 索引">
    <h3>可恢复 mock 索引（调试）</h3>
    <p className="model-assets-note">{getAppBuildSession()?.source === "browser"
      ? "当前使用浏览器 IndexedDB：可测试建库、取消、刷新恢复和引用跳转。数据仅保存在当前浏览器，与桌面 SQLite 独立。"
      : "当前使用桌面 SQLite。"}</p>
    <p className="model-assets-note">仅处理当前书。关闭面板取消任务并保留恢复点；清理只影响本书假向量。预算为注入的测试值，不代表实际硬件探测。</p>
    <label>故障注入 <select value={fault} disabled={busy} onChange={(e) => setFault(e.target.value as typeof fault)}>
      <option value="none">关闭</option><option value="oom">第 2 批内存不足</option><option value="crash">第 2 批 Provider 崩溃</option>
    </select></label>
    <div className="ai-foundation-actions">
      <button disabled={disabled} onClick={() => void execute("run")}>开始 / 继续</button>
      <button disabled={disabled} onClick={() => void execute("rebuild")}>重建</button>
      <button disabled={disabled} onClick={() => void execute("status")}>读取状态</button>
      <button disabled={disabled} onClick={() => void execute("clear")}>清理假向量</button>
      <button disabled={!busy} onClick={() => abort.current?.abort()}>取消</button>
    </div>
    <p role="status">{message}</p>
    {status && <p className="model-assets-meta">暂存 {status.stagedChunks} 块 / 已发布 {status.publishedChunks} 块；恢复点 {status.nextBatch}。
      {status.storage === "indexeddb" ? `IndexedDB 版本 ${status.databaseSchema}，mock 组件 ${status.componentVersion}。`
        : `SQLite ${status.sqliteVersion}，数据库版本 ${status.databaseSchema}（支持至 ${status.supportedDatabaseSchema}），mock 组件 ${status.componentVersion}，锁等待 ${status.busyTimeoutMs} ms。`}
      已预留 {governor.snapshot.reservedBytes} 字节。</p>}
    {citations.map((chunk) => <button className="preparation-citation" key={chunk.chunkId} disabled={busy}
      onClick={() => onNavigate(preparationCitation(chunk))}>{chunk.chapterTitle}：{chunk.originalText.slice(0, 100)}</button>)}
  </section>;
}
