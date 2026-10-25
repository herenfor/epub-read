import { estimateTokens } from "./contextBudget";
import type { ConversationSegment, MemoryEntry } from "./conversationStore";

const terms = (text: string): Set<string> => new Set([...text.toLocaleLowerCase()
  .matchAll(/[a-z0-9]{2,}|(?=([\p{Script=Han}]{2}))/gu)].map(match => match[1] ?? match[0]));
const relevance = (query: Set<string>, text: string) => {
  const target = terms(text);
  return [...query].reduce((sum, term) => sum + Number(target.has(term)), 0);
};
/** Start with transparent lexical selection. The retrieval seam can later host
 * embeddings without changing persistence, source identity or runtime adapters. */
export function selectMemoryContext(segments: readonly ConversationSegment[], question: string, bookHash: string,
  softLimit: number): { summaries: ConversationSegment[]; memories: MemoryEntry[] } {
  const query = terms(question);
  const summaries: ConversationSegment[] = [];
  let tokens = 0;
  for (const segment of [...segments].reverse()) {
    const size = estimateTokens({ summary: segment.summary, openTopics: segment.openTopics, sources: segment.sources });
    if (tokens + size <= softLimit * 0.04) { summaries.push(segment); tokens += size; }
  }
  const entries = segments.flatMap(segment => segment.memories);
  const superseded = new Set(entries.flatMap(entry => entry.supersedesId ? [entry.supersedesId] : []));
  const candidates = entries.filter(entry => !superseded.has(entry.id)).map((entry, index) => ({ entry, index,
    score: relevance(query, entry.content) + (entry.bookHash === bookHash ? 2 : 0) }));
  candidates.sort((a, b) => b.score - a.score || b.index - a.index);
  const memories: MemoryEntry[] = [];
  const seen = new Set<string>();
  tokens = 0;
  for (const { entry, score } of candidates) {
    if (score === 0 && entry.kind !== "preference") continue;
    const key = `${entry.kind}:${entry.bookHash ?? ""}:${entry.content}`;
    const size = estimateTokens(entry);
    if (seen.has(key) || tokens + size > softLimit * 0.04) continue;
    memories.push(entry); seen.add(key); tokens += size;
  }
  return { summaries: summaries.reverse(), memories: memories.sort((a, b) => a.id.localeCompare(b.id)) };
}
