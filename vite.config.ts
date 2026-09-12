import { defineConfig } from "vitest/config";
import { loadEnv } from "vite";
import packageJson from "./package.json";
import react from "@vitejs/plugin-react";
import { normalizeAppEdition } from "./src/config/editionValue";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, ".", "");
  // Unqualified dev and production builds are Core-safe. Explicit
  // VITE_EDITION selects the AI development or production bundle.
  const edition = normalizeAppEdition(env.VITE_EDITION ?? "core");
  const version = packageJson.version;
  const identifier = edition === "ai" ? "dev.epubreader.ai" : "dev.epubreader.app";
  return {
    // Keep edition decisions in the compiled module graph. This lets a core
    // production build remove AI-only branches instead of relying on a
    // runtime DEV check.
    define: {
      __APP_EDITION__: JSON.stringify(edition),
    },
    plugins: [react(), {
      name: "edition-manifest",
      generateBundle() {
        this.emitFile({
          type: "asset",
          fileName: "edition-manifest.json",
          source: JSON.stringify({ schemaVersion: 1, edition, version, expectedBackendFeature: edition === "ai" ? "ai" : "core", identifier }, null, 2) + "\n",
        });
      },
    }],
    // The only current public asset is the C-57 model-download probe. It is
    // part of the explicit AI development edition and must not leak into the
    // Core release bundle through Vite's unconditional public-dir copy.
    publicDir: edition === "ai" ? "public-ai" : false,
    clearScreen: false,
    server: {
      // 注意：1420 曾被 Hyper-V 保留段占用；后改 5517，但 2025-08 电脑重启后
      // 5470-5569 也落入 Windows 保留段（EADDRINUSE），现改用 5173
      port: 5173,
      strictPort: true,
    },
    build: {
      target: "es2022",
      outDir: edition === "ai" ? "dist/ai" : "dist/core",
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
