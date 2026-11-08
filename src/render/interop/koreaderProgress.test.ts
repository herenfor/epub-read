import { DOMParser } from "linkedom";
import { describe, expect, it } from "vitest";
import { CHAPTER_2 } from "./epubCfi.fixture";
import { readKoreaderProgressSidecar, resolveKoreaderProgressPoint } from "./koreaderProgress";

const parser = new DOMParser();
const documentOf = (source: string): Document =>
  parser.parseFromString(source, "text/xml") as unknown as Document;

/** Official KOReader sidecar for the synthetic oracle EPUB. The device path stays in the file and must not come back out. */
const ORACLE_SIDECAR = `-- /home/reader/er0113-oracle/synthetic-oracle.sdr/metadata.epub.lua
return {
    ["annotations"] = {},
    ["cre_dom_version"] = 20240114,
    ["css"] = "./data/epub.css",
    ["copt_font_size"] = 22,
    ["doc_pages"] = 2,
    ["doc_path"] = "/home/reader/er0113-oracle/synthetic-oracle.epub",
    ["doc_props"] = {
        ["identifiers"] = "urn:synthetic:er0101",
        ["title"] = "CFI",
    },
    ["font_face"] = "Noto Serif",
    ["last_xpointer"] = "/body/DocFragment[1]/body/h1/text().0",
    ["partial_md5_checksum"] = "222497a06b183004d245e256009589e0",
    ["percent_finished"] = 0.5,
}
`;

const SPINE = ["OEBPS/Text/c1.xhtml", "OEBPS/Text/c2.xhtml"];

function sourceFor(version: number | null, chapterAt: (index: number) => string | null) {
  return {
    spinePaths: SPINE,
    creDomVersion: version,
    chapterDocument: (index: number) => {
      const xml = chapterAt(index);
      return xml ? documentOf(xml) : null;
    },
  };
}

