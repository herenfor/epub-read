import { describe, expect, it } from "vitest";
import { installMenuEdgeFades, scrollEdgeState } from "./scrollEdgeFade";
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
