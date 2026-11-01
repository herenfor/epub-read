import { describe, expect, it } from "vitest";
import { attachScrollEdgeFade, installMenuEdgeFades, scrollEdgeState } from "./scrollEdgeFade";
import { createReactDomHarness } from "../test/reactDomHarness";

describe("scroll edge fade", () => {
  it("fades only the ends that still hide content", () => {
    expect(scrollEdgeState({ scrollTop: 0, clientHeight: 300, scrollHeight: 300 })).toBe("");
    expect(scrollEdgeState({ scrollTop: 0, clientHeight: 300, scrollHeight: 900 })).toBe("bottom");
    expect(scrollEdgeState({ scrollTop: 200, clientHeight: 300, scrollHeight: 900 })).toBe("top bottom");
    expect(scrollEdgeState({ scrollTop: 600, clientHeight: 300, scrollHeight: 900 })).toBe("top");
    // Sub-pixel rounding at the end is not hidden content.
    expect(scrollEdgeState({ scrollTop: 599.5, clientHeight: 300, scrollHeight: 900 })).toBe("top");
  });

  it("gives the touch fade bars the scroller's gap and padding, and clears them on detach", async () => {
    const dom = createReactDomHarness({
      resizeObserver: true,
      animationFrames: 0,
      computedStyle: () => ({ display: "flex", rowGap: "6px", paddingTop: "8px", paddingBottom: "24px", paddingLeft: "0px", paddingRight: "0px" }),
    });
    const { document } = dom.window;
    try {
      const list = document.createElement("div");
      list.style.color = "red";
      document.body.appendChild(list);
      const detach = attachScrollEdgeFade(list);
      expect(list.style.getPropertyValue("--edge-fade-gap")).toBe("6px");
      expect(list.style.getPropertyValue("--edge-fade-pad-top")).toBe("8px");
      expect(list.style.getPropertyValue("--edge-fade-pad-bottom")).toBe("24px");
      expect(list.style.getPropertyValue("--edge-fade-pad-left")).toBe("0px");
      detach();
      expect(list.style.getPropertyValue("--edge-fade-gap")).toBe("");
      expect(list.style.getPropertyValue("--edge-fade-pad-top")).toBe("");
      // The scroller's own inline styles stay.
      expect(list.style.color).toBe("red");
    } finally {
      await dom.dispose();
    }
  });

  it("attaches to listed menus as they mount and lets go when they unmount", async () => {
    const dom = createReactDomHarness({ resizeObserver: true, animationFrames: 0 });
    dom.frames();
    const { document } = dom.window;
    try {
      const root = document.createElement("div");
      document.body.appendChild(root);
      const stop = installMenuEdgeFades(root, [".menu-list"]);
      const menu = document.createElement("div");
      menu.className = "menu-list";
      root.appendChild(menu);
      const other = document.createElement("div");
      root.appendChild(other);
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(menu.hasAttribute("data-edge-fade")).toBe(true);
      expect(other.hasAttribute("data-edge-fade")).toBe(false);
      stop();
      expect(menu.hasAttribute("data-edge-fade")).toBe(false);
    } finally {
      await dom.dispose();
    }
  });
});
