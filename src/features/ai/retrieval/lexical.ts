import { normalizeCorpusText } from "../../../core/corpus";
import type { ResolvedCrossBookSearchHit } from "../indexing/indexStore";

/** Space-separated terms are a conjunction; separate queries are alternatives. */
export function queryTerms(query: string): string[] {
  return [...new Set(normalizeCorpusText(query).trim().split(/\s+/u).filter(Boolean))];
}
export function prepareQueries(queries: string[]): string[] {
  const result = [...new Set(queries.map(query => normalizeCorpusText(query).trim()).filter(Boolean))].slice(0, 6);
  if (result.some(query => query.length > 256 || queryTerms(query).length > 8)) throw new Error("请拆成较短的检索线索，每条至多8个词");
  return result;
}
export function lexicalScore(text: string, query: string): number {
  const terms = queryTerms(query);
  if (!terms.length || terms.some(term => !text.includes(term))) return 0;
  const occurrences = terms.reduce((sum, term) => sum + Math.min(8, text.split(term).length - 1), 0);
  return (text.includes(query) ? 1 : 0) + occurrences / Math.sqrt(Math.max(text.length, 1));
}
export function rankLexicalHits(hits: ResolvedCrossBookSearchHit[], query: string, limit = 80): ResolvedCrossBookSearchHit[] {
  return hits.map(hit => ({ hit, score: lexicalScore(hit.normalizedText, query) })).filter(item => item.score > 0)
    .sort((a, b) => b.score - a.score || a.hit.spineIndex - b.hit.spineIndex || a.hit.textAnchor.start - b.hit.textAnchor.start)
    .slice(0, limit).map(item => item.hit);
}

/** RRF combines rankings without treating incompatible backend scores as comparable. */
export function fuseHits(lists: readonly (readonly ResolvedCrossBookSearchHit[])[], limit = 12): ResolvedCrossBookSearchHit[] {
  const scored = new Map<string, { hit: ResolvedCrossBookSearchHit; score: number }>();
  for (const list of lists) {
    const seen = new Set<string>();
    list.forEach((hit, rank) => {
      const key = `${hit.contentHash}:${hit.chunkId}`;
      if (seen.has(key)) return;
      seen.add(key);
      const entry = scored.get(key) ?? { hit, score: 0 };
      entry.score += 1 / (60 + rank + 1); scored.set(key, entry);
    });
  }
  const result: ResolvedCrossBookSearchHit[] = [];
  for (const { hit } of [...scored.values()].sort((a, b) => b.score - a.score)) {
    if (result.some(other => other.contentHash === hit.contentHash && other.chapterPath === hit.chapterPath
      && Math.min(other.textAnchor.end, hit.textAnchor.end) - Math.max(other.textAnchor.start, hit.textAnchor.start)
        > 0.8 * Math.min(other.textAnchor.end - other.textAnchor.start, hit.textAnchor.end - hit.textAnchor.start))) continue;
    result.push(hit);
    if (result.length >= limit) break;
  }
  return result;
}
