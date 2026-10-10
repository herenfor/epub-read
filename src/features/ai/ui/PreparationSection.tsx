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
import { uiText, useUiText } from "../../../ui/localization/UiLanguageProvider";
import { liveMessage, rawMessage, type LiveMessage } from "./liveMessage";

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
  const { t, tn } = useUiText();
  const governor = preparationGovernor;
  const [store] = useState(createPreparationStore);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<LiveMessage>(() => liveMessage(({ t }) => t("ai.prep.initial")));
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
        setMessage(liveMessage(({ t }) => t("ai.prep.running")));
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
                if (++calls === 2) throw new Error(uiText(fault === "oom" ? "ai.prep.fault.oomError" : "ai.prep.fault.crashError"));
                return embed(...args);
              };
            }
            return provider;
          },
        });
        if (current()) { setStatus(result); setMessage(liveMessage(({ t }) => t("ai.prep.done"))); }
      } else {
        const response = await store.request(action === "clear"
          ? { action: "clear", book: fingerprint, owner: crypto.randomUUID() }
          : { action: "status", book: fingerprint });
        if (current()) { setStatus(response.status); setMessage(liveMessage(({ t }) => t(action === "clear" ? "ai.prep.cleared" : "ai.prep.statusRead"))); }
      }
      if (current() && !controller.signal.aborted) {
        const response = await store.request({ action: "citations", book: fingerprint });
        if (current()) setCitations(response.citations);
      }
    } catch (error) {
      if (current()) setMessage(controller.signal.aborted ? liveMessage(({ t }) => t("ai.prep.cancelled")) : rawMessage(String(error)));
    } finally {
      if (current()) { locked.current = false; abort.current = null; setBusy(false); }
    }
  };
  const disabled = busy || book.fixedLayout || !/^[a-f0-9]{64}$/.test(fingerprint);
  return <section className="model-assets-section" aria-label={t("ai.prep.region")}>
    <h3>{t("ai.prep.title")}</h3>
    <p className="model-assets-note">{getAppBuildSession()?.source === "browser"
      ? t("ai.prep.note.browser")
      : t("ai.prep.note.desktop")}</p>
    <p className="model-assets-note">{t("ai.prep.note.scope")}</p>
    <label>{t("ai.prep.fault")} <select value={fault} disabled={busy} onChange={(e) => setFault(e.target.value as typeof fault)}>
      <option value="none">{t("ai.prep.fault.none")}</option><option value="oom">{t("ai.prep.fault.oom")}</option><option value="crash">{t("ai.prep.fault.crash")}</option>
    </select></label>
    <div className="ai-foundation-actions">
      <button disabled={disabled} onClick={() => void execute("run")}>{t("ai.prep.run")}</button>
      <button disabled={disabled} onClick={() => void execute("rebuild")}>{t("ai.rebuild")}</button>
      <button disabled={disabled} onClick={() => void execute("status")}>{t("ai.prep.status")}</button>
      <button disabled={disabled} onClick={() => void execute("clear")}>{t("ai.prep.clear")}</button>
      <button disabled={!busy} onClick={() => abort.current?.abort()}>{t("ai.cancel")}</button>
    </div>
    <p role="status">{message.render({ t, tn })}</p>
    {status && <p className="model-assets-meta">{status.storage === "indexeddb"
      ? t("ai.prep.summary.indexeddb", { staged: status.stagedChunks, published: status.publishedChunks, next: status.nextBatch, schema: status.databaseSchema, component: status.componentVersion, bytes: governor.snapshot.reservedBytes })
      : t("ai.prep.summary.sqlite", { staged: status.stagedChunks, published: status.publishedChunks, next: status.nextBatch, sqlite: status.sqliteVersion, schema: status.databaseSchema, supported: status.supportedDatabaseSchema, component: status.componentVersion, timeout: status.busyTimeoutMs, bytes: governor.snapshot.reservedBytes })}</p>}
    {citations.map((chunk) => <button className="preparation-citation" key={chunk.chunkId} disabled={busy}
      onClick={() => onNavigate(preparationCitation(chunk))}>{t("ai.citation", { chapter: chunk.chapterTitle, text: chunk.originalText.slice(0, 100) })}</button>)}
  </section>;
}
