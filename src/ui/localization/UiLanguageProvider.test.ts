import { createElement, useState } from "react";
import { describe, expect, it } from "vitest";
import { createReactDomHarness } from "../../test/reactDomHarness";
import { en } from "./catalog";
import { createUiLanguageStore, translatePlural } from "./core";
import { UiLanguageProvider, useUiText } from "./UiLanguageProvider";

function Probe() {
  const { t } = useUiText();
  const [clicks, setClicks] = useState(0);
  return createElement("button", { type: "button", onClick: () => setClicks((n) => n + 1) }, `${t("common.cancel")}:${clicks}`);
}

describe("UI language provider", () => {
  it("switches text in place without remounting and mirrors the app lang", async () => {
    const dom = createReactDomHarness();
    const store = createUiLanguageStore({ read: () => null, write: () => {}, systemLanguages: () => [] });
    try {
      await dom.render(createElement(UiLanguageProvider, { store }, createElement(Probe)));
      const button = dom.container.querySelector("button")!;
      await dom.click(button);
      expect(button.textContent).toBe("取消:1");
      expect(document.documentElement.lang).toBe("zh-CN");
      await dom.run(() => store.setPreference("en"));
      expect(dom.container.querySelector("button")).toBe(button);
      expect(button.textContent).toBe("Cancel:1");
      expect(document.documentElement.lang).toBe("en");
    } finally {
      await dom.dispose();
    }
  });

  it("picks English singular/plural forms and keeps Chinese uniform", () => {
    const saved = { one: en["search.count.one"], other: en["search.count.other"] };
    try {
      en["search.count.one"] = "{count} result";
      en["search.count.other"] = "{count} results";
      expect(translatePlural("en", "search.count", 1, { count: 1 })).toBe("1 result");
      expect(translatePlural("en", "search.count", 3, { count: 3 })).toBe("3 results");
      expect(translatePlural("zh-CN", "search.count", 1, { count: 1 })).toBe("1 条");
      expect(translatePlural("zh-CN", "search.count", 3, { count: 3 })).toBe("3 条");
    } finally {
      en["search.count.one"] = saved.one;
      en["search.count.other"] = saved.other;
    }
  });
});
