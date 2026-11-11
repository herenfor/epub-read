import { describe, expect, it } from "vitest";
import { isSelectionSearchEngine, selectionSearchUrl } from "./selectionSearch";

describe("selection web search", () => {
  it("builds an encoded query for each engine and collapses whitespace", () => {
    expect(selectionSearchUrl("  量子\n纠缠 & more ", "bing")).toBe(`https://www.bing.com/search?q=${encodeURIComponent("量子 纠缠 & more")}`);
    expect(selectionSearchUrl("a b", "google")).toBe("https://www.google.com/search?q=a%20b");
    expect(selectionSearchUrl("词", "baidu")).toBe(`https://www.baidu.com/s?wd=${encodeURIComponent("词")}`);
  });

  it("returns nothing for an empty selection and cuts very long ones without splitting a character", () => {
    expect(selectionSearchUrl(" \n ", "bing")).toBeNull();
    const url = selectionSearchUrl("😀".repeat(300), "bing")!;
    expect(decodeURIComponent(url.split("q=")[1])).toBe("😀".repeat(120));
  });

  it("accepts only known engines", () => {
    expect(isSelectionSearchEngine("google")).toBe(true);
    expect(isSelectionSearchEngine("yahoo")).toBe(false);
  });
});
