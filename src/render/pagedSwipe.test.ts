import { describe, expect, it, vi } from "vitest";
import { parseHTML } from "linkedom";
import { installPagedSwipe } from "./pagedSwipe";

function setup() {
  const { document } = parseHTML(`<html><body>
    <p id="text">普通正文</p>
    <a id="link" href="#x">链接</a>
  </body></html>`);
  const text = document.getElementById("text")!;
  const link = document.getElementById("link")!;
  const onNext = vi.fn();
  const onPrev = vi.fn();
  const cleanup = installPagedSwipe(document, {
    onNext,
    onPrev,
    shouldIgnore: () => false,
  });
  const touchEvent = (type: "touchstart" | "touchmove" | "touchend" | "touchcancel", x: number, y: number, target: Element = text) => {
    const event = new (document.defaultView as any).Event(type, { bubbles: true, cancelable: true });
    const touch = { clientX: x, clientY: y };
    Object.defineProperty(event, "touches", { value: type === "touchend" || type === "touchcancel" ? [] : [touch] });
    Object.defineProperty(event, "changedTouches", { value: [touch] });
    target.dispatchEvent(event);
    return event;
  };
  return { document, text, link, onNext, onPrev, cleanup, touchEvent };
}

describe("paged swipe input", () => {
  it("commits one next step after a qualifying left swipe", () => {
    const { onNext, onPrev, touchEvent } = setup();
    touchEvent("touchstart", 300, 200);
    touchEvent("touchmove", 250, 202);
    touchEvent("touchmove", 180, 204);
    touchEvent("touchend", 180, 204);
    expect(onNext).toHaveBeenCalledTimes(1);
    expect(onPrev).not.toHaveBeenCalled();
  });

  it("commits one previous step after a qualifying right swipe", () => {
    const { onNext, onPrev, touchEvent } = setup();
    touchEvent("touchstart", 100, 200);
    touchEvent("touchmove", 160, 202);
    touchEvent("touchend", 200, 203);
    expect(onPrev).toHaveBeenCalledTimes(1);
    expect(onNext).not.toHaveBeenCalled();
  });

  it("cancels a candidate when a second finger joins", () => {
    const { document, text, onNext, onPrev, touchEvent } = setup();
    touchEvent("touchstart", 300, 200);
    const event = new (document.defaultView as any).Event("touchmove", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "touches", { value: [{ clientX: 260, clientY: 200 }, { clientX: 340, clientY: 200 }] });
    Object.defineProperty(event, "changedTouches", { value: [{ clientX: 340, clientY: 200 }] });
    text.dispatchEvent(event);
    touchEvent("touchend", 200, 200);
    expect(onNext).not.toHaveBeenCalled();
    expect(onPrev).not.toHaveBeenCalled();
  });

  it("cancels a candidate when the gesture is primarily vertical", () => {
    const { onNext, onPrev, touchEvent } = setup();
    touchEvent("touchstart", 300, 100);
    touchEvent("touchmove", 280, 220);
    touchEvent("touchend", 280, 220);
    expect(onNext).not.toHaveBeenCalled();
    expect(onPrev).not.toHaveBeenCalled();
  });

  it("does not start from an interactive target", () => {
    const { onNext, touchEvent, link } = setup();
    touchEvent("touchstart", 300, 200, link);
    touchEvent("touchmove", 200, 200, link);
    touchEvent("touchend", 200, 200, link);
    expect(onNext).not.toHaveBeenCalled();
  });

  it("removes document listeners when the controller is cleaned up", () => {
    const { cleanup, onNext, touchEvent } = setup();
    cleanup();
    touchEvent("touchstart", 300, 200);
    touchEvent("touchmove", 200, 200);
    touchEvent("touchend", 200, 200);
    expect(onNext).not.toHaveBeenCalled();
  });

  it("restores selection/cancel safety after touchcancel", () => {
    const { onNext, touchEvent } = setup();
    touchEvent("touchstart", 300, 200);
    touchEvent("touchmove", 200, 200);
    touchEvent("touchcancel", 200, 200);
    touchEvent("touchend", 200, 200);
    expect(onNext).not.toHaveBeenCalled();
  });

  it("keeps a single-finger swipe when Android WebView sends touch pointercancel before touch events end", () => {
    const { document, text, onNext, onPrev, touchEvent } = setup();
    touchEvent("touchstart", 300, 200);
    touchEvent("touchmove", 200, 200);
    const cancel = new (document.defaultView as any).Event("pointercancel", { bubbles: true, cancelable: true });
    Object.defineProperty(cancel, "pointerType", { value: "touch" });
    text.dispatchEvent(cancel);
    touchEvent("touchend", 180, 202);
    expect(onNext).toHaveBeenCalledTimes(1);
    expect(onPrev).not.toHaveBeenCalled();
  });

  it("suppresses only the click immediately following a committed swipe", () => {
    const { document, onNext, touchEvent, text } = setup();
    touchEvent("touchstart", 300, 200);
    touchEvent("touchmove", 200, 200);
    touchEvent("touchend", 200, 200);
    expect(onNext).toHaveBeenCalledTimes(1);

    const suppressible = new (document.defaultView as any).Event("click", { bubbles: true, cancelable: true });
    text.dispatchEvent(suppressible);
    expect(suppressible.defaultPrevented).toBe(true);

    // A new real touch starts a new gesture; its click must not be swallowed.
    touchEvent("touchstart", 300, 200);
    touchEvent("touchend", 300, 200);
    const nextClick = new (document.defaultView as any).Event("click", { bubbles: true, cancelable: true });
    text.dispatchEvent(nextClick);
    expect(nextClick.defaultPrevented).toBe(false);
  });
});
