import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Segmented } from "./Segmented";
import { createReactDomHarness } from "../../test/reactDomHarness";

const options = [
  { value: "single", label: "单页" },
  { value: "spread", label: "双页" },
  { value: "scroll", label: "滚动", disabled: true },
] as const;

describe("Segmented", () => {
  it("is one radio group on the shared look, the choice marked checked", () => {
    const html = renderToStaticMarkup(createElement(Segmented, { label: "排版方式", value: "spread", options, onChange: vi.fn(), variant: "compact", className: "x-place" }));
    expect(html).toMatch(/^<div class="ui-segmented is-compact x-place" role="radiogroup" aria-label="排版方式">/);
    expect(html).toMatch(/role="radio" aria-checked="true" class="active"[^>]*>双页</);
    expect(html).toMatch(/role="radio" aria-checked="false"[^>]*>单页</);
    expect(html).toMatch(/disabled=""[^>]*>滚动</);
  });

  it("reports the option pressed", async () => {
    const onChange = vi.fn();
    const dom = createReactDomHarness();
    try {
      await dom.render(createElement(Segmented, { label: "排版方式", value: "single", options, onChange }));
      const buttons = dom.container.querySelectorAll("button");
      await dom.click(buttons[1]);
      expect(onChange).toHaveBeenCalledWith("spread");
    } finally {
      await dom.dispose();
    }
  });
});
