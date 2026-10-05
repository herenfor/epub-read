import { parseHTML } from "linkedom";
import { describe, expect, it } from "vitest";
import {
  DARK_THEME_CANDIDATE,
  applyDarkThemeContrast,
  compositeRgba,
  contrastRatio,
  parseRgba,
  type DarkThemeComputedStyle,
  type DarkThemeStyleAdapter,
} from "./darkThemeContrast";

function style(overrides: Partial<DarkThemeComputedStyle> = {}): DarkThemeComputedStyle {
  return {
    color: "rgb(212, 212, 212)",
    backgroundColor: "rgba(0, 0, 0, 0)",
    backgroundImage: "none",
    opacity: "1",
    ...overrides,
  };
}

function adapter(styles: Map<Element, DarkThemeComputedStyle>, onRead?: () => void): DarkThemeStyleAdapter {
  return {
    getComputedStyle: (element) => {
      onRead?.();
      return styles.get(element) ?? style();
    },
    setColor: (element, color) => {
      const current = styles.get(element) ?? style();
      styles.set(element, { ...current, color });
    },
    mark: (element) => element.setAttribute("data-reader-dark-contrast", "1"),
  };
}

describe("dark theme contrast repair", () => {
  it("parses RGB/alpha and composites translucent foreground over background", () => {
    expect(parseRgba("rgb(212, 212, 212)")).toEqual({ r: 212, g: 212, b: 212, a: 1 });
    expect(parseRgba("rgba(255, 255, 255, 0.8)")?.a).toBe(0.8);
    const result = compositeRgba(
      parseRgba("rgba(255, 255, 255, 0.8)")!,
      parseRgba("rgb(30, 30, 30)")!,
    );
    expect(Math.round(result.r)).toBe(210);
    expect(contrastRatio(parseRgba(DARK_THEME_CANDIDATE)!, result)).toBeGreaterThan(4.5);
  });

  it("only repairs the dark theme when the candidate materially improves contrast", () => {
    const { document } = parseHTML("<html><body><div id='box'><p>text</p></div></body></html>");
    const body = document.body;
    const box = document.querySelector("#box")!;
    const paragraph = document.querySelector("p")!;
    const styles = new Map<Element, DarkThemeComputedStyle>([
      [body, style({ backgroundColor: "rgb(30, 30, 30)" })],
      [box, style({ backgroundColor: "rgba(255, 255, 255, 0.8)" })],
      [paragraph, style()],
    ]);
    const count = applyDarkThemeContrast(document as unknown as Document, { theme: "dark", adapter: adapter(styles) });
    expect(count).toBe(2);
    expect(box.getAttribute("data-reader-dark-contrast")).toBe("1");
    expect(paragraph.getAttribute("data-reader-dark-contrast")).toBe("1");
    expect(styles.get(box)?.color).toBe(DARK_THEME_CANDIDATE);
    expect(applyDarkThemeContrast(document as unknown as Document, { theme: "light", adapter: adapter(styles) })).toBe(0);
    expect(applyDarkThemeContrast(document as unknown as Document, { theme: "sepia", adapter: adapter(styles) })).toBe(0);
  });

  it("repairs the gray theme when light background reduces contrast of gray foreground", () => {
    const { document } = parseHTML("<html><body><div id='box'><p>text</p></div></body></html>");
    const body = document.body;
    const box = document.querySelector("#box")!;
    const paragraph = document.querySelector("p")!;
    const styles = new Map<Element, DarkThemeComputedStyle>([
      [body, style({ backgroundColor: "rgb(45, 45, 48)" })],
      [box, style({ backgroundColor: "rgba(255, 255, 255, 0.85)" })],
      [paragraph, style({ color: "rgb(212, 212, 216)" })],
    ]);
    const count = applyDarkThemeContrast(document as unknown as Document, { theme: "gray", adapter: adapter(styles) });
    expect(count).toBe(2);
    expect(box.getAttribute("data-reader-dark-contrast")).toBe("1");
    expect(paragraph.getAttribute("data-reader-dark-contrast")).toBe("1");
    expect(styles.get(paragraph)?.color).toBe(DARK_THEME_CANDIDATE);
  });

  it("reads each element style once during a top-down traversal", () => {
    const { document } = parseHTML(
      "<html><body><div><p>one</p><section><span>two</span></section></div></body></html>",
    );
    const body = document.body;
    const styles = new Map<Element, DarkThemeComputedStyle>([[body, style({ backgroundColor: "rgb(30, 30, 30)" })]]);
    let reads = 0;
    applyDarkThemeContrast(document as unknown as Document, { theme: "dark", adapter: adapter(styles, () => reads++) });
    expect(reads).toBe(document.body.querySelectorAll("*").length + 2); // html + body and descendants
  });

  it("repairs opaque neutral dark author text for dark and gray backgrounds", () => {
    const darkDoc = parseHTML(
      "<html><body><p id='text'>正文</p></body></html>"
    ).document;
    const darkParagraph = darkDoc.querySelector("#text")!;
    const darkStyles = new Map<Element, DarkThemeComputedStyle>([
      [darkDoc.body, style({ backgroundColor: "rgb(30, 30, 30)" })],
      [darkParagraph, style({ color: "rgb(43, 43, 43)" })],
    ]);
    expect(
      applyDarkThemeContrast(darkDoc as unknown as Document, {
        theme: "dark",
        adapter: adapter(darkStyles),
      })
    ).toBe(1);
    expect(darkStyles.get(darkParagraph)?.color).toBe("#d4d4d4");
    expect(darkParagraph.getAttribute("data-reader-dark-contrast")).toBe("1");

    const grayDoc = parseHTML(
      "<html><body><p id='text'>正文</p></body></html>"
    ).document;
    const grayParagraph = grayDoc.querySelector("#text")!;
    const grayStyles = new Map<Element, DarkThemeComputedStyle>([
      [grayDoc.body, style({ backgroundColor: "rgb(45, 45, 48)" })],
      [grayParagraph, style({ color: "rgb(43, 43, 43)" })],
    ]);
    expect(
      applyDarkThemeContrast(grayDoc as unknown as Document, {
        theme: "gray",
        adapter: adapter(grayStyles),
      })
    ).toBe(1);
    expect(grayStyles.get(grayParagraph)?.color).toBe("#d4d4d8");
    expect(grayParagraph.getAttribute("data-reader-dark-contrast")).toBe("1");
  });

  it("conservatively skips user colors, non-neutral/translucent text, background images and opacity", () => {
    const { document } = parseHTML(
      "<html><body><p id='user'>user</p><p id='colored'>colored</p><p id='faded'>faded</p><p id='image'>image</p></body></html>"
    );
    const body = document.body;
    const user = document.querySelector("#user")!;
    const colored = document.querySelector("#colored")!;
    const faded = document.querySelector("#faded")!;
    const image = document.querySelector("#image")!;
    const styles = new Map<Element, DarkThemeComputedStyle>([
      [body, style({ backgroundColor: "rgb(30, 30, 30)" })],
      [user, style({ color: "rgb(100, 100, 100)" })],
      [colored, style({ color: "rgb(180, 40, 40)" })],
      [faded, style({ color: "rgba(100, 100, 100, 0.8)" })],
      [image, style({ backgroundColor: "rgb(255, 255, 255)", backgroundImage: "url(cover.png)" })],
    ]);
    const count = applyDarkThemeContrast(document as unknown as Document, {
      theme: "dark",
      adapter: adapter(styles),
      userOwnsColor: (element) => element === user,
    });
    expect(count).toBe(0);
    expect(user.hasAttribute("data-reader-dark-contrast")).toBe(false);
    expect(colored.hasAttribute("data-reader-dark-contrast")).toBe(false);
    expect(faded.hasAttribute("data-reader-dark-contrast")).toBe(false);
    expect(image.hasAttribute("data-reader-dark-contrast")).toBe(false);
  });
});