describe("KOReader sidecar progress", () => {
  it("reads the oracle sidecar whitelist and drops paths, percent and appearance", () => {
    const parsed = readKoreaderProgressSidecar(ORACLE_SIDECAR);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.sidecar).toMatchObject({
      partialMd5Checksum: "222497a06b183004d245e256009589e0",
      title: "CFI",
      creDomVersion: 20240114,
      lastXPointer: "/body/DocFragment[1]/body/h1/text().0",
    });
    expect(parsed.sidecar.discarded).toEqual(expect.arrayContaining([
      "annotations", "copt_font_size", "css", "doc_pages", "doc_path", "doc_props", "font_face", "percent_finished",
    ]));
    const encoded = JSON.stringify(parsed.sidecar);
    expect(encoded).not.toContain("/home/reader");
    expect(encoded).not.toContain("0.5");
    expect(encoded).not.toContain("Noto Serif");
    expect(encoded).not.toContain("urn:synthetic");
  });

  it("rejects executed Lua and does not invent a default DOM version", () => {
    const hostile = readKoreaderProgressSidecar(`return { last_xpointer = os.execute("rm") }`);
    expect(hostile.ok).toBe(false);
    if (hostile.ok) return;
    expect(hostile.errorCode).toBe("unsafe-lua-construct");

    const missing = readKoreaderProgressSidecar(`return { ["last_xpointer"] = "/body/DocFragment[1]/body/p/text().0", ["percent_finished"] = 0.9 }`);
    expect(missing.ok).toBe(true);
    if (!missing.ok) return;
    expect(missing.sidecar.creDomVersion).toBeNull();
    expect(missing.sidecar.discarded).toContain("percent_finished");
    const landed = resolveKoreaderProgressPoint(missing.sidecar.lastXPointer, sourceFor(missing.sidecar.creDomVersion, (index) => index === 0 ? CHAPTER_2 : null));
    expect(landed.ok).toBe(false);
    if (landed.ok) return;
    expect(landed.grade).toBe("unsupported");
    expect(landed.reasons).toContain("crengine-dom-version-unsupported");
  });

  it("lands the engine non-zero offset on the second identical sentence", () => {
    const landed = resolveKoreaderProgressPoint(
      "/body/DocFragment[2]/body/p[2]/text().11",
      sourceFor(20240114, (index) => index === 1 ? CHAPTER_2 : null),
    );
    expect(landed).toEqual({
      ok: true,
      grade: "exact",
      locator: {
        locatorVersion: 1,
        chapterPath: "OEBPS/Text/c2.xhtml",
        spineIndexHint: 1,
        target: {
          kind: "text",
          textProfile: "visible-codepoints-no-whitespace-v1",
          offset: 11,
          snippet: "同一句话。",
        },
      },
    });
  });

  it("refuses missing chapters, bounds, old and future DOM versions, pages, whitespace and autoboxing", () => {
    const chapter = sourceFor(20240114, (index) => index === 1 ? CHAPTER_2 : null);
    const missing = resolveKoreaderProgressPoint("/body/DocFragment[3]/body/p/text().0", chapter);
    const bounds = resolveKoreaderProgressPoint("/body/DocFragment[2]/body/p[2]/text().80", chapter);
    const page = resolveKoreaderProgressPoint("12", chapter);
    const oldDom = resolveKoreaderProgressPoint("/body/DocFragment[2]/body/p[2]/text().11", sourceFor(20200223, () => CHAPTER_2));
    const futureDom = resolveKoreaderProgressPoint("/body/DocFragment[2]/body/p[2]/text().11", sourceFor(20270101, () => CHAPTER_2));
    const plain = `<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml"><body><p>abcdef</p></body></html>`;
    const plainSource = sourceFor(20240114, () => plain);
    const explicitBody = resolveKoreaderProgressPoint("/body[1]/DocFragment[1]/body[1]/p/text().1", plainSource);
    const omittedBody = resolveKoreaderProgressPoint("/body/DocFragment[1]/body/p/text().1", plainSource);
    const rootBody = resolveKoreaderProgressPoint("/body[999]/DocFragment[1]/body/p/text().1", plainSource);
    const chapterBodyIndex = resolveKoreaderProgressPoint("/body/DocFragment[1]/body[999]/p/text().1", plainSource);
    const unknownDom = resolveKoreaderProgressPoint("/body/DocFragment[1]/body/p/text().1", sourceFor(20250101, () => plain));
    const whitespace = resolveKoreaderProgressPoint(
      "/body/DocFragment[1]/body/p/text().3",
      sourceFor(20240114, () => `<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml"><body><p>同  一</p></body></html>`),
    );
    const autobox = resolveKoreaderProgressPoint(
      "/body/DocFragment[1]/body/p/text().0",
      sourceFor(20240114, () => `<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml"><body>hello<p>there</p></body></html>`),
    );
    const element = resolveKoreaderProgressPoint("/body/DocFragment[2]/body/p[2]", chapter);

    expect(missing).toMatchObject({ ok: false, reasons: ["chapter-missing"] });
    expect(bounds).toMatchObject({ ok: false, reasons: ["offset-out-of-bounds"] });
    expect(page).toMatchObject({ ok: false, reasons: ["paging-page-only"] });
    expect(explicitBody).toMatchObject({ ok: true, grade: "exact", locator: { target: { offset: 1, snippet: "bcdef" } } });
    expect(omittedBody).toMatchObject({ ok: true, grade: "exact", locator: { target: { offset: 1, snippet: "bcdef" } } });
    expect(oldDom).toMatchObject({ ok: false, grade: "unsupported", reasons: ["crengine-dom-version-unsupported"] });
    expect(futureDom).toMatchObject({ ok: false, grade: "unsupported", reasons: ["crengine-dom-version-unsupported"] });
    expect(unknownDom).toMatchObject({ ok: false, grade: "unsupported", reasons: ["crengine-dom-version-unsupported"] });
    expect(rootBody).toMatchObject({ ok: false, reasons: ["node-missing"] });
    expect(chapterBodyIndex).toMatchObject({ ok: false, reasons: ["node-missing"] });
    expect(whitespace).toMatchObject({ ok: false, reasons: ["crengine-whitespace-unverified"] });
    expect(autobox).toMatchObject({ ok: false, reasons: ["crengine-autoboxing"] });
    expect(element).toMatchObject({ ok: false, grade: "approximate", reasons: ["element-boundary"] });
    for (const result of [missing, bounds, page, oldDom, futureDom, unknownDom, rootBody, chapterBodyIndex, whitespace, autobox, element]) {
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result).not.toHaveProperty("locator");
    }
  });
});
