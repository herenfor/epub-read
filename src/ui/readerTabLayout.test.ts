import { createElement } from "react";
import { describe, expect, it } from "vitest";
import { createReactDomHarness } from "../test/reactDomHarness";
import { readerTabsFitViewport, useReaderTabsVisible } from "./readerTabLayout";

describe("reader tab viewport eligibility", () => {
  it("keeps desktop tabs but excludes wide portrait tablets and landscape phones", () => {
    expect(readerTabsFitViewport(false, 700, 1000)).toBe(true);
    expect(readerTabsFitViewport(true, 1000, 1400)).toBe(false);
    expect(readerTabsFitViewport(true, 900, 412)).toBe(false);
    expect(readerTabsFitViewport(true, 1400, 1000)).toBe(true);
  });

  it("updates when a wide tablet rotates without crossing the wide breakpoint", async () => {
    const dom = createReactDomHarness();
    window.innerWidth = 1000;
    window.innerHeight = 1400;
    function Snapshot() {
      return createElement("output", null, String(useReaderTabsVisible(true)));
    }
    try {
      await dom.render(createElement(Snapshot));
      expect(dom.container.textContent).toBe("false");
      await dom.run(() => {
        window.innerWidth = 1400;
        window.innerHeight = 1000;
        window.dispatchEvent(new window.Event("resize"));
      });
      expect(dom.container.textContent).toBe("true");
      await dom.run(() => {
        window.innerWidth = 1000;
        window.innerHeight = 1400;
        window.dispatchEvent(new window.Event("resize"));
      });
      expect(dom.container.textContent).toBe("false");
    } finally {
      await dom.dispose();
    }
  });
});
