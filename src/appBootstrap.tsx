import { createRoot } from "react-dom/client";
import { StrictMode, type ComponentType } from "react";
import { APP_EDITION } from "./config/edition";
import { APP_PLATFORM } from "./config/appPlatform";
import { platformFromTarget } from "./config/platformValue";
import type { AppBuildInfo } from "./config/appBuildInfo";
import { validateAppBuildInfo } from "./config/appBuildInfo";
import { clearAppBuildSession, setAppBuildSession } from "./config/appBuildSession";
import { createAppUiLanguageStore, UiLanguageProvider, useUiText } from "./ui/localization/UiLanguageProvider";

type AppModule = { default: ComponentType };

export interface AppBootstrapDependencies {
  isNativeHost(): boolean;
  readBuildInfo(): Promise<unknown>;
  loadApp(): Promise<AppModule>;
  mountApp(root: HTMLElement, app: ComponentType): void;
  mountFailure(root: HTMLElement, error: unknown): void;
}

function isTauriEnvironment(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

async function readNativeBuildInfo(): Promise<AppBuildInfo> {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<AppBuildInfo>("app_build_info");
}

async function loadApp(): Promise<AppModule> {
  return import("./App");
}

function mountApp(root: HTMLElement, App: ComponentType): void {
  // One UI-language store for the app's lifetime; switching never remounts App.
  const language = createAppUiLanguageStore();
  createRoot(root).render(
    <StrictMode>
      <UiLanguageProvider store={language}>
        <App />
      </UiLanguageProvider>
    </StrictMode>,
  );
}

export function StartupFailurePage({ error }: { error: unknown }) {
  const message = error instanceof Error ? error.message : String(error);
  const { t } = useUiText();
  const mismatch = message.includes("不匹配");
  return (
    <main className="startup-failure" role="alert">
      <h1>{mismatch ? t("startup.mismatch.title") : t("startup.failed.title")}</h1>
      <p>{mismatch ? t("startup.mismatch.body") : t("startup.failed.body")}</p>
      <code>{message}</code>
    </main>
  );
}

function mountFailure(root: HTMLElement, error: unknown): void {
  // Only the language modules load here; App and AI stay unloaded after a failed handshake.
  createRoot(root).render(
    <UiLanguageProvider store={createAppUiLanguageStore()}>
      <StartupFailurePage error={error} />
    </UiLanguageProvider>,
  );
}

export function createDefaultAppBootstrapDependencies(): AppBootstrapDependencies {
  return {
    isNativeHost: isTauriEnvironment,
    readBuildInfo: readNativeBuildInfo,
    loadApp,
    mountApp,
    mountFailure,
  };
}

/**
 * Verify the native build before importing App. This ordering is the
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
    if (dependencies.isNativeHost()) {
      const buildInfo = await dependencies.readBuildInfo();
      const validated = validateAppBuildInfo(buildInfo, APP_EDITION);
      const actualPlatform = platformFromTarget(validated.target);
      if (!actualPlatform) {
        throw new Error(`无法从后端 target 识别平台：${validated.target}`);
      }
      // Browser preview is allowed to load a Tauri dev host; packaged builds
      // pass an explicit platform and must match the native target.
      if (APP_PLATFORM !== "web" && actualPlatform !== APP_PLATFORM) {
        throw new Error(`平台不匹配：前端为 ${APP_PLATFORM}，后端为 ${validated.target}`);
      }
      setAppBuildSession({ source: "desktop", buildInfo: validated, platform: actualPlatform });
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
