import { isLatinText, type ShareCardContent } from "./shareCardModel";

/**
 * Text helpers for sharing: whitespace tidy-up, sentence steps for the
 * "− one sentence / + one sentence" control, and the citation copied as
 * plain text. The copied text never names the app.
 */

/** Collapses runs of spaces inside paragraphs and drops blank paragraphs. */
export function tidyPassage(text: string): string {
  return text
    .split(/\r?\n/)
    .map((line) => line.replace(/[ \t 　]+/g, " ").trim())
    .filter(Boolean)
    .join("\n");
}

const CJK_SENTENCE = /[^。！？；…\n]+(?:[。！？；]+|…+)?[」』”’）)]*\n?|\n/g;
const LATIN_SENTENCE = /[^.!?\n]+(?:[.!?]+[”’"')\]]*(?=\s|$))?\s*|\n/g;

/**
 * Splits a passage into sentences that keep their own punctuation and
 * closing quotes, so joining them gives back the passage.
 */
export function splitSentences(text: string): string[] {
  const latin = isLatinText(text);
  const parts = text.match(latin ? LATIN_SENTENCE : CJK_SENTENCE) ?? [];
  const out: string[] = [];
  for (const part of parts) {
    if (!part.trim()) {
      if (out.length) out[out.length - 1] += part;
      continue;
    }
    out.push(part);
  }
  return out.length ? out : [text];
}

/** The first `count` sentences of a passage, at least one. */
export function takeSentences(text: string, count: number): string {
  const sentences = splitSentences(text);
  return sentences.slice(0, Math.max(1, Math.min(count, sentences.length))).join("").trim();
}

/**
 * The passage as plain text with its source:
 * 「……」 —— 作者《书名 · 章节》, or “…” — Author, Title, Chapter.
 * Quotes already inside the passage step down one level (「」→『』, “”→‘’).
 */
export function formatShareCitation(content: ShareCardContent, options: { showChapter: boolean }): string {
  const quote = tidyPassage(content.quote);
  const title = content.bookTitle.trim();
  const author = content.author?.trim() ?? "";
  const chapter = options.showChapter ? content.chapter?.trim() ?? "" : "";
  if (isLatinText(quote) && isLatinText(title)) {
    const inner = quote.replace(/“/g, "‘").replace(/”/g, "’");
    const source = [author, title, chapter].filter(Boolean).join(", ");
    return `“${inner}”\n— ${source}`;
  }
  const inner = quote.replace(/「/g, "『").replace(/」/g, "』");
  const book = chapter ? `《${title} · ${chapter}》` : `《${title}》`;
  return `「${inner}」\n—— ${author}${book}`;
}
