import { createElement } from "react";
import { expect, it, vi } from "vitest";
import { createReactDomHarness } from "../test/reactDomHarness";
import { BookmarkPagesPopover, WARM_BOOKMARK_PAGES_SCREEN } from "./BookmarkPagesPopover";

it("A17: a warm-up copy draws both tile kinds but never closes, focuses or listens", async () => {
  const dom = createReactDomHarness();
  const onClose = vi.fn();
  const docAdd = vi.spyOn(document, "addEventListener");
  await dom.render(createElement(BookmarkPagesPopover, {
    warm: true, screen: WARM_BOOKMARK_PAGES_SCREEN,
    onRemove: vi.fn(), onAdd: vi.fn(), onHint: vi.fn(), onClose,
  }));
  expect(dom.container.querySelectorAll(".bookmark-page-tile.empty")).toHaveLength(1);
  expect(dom.container.querySelectorAll(".bookmark-page-tile.has")).toHaveLength(1);
  expect(docAdd.mock.calls.map(([type]) => type)).not.toContain("pointerdown");
  expect(document.activeElement?.closest?.(".bookmark-pages-popover") ?? null).toBeNull();
  expect(onClose).not.toHaveBeenCalled();
  await dom.dispose();
});
