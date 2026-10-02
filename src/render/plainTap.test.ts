import { describe, expect, it, vi } from "vitest";
import { parseHTML } from "linkedom";
import { installPlainTap } from "./plainTap";

function setup() {
  const { document } = parseHTML(`<html><body><p id="text">正文</p><a id="link" href="#x">链接</a><note id="footnote">脚注</note></body></html>`);
  const text = document.getElementById("text")!;
  const link = document.getElementById("link")!;
  const footnote = document.getElementById("footnote")!;
  const onTap = vi.fn();
  const cleanup = installPlainTap(document, { onTap });
  const touch = (type: "touchstart" | "touchmove" | "touchend" | "touchcancel", x: number, y: number, target: Element = text) => {
    const event = new (document.defaultView as any).Event(type, { bubbles: true, cancelable: true });
    const point = { clientX: x, clientY: y };
    Object.defineProperty(event, "touches", { value: type === "touchend" || type === "touchcancel" ? [] : [point] });
    Object.defineProperty(event, "changedTouches", { value: [point] });
    target.dispatchEvent(event);
  };
  return { onTap, cleanup, touch, link, footnote };
}

describe("plain touch tap", () => {
  it("reports a short non-interactive tap once", () => {
    const { onTap, touch } = setup();
    touch("touchstart", 100, 100);
    touch("touchend", 102, 101);
    expect(onTap).toHaveBeenCalledTimes(1);
  });

  it("does not report movement or interactive targets", () => {
    const { onTap, touch, link, footnote } = setup();
    touch("touchstart", 100, 100);
    touch("touchmove", 130, 100);
    touch("touchend", 130, 100);
    touch("touchstart", 100, 100, link);
    touch("touchend", 100, 100, link);
    touch("touchstart", 100, 100, footnote);
    touch("touchend", 100, 100, footnote);
    expect(onTap).not.toHaveBeenCalled();
  });

  it("does not report after touchcancel and removes listeners on cleanup", () => {
    const { onTap, cleanup, touch } = setup();
    touch("touchstart", 100, 100);
    touch("touchcancel", 100, 100);
    touch("touchend", 100, 100);
    expect(onTap).not.toHaveBeenCalled();
    cleanup();
    touch("touchstart", 100, 100);
    touch("touchend", 100, 100);
    expect(onTap).not.toHaveBeenCalled();
  });
});
