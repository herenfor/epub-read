import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeAppEdition } from "../src/config/editionValue.ts";
import { normalizeAppPlatform } from "../src/config/platformValue.ts";

const [, , command = "build", rawEdition = "core"] = process.argv;
const edition = normalizeAppEdition(rawEdition);
if (!new Set(["dev", "build", "tauri-dev"]).has(command)) throw new Error("command must be dev, build, or tauri-dev");
// Browser development defaults to web. Production and Tauri dev default to
// the current Windows shell so existing package scripts keep their meaning.
const defaultPlatform = command === "dev" ? "web" : "windows";
const platform = normalizeAppPlatform(process.env.VITE_APP_PLATFORM ?? defaultPlatform);

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
// Keep an explicit CARGO_TARGET_DIR from the caller (e.g. the Android build
// entry point in scripts/build-android.sh) and only fall back to the per-edition
// desktop default. Desktop build behaviour is unchanged.
const env = {
  ...process.env,
  VITE_EDITION: edition,
  VITE_APP_PLATFORM: platform,
  EPUB_READER_EXPECTED_EDITION: edition,
  CARGO_TARGET_DIR:
    process.env.CARGO_TARGET_DIR && process.env.CARGO_TARGET_DIR.trim() !== ""
      ? process.env.CARGO_TARGET_DIR
      : resolve(projectRoot, "src-tauri", `target-${edition}`),
};
const node = process.execPath;
const runNode = (entry, args = []) => {
  const result = spawnSync(node, [resolve(projectRoot, entry), ...args], {
    cwd: projectRoot,
    stdio: "inherit",
    env,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
};

if (command === "dev") runNode("node_modules/vite/bin/vite.js");
if (command === "build") {
  runNode("node_modules/typescript/bin/tsc", ["--noEmit"]);
  runNode("node_modules/vite/bin/vite.js", ["build", "--mode", "production"]);
  runNode("scripts/verify-edition-artifacts.mjs", [edition]);
}
if (command === "tauri-dev") {
  // Tauri CLI exposes Cargo features but not Cargo's --no-default-features
  // flag. Cargo.toml has default = [], so selecting exactly one feature is
  // sufficient and keeps this argument list valid for Tauri 2.x.
  const args = ["dev"];
  if (edition === "ai") args.push("--features", "ai", "--config", "src-tauri/tauri.ai.conf.json");
  else args.push("--features", "core", "--config", "src-tauri/tauri.core.conf.json");
  runNode("node_modules/@tauri-apps/cli/tauri.js", args);
}
