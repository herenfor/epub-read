import { createElement } from "react";
import { describe, expect, it, vi } from "vitest";
import { createReactDomHarness } from "../test/reactDomHarness";
import { ReaderReturnControl } from "./ReaderReturnControl";

describe("reader return control", () => {
  it("names where back/forward go, hides an empty direction, and nothing at all without history", async () => {
    const dom = createReactDomHarness();
    const onBack = vi.fn();
    const onForward = vi.fn();
    const render = (back: string | null, forward: string | null) =>
      dom.render(createElement(ReaderReturnControl, { back, forward, onBack, onForward, placement: "phone", raised: true }));
    const buttons = () => [...dom.container.querySelectorAll("button")];
    try {
      await render("第三章 注释", null);
      expect(buttons().map((b) => b.textContent)).toEqual(["返回 第三章 注释"]);
      expect(dom.container.querySelector(".reader-return")?.className).toBe("reader-return is-phone is-raised");
      await dom.click(buttons()[0]);
      expect(onBack).toHaveBeenCalledTimes(1);

      // After returning: forward appears; a target in the same chapter has no place name.
      await render(null, "");
      expect(buttons().map((b) => b.textContent)).toEqual(["前进"]);
      await dom.click(buttons()[0]);
      expect(onForward).toHaveBeenCalledTimes(1);

      await render("", "第五章");
      expect(buttons().map((b) => b.textContent)).toEqual(["返回", "前进到 第五章"]);

      await render(null, null);
      expect(dom.container.querySelector(".reader-return")).toBeNull();
    } finally {
      await dom.dispose();
    }
  });
});
