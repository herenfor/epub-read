import { describe, expect, it } from "vitest";
import { parseHTML } from "linkedom";
import { PRESS_MIN_MS, installPressFeedback } from "./pressFeedback";

function setup() {
  const { document: doc, window: win } = parseHTML(`<html><body>
    <div class="sidebar-note-actions"><button class="sidebar-note-act" id="edit"><span id="label">编辑</span></button>
    <button class="sidebar-note-act danger" id="off" disabled>删除</button></div>
    <button class="ui-quiet-btn" id="quiet">分享</button><button id="plain">普通</button>
  </body></html>`);
  let clock = 0;
  const timers: { run: () => void; at: number }[] = [];
  const uninstall = installPressFeedback(doc, {
    now: () => clock,
    schedule: (run, ms) => { const t = { run, at: clock + ms }; timers.push(t); return t; },
    cancel: (t) => { const i = timers.indexOf(t as never); if (i >= 0) timers.splice(i, 1); },
  });
  const fire = (id: string, type: string, x = 0, y = 0, pointerId = 1) => {
    const event = new win.Event(type, { bubbles: true }) as Event & Record<string, number>;
    Object.assign(event, { pointerId, clientX: x, clientY: y, button: 0 });
    doc.getElementById(id)!.dispatchEvent(event);
  };
  const advance = (ms: number) => {
    clock += ms;
    for (const t of [...timers].sort((a, b) => a.at - b.at)) {
      if (t.at <= clock) { timers.splice(timers.indexOf(t), 1); t.run(); }
    }
  };
  const pressed = (id: string) => doc.getElementById(id)!.hasAttribute("data-pressed");
  return { fire, advance, pressed, uninstall };
}

describe("quiet button press feedback", () => {
  it("marks the button the moment the finger lands and holds a quick tap for the minimum time", () => {
    const { fire, advance, pressed, uninstall } = setup();
    fire("label", "pointerdown");
    expect(pressed("edit")).toBe(true);
    advance(30);
    fire("label", "pointerup");
    expect(pressed("edit")).toBe(true);
    advance(PRESS_MIN_MS - 31);
    expect(pressed("edit")).toBe(true);
    advance(1);
    expect(pressed("edit")).toBe(false);
    uninstall();
  });

  it("releases a long press at once and drops the mark when the finger starts scrolling", () => {
    const { fire, advance, pressed, uninstall } = setup();
    fire("quiet", "pointerdown", 10, 10);
    advance(PRESS_MIN_MS + 50);
    fire("quiet", "pointerup", 10, 10);
    expect(pressed("quiet")).toBe(false);

    fire("quiet", "pointerdown", 10, 10);
    fire("quiet", "pointermove", 14, 16);
    expect(pressed("quiet")).toBe(true);
    fire("quiet", "pointermove", 10, 30);
    expect(pressed("quiet")).toBe(false);
    uninstall();
  });

  it("ignores disabled and non-quiet buttons, cancels on pointercancel and cleans up on uninstall", () => {
    const { fire, pressed, uninstall } = setup();
    fire("off", "pointerdown");
    fire("plain", "pointerdown");
    expect(pressed("off")).toBe(false);
    expect(pressed("plain")).toBe(false);

    fire("edit", "pointerdown");
    fire("edit", "pointercancel");
    expect(pressed("edit")).toBe(false);

    fire("edit", "pointerdown");
    uninstall();
    expect(pressed("edit")).toBe(false);
    fire("edit", "pointerdown");
    expect(pressed("edit")).toBe(false);
  });
});
