import { describe, expect, it } from "vitest";

async function readSource(path: string): Promise<string> {
  // @ts-expect-error The project intentionally does not include @types/node.
  const { readFile } = await import("node:fs/promises");
  return readFile(new URL(path, import.meta.url), "utf8");
}

describe("AI release development-action boundary", () => {
  it("keeps the panel action gate tied to the immutable build session", async () => {
    const source = await readSource("./AiFoundationPanel.tsx");
    expect(source).toContain("isAiDevelopmentActionsAllowed");
    expect(source).toContain("const developmentActionsAllowed = isAiDevelopmentActionsAllowed();");
    expect(source).toContain("{developmentActionsAllowed && <div className=\"ai-foundation-actions\">");
    expect(source).toContain("<ModelAssetsDevelopmentSection allowDevelopmentActions={developmentActionsAllowed} />");
  });

  it("only exposes test catalog registration when development actions are allowed", async () => {
    const source = await readSource("./ModelAssetsDevelopmentSection.tsx");
    expect(source).toContain("allowDevelopmentActions: boolean");
    expect(source).toContain("{allowDevelopmentActions && <button");
    expect(source).toContain("controller.registerDevelopmentCatalog()");
    expect(source).toContain("选择模型库");
    expect(source).toContain("导入 linked 目录");
  });
});
