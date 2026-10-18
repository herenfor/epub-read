import { describe, expect, it, vi } from "vitest";
import { parseHTML } from "linkedom";
import { installPlainTap } from "./plainTap";

function setup(claimsRepeatClick?: (point: { clientX: number; clientY: number }) => boolean,
  onPress?: (point: { clientX: number; clientY: number }) => void) {
  const { document } = parseHTML(`<html><body><p id="text">正文</p><a id="link" href="#x">链接</a><note id="footnote">脚注</note></body></html>`);
  const text = document.getElementById("text")!;
  const link = document.getElementById("link")!;
  const footnote = document.getElementById("footnote")!;
  const onTap = vi.fn();
  const cleanup = installPlainTap(document, { onTap, claimsRepeatClick, onPress });
  const touch = (type: "touchstart" | "touchmove" | "touchend" | "touchcancel", x: number, y: number, target: Element = text) => {
    const event = new (document.defaultView as any).Event(type, { bubbles: true, cancelable: true });
    const point = { clientX: x, clientY: y };
    Object.defineProperty(event, "touches", { value: type === "touchend" || type === "touchcancel" ? [] : [point] });
    Object.defineProperty(event, "changedTouches", { value: [point] });
    target.dispatchEvent(event);
  };
  const mouse = (type: "pointerdown" | "mousedown" | "mousemove" | "click", x: number, y: number,
    options: { target?: Element; button?: number; detail?: number; pointerType?: string } = {}) => {
    const event = new (document.defaultView as any).Event(type, { bubbles: true, cancelable: true });
    for (const [key, value] of Object.entries({ clientX: x, clientY: y, button: options.button ?? 0,
      detail: options.detail ?? 1, pointerType: options.pointerType ?? "mouse" })) {
      Object.defineProperty(event, key, { value });
    }
    (options.target ?? text).dispatchEvent(event);
    return event as Event;
  };
  const click = (x: number, y: number, options: { target?: Element; button?: number; detail?: number; pointerType?: string } = {}) => {
    mouse("pointerdown", x, y, options);
    const down = mouse("mousedown", x, y, options);
    mouse("click", x, y, options);
    return down;
  };
  return { onTap, cleanup, touch, mouse, click, link, footnote };
}

