import { createReadStream, statSync } from "node:fs";
import { resolve, sep } from "node:path";
import { installCompanionDiagnostics } from "./ai-companion-diagnostics.mjs";
import { installCompanionHarness } from "./ai-companion-harness.mjs";
import { installReaderToolDevBridge } from "./reader-tool-dev-bridge.mjs";

/** Dev middleware only: local Live2D materials never enter Vite's public copy/build. */
export function aiCompanionDevAssets() {
  return {
    name: "ai-companion-local-assets",
    configureServer(server) {
      installCompanionDiagnostics(server);
      installCompanionHarness(server);
      installReaderToolDevBridge(server);
      const root = resolve(server.config.root, ".ai-companion-local");
      server.middlewares.use("/__ai-companion", (request, response) => {
        try {
          const path = resolve(root, "." + decodeURIComponent(new URL(request.url || "/", "http://localhost").pathname));
          if (!path.startsWith(root + sep) || !statSync(path).isFile()) throw new Error("Missing local asset");
          response.setHeader("Content-Type", path.endsWith(".js") ? "text/javascript"
            : path.endsWith(".json") ? "application/json" : path.endsWith(".png") ? "image/png" : "application/octet-stream");
          response.setHeader("Cache-Control", "no-store");
          if (request.method === "HEAD") { response.end(); return; }
          createReadStream(path).on("error", () => response.destroy()).pipe(response);
        } catch { response.statusCode = 404; response.end("Local AI sample is not installed"); }
      });
    },
  };
}
