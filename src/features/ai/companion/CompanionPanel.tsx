import { lazy, Suspense, useEffect, useRef, useState } from "react";
import type { Book } from "../../../core/types";
import { getAppBuildSession } from "../../../config/appBuildSession";
import { useUiText } from "../../../ui/localization/UiLanguageProvider";
import { createDirectRuntime } from "./runtime";
import { createReadingLibrary, type LibraryBook } from "./retrieval";
import { loadChatSettings, loadMemories, saveChatSettings, saveMemories } from "./storage";
import { clearConversation, putExchange, readExchanges, readSegments } from "./conversationStore";
import { cancelMemoryMaintenance, maintainConversation } from "./memoryMaintenance";
import type { ContextLedger } from "./contextBudget";
import { createChatTransport, messageText } from "./transport";
import { InvestigationTrace } from "./InvestigationTrace";
import { companionDiagnostics } from "./diagnostics";
import type { ChatPhase, Evidence, InvestigationStep, ReadingContext, SavedExchange } from "./types";
import "./companion.css";

const Avatar = lazy(() => import("./CompanionAvatar").then(module => ({ default: module.CompanionAvatar })));
// Survives closing the panel, never written to settings, history or native logs.
let sessionApiKey = "";

export interface CompanionPanelProps {
  book: Book;
  context: ReadingContext;
  libraryBooks: readonly LibraryBook[];
  onNavigate(evidence: Evidence): void;
}

