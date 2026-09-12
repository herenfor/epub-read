import { describe, expect, it } from "vitest";

describe("AI UI CSS boundary", () => {
  it("keeps AI selectors out of the global stylesheet and loads them from the lazy panel", async () => {
    // @ts-expect-error The project intentionally does not include @types/node.
    const { readFile } = await import("node:fs/promises");
    const globalCss = await readFile(new URL("../../../styles.css", import.meta.url), "utf8");
    const aiCss = await readFile(new URL("./ai.css", import.meta.url), "utf8");
    const panel = await readFile(new URL("./AiFoundationPanel.tsx", import.meta.url), "utf8");
    expect(globalCss).not.toMatch(/\.ai-foundation-|\.model-assets-/);
    expect(aiCss).toMatch(/\.ai-foundation-panel/);
    expect(aiCss).toMatch(/\.model-assets-development/);
    expect(panel).toContain('import "./ai.css"');
  });
});
