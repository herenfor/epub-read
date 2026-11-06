import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { RuntimeCapabilities } from "../platform/runtimeCapabilities";
import { uiText } from "./localization/UiLanguageProvider";
import { readTitlebarAutoHide, writeTitlebarAutoHide } from "./titlebarPreferences";
import {
  createNativeFullscreenController,
  type NativeFullscreenController,
  type NativeFullscreenPort,
} from "./windowFullscreen";

export interface FullscreenControlsDeps {
  runtime: RuntimeCapabilities;
  isTauriEnv: () => boolean;
  setRuntimeIssues: Dispatch<SetStateAction<string[]>>;
}

export function useFullscreenControls({ runtime, isTauriEnv, setRuntimeIssues }: FullscreenControlsDeps) {
  // ---- 全屏 / 沉浸禅模式（Zen Mode） ----
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [fullscreenBusy, setFullscreenBusy] = useState(false);
  // 顶栏自动隐藏：本机偏好；顶栏图钉和 设置 › 阅读 都切换它。
  const [readerZenMode, setReaderZenMode] = useState(readTitlebarAutoHide);
  const changeReaderZenMode = useCallback((enabled: boolean) => {
    setReaderZenMode(enabled);
    writeTitlebarAutoHide(enabled);
  }, []);

  const fullscreenControllerRef = useRef<NativeFullscreenController | null>(null);
  if (!fullscreenControllerRef.current && runtime.hasDesktopWindowChrome) {
    try {
      const win = getCurrentWindow();
      const port: NativeFullscreenPort = {
        isFullscreen: () => win.isFullscreen(),
        isMaximized: () => win.isMaximized(),
        unmaximize: () => win.unmaximize(),
        maximize: () => win.maximize(),
        setFullscreen: (v) => win.setFullscreen(v),
      };
      const isWindows = runtime.platform === "windows";
      fullscreenControllerRef.current = createNativeFullscreenController(
        port,
        isWindows,
        (fs) => setIsFullscreen(fs),
        (busy) => setFullscreenBusy(busy)
      );
    } catch {}
  }

  const toggleWebFullscreen = useCallback(async () => {
    if (typeof document === "undefined") return;
    try {
      if (!document.fullscreenElement) {
        if (document.documentElement.requestFullscreen) {
          await document.documentElement.requestFullscreen();
        } else {
          throw new Error("当前环境不支持全屏 API");
        }
      } else {
        if (document.exitFullscreen) {
          await document.exitFullscreen();
        }
      }
    } catch (err) {
      setRuntimeIssues((issues) => [...issues, uiText("appUi.issue.fullscreenFailed", { error: String(err) })]);
    }
  }, []);

  const toggleFullscreen = useCallback(async () => {
    if (isTauriEnv()) {
      const controller = fullscreenControllerRef.current;
      if (controller) {
        try {
          await controller.toggle();
        } catch (err) {
          console.warn("Tauri setFullscreen failed", err);
          setRuntimeIssues((issues) => [...issues, uiText("appUi.issue.windowFullscreenFailed", { error: String(err) })]);
        }
      }
      return;
    }
    await toggleWebFullscreen();
  }, [toggleWebFullscreen]);

  useEffect(() => {
    if (!isTauriEnv()) {
      const handleFullscreenChange = () => {
        setIsFullscreen(Boolean(document.fullscreenElement));
      };
      document.addEventListener("fullscreenchange", handleFullscreenChange);
      return () => document.removeEventListener("fullscreenchange", handleFullscreenChange);
    }
    if (!runtime.hasDesktopWindowChrome) return;
    try {
      const controller = fullscreenControllerRef.current;
      if (controller) {
        void controller.refresh();
        const win = getCurrentWindow();
        const unlistenPromise = win.onResized(() => {
          void controller.refresh();
        });
        return () => {
          void unlistenPromise.then((unlisten) => unlisten()).catch(() => {});
        };
      }
    } catch {}
  }, []);

  return {
    isFullscreen,
    fullscreenBusy,
    readerZenMode,
    changeReaderZenMode,
    toggleFullscreen,
  };
}
