import { lazy, Suspense, useEffect, useRef, useState } from "react";
import type { Book } from "../../../core/types";
import { getAppBuildSession } from "../../../config/appBuildSession";
import { useUiText } from "../../../ui/localization/UiLanguageProvider";
import { answerWithBooks } from "./conversation";
import { createReadingLibrary, type LibraryBook } from "./retrieval";
import { loadChatSettings, loadExchanges, loadMemories, saveChatSettings, saveExchanges, saveMemories } from "./storage";
import { createChatTransport, messageText } from "./transport";
import { InvestigationTrace } from "./InvestigationTrace";
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
  const current = useRef<AbortController | null>(null);
  const historyScope = `${settings.scope}:${settings.scope === "book" ? context.bookHash : "library"}`;

  useEffect(() => {
    let disposed = false;
    setReady(false); setRunning(false); setError(""); setDraft(""); setEvidence([]); setTrace([]); setActiveQuestion("");
    void Promise.all([loadExchanges(historyScope), loadMemories()]).then(([exchanges, savedMemories]) => {
      if (disposed) return;
      setHistory(exchanges); setMemoryText(savedMemories); setReady(true);
    }).catch(cause => { if (!disposed) setError(messageText(cause)); });
    return () => { disposed = true; current.current?.abort(); current.current = null; };
  }, [historyScope, book]);

  const updateSettings = (patch: Partial<typeof settings>) => {
    const next = { ...settings, ...patch };
    setSettings(next);
    try { saveChatSettings(next); } catch (cause) { setError(messageText(cause)); }
  };
  const send = async () => {
    if (running || !ready || !question.trim()) return;
    if (!apiKey.trim() || !settings.model.trim()) { setError(label("请先填写 API 密钥和模型名称", "Enter an API key and model first")); return; }
    const controller = new AbortController();
    current.current = controller;
    const text = question.trim();
    setQuestion(""); setActiveQuestion(text); setDraft(""); setEvidence([]); setTrace([]); setError(""); setRunning(true);
    let visibleText = "";
    let visibleEvidence: readonly Evidence[] = [];
    let visibleTrace: readonly InvestigationStep[] = [];
    try {
      const result = await answerWithBooks({
        question: text, history, memories, grounded: settings.mode === "reading", signal: controller.signal,
        library: createReadingLibrary(book, context, libraryBooks, settings),
        transport: createChatTransport(settings, apiKey.trim()),
        onUpdate(nextPhase, nextText, nextEvidence, nextTrace) {
          if (current.current !== controller || controller.signal.aborted) return;
          visibleText = nextText; visibleEvidence = nextEvidence;
          visibleTrace = nextTrace;
          setPhase(nextPhase); setDraft(nextText); setEvidence(nextEvidence); setTrace(nextTrace);
        },
      });
      controller.signal.throwIfAborted();
      const next = [...history, { id: crypto.randomUUID(), question: text, answer: result.answer,
        evidence: result.evidence, trace: result.trace, createdAt: Date.now() }].slice(-30);
      if (current.current !== controller) return;
      setHistory(next); setDraft(""); setEvidence([]); setActiveQuestion("");
      await saveExchanges(historyScope, next);
    } catch (cause) {
      if (current.current !== controller) return;
      if (controller.signal.aborted) {
        if (visibleText) {
          const next = [...history, { id: crypto.randomUUID(), question: text, answer: visibleText,
            evidence: [...visibleEvidence], trace: [...visibleTrace], createdAt: Date.now(), interrupted: true }].slice(-30);
          setHistory(next); setDraft(""); setActiveQuestion("");
          await saveExchanges(historyScope, next).catch(error => setError(messageText(error)));
        }
        setError(label("已停止；未完成的回答不会用于后续事实判断", "Stopped. The unfinished answer will not be reused as factual context."));
      } else { setError(messageText(cause)); setQuestion(text); }
    } finally {
      if (current.current === controller) { current.current = null; setRunning(false); }
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
      <p>{label("记录偏好、讨论过的观点与未完话题。它们不会自动成为书中事实。", "Keep preferences, interpretations and unfinished topics. These are not book facts.")}</p>
      <textarea value={memories} maxLength={6000} onChange={event => setMemoryText(event.target.value)} aria-label={label("共同阅读记忆", "Reading memories")} />
      <button disabled={!ready || running} onClick={() => { void saveMemories(memories).then(() => setError("")).catch(cause => setError(messageText(cause))); }}>{label("保存记忆", "Save memories")}</button>
    </details>
    <div className="companion-history" aria-label={label("对话记录", "Conversation history")}>
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
    {error && <p role="alert" className="companion-error">{error}</p>}
    <form onSubmit={event => { event.preventDefault(); void send(); }}>
      <textarea value={question} disabled={running || !ready} maxLength={6000} onChange={event => setQuestion(event.target.value)}
        placeholder={label("聊聊这本书，或提出一个需要核实的问题…", "Discuss the book or ask a question to investigate…")} aria-label={label("向阅读伙伴提问", "Ask your reading companion")} />
      <div className="companion-actions">
        <button type="button" disabled={running || !ready} onClick={() => {
          void saveExchanges(historyScope, []).then(() => { setHistory([]); setError(""); setDraft(""); setActiveQuestion(""); setEvidence([]); })
            .catch(cause => setError(messageText(cause)));
        }}>{label("清空当前对话", "Clear conversation")}</button>
        {running ? <button type="button" onClick={() => current.current?.abort()}>{label("停止", "Stop")}</button>
          : <button type="submit" disabled={!ready || !question.trim()}>{label("发送", "Send")}</button>}
      </div>
    </form>
  </section>;
}
