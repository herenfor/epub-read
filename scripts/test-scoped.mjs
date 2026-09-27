// Default to explicitly selected files. Full runs require the deliberate test:all entry.
import { existsSync, statSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2).filter((arg) => arg !== "--");

function stop(message) {
  console.error(message);
  console.error('用法：pnpm test src/模块/文件.test.ts [-t "用例名"]');
  console.error("只有用户明确要求全量时才使用 pnpm test:all。");
  process.exit(1);
}

const all = args.length === 1 && args[0] === "--all";
const files = [];
const options = [];
if (!all) {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "-t" || arg === "--testNamePattern") {
      const pattern = args[++i];
      if (!pattern || pattern.startsWith("-")) stop("请提供具体用例名。");
      options.push("-t", pattern);
      continue;
    }
    const path = resolve(root, arg);
    const local = relative(root, path);
    if (
      arg.startsWith("-") || isAbsolute(local) || local.startsWith(`..${sep}`) ||
      !local.endsWith(".test.ts") || !existsSync(path) || !statSync(path).isFile()
    ) {
      stop(`必须指定项目内真实的 .test.ts 文件，不能使用目录或宽泛过滤：${arg}`);
    }
    files.push(local.split(sep).join("/"));
  }
  if (files.length === 0) stop("未指定测试文件，已停止；不会自动运行全量测试。");
}

const selected = [...new Set(files)];
console.log(all ? "全量测试：此入口仅用于用户明确要求的全量运行。" : `定向测试：${selected.join(", ")}`);
const result = spawnSync(process.execPath, [
  resolve(root, "node_modules/vitest/vitest.mjs"), "run", ...selected, ...options,
], { cwd: root, stdio: "inherit" });
if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}
process.exit(result.status ?? 1);
