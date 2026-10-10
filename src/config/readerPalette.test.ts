import { describe, expect, it } from "vitest";
import { parseHTML } from "linkedom";
import { READER_PALETTES } from "./readerPalette";
import { DEFAULT_SETTINGS, type Theme } from "../render/settings";
import { sanitizeChapter } from "../render/sanitize";
import { THEME_PALETTES } from "../ui/AaPopover";

const themes: Theme[] = ["light", "sepia", "gray", "dark"];

describe("reader palette boundaries", () => {
  it("keeps application colors and Aa previews aligned with their semantic palette", async () => {
    // @ts-expect-error The project intentionally does not include @types/node.
    const { readFile } = await import("node:fs/promises");
    const css = await readFile(new URL("../styles.css", import.meta.url), "utf8");
    for (const theme of themes) {
      const palette = READER_PALETTES[theme];
      const selector = theme === "light" ? ":root" : `[data-theme="${theme}"]`;
      const block = css.slice(css.indexOf(`\n${selector} {`)).split("}")[0];
      expect(block).toContain(`--bg: ${palette.background};`);
      expect(block).toContain(`--fg: ${palette.uiForeground};`);
      expect(THEME_PALETTES.find((preview) => preview.id === theme)).toMatchObject({
        bg: palette.background, fg: palette.foreground, border: palette.previewBorder,
      });
    }
  });

  it.each(themes)("preserves author background images and user CSS in %s", async (theme) => {
    const palette = READER_PALETTES[theme];
    const { html } = await sanitizeChapter(
      '<html><body style="background-image:url(../Images/paper.png)"><p>Text</p></body></html>',
      {
        basePath: "Text/chapter.xhtml",
        strictXml: false,
        urlFor: (path) => `blob:test/${path}`,
        settings: { ...DEFAULT_SETTINGS, theme, customCss: "body { color: magenta; }" },
      },
    );
    const { document } = parseHTML(html);
    const css = [...document.querySelectorAll("style")].map((node) => node.textContent).join("\n");
    expect(document.body.getAttribute("style")).toContain("blob:test/Images/paper.png");
    expect(css).toContain(`body { color: ${palette.foreground}; background-color: ${palette.background};`);
    expect(css).toContain(`text-decoration-color: ${palette.noteUnderline};`);
    expect(css).toContain(`background-color: ${palette.searchBackground};`);
    expect(css).toContain(`color: ${palette.searchForeground};`);
    expect(css.indexOf("body { color: magenta; }")).toBeGreaterThan(css.indexOf(`body { color: ${palette.foreground};`));
  });
});
