import { describe, expect, it } from "vitest";
import type { Book } from "../core/types";
import { ImageChapterSpreads } from "./imageChapterSpreads";

const image = (name: string) => `<html xmlns="http://www.w3.org/1999/xhtml"><body><div><img src="${name}.png"/></div></body></html>`;
function fixture(bodies: string[], nonLinear = -1) {
  const book = {
    version: 2, opfPath: "book.opf",
    spine: bodies.map((_, index) => ({ idref: `${index}`, linear: index !== nonLinear })),
    manifest: new Map(bodies.map((_, index) => [`${index}`, { href: `${index}.xhtml` }])),
  } as Book;
  const reads: string[] = [];
  const resolver = new ImageChapterSpreads(book, async (path) => {
    reads.push(path);
    return bodies[Number.parseInt(path)];
  });
  return { resolver, reads, signal: new AbortController().signal };
}
describe("image chapter spreads", () => {
  it("keeps stable pairs on direct right-page jumps and an odd run when reversing", async () => {
    const { resolver, reads, signal } = fixture(["<html><body>正文</body></html>", ...[1, 2, 3, 4, 5].map(String).map(image)]);
    expect(await resolver.resolve(4, signal)).toEqual({ left: 3, right: 4 });
    expect(await resolver.resolve(5, signal)).toEqual({ left: 5, right: null });
    expect(await resolver.resolve(2, signal)).toEqual({ left: 1, right: 2 });
    expect(await resolver.resolve(3, signal)).toEqual({ left: 3, right: 4 });
    expect(reads.length).toBe(6); // One metadata read per inspected chapter, no image decoding.
  });
  it("skips non-linear entries without changing image-pair parity", async () => {
    const { resolver, signal } = fixture([image("a"), "<html><body>附录</body></html>", image("b"), image("c")], 1);
    expect(await resolver.resolve(2, signal)).toEqual({ left: 0, right: 2 });
    expect(await resolver.resolve(3, signal)).toEqual({ left: 3, right: null });
    expect(await resolver.resolve(1, signal)).toBeNull();
  });
  it("keeps single constrained art as its original leaf, and separates mixed/composed pages", async () => {
    const bodies = [
      `<html><body><img src="title.png" style="width:13em"/></body></html>`,
      `<html><body><img src="caption.png"/><p>图注</p></body></html>`,
      `<html><body><img src="a.png"/><img src="b.png"/></body></html>`,
      image("d"), image("e"),
    ];
    const { resolver, signal } = fixture(bodies);
    expect(await resolver.resolve(0, signal)).toEqual({ left: 0, right: null });
    for (let i = 1; i < 3; i++) expect(await resolver.resolve(i, signal)).toBeNull();
    expect(await resolver.resolve(4, signal)).toEqual({ left: 3, right: 4 });
  });
  it("pairs full-page SVG image wrappers without rewriting their viewBox", async () => {
    const svg = `<html><body><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 1800"><image href="a.png" width="1200" height="1800"/></svg></body></html>`;
    const { resolver, signal } = fixture([svg, image("b")]);
    expect(await resolver.resolve(1, signal)).toEqual({ left: 0, right: 1 });
  });
  it("includes a full-page picture's navigation caption without accepting ordinary illustrated text", async () => {
    const linked = `<html><body><a href="text.xhtml#image"><div class="kuchie"><img src="a.png"/></div><p>定位至文章</p></a></body></html>`;
    const { resolver, signal } = fixture([linked, image("b"), `<html><body><p>正文</p>${linked}</body></html>`]);
    expect(await resolver.resolve(1, signal)).toEqual({ left: 0, right: 1 });
    expect(await resolver.resolve(2, signal)).toBeNull();
  });
});
