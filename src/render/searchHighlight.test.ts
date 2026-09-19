import { describe, expect, it, vi } from "vitest";
import {
  applySearchHighlight,
  clearSearchHighlight,
  SEARCH_HIGHLIGHT_NAME,
} from "./searchHighlight";

function fakeDocument() {
  const set = vi.fn();
  const remove = vi.fn();
  class Highlight {
    readonly ranges: Range[];
    constructor(...ranges: Range[]) {
      this.ranges = ranges;
    }
  }
  const doc = {
    defaultView: {
      CSS: { highlights: { set, delete: remove } },
      Highlight,
    },
  } as unknown as Document;
  return { doc, set, remove, Highlight };
}

describe("search highlight registry", () => {
  it("sets and removes only the owned highlight name", () => {
    const { doc, set, remove, Highlight } = fakeDocument();
    const range = {} as Range;
    expect(applySearchHighlight(doc, [range])).toBe("applied");
    expect(set).toHaveBeenCalledTimes(1);
    expect(set.mock.calls[0][0]).toBe(SEARCH_HIGHLIGHT_NAME);
    expect(set.mock.calls[0][1]).toBeInstanceOf(Highlight);

    clearSearchHighlight(doc);
    expect(remove).toHaveBeenCalledWith(SEARCH_HIGHLIGHT_NAME);
  });

  it("reports unsupported without falling back to DOM ranges/selection", () => {
    expect(applySearchHighlight({ defaultView: {} } as unknown as Document, [{} as Range]))
      .toBe("unsupported");
  });
});
