import { useEffect, useMemo, useRef, useState } from "react";
import type { Book } from "../../../core/types";
import type { SearchResult } from "../../../core/search";
import { iterateBookChunkBatches, textForBookResource } from "../../../core/bookCorpusIndex";
import { embeddingChunkProfile } from "../../../core/chunking";
import { getAppBuildSession } from "../../../config/appBuildSession";
import { preparationCitation } from "../preparation/citation";
import { createSemanticStore } from "../semantic/nativeStore";
import { SemanticQueryController, type SemanticHit, type SemanticQueryStatus } from "../semantic/queryController";
import type { EmbeddingProfile } from "../semantic/contracts";
import { createPreviewSession } from "../semantic/previewSession";
import { embeddingErrorMessage, probeSemanticEmbedding } from "../semantic/nativeSession";

export interface SemanticSectionProps {
  book: Book;
  fingerprint: string;
  readingBusy: boolean;
  onNavigate(result: SearchResult): void;
}

const INITIAL_MESSAGE = "尚未建库。语义索引只在点击“建立索引”后开始，不会自动下载模型或后台建库。";

/** Debug harness for the single-book semantic index.  Web builds exercise real
 * storage and the real ranking code with preview vectors and say so; only a
 * Windows AI build loads the ONNX Runtime DirectML model. */
