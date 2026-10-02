import { describe, expect, it, vi } from "vitest";
import {
  createNativeFullscreenController,
  isWindowsTauriEnvironment,
  type NativeFullscreenPort,
} from "./windowFullscreen";

function createMockPort(initial: { isFullscreen?: boolean; isMaximized?: boolean } = {}) {
  let fs = initial.isFullscreen ?? false;
  let max = initial.isMaximized ?? false;
  const callLog: string[] = [];

  const port: NativeFullscreenPort = {
    isFullscreen: vi.fn(async () => {
      callLog.push(`isFullscreen:${fs}`);
      return fs;
    }),
    isMaximized: vi.fn(async () => {
      callLog.push(`isMaximized:${max}`);
      return max;
    }),
    unmaximize: vi.fn(async () => {
      callLog.push("unmaximize");
      max = false;
    }),
    maximize: vi.fn(async () => {
      callLog.push("maximize");
      max = true;
    }),
    setFullscreen: vi.fn(async (val: boolean) => {
      callLog.push(`setFullscreen:${val}`);
      fs = val;
    }),
  };

  return { port, callLog, getFs: () => fs, getMax: () => max, setFs: (v: boolean) => { fs = v; } };
}

describe("windowFullscreen - NativeFullscreenController", () => {
  it("Windows 环境：普通窗口进入全屏与退出全屏，不触发 unmaximize / maximize", async () => {
    const mock = createMockPort({ isFullscreen: false, isMaximized: false });
    const publish = vi.fn();
    const publishBusy = vi.fn();
    const controller = createNativeFullscreenController(mock.port, true, publish, publishBusy);

    await controller.toggle();

    // 应该直接调用 setFullscreen(true)，不触发 unmaximize
    expect(mock.port.unmaximize).not.toHaveBeenCalled();
    expect(mock.port.setFullscreen).toHaveBeenCalledWith(true);
    expect(publish).toHaveBeenCalledWith(true);
    expect(publishBusy).toHaveBeenLastCalledWith(false);

    // 退出全屏
    await controller.toggle();
    expect(mock.port.setFullscreen).toHaveBeenCalledWith(false);
    expect(mock.port.maximize).not.toHaveBeenCalled();
    expect(publish).toHaveBeenLastCalledWith(false);
  });

  it("Windows 环境：最大化窗口进入全屏先 unmaximize，退出时自动恢复 maximize", async () => {
    const mock = createMockPort({ isFullscreen: false, isMaximized: true });
    const publish = vi.fn();
    const publishBusy = vi.fn();
    const controller = createNativeFullscreenController(mock.port, true, publish, publishBusy);

    // 进入全屏
    await controller.toggle();

    // 验证调用顺序：先 isMaximized -> unmaximize -> setFullscreen(true)
    const entryIndexUnmax = mock.callLog.indexOf("unmaximize");
    const entryIndexSetFs = mock.callLog.indexOf("setFullscreen:true");
    expect(entryIndexUnmax).toBeGreaterThan(-1);
    expect(entryIndexSetFs).toBeGreaterThan(entryIndexUnmax);
    expect(publish).toHaveBeenCalledWith(true);

    // 退出全屏
    await controller.toggle();

    // 验证调用顺序：先 setFullscreen(false) -> maximize
    const exitIndexSetFs = mock.callLog.indexOf("setFullscreen:false");
    const exitIndexMax = mock.callLog.indexOf("maximize");
    expect(exitIndexSetFs).toBeGreaterThan(-1);
    expect(exitIndexMax).toBeGreaterThan(exitIndexSetFs);
    expect(publish).toHaveBeenLastCalledWith(false);
  });

  it("非 Windows 环境（workAroundMaximized=false）：最大化窗口全屏时不触发 unmaximize", async () => {
    const mock = createMockPort({ isFullscreen: false, isMaximized: true });
    const publish = vi.fn();
    const publishBusy = vi.fn();
    const controller = createNativeFullscreenController(mock.port, false, publish, publishBusy);

    await controller.toggle();
    expect(mock.port.unmaximize).not.toHaveBeenCalled();
    expect(mock.port.setFullscreen).toHaveBeenCalledWith(true);

    await controller.toggle();
    expect(mock.port.maximize).not.toHaveBeenCalled();
    expect(mock.port.setFullscreen).toHaveBeenCalledWith(false);
  });

  it("在途操作互斥：切换中重复调用 toggle 被忽略", async () => {
    const mock = createMockPort({ isFullscreen: false, isMaximized: false });
    let resolveSetFs!: () => void;
    mock.port.setFullscreen = vi.fn((_val: boolean) => new Promise<void>((resolve) => {
      resolveSetFs = () => {
        mock.setFs(true);
        resolve();
      };
    }));

    const publish = vi.fn();
    const publishBusy = vi.fn();
    const controller = createNativeFullscreenController(mock.port, true, publish, publishBusy);

    const firstPromise = controller.toggle();
    expect(controller.isBusy()).toBe(true);

    // 第二次调用应因 busy 在途被直接忽略
    const secondPromise = controller.toggle();

    // 等待第一个异步到达 setFullscreen 挂站点
    await vi.waitFor(() => {
      expect(mock.port.setFullscreen).toHaveBeenCalledTimes(1);
    });

    resolveSetFs();
    await Promise.all([firstPromise, secondPromise]);
    expect(controller.isBusy()).toBe(false);
    expect(mock.port.setFullscreen).toHaveBeenCalledTimes(1);
  });

  it("进入全屏失败时如果先前执行了 unmaximize，则自动恢复原最大化状态并抛出异常", async () => {
    const mock = createMockPort({ isFullscreen: false, isMaximized: true });
    mock.port.setFullscreen = vi.fn(async () => {
      throw new Error("Simulated native failure");
    });

    const publish = vi.fn();
    const publishBusy = vi.fn();
    const controller = createNativeFullscreenController(mock.port, true, publish, publishBusy);

    await expect(controller.toggle()).rejects.toThrow("Simulated native failure");
    // 应该恢复了最大化
    expect(mock.port.maximize).toHaveBeenCalled();
    expect(controller.isBusy()).toBe(false);
    expect(publishBusy).toHaveBeenLastCalledWith(false);
  });

  it("异步 refresh 序号机制：过期的旧查询不会覆盖较新的状态", async () => {
    let slowResolve!: (v: boolean) => void;

    const port: NativeFullscreenPort = {
      isFullscreen: vi.fn()
        .mockImplementationOnce(() => new Promise((res) => { slowResolve = res; }))
        .mockImplementationOnce(async () => true),
      isMaximized: vi.fn(async () => false),
      unmaximize: vi.fn(async () => {}),
      maximize: vi.fn(async () => {}),
      setFullscreen: vi.fn(async () => {}),
    };

    const publish = vi.fn();
    const publishBusy = vi.fn();
    const controller = createNativeFullscreenController(port, true, publish, publishBusy);

    // 第 1 次 refresh（被延迟挂起）
    const firstRefresh = controller.refresh();

    // 第 2 次 refresh（快速返回 true）
    const secondRefresh = controller.refresh();
    await secondRefresh;
    expect(publish).toHaveBeenCalledWith(true);

    // 此时第 1 次慢查询返回 false，因 generation 过期，不应覆盖第 2 次的 true
    publish.mockClear();
    slowResolve(false);
    await firstRefresh;
    expect(publish).not.toHaveBeenCalledWith(false);
  });

  it("isWindowsTauriEnvironment 正确识别平台与环境", () => {
    expect(isWindowsTauriEnvironment(false, "Mozilla/5.0 (Windows NT 10.0; Win64; x64)")).toBe(false);
    expect(isWindowsTauriEnvironment(true, "Mozilla/5.0 (Windows NT 10.0; Win64; x64)")).toBe(true);
    expect(isWindowsTauriEnvironment(true, "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)")).toBe(false);
    expect(isWindowsTauriEnvironment(true, "Mozilla/5.0 (X11; Linux x86_64)")).toBe(false);
  });
});
