/**
 * 原生全屏与窗口状态控制器
 * 
 * 解决 Windows 下 Tao 0.35.3 无边框窗口在已最大化状态下进入全屏时，
 * WM_NCCALCSIZE 仍按普通最大化将客户区裁切到 rcWork（导致底部留出任务栏高度黑块）的问题。
 *
 * 核心绕行方案：
 * - Windows 进入全屏前检测是否已最大化，若是则先 unmaximize()，再 setFullscreen(true)；
 * - 退出全屏后若原先为最大化，则恢复 maximize()；
 * - 非 Windows（macOS/Linux）保持平台原生全屏处理；
 * - 在途操作互斥，避免并发重入与竞争；
 * - 异步查询采用 generation 标记，避免过时的 resize 回调覆盖最新状态；
 * - 最终全屏状态始终以 native 底层查询结果为准。
 */

export interface NativeFullscreenPort {
  isFullscreen(): Promise<boolean>;
  isMaximized(): Promise<boolean>;
  unmaximize(): Promise<void>;
  maximize(): Promise<void>;
  setFullscreen(value: boolean): Promise<void>;
}

export interface NativeFullscreenController {
  toggle(): Promise<void>;
  refresh(): Promise<void>;
  isBusy(): boolean;
}

/**
 * 判定当前是否为运行在 Windows 下的 Tauri 桌面端
 */
export function isWindowsTauriEnvironment(isTauri: boolean, userAgent?: string): boolean {
  if (!isTauri) return false;
  const ua = userAgent ?? (typeof navigator !== "undefined" ? navigator.userAgent : "");
  return ua.includes("Windows");
}

export function createNativeFullscreenController(
  win: NativeFullscreenPort,
  workAroundMaximized: boolean,
  publish: (fullscreen: boolean) => void,
  publishBusy: (busy: boolean) => void,
): NativeFullscreenController {
  let busy = false;
  let restoreMaximized = false;
  let readGeneration = 0;

  async function refresh(): Promise<void> {
    if (busy) return;
    const generation = ++readGeneration;
    const actual = await win.isFullscreen();
    if (!busy && generation === readGeneration) {
      publish(actual);
    }
  }

  async function toggle(): Promise<void> {
    if (busy) return;
    busy = true;
    ++readGeneration;
    publishBusy(true);
    let unmaximizedForEntry = false;
    try {
      if (await win.isFullscreen()) {
        await win.setFullscreen(false);
        if (restoreMaximized) {
          await win.maximize();
        }
        restoreMaximized = false;
      } else {
        restoreMaximized = workAroundMaximized && (await win.isMaximized());
        if (restoreMaximized) {
          await win.unmaximize();
          unmaximizedForEntry = true;
        }
        await win.setFullscreen(true);
      }
    } catch (error) {
      // 若因错误未能进入全屏且先前已解除了最大化，则恢复先前的最大化状态
      if (unmaximizedForEntry && !(await win.isFullscreen())) {
        try {
          await win.maximize();
        } catch {}
        restoreMaximized = false;
      }
      throw error;
    } finally {
      try {
        const actual = await win.isFullscreen();
        ++readGeneration;
        publish(actual);
      } finally {
        busy = false;
        publishBusy(false);
      }
    }
  }

  return {
    toggle,
    refresh,
    isBusy: () => busy,
  };
}