export function SemanticSection({ book, fingerprint, readingBusy, onNavigate }: SemanticSectionProps) {
  const preview = getAppBuildSession()?.source === "browser";
  const packageId = preview ? "preview-test-vectors" : "bge-small-zh-v1.5";
  const [status, setStatus] = useState<SemanticQueryStatus | null>(null);
  const [hits, setHits] = useState<readonly SemanticHit[]>([]);
  const [message, setMessage] = useState(INITIAL_MESSAGE);
  const [question, setQuestion] = useState("");
  const [topK, setTopK] = useState(5);
  const [running, setRunning] = useState(false);
  const [probe, setProbe] = useState<string | null>(null);
  const generation = useRef(0);
  const readingBusyRef = useRef(readingBusy);
  readingBusyRef.current = readingBusy;

  const controller = useMemo(() => {
    const store = createSemanticStore();
    return new SemanticQueryController({
      store,
      previewSession: preview
        ? { packageId, session: createPreviewSession(), device: { adapterName: "浏览器 IndexedDB", luid: null } }
        : undefined,
      chunks: (_book, signal, profile) => iterateBookChunks(book, fingerprint, signal, profile),
      yieldToReader: () => new Promise((resolve) => setTimeout(resolve, 0)),
      isReadingBusy: () => readingBusyRef.current,
      onChange: (value) => setStatus(value),
    });
  }, [book, fingerprint, packageId, preview]);

  useEffect(() => {
    const seq = ++generation.current;
    setHits([]);
    setMessage(INITIAL_MESSAGE);
    setStatus(null);
    if (!/^[a-f0-9]{64}$/.test(fingerprint) || book.fixedLayout) return;
    void controller.refresh(fingerprint).then((value) => {
      if (seq === generation.current && value.state === "ready") setMessage(value.message);
    });
    return () => { generation.current++; controller.cancel(); };
  }, [book, controller, fingerprint]);

  const run = async (action: "build" | "rebuild" | "clear") => {
    if (running) return;
    setRunning(true);
    const seq = generation.current;
    try {
      if (action === "clear") {
        const value = await controller.clear(fingerprint);
        if (seq === generation.current) {
          setHits([]);
          setMessage(value.message);
        }
      } else {
        setHits([]);
        setMessage(action === "rebuild" ? "正在重建；不会复用旧的已发布代次。" : "正在建立语义索引；关闭面板会保留可恢复检查点。");
        const value = await controller.build(fingerprint, packageId, null, action === "rebuild");
        if (seq === generation.current) setMessage(value.message);
      }
    } catch (error) {
      setMessage(embeddingErrorMessage(error));
    } finally {
      if (seq === generation.current) setRunning(false);
    }
  };

  const search = async () => {
    if (running || !question.trim()) return;
    setRunning(true);
    const seq = generation.current;
    try {
      setMessage("正在查询本地已发布代次…");
      const results = await controller.query(fingerprint, packageId, null, question.trim(), topK);
      if (seq === generation.current) {
        setHits(results);
        setMessage(results.length ? `第 ${results[0].generation} 代命中 ${results.length} 段。cosine 得分只表示相似度排序，不是置信概率。` : "没有命中任何段落。");
      }
    } catch (error) {
      setMessage(embeddingErrorMessage(error));
    } finally {
      if (seq === generation.current) setRunning(false);
    }
  };

  const runProbe = async () => {
    if (running) return;
    setRunning(true);
    setProbe("正在加载已验证模型并运行一次真实短句嵌入…");
    try {
      const report = await probeSemanticEmbedding(question.trim() || undefined);
      setProbe(`设备 ${report.device.adapterName ?? "未知"}（LUID ${report.device.luid ?? "未知"}，DirectML 索引 ${report.device.deviceIndex ?? "?"}）`
        + `｜运行库 ${report.profile.runtimeVersion}｜token 查询/段落 ${report.queryTokens}/${report.passageTokens}`
        + `｜归一 ${report.vectorNorm.toFixed(6)}，最大绝对值 ${report.vectorMaxAbs.toFixed(6)}`
        + `｜向量摘要 ${report.vectorDigest.slice(0, 16)}…｜耗时 ${report.elapsedMs} ms｜query/passage cosine ${report.queryPassageCosine.toFixed(6)}`);
    } catch (error) {
      setProbe(`探针失败：${embeddingErrorMessage(error)}`);
    } finally {
      setRunning(false);
    }
  };

  const disabled = running || book.fixedLayout || !/^[a-f0-9]{64}$/.test(fingerprint);
  return <section className="model-assets-section semantic-section" aria-label="单书语义检索">
    <h3>单书语义检索（调试）</h3>
    <p className="model-assets-note">{preview
      ? "浏览器预览：使用固定测试向量在 IndexedDB 中真实建库、恢复与排序，用于验证交互；这不是本机 Windows GPU 模型结果，也不代表已接入真实 Embedding。"
      : "桌面 AI 调试版：使用已验证的本机 ONNX Runtime DirectML 模型；查询与建库共享同一原生许可，阅读优先在批次边界让行。"}</p>
    <p className="model-assets-note">一次只处理当前书。不自动下载模型，不做问答、总结或跨书融合。
      {preview && " 需要真实语义检索时请在 Windows AI 调试版运行。"}</p>
    <div className="semantic-summary" role="status">
      <span>状态：{semanticStateLabel(status?.state ?? "idle")}</span>
      <span>模型：{status?.model ?? (preview ? "preview-test-vectors" : "尚未打开")}</span>
      <span>设备：{status?.device ?? (preview ? "浏览器 IndexedDB" : "尚未探测")}</span>
      <span>已发布代次：{status?.generation ?? "无"}</span>
      <span>已发布段落：{status?.publishedRows ?? 0}</span>
      <span>暂存/恢复点：{status?.stagedRows ?? 0} / 第 {status?.checkpointBatch ?? 0} 批</span>
    </div>
    <div className="ai-foundation-actions">
      <button disabled={disabled} onClick={() => void run("build")}>建立索引 / 继续</button>
      <button disabled={disabled} onClick={() => void run("rebuild")}>重建</button>
      <button disabled={disabled} onClick={() => void run("clear")}>清理本书语义索引</button>
      <button disabled={!running} onClick={() => { controller.cancel(); setMessage("已请求取消；driver 结束前会保留占用与恢复点。"); }}>取消</button>
    </div>
    <label>查询<input value={question} disabled={disabled} placeholder="用自然语言描述要查找的内容"
      onChange={(event) => setQuestion(event.target.value)}
      onKeyDown={(event) => { if (event.key === "Enter") void search(); }} /></label>
    <label>Top-K <select value={topK} disabled={disabled} onChange={(event) => setTopK(Number(event.target.value))}>
      {[3, 5, 8, 10].map((value) => <option key={value} value={value}>{value}</option>)}
    </select></label>
    <div className="ai-foundation-actions">
      <button disabled={disabled || !question.trim()} onClick={() => void search()}>查询</button>
      {!preview && <button disabled={running} onClick={() => void runProbe()}>真实模型探针</button>}
    </div>
    {probe && <p className="model-assets-meta">{probe}</p>}
    <p role="status">{message}</p>
    {status?.state === "failed" && <button className="ai-foundation-secondary" onClick={() => void controller.refresh(fingerprint)}>重试读取状态</button>}
    {hits.map((hit) => <button className="preparation-citation" key={`${hit.generation}-${hit.chunkId}-${hit.chunk.textAnchor.start}`} disabled={running}
      onClick={() => onNavigate(toSearchResult(hit))}>
      {hit.citation.chapterTitle}（{hit.score.toFixed(3)}）：{hit.citation.snippet.slice(0, 100)}
    </button>)}
  </section>;
}

function semanticStateLabel(state: SemanticQueryStatus["state"]): string {
  switch (state) {
    case "idle": return "未检查";
    case "checking": return "检查中";
    case "unavailable": return "未接入/不可用";
    case "building": return "处理中";
    case "ready": return "已就绪";
    case "failed": return "失败";
  }
}

async function* iterateBookChunks(
  book: Book,
  fingerprint: string,
  signal: AbortSignal,
  profile: EmbeddingProfile,
) {
  // The embedding model refuses a passage over its token limit, so this path
  // uses the model-derived chunk profile instead of the lexical default.
  const chunking = embeddingChunkProfile(profile.maxTokens);
  for await (const batch of iterateBookChunkBatches(book, {
    bookFingerprint: fingerprint,
    signal,
    chunking,
    textFor: (path) => textForBookResource(book, path),
  })) {
    yield batch.chunks;
  }
}

/** Reuses the stored chunk so the reader jumps to the original text range. */
function toSearchResult(hit: SemanticHit): SearchResult {
  return preparationCitation(hit.chunk);
}
