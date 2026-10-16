import { describe, expect, it } from "vitest";
import type { Book } from "../core/types";
import { ChapterDependencies } from "./chapterDependencies";

const css = `@font-face{font-family:"Body";src:url(../Fonts/body.ttf)}
@font-face{font-family:Title;src:url(../Fonts/title.ttf)}
@font-face{font-family:Ruby;src:url(../Fonts/ruby.ttf)}
@font-face{src:url(../Fonts/nameless.ttf)}
p.text{font-family:"Body",serif}
h1 .title{font-family:Title}
rt{font-family:Ruby}`;

function collect(body: string, stylesheet = css): Promise<Set<string>> {
  const texts = new Map<string, string>([
    ["OEBPS/Text/c.xhtml", `<html xmlns="http://www.w3.org/1999/xhtml"><head><link rel="stylesheet" href="../Styles/s.css"/></head><body>${body}</body></html>`],
    ["OEBPS/Styles/s.css", stylesheet],
  ]);
  const resources = new Map(["OEBPS/Text/c.xhtml", "OEBPS/Styles/s.css", "OEBPS/Fonts/body.ttf", "OEBPS/Fonts/title.ttf", "OEBPS/Fonts/ruby.ttf", "OEBPS/Fonts/nameless.ttf", "OEBPS/Fonts/inline.ttf"]
    .map((path) => [path, { path, mediaType: "", data: new Uint8Array() }]));
  const book = { version: 3, resources } as unknown as Book;
  return new ChapterDependencies(book, (path) => texts.get(path)).collect("OEBPS/Text/c.xhtml");
}

describe("ChapterDependencies fonts", () => {
  it("keeps only the @font-face files this chapter may use", async () => {
    const deps = await collect(`<p class="text">正文</p>`);
    expect(deps.has("OEBPS/Fonts/body.ttf")).toBe(true);
    expect(deps.has("OEBPS/Fonts/title.ttf")).toBe(false);
    expect(deps.has("OEBPS/Fonts/ruby.ttf")).toBe(false);
    // A face without a family name cannot be judged, so it stays.
    expect(deps.has("OEBPS/Fonts/nameless.ttf")).toBe(true);
  });

  it("drops every named font from a page that only shows an image", async () => {
    const deps = await collect(`<div><img src="../Images/a.jpg"/></div>`);
    expect([...deps].filter((path) => path.includes("/Fonts/"))).toEqual(["OEBPS/Fonts/nameless.ttf"]);
  });

  it("counts descendant selectors and inline styles", async () => {
    const deps = await collect(`<h1><span class="title">题</span></h1><ruby>字<rt>zi</rt></ruby><p style="font-family: 'Title'">x</p>`);
    expect(deps.has("OEBPS/Fonts/title.ttf")).toBe(true);
    expect(deps.has("OEBPS/Fonts/ruby.ttf")).toBe(true);
    expect(deps.has("OEBPS/Fonts/body.ttf")).toBe(false);
  });

  it("keeps an external face used by a chapter style rule", async () => {
    const deps = await collect(`<style>@media all { p {font-family: Body} }</style><p>text</p>`);
    expect(deps.has("OEBPS/Fonts/body.ttf")).toBe(true);
    expect(deps.has("OEBPS/Fonts/title.ttf")).toBe(false);
  });

  it("resolves chapter font faces relative to the chapter and prunes only unused ones", async () => {
    const deps = await collect(`<style>
      @font-face {font-family: Local; src:url(../Fonts/inline.ttf)}
      @font-face {font-family: Alias; src:url(../Fonts/body.ttf)}
      p {font-family: Alias}
    </style><p>text</p>`);
    // The shared file must survive the unused external Body face.
    expect(deps.has("OEBPS/Fonts/body.ttf")).toBe(true);
    expect(deps.has("OEBPS/Fonts/inline.ttf")).toBe(false);
  });

  it.each([
    `<p style="font: italic 16px Body">text</p>`,
    `<style>p {font: 16px Body}</style><p>text</p>`,
    `<style>:root {--body-font: Body} p {font-family:var(--body-font)}</style><p>text</p>`,
    `<p style="font-family:var(--body-font, Body)">text</p>`,
  ])("does not prune fonts when used declarations require CSS evaluation: %s", async (body) => {
    const deps = await collect(body);
    expect(deps.has("OEBPS/Fonts/body.ttf")).toBe(true);
  });

  it("does not disable pruning for a shorthand on an absent selector", async () => {
    const deps = await collect(`<p>text</p>`, `${css}\n.absent {font:16px Body}`);
    expect(deps.has("OEBPS/Fonts/body.ttf")).toBe(false);
  });
});
