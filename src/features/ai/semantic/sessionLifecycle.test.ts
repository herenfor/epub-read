import { describe, expect, it, vi } from "vitest";
import { SemanticQueryController } from "./queryController";
import { createPreviewSession } from "./previewSession";
import { MemorySemanticStore, testChunk } from "./testStore";
import type { SemanticSession } from "./contracts";

const BOOK = "a".repeat(64);
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
function setup(change?: (session: SemanticSession) => void) {
  const store = new MemorySemanticStore();
  let active = false;
  const sessions: SemanticSession[] = [];
  const openSession = vi.fn(async () => {
    if (active) throw new Error("已有活动的嵌入会话，请先关闭");
    active = true;
    const session = createPreviewSession();
    session.close = vi.fn(async () => { active = false; });
    change?.(session);
    sessions.push(session);
    return { session, device: { adapterName: "Test device", luid: null } };
  });
  const options = { store, openSession, chunks: async function* () { yield [testChunk(0), testChunk(1)]; } };
  return { store, sessions, openSession, options, controller: new SemanticQueryController(options) };
}

describe("controller owns embedding sessions", () => {
  it("closes successful builds, reuse and queries so each next action can acquire", async () => {
    const { controller, sessions, store } = setup();
    expect((await controller.build(BOOK, "test", null, false)).publishedRows).toBe(2);
    expect(await controller.query(BOOK, "test", null, "正文", 2)).toHaveLength(2);
    expect((await controller.build(BOOK, "test", null, false)).generation).toBe(1);
    expect(await controller.query(BOOK, "test", null, "正文", 2)).toHaveLength(2);
    expect(sessions).toHaveLength(4);
    for (const session of sessions) expect(session.close).toHaveBeenCalledOnce();
    expect((await store.request({ action: "status", book: BOOK })).published?.total).toBe(2);
  });

  it("closes a failed build and permits retry without restarting the application", async () => {
    let fail = true;
    const { controller, sessions } = setup((session) => {
      if (fail) session.embed = async () => { throw new Error("正文超过模型 token 上限"); };
    });
    expect((await controller.build(BOOK, "test", null, false)).message).toContain("token 上限");
    expect(sessions[0].close).toHaveBeenCalledOnce();
    fail = false;
    expect((await controller.build(BOOK, "test", null, false)).state).toBe("ready");
    expect(sessions[1].close).toHaveBeenCalledOnce();
  });

  it("closes a query session even if no snapshot could be opened", async () => {
    const { controller, sessions } = setup();
    await expect(controller.query(BOOK, "test", null, "正文", 2)).rejects.toThrow("尚未发布");
    expect(sessions[0].close).toHaveBeenCalledOnce();
    expect((await controller.build(BOOK, "test", null, false)).state).toBe("ready");
  });

  it("closes a session that finishes opening after the panel was released", async () => {
    const { options, openSession, sessions } = setup();
    const opened = deferred<Awaited<ReturnType<typeof openSession>>>();
    const onChange = vi.fn();
    const controller = new SemanticQueryController({ ...options, openSession: () => opened.promise, onChange });
    const pending = controller.build(BOOK, "test", null, false);
    controller.release();
    const notifications = onChange.mock.calls.length;
    const value = await openSession();
    const embed = vi.spyOn(value.session, "embed");
    opened.resolve(value);
    await pending;
    expect(embed).not.toHaveBeenCalled();
    expect(sessions[0].close).toHaveBeenCalledOnce();
    expect(onChange).toHaveBeenCalledTimes(notifications);
  });

  it("waits for running inference and disposal before allowing another operation", async () => {
    const work = deferred<readonly (readonly number[])[]>();
    const disposal = deferred<void>();
    const { controller, sessions, openSession } = setup((session) => {
      session.embed = vi.fn(() => work.promise);
      session.close = vi.fn(() => disposal.promise);
    });
    const pending = controller.build(BOOK, "test", null, false);
    await vi.waitFor(() => expect(sessions[0]?.embed).toHaveBeenCalled());
    controller.cancel();
    expect(sessions[0].close).not.toHaveBeenCalled();
    work.resolve([]);
    await vi.waitFor(() => expect(sessions[0].close).toHaveBeenCalledOnce());
    await expect(controller.query(BOOK, "test", null, "正文", 2)).rejects.toThrow("已有任务");
    expect(openSession).toHaveBeenCalledOnce();
    disposal.resolve();
    await pending;
  });

  it("surfaces disposal failure and fences another acquisition", async () => {
    const { controller, openSession } = setup((session) => {
      session.close = async () => { throw new Error("释放失败，请重启应用"); };
    });
    expect((await controller.build(BOOK, "test", null, false)).message).toContain("释放失败");
    await expect(controller.query(BOOK, "test", null, "正文", 2)).rejects.toThrow("释放失败");
    expect(openSession).toHaveBeenCalledOnce();
  });
});
