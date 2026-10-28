import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Switch } from "./Switch";
import { SettingsSwitchRow } from "../settingsRows";

describe("Switch", () => {
  it("is one role=switch checkbox drawn on the shared track", () => {
    const html = renderToStaticMarkup(createElement(Switch, { checked: true, onChange: vi.fn(), label: "预读" }));
    expect(html).toMatch(/^<label class="ui-switch"/);
    expect(html).toMatch(/<input type="checkbox" role="switch"[^>]*aria-label="预读"/);
    expect(html).toMatch(/<input[^>]*checked=""/);
    expect(html).toContain('class="ui-switch-track"');
  });

  it("inside a row it is a span, so the row's own label toggles it", () => {
    const html = renderToStaticMarkup(createElement(SettingsSwitchRow, { title: "导入时复制", checked: false, onChange: vi.fn() }));
    expect(html).toMatch(/^<label class="shelf-settings-row is-switch">/);
    expect(html).toContain('<span class="ui-switch">');
    expect(html.match(/<label/g)).toHaveLength(1);
    // Switch rows carry no icon tile; only rows that open a page do.
    expect(html).not.toContain("shelf-settings-row-icon");
  });

  it("disabled stays disabled", () => {
    const html = renderToStaticMarkup(createElement(Switch, { checked: false, disabled: true, onChange: vi.fn() }));
    expect(html).toMatch(/<input[^>]*disabled=""/);
  });
});
