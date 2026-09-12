import { createRoot } from "react-dom/client";
import { StrictMode, type ComponentType } from "react";
import { APP_EDITION } from "./config/edition";
import type { AppBuildInfo } from "./config/appBuildInfo";
import { validateAppBuildInfo } from "./config/appBuildInfo";
import { clearAppBuildSession, setAppBuildSession } from "./config/appBuildSession";

type AppModule = { default: ComponentType };

export interface AppBootstrapDependencies {
  isDesktop(): boolean;
  readBuildInfo(): Promise<unknown>;
  loadApp(): Promise<AppModule>;
  mountApp(root: HTMLElement, app: ComponentType): void;
  mountFailure(root: HTMLElement, error: unknown): void;
}

function isTauriEnvironment(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

async function readDesktopBuildInfo(): Promise<AppBuildInfo> {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<AppBuildInfo>("app_build_info");
}

async function loadApp(): Promise<AppModule> {
  return import("./App");
}

function mountApp(root: HTMLElement, App: ComponentType): void {
  createRoot(root).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}

export function StartupFailurePage({ error }: { error: unknown }) {
  const message = error instanceof Error ? error.message : String(error);
  const mismatch = message.includes("edition 不匹配");
  return (
    <main className="startup-failure" role="alert">
      <h1>{mismatch ? "发行组件不匹配" : "无法验证发行组件"}</h1>
      <p>{mismatch ? "前端与桌面后端不是同一发行版，应用已停止启动。" : "桌面发行版握手失败，应用已停止启动。"}</p>
      <code>{message}</code>
    </main>
  );
}

function mountFailure(root: HTMLElement, error: unknown): void {
  createRoot(root).render(<StartupFailurePage error={error} />);
}

export function createDefaultAppBootstrapDependencies(): AppBootstrapDependencies {
  return {
    isDesktop: isTauriEnvironment,
    readBuildInfo: readDesktopBuildInfo,
    loadApp,
    mountApp,
    mountFailure,
  };
}

/**
 * Verify the desktop build before importing App. This ordering is the
 * important fail-closed boundary: mismatch/failure cannot initialize FTS or
 * any AI runtime because App's module graph is never loaded.
 */
export async function bootstrapApp(
  root: HTMLElement,
  overrides: Partial<AppBootstrapDependencies> = {},
): Promise<"mounted" | "failed"> {
  const dependencies = {
    ...createDefaultAppBootstrapDependencies(),
    ...overrides,
  };
  clearAppBuildSession();
  try {
    if (dependencies.isDesktop()) {
      const buildInfo = await dependencies.readBuildInfo();
      const validated = validateAppBuildInfo(buildInfo, APP_EDITION);
      setAppBuildSession({ source: "desktop", buildInfo: validated });
    } else {
      setAppBuildSession({ source: "browser", edition: APP_EDITION, debug: import.meta.env.DEV });
    }
    const appModule = await dependencies.loadApp();
    dependencies.mountApp(root, appModule.default);
    return "mounted";
  } catch (error) {
    clearAppBuildSession();
    dependencies.mountFailure(root, error);
    return "failed";
  }
}