export function CompanionPanel({ book, context, libraryBooks, onNavigate }: CompanionPanelProps) {
  const { locale } = useUiText();
  const label = (zh: string, en: string) => locale === "en" ? en : zh;
  const [settings, setSettings] = useState(loadChatSettings);
  const [apiKey, setApiKey] = useState(() => sessionApiKey);
  const [question, setQuestion] = useState("");
  const [history, setHistory] = useState<SavedExchange[]>([]);
  const [memories, setMemoryText] = useState("");
  const [ready, setReady] = useState(false);
  const [running, setRunning] = useState(false);
  const [phase, setPhase] = useState<ChatPhase>("planning");
  const [draft, setDraft] = useState("");
  const [activeQuestion, setActiveQuestion] = useState("");
  const [evidence, setEvidence] = useState<readonly Evidence[]>([]);
  const [trace, setTrace] = useState<readonly InvestigationStep[]>([]);
  const [error, setError] = useState("");
  const [showAvatar, setShowAvatar] = useState(true);
  const [contextLedger, setContextLedger] = useState<ContextLedger>();
  const [memoryStatus, setMemoryStatus] = useState("");
  const [hasOlder, setHasOlder] = useState(false);
  const current = useRef<AbortController | null>(null);

  useEffect(() => {
    let disposed = false;
    setReady(false); setRunning(false); setError(""); setDraft(""); setEvidence([]); setTrace([]); setActiveQuestion("");
    void Promise.all([readExchanges({ limit: 40 }), loadMemories()]).then(([exchanges, savedMemories]) => {
      if (disposed) return;
      setHistory(exchanges); setHasOlder(exchanges.length === 40); setMemoryText(savedMemories); setReady(true);
    }).catch(cause => { if (!disposed) setError(messageText(cause)); });
    return () => { disposed = true; current.current?.abort(); current.current = null; cancelMemoryMaintenance(); };
  }, [book]);

  useEffect(() => {
    if (ready) companionDiagnostics.history(context, history);
  }, [ready, context.bookHash, history]);

  const updateSettings = (patch: Partial<typeof settings>) => {
    const next = { ...settings, ...patch };
    setSettings(next);
    try { saveChatSettings(next); } catch (cause) { setError(messageText(cause)); }
  };
  const send = async () => {
    if (current.current || running || !ready || !question.trim()) return;
    if (!apiKey.trim() || !settings.model.trim()) { setError(label("请先填写 API 密钥和模型名称", "Enter an API key and model first")); return; }
    const controller = new AbortController();
    cancelMemoryMaintenance(); setMemoryStatus("");
    current.current = controller;
    const text = question.trim();
    const exchange: SavedExchange = { id: crypto.randomUUID(), question: text, answer: "", evidence: [],
      context: { ...context }, createdAt: Date.now(), revision: 1, interrupted: true };
    setQuestion(""); setActiveQuestion(text); setDraft(""); setEvidence([]); setTrace([]); setError(""); setRunning(true);
    let visibleText = "";
    let visibleEvidence: readonly Evidence[] = [];
    let visibleTrace: readonly InvestigationStep[] = [];
    let completed = false;
    let stored = false;
    try {
      // Persist the question before inference; a close/crash retains its words.
      await putExchange(exchange);
      stored = true;
      const [requestHistory, segments] = await Promise.all([
        readExchanges({ before: [exchange.createdAt, exchange.id], tokenBudget: settings.contextTier * 1.2 }), readSegments(),
      ]);
      controller.signal.throwIfAborted();
      const transport = createChatTransport(settings, apiKey.trim());
      const result = await createDirectRuntime(transport).runTurn({
        question: text, history: requestHistory, memories, grounded: settings.mode === "reading", signal: controller.signal,
        segments: settings.automaticMemory ? segments : [],
        contextPolicy: { softLimit: settings.contextTier, capacity: settings.contextCapacity,
          outputTokens: transport.requestInfo?.maxTokens ?? 8192 }, onContext: setContextLedger,
        library: createReadingLibrary(book, context, libraryBooks, settings),
        onUpdate(nextPhase, nextText, nextEvidence, nextTrace) {
          if (current.current !== controller || controller.signal.aborted) return;
          visibleText = nextText; visibleEvidence = nextEvidence;
          visibleTrace = nextTrace;
          setPhase(nextPhase); setDraft(nextText); setEvidence(nextEvidence); setTrace(nextTrace);
        },
      });
      controller.signal.throwIfAborted();
      const finished: SavedExchange = { ...exchange, answer: result.answer, evidence: result.evidence,
        trace: result.trace, revision: 2, interrupted: false };
      if (current.current !== controller) return;
      await putExchange(finished);
      setHistory(previous => [...previous, finished].slice(-Math.max(40, previous.length)));
      setDraft(""); setEvidence([]); setActiveQuestion("");
      completed = true;
    } catch (cause) {
      if (current.current !== controller) return;
      const stopped = { ...exchange, answer: visibleText, evidence: [...visibleEvidence], trace: [...visibleTrace], revision: 2 };
      if (stored && visibleText) await putExchange(stopped).catch(error => setError(messageText(error)));
      if (stored) setHistory(previous => [...previous, visibleText ? stopped : exchange].slice(-Math.max(40, previous.length)));
      setDraft(""); setActiveQuestion("");
      if (controller.signal.aborted) {
        setError(label("已停止；未完成的回答不会用于后续事实判断", "Stopped. The unfinished answer will not be reused as factual context."));
      } else { setError(messageText(cause)); setQuestion(text); }
    } finally {
      if (current.current === controller) {
        current.current = null; setRunning(false);
        if (completed && settings.automaticMemory) {
          void maintainConversation(createChatTransport(settings, apiKey.trim())).then(status => {
            if (status === "published") setMemoryStatus(label("已整理一段对话，原话完整保留。", "A segment was organized; originals are preserved."));
          }).catch(cause => setMemoryStatus(messageText(cause)));
        }
      }
    }
  };
  const sourceButtons = (items: readonly Evidence[]) => <div className="companion-sources">{items.map(source =>
    <details key={source.id}><summary>[{source.id}] {source.bookTitle} · {source.chapterTitle}</summary>
      <blockquote>{source.text}</blockquote>
      <button type="button" onClick={() => onNavigate(source)}>{label("回到书中原文", "Open original passage")}</button>
    </details>)}</div>;
  const phaseLabels: Record<ChatPhase, string> = {
    planning: label("正在整理问题", "Considering the question"), searching: label("正在查找原文", "Searching passages"),
    reading: label("正在展开上下文", "Reading context"), answering: label("正在回答（尚未完成查证）", "Drafting — verification in progress"),
  };
  const native = getAppBuildSession()?.source === "desktop";

  return <section className="companion-panel" aria-label={label("阅读伙伴实验", "Reading companion experiment")}>
    <div className="companion-intro">
      {showAvatar && <Suspense fallback={<small>{label("正在加载测试形象…", "Loading sample avatar…")}</small>}><Avatar /></Suspense>}
      <div><h3>{label("一起读书", "Read together")}</h3>
        <p>{context.title} · {label("当前第", "Chapter ")}{context.spineIndex + 1}{label("个文档", "")}</p>
        <p>{label("由模型按需查阅原文，出处可以点回书中。", "The model chooses when to read; sources link back to the book.")}</p>
        <label><input type="checkbox" checked={showAvatar} onChange={event => setShowAvatar(event.target.checked)} />{label("显示测试形象", "Show sample avatar")}</label>
      </div>
    </div>
    <details className="companion-settings" open={!apiKey}>
      <summary>{label("API 与阅读范围", "API and reading scope")}</summary>
      <fieldset disabled={running}>
        <label>API Base URL<input value={settings.baseUrl} onChange={event => updateSettings({ baseUrl: event.target.value })} placeholder="https://api.deepseek.com/v1" /></label>
        <label>{label("模型", "Model")}<input value={settings.model} onChange={event => updateSettings({ model: event.target.value })} /></label>
        <label>{label("对话上下文", "Conversation context")}<select value={settings.contextTier}
          onChange={event => updateSettings({ contextTier: Number(event.target.value) as typeof settings.contextTier })}>
          <option value={100000}>100K</option><option value={200000}>200K</option><option value={400000}>400K</option>
        </select></label>
        <label>{label("接口上下文容量（token，可选）", "Provider context capacity (tokens, optional)")}<input type="number"
          min={32768} step={1024} value={settings.contextCapacity ?? ""} onChange={event => updateSettings({
            contextCapacity: event.target.value ? Math.max(32768, Number(event.target.value)) : undefined,
          })} /></label>
        <small>{label("软上限用于整理资料，不必填满；容量留空时不假设接口支持 1M。用量为估算。", "The soft limit organizes context, not a fill target. Unknown API capacity is not assumed to be 1M. Usage is estimated.")}</small>
        <label><input type="checkbox" checked={settings.thinkingEnabled} onChange={event => updateSettings({ thinkingEnabled: event.target.checked })} />{label("低强度思考（low）", "Low reasoning effort")}</label>
        <small>{label("默认开启。DeepSeek 官方接口可切换开关；其他接口需支持 reasoning_effort，取消勾选则沿用服务端默认。", "Enabled by default. DeepSeek supports the explicit toggle; other endpoints must support reasoning_effort, and use their default when unchecked.")}</small>
        <label>API Key<input type="password" autoComplete="off" value={apiKey} onChange={event => { sessionApiKey = event.target.value; setApiKey(sessionApiKey); }} /></label>
        <small>{label("密钥只在本次应用内存中保留，关闭应用即清除。发问时会把所需原文、最近对话与记忆发送到所填 API。", "The key stays in memory until the app closes. Questions send selected passages, recent dialogue and memories to your API.")}</small>
        <label>{label("模式", "Mode")}<select value={settings.mode} onChange={event => updateSettings({ mode: event.target.value as "reading" | "auto" })}>
          <option value="auto">{label("自动 · 按需查阅", "Automatic · read as needed")}</option><option value="reading">{label("严格查证 · 实验对照", "Strict evidence · comparison")}</option>
        </select></label>
        <label>{label("检索范围", "Search scope")}<select value={settings.scope} onChange={event => updateSettings({ scope: event.target.value as "book" | "library" })}>
          <option value="book">{label("当前书籍", "Current book")}</option><option value="library" disabled={!native}>{label("已建库的全部书籍", "Indexed library")}</option>
        </select></label>
        <label><input type="checkbox" checked={settings.allowLaterChapters} onChange={event => updateSettings({ allowLaterChapters: event.target.checked })} />{label("允许查阅后续章节（可能剧透）", "Allow later chapters — may spoil the story")}</label>
        <small>{label("关闭时限制到各书当前章节；同一章中尚未读到的段落仍可能出现。跨书检索需先在书架正文搜索建立索引。", "Otherwise, retrieval stops at each book’s current chapter; later passages within that chapter remain visible. Library search requires the shelf text index.")}</small>
      </fieldset>
    </details>
    <details className="companion-settings"><summary>{label("共同阅读记忆", "Reading memories")}</summary>
      <label><input type="checkbox" checked={settings.automaticMemory} disabled={running} onChange={event => {
        if (!event.target.checked) cancelMemoryMaintenance();
        updateSettings({ automaticMemory: event.target.checked });
      }} />{label("自动整理对话与记忆", "Automatically organize conversation and memory")}</label>
      <small>{label("约24轮或16K新对话后用当前API批量整理一次；不覆盖原话，提问时让出。关闭后不整理、不注入派生记忆。", "Organize via the current API after about 24 exchanges or 16K new dialogue tokens. Originals remain; user questions take priority. Disabling also excludes derived memories.")}</small>
      <p>{label("记录偏好、讨论过的观点与未完话题。它们不会自动成为书中事实。", "Keep preferences, interpretations and unfinished topics. These are not book facts.")}</p>
      <textarea value={memories} maxLength={6000} onChange={event => setMemoryText(event.target.value)} aria-label={label("共同阅读记忆", "Reading memories")} />
      <button disabled={!ready || running} onClick={() => { void saveMemories(memories).then(() => setError("")).catch(cause => setError(messageText(cause))); }}>{label("保存记忆", "Save memories")}</button>
    </details>
    <div className="companion-history" aria-label={label("对话记录", "Conversation history")}>
      {hasOlder && <button type="button" disabled={running || !ready} onClick={() => {
        const first = history[0];
        if (!first) return;
        void readExchanges({ before: [first.createdAt, first.id], limit: 40 }).then(older => {
          setHistory(previous => [...older, ...previous]); setHasOlder(older.length === 40);
        }).catch(cause => setError(messageText(cause)));
      }}>{label("查看更早对话", "Load earlier conversation")}</button>}
      {history.map(exchange => <article key={exchange.id}>
        <strong>{exchange.question}</strong><p>{exchange.answer}</p>
        {exchange.interrupted && <small>{label("未完成", "Interrupted")}</small>}
        {sourceButtons(exchange.evidence)}
        <InvestigationTrace steps={exchange.trace ?? []} />
      </article>)}
      {activeQuestion && <article><strong>{activeQuestion}</strong>{draft && <p>{draft}</p>}
        {sourceButtons(evidence)}<InvestigationTrace steps={trace} /></article>}
    </div>
    {running && <p role="status">{phaseLabels[phase]}</p>}
    {contextLedger && <small>{label("本次输入估算", "Estimated input")}: {contextLedger.inputTokens.toLocaleString()} token · {settings.contextTier / 1000}K
      {contextLedger.overSoftLimit && label(" · 本轮必要资料暂超软线", " · Necessary current material exceeds the soft limit")}</small>}
    {memoryStatus && <small role="status">{memoryStatus}</small>}
    {error && <p role="alert" className="companion-error">{error}</p>}
    <form onSubmit={event => { event.preventDefault(); void send(); }}>
      <textarea value={question} disabled={running || !ready} maxLength={6000} onChange={event => setQuestion(event.target.value)}
        placeholder={label("聊聊这本书，或提出一个需要核实的问题…", "Discuss the book or ask a question to investigate…")} aria-label={label("向阅读伙伴提问", "Ask your reading companion")} />
      <div className="companion-actions">
        <button type="button" disabled={running || !ready} onClick={() => {
          cancelMemoryMaintenance();
          void clearConversation().then(() => { setHistory([]); setHasOlder(false); setContextLedger(undefined);
            setMemoryStatus(""); setError(""); setDraft(""); setActiveQuestion(""); setEvidence([]); })
            .catch(cause => setError(messageText(cause)));
        }}>{label("清空当前对话", "Clear conversation")}</button>
        {running ? <button type="button" onClick={() => current.current?.abort()}>{label("停止", "Stop")}</button>
          : <button type="submit" disabled={!ready || !question.trim()}>{label("发送", "Send")}</button>}
      </div>
    </form>
  </section>;
}
