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
import { uiText, useUiText, type Translate } from "../../../ui/localization/UiLanguageProvider";
import { liveMessage, rawMessage, type LiveMessage } from "./liveMessage";

export interface SemanticSectionProps {
  book: Book;
  fingerprint: string;
  readingBusy: boolean;
  onNavigate(result: SearchResult): void;
}

const INITIAL_MESSAGE = liveMessage(({ t }) => t("ai.sem.initial"));

/** Debug harness for the single-book semantic index.  Web builds exercise real
 * storage and the real ranking code with preview vectors and say so; only a
 * Windows AI build loads the ONNX Runtime DirectML model. */
export function SemanticSection({ book, fingerprint, readingBusy, onNavigate }: SemanticSectionProps) {
  const { t, tn } = useUiText();
  const preview = getAppBuildSession()?.source === "browser";
  const packageId = preview ? "preview-test-vectors" : "bge-small-zh-v1.5";
  const [status, setStatus] = useState<SemanticQueryStatus | null>(null);
  const [hits, setHits] = useState<readonly SemanticHit[]>([]);
  const [message, setMessage] = useState<LiveMessage>(INITIAL_MESSAGE);
  const [question, setQuestion] = useState("");
  const [topK, setTopK] = useState(5);
  const [running, setRunning] = useState(false);
  const [probe, setProbe] = useState<LiveMessage | null>(null);
  const generation = useRef(0);
  const readingBusyRef = useRef(readingBusy);
  readingBusyRef.current = readingBusy;

  const controller = useMemo(() => {
    const store = createSemanticStore();
    return new SemanticQueryController({
      store,
      previewSession: preview
        ? { packageId, session: createPreviewSession(), device: { adapterName: uiText("ai.sem.browserStore"), luid: null } }
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
      if (seq === generation.current && value.state === "ready") setMessage(rawMessage(value.message));
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
          setMessage(rawMessage(value.message));
        }
      } else {
        setHits([]);
        setMessage(liveMessage(({ t }) => t(action === "rebuild" ? "ai.sem.rebuilding" : "ai.sem.building")));
        const value = await controller.build(fingerprint, packageId, null, action === "rebuild");
        if (seq === generation.current) setMessage(rawMessage(value.message));
      }
    } catch (error) {
      setMessage(rawMessage(embeddingErrorMessage(error)));
    } finally {
      if (seq === generation.current) setRunning(false);
    }
  };

  const search = async () => {
    if (running || !question.trim()) return;
    setRunning(true);
    const seq = generation.current;
    try {
      setMessage(liveMessage(({ t }) => t("ai.sem.querying")));
      const results = await controller.query(fingerprint, packageId, null, question.trim(), topK);
      if (seq === generation.current) {
        setHits(results);
        setMessage(results.length
          ? liveMessage(({ tn }) => tn("ai.sem.hits", results.length, { generation: results[0].generation, count: results.length }))
          : liveMessage(({ t }) => t("ai.sem.noHits")));
      }
    } catch (error) {
      setMessage(rawMessage(embeddingErrorMessage(error)));
    } finally {
      if (seq === generation.current) setRunning(false);
    }
  };

  const runProbe = async () => {
    if (running) return;
    setRunning(true);
    setProbe(liveMessage(({ t }) => t("ai.sem.probing")));
    try {
      const report = await probeSemanticEmbedding(question.trim() || undefined);
      setProbe(liveMessage(({ t }) => t("ai.sem.probeReport", {
        adapter: report.device.adapterName ?? t("ai.unknown"),
        luid: report.device.luid ?? t("ai.unknown"),
        index: report.device.deviceIndex ?? "?",
        runtime: report.profile.runtimeVersion,
        queryTokens: report.queryTokens,
        passageTokens: report.passageTokens,
        norm: report.vectorNorm.toFixed(6),
        maxAbs: report.vectorMaxAbs.toFixed(6),
        digest: report.vectorDigest.slice(0, 16),
        ms: report.elapsedMs,
        cosine: report.queryPassageCosine.toFixed(6),
      })));
    } catch (error) {
      const detail = embeddingErrorMessage(error);
      setProbe(liveMessage(({ t }) => t("ai.sem.probeFailed", { error: detail })));
    } finally {
      setRunning(false);
    }
  };

  const disabled = running || book.fixedLayout || !/^[a-f0-9]{64}$/.test(fingerprint);
  return <section className="model-assets-section semantic-section" aria-label={t("ai.sem.region")}>
    <h3>{t("ai.sem.title")}</h3>
    <p className="model-assets-note">{preview
      ? t("ai.sem.note.preview")
      : t("ai.sem.note.desktop")}</p>
    <p className="model-assets-note">{t(preview ? "ai.sem.note.scopePreview" : "ai.sem.note.scope")}</p>
    <div className="semantic-summary" role="status">
      <span>{t("ai.sem.summary.state", { state: semanticStateLabel(t, status?.state ?? "idle") })}</span>
      <span>{t("ai.sem.summary.model", { model: status?.model ?? (preview ? "preview-test-vectors" : t("ai.sem.notOpened")) })}</span>
      <span>{t("ai.sem.summary.device", { device: status?.device ?? (preview ? t("ai.sem.browserStore") : t("ai.sem.notProbed")) })}</span>
      <span>{t("ai.sem.summary.generation", { generation: status?.generation ?? t("ai.sem.none") })}</span>
      <span>{t("ai.sem.summary.rows", { rows: status?.publishedRows ?? 0 })}</span>
      <span>{t("ai.sem.summary.staged", { staged: status?.stagedRows ?? 0, batch: status?.checkpointBatch ?? 0 })}</span>
    </div>
    <div className="ai-foundation-actions">
      <button disabled={disabled} onClick={() => void run("build")}>{t("ai.sem.build")}</button>
      <button disabled={disabled} onClick={() => void run("rebuild")}>{t("ai.rebuild")}</button>
      <button disabled={disabled} onClick={() => void run("clear")}>{t("ai.sem.clear")}</button>
      <button disabled={!running} onClick={() => { controller.cancel(); setMessage(liveMessage(({ t }) => t("ai.sem.cancelRequested"))); }}>{t("ai.cancel")}</button>
    </div>
    <label>{t("ai.sem.query")}<input value={question} disabled={disabled} placeholder={t("ai.sem.queryPlaceholder")}
      onChange={(event) => setQuestion(event.target.value)}
      onKeyDown={(event) => { if (event.key === "Enter") void search(); }} /></label>
    <label>Top-K <select value={topK} disabled={disabled} onChange={(event) => setTopK(Number(event.target.value))}>
      {[3, 5, 8, 10].map((value) => <option key={value} value={value}>{value}</option>)}
    </select></label>
    <div className="ai-foundation-actions">
      <button disabled={disabled || !question.trim()} onClick={() => void search()}>{t("ai.sem.query")}</button>
      {!preview && <button disabled={running} onClick={() => void runProbe()}>{t("ai.sem.probe")}</button>}
    </div>
    {probe && <p className="model-assets-meta">{probe.render({ t, tn })}</p>}
    <p role="status">{message.render({ t, tn })}</p>
    {status?.state === "failed" && <button className="ai-foundation-secondary" onClick={() => void controller.refresh(fingerprint)}>{t("ai.sem.retry")}</button>}
    {hits.map((hit) => <button className="preparation-citation" key={`${hit.generation}-${hit.chunkId}-${hit.chunk.textAnchor.start}`} disabled={running}
      onClick={() => onNavigate(toSearchResult(hit))}>
      {t("ai.sem.hit", { chapter: hit.citation.chapterTitle, score: hit.score.toFixed(3), text: hit.citation.snippet.slice(0, 100) })}
    </button>)}
  </section>;
}

function semanticStateLabel(t: Translate, state: SemanticQueryStatus["state"]): string {
  switch (state) {
    case "idle": return t("ai.sem.state.idle");
    case "checking": return t("ai.sem.state.checking");
    case "unavailable": return t("ai.sem.state.unavailable");
    case "building": return t("ai.sem.state.building");
    case "ready": return t("ai.sem.state.ready");
    case "failed": return t("ai.sem.state.failed");
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
