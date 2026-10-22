import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createReactDomHarness } from "../test/reactDomHarness";
import { emptyOrganization, type LibraryOrganization, type OrganizationCommand } from "./libraryOrganization";
import type { ShelfEntry } from "./shelf";
import { groupShelfActions, shelfBookActions, shelfMenuPresentation } from "./shelfActions";
import { ShelfGestureTail, ShelfPressGesture, shelfLongPressKind, type ShelfPressPhase } from "./shelfPress";
import { ShelfView, type ShelfViewProps } from "./ShelfView";

function fakeClock() {
  let now = 0;
  let seq = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  return {
    clock: {
      setTimeout: (fn: () => void, ms: number) => { timers.set(++seq, { at: now + ms, fn }); return seq; },
      clearTimeout: (id: unknown) => { timers.delete(id as number); },
      now: () => now,
    },
    advance(ms: number) {
      const end = now + ms;
      for (;;) {
        const next = [...timers.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        timers.delete(next[0]);
        now = next[1].at;
        next[1].fn();
      }
      now = end;
    },
  };
}

function gesture(kind: "select" | null = "select") {
  const time = fakeClock();
  const phases: Array<ShelfPressPhase | null> = [];
  const fired: string[] = [];
  const press = new ShelfPressGesture({
    longPressKind: () => kind,
    onLongPress: (k) => fired.push(k),
    setPhase: (phase) => phases.push(phase),
  }, time.clock);
  const down = (pointerId = 1, x = 10, y = 10) =>
    press.down({ pointerId, pointerType: "touch", button: 0, isPrimary: true, clientX: x, clientY: y });
  return { press, time, phases, fired, down };
}

describe("shelf press recognizer", () => {
  it("a quick tap acts through its click without feedback flashing", () => {
    const g = gesture();
    g.down();
    g.time.advance(40);
    g.press.up({ pointerId: 1 });
    expect(g.phases.filter(Boolean)).toEqual([]);
    expect(g.press.takeClick()).toBe(false);
  });

  it("long press shows press then charge, fires once, and swallows only its own click", () => {
    const g = gesture();
    g.down();
    g.time.advance(60);
    expect(g.phases).toEqual(["pressed"]);
    g.time.advance(140);
    expect(g.phases.at(-1)).toBe("charging");
    g.time.advance(300);
    expect(g.fired).toEqual(["select"]);
    expect(g.phases.at(-1)).toBeNull();
    g.time.advance(2000);
    expect(g.fired).toEqual(["select"]);
    g.press.up({ pointerId: 1 });
    expect(g.press.takeClick()).toBe(true);
    // The trailing click is gone; nothing else is blocked.
    expect(g.press.takeClick()).toBe(false);
  });

  it("a fired long press without a trailing click never blocks the next independent tap", () => {
    const g = gesture();
    g.down();
    g.time.advance(500);
    g.press.up({ pointerId: 1 });
    g.time.advance(100);
    g.down();
    g.press.up({ pointerId: 1 });
    expect(g.press.takeClick()).toBe(false);
  });

  it("movement, scroll and pointercancel withdraw the press and its click; a new tap works at once", () => {
    const g = gesture();
    g.down();
    g.time.advance(80);
    g.press.move({ pointerId: 1, clientX: 10, clientY: 30 });
    g.time.advance(600);
    expect(g.fired).toEqual([]);
    expect(g.phases.at(-1)).toBeNull();
    g.press.up({ pointerId: 1 });
    expect(g.press.takeClick()).toBe(true);

    g.down();
    g.press.withdraw(); // page scrolled under the finger
    g.time.advance(600);
    g.press.pointerCancel({ pointerId: 1 });
    expect(g.fired).toEqual([]);
    expect(g.press.takeClick()).toBe(true);

    g.down();
    g.press.up({ pointerId: 1 });
    expect(g.press.takeClick()).toBe(false);
  });

  it("a press that began on a control inside the card never opens the card", () => {
    const g = gesture();
    g.press.foreign({ pointerId: 1, pointerType: "mouse", button: 0, isPrimary: true, clientX: 10, clientY: 10 });
    g.time.advance(600);
    g.press.up({ pointerId: 1 });
    expect(g.fired).toEqual([]);
    expect(g.phases).toEqual([]);
    expect(g.press.takeClick()).toBe(true);
  });

  it("the click ending an acted long press reaches no book, even one that moved under the finger", () => {
    let now = 0;
    const tail = new ShelfGestureTail(() => now);
    tail.arm();
    // Still pressed: whatever element the release hits, its click is the gesture's own.
    tail.pointerUp();
    now += 100;
    expect(tail.takeClick(1)).toBe(true);
    expect(tail.takeClick(1)).toBe(false);
    // Keyboard activation is never part of a pointer gesture.
    tail.arm();
    tail.pointerUp();
    expect(tail.takeClick(0)).toBe(false);
    // A new press clears the tail at once: an independent tap acts.
    tail.pointerDown();
    expect(tail.takeClick(1)).toBe(false);
    // A click long after release belongs to nothing.
    tail.arm();
    tail.pointerUp();
    now += 5000;
    expect(tail.takeClick(1)).toBe(false);
  });

  it("a second finger cancels the press", () => {
    const g = gesture();
    g.down();
    g.press.down({ pointerId: 2, pointerType: "touch", button: 0, isPrimary: false, clientX: 50, clientY: 50 });
    g.time.advance(600);
    expect(g.fired).toEqual([]);
  });

  it("long press means select first, drag in selection, drag-out in folders, menu on touch folders", () => {
    const can = { select: true, drag: true, menu: true };
    expect(shelfLongPressKind("book", "touch", false, can)).toBe("select");
    expect(shelfLongPressKind("book", "touch", true, can)).toBe("drag");
    expect(shelfLongPressKind("book", "mouse", false, can)).toBe("drag");
    expect(shelfLongPressKind("book", "mouse", true, can)).toBeNull();
    expect(shelfLongPressKind("folderModalBook", "touch", false, can)).toBe("drag");
    expect(shelfLongPressKind("row", "touch", false, can)).toBe("select");
    expect(shelfLongPressKind("row", "mouse", false, can)).toBeNull();
    expect(shelfLongPressKind("folder", "touch", false, can)).toBe("menu");
    expect(shelfLongPressKind("folder", "touch", true, can)).toBeNull();
  });
});

describe("shelf action descriptors", () => {
  it("list only existing actions, keep danger last and follow busy/import conditions", () => {
    const base = {
      favorite: false, inFolder: true, busy: false, deleteDisabled: false,
      canSelect: true, canFavorite: true, canMove: true, canRemoveFromFolder: true,
    };
    const ids = (ctx: typeof base) => groupShelfActions(shelfBookActions(ctx)).map((g) => `${g.group}:${g.actions.map((a) => a.id).join(",")}`);
    expect(ids(base)).toEqual(["read:open", "organize:favorite,move,removeFromFolder,select", "danger:delete"]);
    expect(ids({ ...base, inFolder: false, canSelect: false, favorite: true })).toEqual(["read:open", "organize:unfavorite,move", "danger:delete"]);
    expect(ids({ ...base, canFavorite: false, canMove: false, canRemoveFromFolder: false, canSelect: false })).toEqual(["read:open", "danger:delete"]);
    const busy = shelfBookActions({ ...base, busy: true });
    expect(busy.filter((a) => a.disabled).map((a) => a.id)).toEqual(["favorite", "move", "removeFromFolder", "delete"]);
    expect(shelfBookActions({ ...base, deleteDisabled: true }).find((a) => a.id === "delete")?.disabled).toBe(true);
    expect(ids({ ...base, canExport: true } as typeof base)).toEqual(["read:open", "organize:favorite,move,removeFromFolder,exportBook,select", "danger:delete"]);
    expect(shelfBookActions({ ...base, canExport: true, exportDisabled: true }).find((a) => a.id === "exportBook")?.disabled).toBe(true);
    expect(shelfMenuPresentation("touch", false)).toBe("sheet");
    expect(shelfMenuPresentation("mouse", true)).toBe("popover");
    expect(shelfMenuPresentation("", true)).toBe("sheet");
    expect(shelfMenuPresentation("", false)).toBe("popover");
  });
});

const DEVICE = "00000000-0000-4000-8000-00000000000b";
const FOLDER = "11111111-1111-4111-8111-11111111111b";

function book(id: string, title: string): ShelfEntry {
  return {
    id, title, creator: "作者", fileName: `${title}.epub`, fileSize: 1024, coverMime: "image/jpeg",
    addedAtMs: 1, lastReadAtMs: 0, spineIndex: 0, page: 0, progressPct: 0,
    anchorIndex: null, anchorRatio: null, contentHash: id.repeat(8), isNew: false,
  };
}

function folderOrganization(ids: string[]): LibraryOrganization {
  return {
    ...emptyOrganization(),
    folders: { [FOLDER]: { name: { value: "资料", stamp: { counter: 1, deviceId: DEVICE } } } },
    books: Object.fromEntries(ids.map((id, i) => [id.repeat(8), {
      folderId: { value: FOLDER, stamp: { counter: 10 + i, deviceId: DEVICE } },
    }])),
  };
}

function pointer(win: Window, type: string, init: Record<string, unknown>): Event {
  const Ctor = (win as unknown as { Event: typeof Event }).Event;
  const event = new Ctor(type, { bubbles: true, cancelable: true });
  for (const [key, value] of Object.entries({ button: 0, isPrimary: true, pointerId: 1, pointerType: "touch", clientX: 50, clientY: 50, ...init })) {
    Object.defineProperty(event, key, { value });
  }
  return event;
}

describe("shelf menu and gesture lifecycle", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  async function mount(overrides: Partial<ShelfViewProps> = {}) {
    const dom = createReactDomHarness();
    const entries = [book("b1", "第一本"), book("b2", "第二本")];
    const props: ShelfViewProps = {
      entries,
      organization: emptyOrganization(),
      busy: false,
      theme: "light",
      onThemeChange: () => {},
      onOpen: vi.fn(),
      onImport: () => {},
      onImportArchive: () => {},
      onExportArchive: () => {},
      onDelete: () => {},
      onDeleteMany: () => {},
      onApplyOrganization: async () => {},
      ...overrides,
    };
    await dom.render(createElement(ShelfView, props));
    const doc = dom.container.ownerDocument;
    return {
      dom,
      props,
      doc,
      win: doc.defaultView as unknown as Window,
      card: (id: string) => dom.container.querySelector(`[data-book-id="${id}"]`) as HTMLElement,
      menu: () => doc.querySelector(".shelf-action-popover, .shelf-action-sheet"),
      async openMenu(id: string) {
        await dom.click(dom.container.querySelector(`[data-book-id="${id}"] .shelf-card-more-btn`)!);
      },
      rerender: (next: Partial<ShelfViewProps>) => dom.render(createElement(ShelfView, { ...props, ...next })),
    };
  }

  it("exports the whole folder from its menu and dialog without including other books", async () => {
    const onExportBooks = vi.fn();
    const entries = [book("b1", "第一本"), book("b2", "第二本"), book("b3", "夹外书籍")];
    const shelf = await mount({ entries, organization: folderOrganization(["b1", "b2"]), onExportBooks });
    try {
      const folder = () => shelf.dom.container.querySelector(`[data-folder-id="${FOLDER}"]`)!;
      await shelf.dom.click(folder().querySelector(".shelf-card-more-btn")!);
      const exportAction = () => [...shelf.menu()!.querySelectorAll<HTMLButtonElement>("button")]
        .find((button) => button.textContent === "导出书籍")!;
      expect(exportAction().disabled).toBe(false);
      await shelf.rerender({ saveFileActive: true });
      expect(exportAction().disabled).toBe(true);
      await shelf.rerender({ lanTransferActive: true });
      expect(exportAction().disabled).toBe(true);
      await shelf.rerender({ busy: true });
      expect(exportAction().disabled).toBe(true);
      await shelf.rerender({});
      await shelf.dom.click(exportAction());
      expect(onExportBooks).toHaveBeenCalledTimes(1);
      expect(onExportBooks.mock.calls[0][0].map((entry: ShelfEntry) => entry.id).sort()).toEqual(["b1", "b2"]);

      await shelf.dom.run(() => { vi.advanceTimersByTime(1000); });
      await shelf.dom.click(folder());
      const dialogExport = () => shelf.doc.querySelector<HTMLButtonElement>(".shelf-folder-modal button[aria-label='导出书籍']")!;
      await shelf.dom.click(dialogExport());
      expect(onExportBooks).toHaveBeenCalledTimes(2);
      expect(onExportBooks.mock.calls[1][0].map((entry: ShelfEntry) => entry.id).sort()).toEqual(["b1", "b2"]);

      await shelf.rerender({ organization: folderOrganization([]) });
      expect(dialogExport().disabled).toBe(true);
      await shelf.dom.click(dialogExport());
      expect(onExportBooks).toHaveBeenCalledTimes(2);
    } finally {
      await shelf.dom.dispose();
    }
  });

  it("a menu reopened while the old one closes is not unmounted by the old timer", async () => {
    let back: (() => boolean) | null = null;
    const shelf = await mount({ registerBackHandler: (handler) => { back = handler; } });
    try {
      await shelf.openMenu("b1");
      await shelf.dom.run(() => { expect(back?.()).toBe(true); });
      expect(shelf.menu()?.className).toContain("is-closing");
      await shelf.dom.run(() => { vi.advanceTimersByTime(100); });
      await shelf.openMenu("b2");
      await shelf.dom.run(() => { vi.advanceTimersByTime(1000); });
      expect(shelf.menu()?.getAttribute("aria-label")).toContain("第二本");
      expect(shelf.menu()?.className).not.toContain("is-closing");
    } finally {
      await shelf.dom.dispose();
    }
  });

  it("closes at once when its book leaves the shelf, without acting on the old object", async () => {
    const shelf = await mount();
    try {
      await shelf.openMenu("b1");
      expect(shelf.menu()).not.toBeNull();
      await shelf.rerender({ entries: [book("b2", "第二本")] });
      expect(shelf.menu()).toBeNull();
    } finally {
      await shelf.dom.dispose();
    }
  });

  it("a late failure from an old menu never lands on the menu now open", async () => {
    let reject: (error: Error) => void = () => {};
    const commands: OrganizationCommand[] = [];
    const shelf = await mount({
      organization: folderOrganization(["b1", "b2"]),
      scope: { type: "folder", folderId: FOLDER },
      onApplyOrganization: (command) => {
        commands.push(command);
        return new Promise<void>((_, fail) => { reject = fail; });
      },
    });
    try {
      await shelf.openMenu("b1");
      const remove = () => [...shelf.doc.querySelectorAll(".shelf-action-item")]
        .find((item) => /从文件夹移除|正在移出/.test(item.textContent ?? "")) as HTMLElement | undefined;
      await shelf.dom.click(remove()!);
      expect(remove()?.textContent).toContain("正在移出");
      // In flight: the same menu does not submit it twice.
      await shelf.dom.click(remove()!);
      expect(commands).toHaveLength(1);
      await shelf.openMenu("b2");
      await shelf.dom.run(async () => { reject(new Error("index locked")); await Promise.resolve(); });
      await shelf.dom.run(() => { vi.advanceTimersByTime(1000); });
      expect(shelf.menu()?.getAttribute("aria-label")).toContain("第二本");
      expect(shelf.menu()?.querySelector("[role='alert']")).toBeNull();
      expect(remove()?.textContent).toContain("从文件夹移除");
    } finally {
      await shelf.dom.dispose();
    }
  });

  it("touch long press selects once; its late click is swallowed while the next tap still acts", async () => {
    const shelf = await mount();
    try {
      const card = shelf.card("b1");
      await shelf.dom.dispatch(card, pointer(shelf.win, "pointerdown", {}));
      await shelf.dom.run(() => { vi.advanceTimersByTime(520); });
      expect(shelf.dom.container.querySelector(".shelf-view.selection-mode")).not.toBeNull();
      await shelf.dom.dispatch(card, pointer(shelf.win, "pointerup", {}));
      await shelf.dom.click(card);
      // The long press selected b1; its trailing click did not toggle it off again.
      expect(shelf.card("b1").classList.contains("selected")).toBe(true);

      const other = shelf.card("b2");
      await shelf.dom.dispatch(other, pointer(shelf.win, "pointerdown", {}));
      await shelf.dom.dispatch(other, pointer(shelf.win, "pointerup", {}));
      await shelf.dom.click(other);
      expect(shelf.card("b2").classList.contains("selected")).toBe(true);
      expect(shelf.props.onOpen).not.toHaveBeenCalled();
    } finally {
      await shelf.dom.dispose();
    }
  });

  it("Back closes a folder dialog and leaves the folder cards beneath it in place", async () => {
    let back: (() => boolean) | null = null;
    const shelf = await mount({
      compact: true,
      organization: folderOrganization(["b1"]),
      registerBackHandler: (handler) => { back = handler; },
    });
    try {
      // The phone shelf shows its folder cards by default.
      await shelf.dom.click(shelf.dom.container.querySelector(".shelf-folder-card")!);
      expect(shelf.dom.container.querySelector(".shelf-folder-modal")).not.toBeNull();
      // The dialog's books share the shelf grid: density columns and the touch card buttons.
      expect(shelf.dom.container.querySelector(".shelf-folder-modal .shelf-grid .shelf-card")).not.toBeNull();
      await shelf.dom.run(() => { expect(back?.()).toBe(true); });
      await shelf.dom.run(() => { vi.advanceTimersByTime(1000); });
      expect(shelf.dom.container.querySelector(".shelf-folder-modal")).toBeNull();
      // Expanded cards are the shelf's normal state, not a layer: Back leaves them alone.
      expect(shelf.dom.container.querySelector(".shelf-folder-card")).not.toBeNull();
      await shelf.dom.run(() => { expect(back?.()).toBe(false); });
      expect(shelf.dom.container.querySelector(".shelf-folder-card")).not.toBeNull();
    } finally {
      await shelf.dom.dispose();
    }
  });

  it("scrolling during a press withdraws it: no selection, no open, no press state left", async () => {
    const shelf = await mount();
    try {
      const card = shelf.card("b1");
      await shelf.dom.dispatch(card, pointer(shelf.win, "pointerdown", {}));
      await shelf.dom.run(() => { vi.advanceTimersByTime(100); });
      expect(card.getAttribute("data-press")).toBe("pressed");
      const Ctor = (shelf.win as unknown as { Event: typeof Event }).Event;
      await shelf.dom.run(() => { shelf.win.dispatchEvent(new Ctor("scroll")); });
      await shelf.dom.run(() => { vi.advanceTimersByTime(600); });
      expect(card.hasAttribute("data-press")).toBe(false);
      await shelf.dom.dispatch(card, pointer(shelf.win, "pointercancel", {}));
      await shelf.dom.click(card);
      expect(shelf.dom.container.querySelector(".shelf-view.selection-mode")).toBeNull();
      expect(shelf.props.onOpen).not.toHaveBeenCalled();

      await shelf.dom.dispatch(card, pointer(shelf.win, "pointerdown", {}));
      await shelf.dom.dispatch(card, pointer(shelf.win, "pointerup", {}));
      await shelf.dom.click(card);
      expect(shelf.props.onOpen).toHaveBeenCalledWith("b1");
    } finally {
      await shelf.dom.dispose();
    }
  });
});
