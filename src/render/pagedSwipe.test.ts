import { describe, expect, it, vi } from "vitest";
import { parseHTML } from "linkedom";
import { installPagedSwipe } from "./pagedSwipe";

function setup(host = false) {
  const { document } = parseHTML(`<html><body><main id="surface">
    <p id="text">普通正文</p>
    <a id="link" href="#x">链接</a>
    <button id="button">按钮</button>
    <img id="image" src="cover.jpg" />
    <svg id="svg-image"><image href="cover.jpg" /></svg>
  </main></body></html>`);
  const text = document.getElementById("text")!;
  const link = document.getElementById("link")!;
  const button = document.getElementById("button")!;
  const onNext = vi.fn();
  const onPrev = vi.fn();
  const onPreview = vi.fn();
  const surface = host ? document.getElementById("surface")! : document.documentElement;
  // linkedom omits this standard CSSOM method; real WebViews provide it.
  Object.defineProperty(Object.getPrototypeOf(surface.style), "getPropertyPriority", {
    value: () => "", configurable: true,
  });
  const cleanup = installPagedSwipe(host ? surface : document, {
    onNext,
    onPrev,
    onPreview,
    shouldIgnore: () => false,
  });
  const touchEvent = (type: "touchstart" | "touchmove" | "touchend" | "touchcancel", x: number, y: number, target: Element = text, screen = { x, y }) => {
    const event = new (document.defaultView as any).Event(type, { bubbles: true, cancelable: true });
    const touch = { clientX: x, clientY: y, screenX: screen.x, screenY: screen.y };
    Object.defineProperty(event, "touches", { value: type === "touchend" || type === "touchcancel" ? [] : [touch] });
    Object.defineProperty(event, "changedTouches", { value: [touch] });
    target.dispatchEvent(event);
    return event;
  };
  return { document, surface, text, link, button, onNext, onPrev, onPreview, cleanup, touchEvent };
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
    const { onNext, touchEvent, button } = setup();
    touchEvent("touchstart", 300, 200, button);
    touchEvent("touchmove", 200, 200, button);
    touchEvent("touchend", 200, 200, button);
    expect(onNext).not.toHaveBeenCalled();
  });

  it.each(["image", "svg-image", "link"])("accepts a swipe on %s and suppresses its activation click", (id) => {
    const { document, onNext, onPrev, touchEvent } = setup();
    const image = document.getElementById(id)!;
    touchEvent("touchstart", 300, 200, image);
    touchEvent("touchmove", 200, 200, image);
    touchEvent("touchend", 180, 202, image);
    expect(onNext).toHaveBeenCalledTimes(1);
    expect(onPrev).not.toHaveBeenCalled();
    const click = new (document.defaultView as any).Event("click", { bubbles: true, cancelable: true });
    image.dispatchEvent(click);
    expect(click.defaultPrevented).toBe(true);
  });

  it("keeps image taps available to open the image viewer", () => {
    const { document, onNext, onPrev, touchEvent } = setup();
    const image = document.getElementById("image")!;
    touchEvent("touchstart", 300, 200, image);
    touchEvent("touchend", 300, 200, image);
    const click = new (document.defaultView as any).Event("click", { bubbles: true, cancelable: true });
    image.dispatchEvent(click);
    expect(click.defaultPrevented).toBe(false);
    expect(onNext).not.toHaveBeenCalled();
    expect(onPrev).not.toHaveBeenCalled();
  });

  it("shows feedback before committing and clears it on a short drag", () => {
    const { onNext, onPreview, touchEvent } = setup();
    touchEvent("touchstart", 300, 200);
    touchEvent("touchmove", 288, 202);
    expect(onPreview).toHaveBeenLastCalledWith(-12);
    expect(onNext).not.toHaveBeenCalled();
    touchEvent("touchend", 288, 202);
    expect(onPreview).toHaveBeenLastCalledWith(null);
    expect(onNext).not.toHaveBeenCalled();
  });

  it("accepts a qualifying final displacement even when moves were coalesced", () => {
    const { onNext, touchEvent } = setup();
    touchEvent("touchstart", 300, 200);
    touchEvent("touchmove", 288, 202);
    touchEvent("touchend", 270, 203);
    expect(onNext).toHaveBeenCalledTimes(1);
  });

  it("uses screen displacement when the preview moves the iframe viewport", () => {
    const { text, onNext, onPreview, touchEvent } = setup();
    touchEvent("touchstart", 100, 100, text, { x: 300, y: 200 });
    touchEvent("touchmove", 100, 100, text, { x: 270, y: 202 });
    expect(onPreview).toHaveBeenLastCalledWith(-30);
    touchEvent("touchend", 100, 100, text, { x: 260, y: 202 });
    expect(onNext).toHaveBeenCalledTimes(1);
  });

  it("accepts swipes on the host reading surface and restores its touch action", () => {
    const { surface, onNext, cleanup, touchEvent } = setup(true);
    expect(surface.style.getPropertyValue("touch-action")).toBe("pan-y pinch-zoom");
    touchEvent("touchstart", 300, 200, surface);
    touchEvent("touchmove", 200, 200, surface);
    touchEvent("touchend", 200, 200, surface);
    expect(onNext).toHaveBeenCalledTimes(1);
    cleanup();
    expect(surface.style.getPropertyValue("touch-action")).toBe("");
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
