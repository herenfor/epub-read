import { DOMParser } from "linkedom";
import { expect, it } from "vitest";
import { ChapterTextIndex, resolveCfiInDocument } from "./epubCfi";
import { matchEpubText } from "./epubTextMatch";
function chapter(body: string) {
  const doc = new DOMParser().parseFromString(`<html><head/><body>${body}</body></html>`, "text/xml") as unknown as Document;
  return { doc, index: new ChapterTextIndex(doc) };
}
it("projects ruby base text back into canonical coordinates, keeping rt but excluding rp", () => {
  const { index } = chapter('<p><ruby>伊武圣兰<rp>（</rp><rt>Ibu Seira</rt><rp>）</rp></ruby>后</p>');
  expect(index.slice(0, index.totalChars)).toBe("伊武圣兰IbuSeira后");
  expect(matchEpubText(index, "伊武圣兰（）", null)).toMatchObject({ start: 0, end: 4, kind: "presentation" });
});
it("matches presentation characters without inventing canonical offsets or choosing tied repetitions", () => {
  const { index } = chapter('<p>甲·乙丙丁甲·乙丙丁</p>');
  expect(matchEpubText(index, "甲乙丙丁", null)).toBeNull();
  expect(matchEpubText(index, "甲乙丙丁", 5)).toMatchObject({ start: 5, end: 10, kind: "content" });
  expect(matchEpubText(chapter('<p>零宽字符</p>').index, "零\u200b宽\u00ad字符", null)?.start).toBe(0);
});
it("clamps only on explicit opt in and keeps default CFI resolution strict", () => {
  const { doc, index } = chapter('<p>正文</p>');
  const steps = [{ index: 4 }, { index: 2 }, { index: 1, offset: 99 }];
  expect(resolveCfiInDocument(doc, steps)).toBeNull();
  const result = resolveCfiInDocument(doc, steps, { clampTextOffset: true });
  expect(result?.clamped).toBe(true);
  expect(index.offsetAt(result!.point)).toBe(2);
});
