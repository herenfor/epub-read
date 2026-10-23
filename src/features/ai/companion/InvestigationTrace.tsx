import { useUiText } from "../../../ui/localization/UiLanguageProvider";
import type { InvestigationStep } from "./types";

/** Shows actual tool work, not model chain-of-thought or an accuracy score. */
export function InvestigationTrace({ steps }: { steps: readonly InvestigationStep[] }) {
  const { locale } = useUiText();
  const en = locale === "en";
  if (!steps.length) return null;
  const names: Record<string, string> = {
    search_library: en ? "Search passages" : "查找原文", read_chapter: en ? "Read chapter" : "展开章节",
    list_chapters: en ? "List chapters" : "查看目录", find_books: en ? "Find books" : "查找书籍",
  };
  return <details className="companion-trace"><summary>{en ? "Reading activity" : "本轮查阅"} · {steps.length}</summary>
    <ol>{steps.map((step, index) => <li key={index}>
      <strong>{names[step.tool] || step.tool}</strong>
      <span>{step.status === "running" ? (en ? "Working…" : "正在查阅…")
        : step.status === "cancelled" ? (en ? "Stopped" : "已停止")
        : step.status === "error" ? step.error
        : `${step.resultCount} ${en ? "results" : "项结果"} · ${step.elapsedMs} ms`}</span>
      {step.queries?.length ? <small>{step.queries.join(" / ")}</small> : null}
      {step.chapterPath && <small>{step.chapterPath}</small>}
      {step.offset !== undefined && <small>{en ? "Passage range" : "原文块范围"} {step.offset} → {step.nextOffset ?? (en ? "end" : "章末")}</small>}
    </li>)}</ol>
    <small>{en ? "Records actual tool calls; does not certify answer accuracy." : "只记录实际查阅过程，不代表回答已被证明正确。"}</small>
  </details>;
}
