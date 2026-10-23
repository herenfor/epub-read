import { CORPUS_PARSER_VERSION, CORPUS_NORMALIZER_VERSION } from "../../../core/corpus";
import { CORPUS_CHUNKER_VERSION } from "../../../core/chunking";
import type { ResolvedCrossBookSearchHit } from "../indexing/indexStore";
import type { ReadingLibrary } from "./retrieval";
import type { Evidence, SavedExchange } from "./types";

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
  history(exchanges: readonly SavedExchange[]): Array<{ question: string; answer: string }> {
    const recent = exchanges.filter(exchange => !exchange.interrupted).slice(-6);
    const remapped = new Map<SavedExchange, Map<string, string>>();
    let characters = 0;
    // Prefer recent source text; old/unknown corpus versions remain readable in UI but are not reused as evidence.
    for (const exchange of [...recent].reverse()) {
      const ids = new Map<string, string>();
      for (const source of exchange.evidence) {
        if (source.corpusVersion !== corpusVersion || !this.library.canRead(source.bookHash, source.spineIndex)) continue;
        if (this.byId.size >= 12 || characters + source.text.length > 18_000) break;
        const retained = this.retain([source.hit])[0];
        if (retained) { ids.set(source.id, retained.id); characters += source.text.length; }
      }
      remapped.set(exchange, ids);
    }
    return recent.map(exchange => ({ question: exchange.question,
      answer: exchange.answer.replace(/\[(E\d+)\]/gu, (_, id: string) => remapped.get(exchange)?.has(id)
        ? `[${remapped.get(exchange)!.get(id)}]` : "（历史出处未提供，需要时重新查阅）") }));
  }
}
