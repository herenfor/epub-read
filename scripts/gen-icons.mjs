/**
 * 从 src-tauri/icons/source/ 的 SVG 源生成全部应用图标。
 * - 桌面：src-tauri/icons/{32x32,128x128,128x128@2x}.png 与 icon.ico
 * - Android 8+：自适应图标（前景 / 背景 / 单色主题层）与 mipmap-anydpi-v26/ic_launcher.xml
 * - Android 7.x：传统 ic_launcher / ic_launcher_round，由桌面圆角方块与圆形源直接缩放
 *   （Tauri 自带的传统图标会把前景裁切放大，不能用）。
 * 用法：pnpm icons
 */
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const source = join(root, "src-tauri", "icons", "source");
const desktopOut = join(root, "src-tauri", "icons");
const androidRes = join(root, "src-tauri", "gen", "android", "app", "src", "main", "res");
const tauriCli = join(root, "node_modules", "@tauri-apps", "cli", "tauri.js");

const densities = { mdpi: 48, hdpi: 72, xhdpi: 96, xxhdpi: 144, xxxhdpi: 192 };

function tauriIcon(input, out, pngSizes) {
  const args = [tauriCli, "icon", input, "-o", out];
  if (pngSizes) args.push("-p", pngSizes.join(","));
  execFileSync(process.execPath, args, { cwd: root, stdio: ["ignore", "ignore", "inherit"] });
}

const work = mkdtempSync(join(tmpdir(), "epub-reader-icons-"));
try {
  const full = join(work, "full");
  tauriIcon(join(source, "manifest.json"), full);
  for (const name of ["32x32.png", "128x128.png", "128x128@2x.png", "icon.ico"]) {
    copyFileSync(join(full, name), join(desktopOut, name));
  }

  mkdirSync(join(androidRes, "mipmap-anydpi-v26"), { recursive: true });
  copyFileSync(
    join(full, "android", "mipmap-anydpi-v26", "ic_launcher.xml"),
    join(androidRes, "mipmap-anydpi-v26", "ic_launcher.xml"),
  );

  const sizes = Object.values(densities);
  const square = join(work, "square");
  const round = join(work, "round");
  tauriIcon(join(source, "app-icon.svg"), square, sizes);
  tauriIcon(join(source, "app-icon-round.svg"), round, sizes);

  for (const [density, size] of Object.entries(densities)) {
    const dir = join(androidRes, `mipmap-${density}`);
    mkdirSync(dir, { recursive: true });
    for (const layer of ["ic_launcher_foreground", "ic_launcher_background", "ic_launcher_monochrome"]) {
      copyFileSync(join(full, "android", `mipmap-${density}`, `${layer}.png`), join(dir, `${layer}.png`));
    }
    copyFileSync(join(square, `${size}x${size}.png`), join(dir, "ic_launcher.png"));
    copyFileSync(join(round, `${size}x${size}.png`), join(dir, "ic_launcher_round.png"));
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}
console.log("icons: desktop and Android launcher icons regenerated from src-tauri/icons/source");
