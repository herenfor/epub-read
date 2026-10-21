import { defineConfig } from "vitest/config";
import { loadEnv } from "vite";
import packageJson from "./package.json";
import react from "@vitejs/plugin-react";
import { normalizeAppEdition } from "./src/config/editionValue";
import { frontendOutDir, normalizeAppPlatform, shellForPlatform } from "./src/config/platformValue";
import { aiCompanionDevAssets } from "./scripts/ai-companion-dev-assets.mjs";
import { resolveAppUpdateSource } from "./src/config/appUpdateSourceValue";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, ".", "");
  // Unqualified dev and production builds are Core-safe. Explicit
  // VITE_EDITION selects the AI development or production bundle.
  const edition = normalizeAppEdition(env.VITE_EDITION ?? "core");
  const platform = normalizeAppPlatform(env.VITE_APP_PLATFORM ?? "windows");
  const shell = shellForPlatform(platform);
  const version = packageJson.version;
  // Android ships under its own application ID; Windows keeps the original
  // identifier because it names the existing app data directory.
  const identifier = platform === "android"
    ? (edition === "ai" ? "dev.herenfor.epubreader.ai" : "dev.herenfor.epubreader")
    : (edition === "ai" ? "dev.epubreader.ai" : "dev.epubreader.app");
  // One resolved source feeds both the runtime constant and the build's
  // declaration, so the release script judges what the app will really call.
  const updateSource = resolveAppUpdateSource(env);
  return {
    // Keep edition and target decisions in the compiled module graph. This
    // lets a core desktop build remove AI/Android-only branches instead of
    // relying on runtime DEV checks.
    define: {
      __APP_EDITION__: JSON.stringify(edition),
      __APP_PLATFORM__: JSON.stringify(platform),
      __APP_VERSION__: JSON.stringify(version),
      __APP_UPDATE_SOURCE__: JSON.stringify(updateSource),
    },
    plugins: [react(), ...(edition === "ai" ? [aiCompanionDevAssets()] : []), {
      name: "edition-manifest",
      transformIndexHtml(html) {
        if (platform !== "android") return html;
        // App settings own text/UI sizing; ImageViewer owns image pinch.
        return html.replace(
          "width=device-width, initial-scale=1.0",
          "width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no",
        );
      },
      generateBundle() {
        this.emitFile({
          type: "asset",
          fileName: "edition-manifest.json",
          source: JSON.stringify({ schemaVersion: 1, edition, platform, shell, version, expectedBackendFeature: edition === "ai" ? "ai" : "core", identifier }, null, 2) + "\n",
        });
        this.emitFile({
          type: "asset",
          fileName: "app-update-source.json",
          source: JSON.stringify({ schemaVersion: 1, ...updateSource }, null, 2) + "\n",
        });
      }
    }],
    // Download probes belong only to AI. Local Live2D materials live outside
    // public-ai and are served by AI dev middleware, never by a release build.
    publicDir: edition === "ai" ? "public-ai" : false,
    clearScreen: false,
    server: {
      // 注意：1420 曾被 Hyper-V 保留段占用；后改 5517，但 2025-08 电脑重启后
      // Track B (Zen UI 实验树) 锁定固定使用 5175，保持与浏览器 IndexedDB 存储源一致
      port: 5175,
      strictPort: true,
    },
    build: {
      target: "es2022",
      outDir: frontendOutDir(edition, platform),
      emptyOutDir: true,
      rollupOptions: {
        output: {
          assetFileNames: "assets/[name]-[hash][extname]",
        },
      },
    },
    // The corpus worker dynamically loads the cross-environment XML parser.
    // ES workers support the resulting split chunks; IIFE workers do not.
    worker: {
      format: "es",
    },
    test: {
      environment: "node",
      include: ["src/**/*.test.ts"],
    },
  };
});