describe("plain touch tap", () => {
  it("reports a short non-interactive tap once, with where it landed", () => {
    const { onTap, touch } = setup();
    touch("touchstart", 100, 100);
    touch("touchend", 102, 101);
    expect(onTap).toHaveBeenCalledTimes(1);
    expect(onTap).toHaveBeenLastCalledWith({ clientX: 102, clientY: 101, pointerType: "touch" });
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

describe("plain mouse click", () => {
  it("reports a primary click on body text once, as mouse input", () => {
    const { onTap, click } = setup();
    click(40, 200);
    expect(onTap).toHaveBeenCalledTimes(1);
    expect(onTap).toHaveBeenLastCalledWith({ clientX: 40, clientY: 200, pointerType: "mouse" });
  });

  it("ignores other buttons, drags, interactive targets and touch compatibility clicks", () => {
    const { onTap, click, mouse, touch, link, footnote } = setup();
    click(40, 200, { button: 2 });
    mouse("pointerdown", 40, 200);
    mouse("mousedown", 40, 200);
    mouse("mousemove", 90, 200);
    mouse("click", 90, 200);
    click(40, 200, { target: link });
    click(40, 200, { target: footnote });
    // A touch tap is reported by the touch path only; its trailing mouse events are not a second tap.
    touch("touchstart", 100, 100);
    touch("touchend", 100, 100);
    click(100, 100, { pointerType: "touch" });
    expect(onTap).toHaveBeenCalledTimes(1);
    expect(onTap.mock.calls[0][0].pointerType).toBe("touch");
  });

  it("keeps a claimed repeated click from selecting a word, and only there", () => {
    const claims = vi.fn((point: { clientX: number }) => point.clientX < 100);
    const { onTap, click } = setup(claims);
    expect(click(40, 200, { detail: 1 }).defaultPrevented).toBe(false);
    expect(click(40, 200, { detail: 2 }).defaultPrevented).toBe(true);
    expect(click(300, 200, { detail: 2 }).defaultPrevented).toBe(false);
    expect(onTap).toHaveBeenCalledTimes(3);
  });

  it("reports a press that may become a tap, but not on links or footnotes", () => {
    const onPress = vi.fn();
    const { click, link, footnote } = setup(undefined, onPress);
    click(40, 200);
    expect(onPress).toHaveBeenCalledTimes(1);
    expect(onPress.mock.calls[0][0]).toMatchObject({ clientX: 40, clientY: 200 });
    click(40, 200, { target: link });
    click(40, 200, { target: footnote });
    click(40, 200, { button: 2 });
    expect(onPress).toHaveBeenCalledTimes(1);
  });
});

describe("input surface that becomes hit-testable mid-touch", () => {
  function surface() {
    const { document } = parseHTML(`<html><body><div id="surface"></div></body></html>`);
    const element = document.getElementById("surface")! as unknown as HTMLElement;
    const onTap = vi.fn();
    const cleanup = installPlainTap(element, { onTap });
    const fire = (type: string, x: number, options: Record<string, unknown> = {}) => {
      const event = new (document.defaultView as any).Event(type, { bubbles: true, cancelable: true });
      const point = { clientX: x, clientY: 300 };
      const fields: Record<string, unknown> = { clientX: x, clientY: 300, button: 0, detail: 1, ...options };
      if (type.startsWith("touch")) {
        fields.touches = type === "touchend" ? [] : [point];
        fields.changedTouches = [point];
      }
      for (const [key, value] of Object.entries(fields)) Object.defineProperty(event, key, { value });
      element.dispatchEvent(event);
    };
    return { onTap, cleanup, fire };
  }

  it("does not turn on the compatibility click of a touch that went down in a leaf document", () => {
    const { onTap, fire } = surface();
    // Only the trailing mouse events of the leaf's touch reach the surface.
    fire("mousedown", 1100, { pointerType: "touch" });
    fire("click", 1100, { pointerType: "touch", pointerId: 7 });
    // Even with a stale mouse type and no pointerType on the click.
    fire("pointerdown", 40, { pointerType: "mouse", pointerId: 1 });
    fire("mousedown", 40);
    fire("click", 40, { pointerId: 1 });
    fire("mousedown", 1100);
    fire("click", 1100, { sourceCapabilities: { firesTouchEvents: true } });
    expect(onTap).toHaveBeenCalledTimes(1);
    expect(onTap.mock.calls[0][0]).toMatchObject({ clientX: 40, pointerType: "mouse" });
  });

  it("consumes its own touch once at touchend, never again on the trailing click", () => {
    const { onTap, fire } = surface();
    fire("pointerdown", 1100, { pointerType: "touch", pointerId: 9 });
    fire("touchstart", 1100);
    fire("touchend", 1100);
    fire("mousedown", 1100, { pointerType: "touch" });
    fire("click", 1100, { pointerType: "touch", pointerId: 9 });
    expect(onTap).toHaveBeenCalledTimes(1);
    expect(onTap.mock.calls[0][0]).toMatchObject({ clientX: 1100, pointerType: "touch" });
  });

  it("requires its own press for a mouse click", () => {
    const { onTap, fire, cleanup } = surface();
    fire("mousedown", 1100);
    fire("click", 1100, { pointerId: 1 });
    expect(onTap).not.toHaveBeenCalled();
    fire("pointerdown", 1100, { pointerType: "pen", pointerId: 3 });
    fire("mousedown", 1100);
    fire("click", 1100, { pointerId: 3 });
    expect(onTap).toHaveBeenCalledTimes(1);
    cleanup();
    fire("pointerdown", 1100, { pointerType: "mouse", pointerId: 1 });
    fire("mousedown", 1100);
    fire("click", 1100, { pointerId: 1 });
    expect(onTap).toHaveBeenCalledTimes(1);
  });
});
