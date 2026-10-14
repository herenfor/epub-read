import { parseHTML } from "linkedom";
import { describe, expect, it } from "vitest";
import {
  PAGE_BACKGROUND_LANE_TAG,
  PAGE_BACKGROUND_SOURCE_ATTR,
  installPageBackgroundLanes,
} from "./pageBackgroundLanes";

/** linkedom has no cascade: computed values come straight from inline styles. */
function chapter(bodyStyle: string, rootStyle = ""): Document {
  const { document } = parseHTML(
    `<html style="${rootStyle}"><head></head><body style="${bodyStyle}"><epub-viewer id="epub-viewer"><p>text</p></epub-viewer></body></html>`,
  );
  const win = document.defaultView as unknown as { getComputedStyle: (el: HTMLElement) => unknown };
  win.getComputedStyle = (el: HTMLElement) => ({
    get backgroundImage() {
      return el.style.getPropertyValue("background-image") || "none";
    },
    getPropertyValue: (property: string) => el.style.getPropertyValue(property),
  });
  return document as unknown as Document;
}

const lanesOf = (doc: Document) => Array.from(doc.querySelectorAll(PAGE_BACKGROUND_LANE_TAG)) as HTMLElement[];

describe("page background lanes (A12)", () => {
  it("does nothing for a chapter without a page background image", () => {
    const doc = chapter("background-color: #231816");
    expect(installPageBackgroundLanes(doc)).toBeNull();
    expect(lanesOf(doc)).toHaveLength(0);
  });

  it("moves the body image onto two lanes outside the paginated viewer and restores it", () => {
    const doc = chapter("background-image: url(curtain.png); background-size: cover; background-attachment: fixed");
    // linkedom re-lists <body> after an insertBefore on <html>; keep the original node.
    const body = doc.body;
    const lanes = installPageBackgroundLanes(doc)!;
    expect(lanes).not.toBeNull();

    const [left, right] = lanesOf(doc);
    expect(left.parentElement).toBe(doc.documentElement);
    expect(right.parentElement).toBe(doc.documentElement);
    expect(body.querySelector(PAGE_BACKGROUND_LANE_TAG)).toBeNull();
    expect(doc.getElementById("epub-viewer")!.querySelector(PAGE_BACKGROUND_LANE_TAG)).toBeNull();
    expect(left.style.getPropertyValue("background-image")).toBe("url(curtain.png)");
    expect(left.style.getPropertyValue("background-size")).toBe("cover");
    expect(left.style.getPropertyValue("background-attachment")).toBe("scroll");
    expect(body.style.getPropertyValue("background-image")).toBe("none");
    expect(body.getAttribute(PAGE_BACKGROUND_SOURCE_ATTR)).toBe("url(curtain.png)");

    lanes.dispose();
    expect(lanesOf(doc)).toHaveLength(0);
    expect(body.style.getPropertyValue("background-image")).toBe("url(curtain.png)");
    expect(body.hasAttribute(PAGE_BACKGROUND_SOURCE_ATTR)).toBe(false);
  });

  it("shows the image only on pages that have content, split at the spread centre", () => {
    const doc = chapter("background-image: url(curtain.png)");
    const lanes = installPageBackgroundLanes(doc)!;
    lanes.update({ splitX: 1000, leftFilled: true, rightFilled: false });
    const [left, right] = lanesOf(doc);
    expect(left.style.getPropertyValue("width")).toBe("1000px");
    expect(left.style.getPropertyValue("display")).toBe("block");
    expect(right.style.getPropertyValue("left")).toBe("1000px");
    expect(right.style.getPropertyValue("display")).toBe("none");

    lanes.update({ splitX: 1000, leftFilled: true, rightFilled: true });
    expect(right.style.getPropertyValue("display")).toBe("block");
  });

  it("prefers the root element when html carries the page image", () => {
    const doc = chapter("", "background-image: url(root.png)");
    installPageBackgroundLanes(doc)!;
    expect(doc.documentElement.style.getPropertyValue("background-image")).toBe("none");
    expect(lanesOf(doc)[0].style.getPropertyValue("background-image")).toBe("url(root.png)");
  });
});
