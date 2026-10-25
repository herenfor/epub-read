import { CORPUS_PARSER_VERSION, CORPUS_NORMALIZER_VERSION } from "../../../core/corpus";
import { CORPUS_CHUNKER_VERSION } from "../../../core/chunking";
import type { ResolvedCrossBookSearchHit } from "../indexing/indexStore";
import type { ReadingLibrary } from "./retrieval";
import type { Evidence, SavedExchange } from "./types";
import { estimateTokens } from "./contextBudget";

const corpusVersion = [CORPUS_PARSER_VERSION, CORPUS_NORMALIZER_VERSION, CORPUS_CHUNKER_VERSION].join(":");
export function evidenceFor(hit: ResolvedCrossBookSearchHit, id: string): Evidence {
  return {
    id, corpusVersion, bookHash: hit.contentHash, bookTitle: hit.title, chapterPath: hit.chapterPath,
    chapterTitle: hit.chapterTitle || hit.chapterPath, spineIndex: hit.spineIndex, text: hit.originalText, hit,
    citation: { spineIndex: hit.spineIndex, chapterPath: hit.chapterPath, chapterTitle: hit.chapterTitle || hit.chapterPath,
      snippet: hit.originalText, snippetMatchRanges: [], originalRange: { start: 0, end: hit.originalText.length },
      textOffset: hit.textAnchor.start, textSnippet: hit.textAnchor.snippet, matchedText: hit.originalText, matchType: "phrase" },
  };
}
export const sourcePayload = (source: Evidence) => ({ id: source.id, bookHash: source.bookHash, bookTitle: source.bookTitle,
  chapterPath: source.chapterPath, chapterTitle: source.chapterTitle, spineIndex: source.spineIndex, originalText: source.text });

/** An ID names actual supplied text, never a model's reconstructed fact or generated summary. */
export class EvidenceRegistry {
  private byChunk = new Map<string, Evidence>();
  private byId = new Map<string, Evidence>();
  constructor(private library: ReadingLibrary) {}
  retain(hits: readonly ResolvedCrossBookSearchHit[]): Evidence[] {
    return hits.filter(hit => this.library.canRead(hit.contentHash, hit.spineIndex)).map(hit => {
      const key = `${hit.contentHash}:${hit.chunkId}`;
      let source = this.byChunk.get(key);
      if (!source) {
        source = evidenceFor(hit, `E${this.byId.size + 1}`);
        this.byChunk.set(key, source); this.byId.set(source.id, source);
      }
      return source;
    });
  }
  get(id: string): Evidence | undefined { return this.byId.get(id); }
  all(): Evidence[] { return [...this.byId.values()]; }
  fromAnswer(answer: string): Evidence[] {
    const ids = [...new Set([...answer.matchAll(/\[(E\d+)\]/gu)].map(match => match[1]))];
    return ids.map(id => {
      const source = this.byId.get(id);
      if (!source) throw new Error("回答包含不存在的引用，已停止保存，请重试");
      return source;
    });
  }
  history(exchanges: readonly SavedExchange[], tokenBudget = 40000): Array<{
    id: string; revision: number; question: string; answer: string; createdAt: number; context?: SavedExchange["context"]; interrupted: boolean;
  }> {
    const recent = [...exchanges];
    const remapped = new Map<SavedExchange, Map<string, string>>();
    let tokens = 0;
    // Prefer recent source text; old/unknown corpus versions remain readable in UI but are not reused as evidence.
    for (const exchange of [...recent].reverse()) {
      const ids = new Map<string, string>();
      for (const source of exchange.interrupted ? [] : exchange.evidence) {
        if (source.corpusVersion !== corpusVersion || !this.library.canRead(source.bookHash, source.spineIndex)) continue;
        const exists = this.byChunk.has(`${source.hit.contentHash}:${source.hit.chunkId}`);
        const size = exists ? 0 : estimateTokens(sourcePayload(source));
        if (tokens + size > tokenBudget) continue;
        const retained = this.retain([source.hit])[0];
        if (retained) { ids.set(source.id, retained.id); tokens += size; }
      }
      remapped.set(exchange, ids);
    }
    return recent.map(exchange => ({ id: exchange.id, revision: exchange.revision ?? 1, createdAt: exchange.createdAt, context: exchange.context,
      interrupted: Boolean(exchange.interrupted), question: exchange.question,
      answer: exchange.interrupted ? "" : exchange.answer.replace(/\[(E\d+)\]/gu, (_, id: string) => remapped.get(exchange)?.has(id)
        ? `[${remapped.get(exchange)!.get(id)}]` : "（历史出处未提供，需要时重新查阅）") }));
  }
}
