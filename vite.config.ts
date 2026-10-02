import { defineConfig } from "vitest/config";
import { loadEnv } from "vite";
import packageJson from "./package.json";
import react from "@vitejs/plugin-react";
import { normalizeAppEdition } from "./src/config/editionValue";
import { frontendOutDir, normalizeAppPlatform, shellForPlatform } from "./src/config/platformValue";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, ".", "");
  // Unqualified dev and production builds are Core-safe. Explicit
  // VITE_EDITION selects the AI development or production bundle.
  const edition = normalizeAppEdition(env.VITE_EDITION ?? "core");
  const platform = normalizeAppPlatform(env.VITE_APP_PLATFORM ?? "windows");
  const shell = shellForPlatform(platform);
  const version = packageJson.version;
  const identifier = edition === "ai" ? "dev.epubreader.ai" : "dev.epubreader.app";
  return {
    // Keep edition and target decisions in the compiled module graph. This
    // lets a core desktop build remove AI/Android-only branches instead of
    // relying on runtime DEV checks.
    define: {
      __APP_EDITION__: JSON.stringify(edition),
      __APP_PLATFORM__: JSON.stringify(platform),
    },
    plugins: [react(), {
      name: "edition-manifest",
      generateBundle() {
        this.emitFile({
          type: "asset",
          fileName: "edition-manifest.json",
          source: JSON.stringify({ schemaVersion: 1, edition, platform, shell, version, expectedBackendFeature: edition === "ai" ? "ai" : "core", identifier }, null, 2) + "\n",
        });
      }
    }],
    // The only current public asset is the C-57 model-download probe. It is
    // part of the explicit AI development edition and must not leak into the
    // Core release bundle through Vite's unconditional public-dir copy.
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
