import { expect, it } from "vitest";
import { pageContentX, readPageScroll, writePageScroll } from "./pagedDirection";
import { columnAtPoint, containingFragmentAtPoint } from "./fragmentGeometry";
import { readSnapPosition, visibleSnapColumnSampleX } from "./nativeSnapPosition";

it("RTL keeps logical offsets ascending and samples the right leaf first without selecting the gutter", () => {
  const viewer = { scrollLeft: 0 };
  writePageScroll(viewer, 600, "rtl");
  expect(viewer.scrollLeft).toBe(-600);
  expect(readPageScroll(viewer, "rtl")).toBe(600);
  expect(pageContentX(850, 900, 600, "rtl")).toBe(650);
  const space = { originClientX: 900, scrollLeft: 600, progression: "rtl" as const,
    geometry: { columnWidth: 280, columnStep: 300 } };
  expect(columnAtPoint({ x: 850, y: 10 }, space)).toBe(2);
  expect(columnAtPoint({ x: 610, y: 10 }, space)).toBeNull();
  expect(containingFragmentAtPoint([
    { left: 320, right: 600, top: 0, bottom: 30 },
    { left: 620, right: 900, top: 0, bottom: 30 },
  ], { x: 850, y: 10 }, space)).toBe(1);
  expect(visibleSnapColumnSampleX({ position: readSnapPosition([0, 600, 1200], 600)!,
    contentOriginClientX: 900, viewportLeft: 300, viewportRight: 900,
    columnWidth: 280, columnStep: 300, columns: 2, progression: "rtl" })).toBe(760);
});
