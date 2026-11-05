# SeLis AUR 源构建候选（ER-0062）

状态：**候选，未上传 AUR、未注册包名、未推送、未打 tag、未改产品版本。** 本轮没有完整的
Arch 构建环境；已用 Arch 官方 pacman 包内的 `makepkg 7.1.0` 仅执行 `--printsrcinfo`
生成 `.SRCINFO`，但完整 `makepkg` 构建和安装文件核对尚未在 Arch 上执行。

## 范围与基线

- 只新增 x86-64 源码构建所需的 `PKGBUILD` 和本说明；不修改 Rust、UI、共享构建脚本或
  `src-tauri/tauri.linux-core.conf.json`。
- 基线为实际 main `7081619dfae5a12b0ec8b29425d2d5d2f5175548`（版本 `0.4.1`）。产品源码
  没有为本包做额外修改。
- 上游当前没有包含 Linux 支持的正式 tag：`v0.4.0` 不含本批 Linux 支持，`v0.4.1` 尚未发行。
  因此 `source` 使用明确提交的本地源码归档，不填写不存在的发行地址，也不编造校验值。

## 本地候选源码

在 `PKGBUILD` 同目录执行：

```bash
git archive --format=tar --prefix=selis-0.4.1/ \
  7081619dfae5a12b0ec8b29425d2d5d2f5175548 | gzip -9n > selis-0.4.1.tar.gz
sha256sum selis-0.4.1.tar.gz
```

应得到：

```text
3fe07603ade4b3928a579e5e4a9a3ce7000afdb1d1da7052ee27b63a78d3a1c8  selis-0.4.1.tar.gz
```

该归档不进入 Git，只用于本地审查和构建。`PKGBUILD` 的 `sha256sums` 对应上面这条命令的
输出；重新生成后应保持一致。**它不是正式上游发行归档，不能把这个本地文件当作 AUR 的
可下载源上传。**

## Arch 依赖

以下包名在 2026-11-05 按当前 Arch 官方仓库查询确认，并和 Linux 构建入口及二进制的直接
`NEEDED` 对照；版本只是当时仓库版本，不是最低版本要求：

| 类型 | 包 | 用途 |
| --- | --- | --- |
| 运行 | `gtk3`、`webkit2gtk-4.1`、`libsoup3` | GTK 3 / WebKitGTK 4.1 / Soup 3 |
| 运行 | `glib2`、`cairo`、`gdk-pixbuf2`、`dbus`、`fontconfig`、`gcc-libs` | 二进制的直接共享库依赖 |
| 运行 | `hicolor-icon-theme`、`xdg-utils` | 图标主题和 `xdg-open` 外部打开 |
| 构建 | `rust`（提供 `cargo`）、`nodejs`、`pnpm`、`pkgconf` | Rust、前端与 Tauri CLI、`pkg-config` |
| 构建 | `gtk3`、`webkit2gtk-4.1`、`fontconfig` | `scripts/build-linux.sh` 检查的三个 pkg-config 模块 |

当时查询到的参考版本：`gtk3 3.24.52-2`、`webkit2gtk-4.1 2.54.2-1`、`libsoup3 3.8.1-1`、
`glib2 2.90.1-1`、`cairo 1.18.6-1`、`gdk-pixbuf2 2.44.8-1`、`fontconfig 2.18.3-2`、
`dbus 1.16.2-2`、`nodejs 26.13.0-1`、`pnpm 12.17.0-1`、`rust 1.99.1-1`、`pkgconf 3.0.10-1`。
`base-devel` 按 Arch 构建惯例由 makepkg 环境提供，不在 `makedepends` 重复。

运行依赖来自当前 Linux 构建的直接 `readelf -d` 结果；release/LTO 产物仍应在 Arch 实包
中复核，不能把 debug 二进制的依赖表当最终证明。

## Arch 构建与安装核对

在干净的 Arch x86-64 环境中，把上面的 `selis-0.4.1.tar.gz` 放到 `PKGBUILD` 同目录后执行：

```bash
makepkg --printsrcinfo > .SRCINFO
makepkg -sri
```

本目录的 `.SRCINFO` 已由 Arch 的 `makepkg 7.1.0 --printsrcinfo` 生成（只在 Ubuntu 主机上
解析 `PKGBUILD`，不是 Arch 构建）。`--printsrcinfo` 不校验源码归档是否存在、校验值是否
可用或依赖是否能安装；正式 tag 更新 `source` 后必须重新生成。完整构建和安装仍须在 Arch
上按上面的命令执行。

`build()` 只调用现有 `scripts/build-linux.sh --no-bundle -- --locked`，前端使用
`pnpm install --frozen-lockfile`，Rust 产物放在 `$srcdir/target/release/epub-reader`。
`package()` 安装：

| 路径 | 内容 |
| --- | --- |
| `/usr/bin/selis` | 本机二进制 |
| `/usr/share/applications/selis.desktop` | `Exec=selis %U`、`application/epub+zip`、`Office;Viewer;` |
| `/usr/share/icons/hicolor/{32x32,128x128,256x256}/apps/selis.png` | 现有图标 |
| `/usr/share/licenses/selis/` | `LICENSE`、`LICENSING.md`、`NOTICE`、`THIRD_PARTY_LICENSES.md`、`third-party-licenses/` |

`application/epub+zip` 由 `shared-mime-info` 提供，本包不新增 MIME XML；也不安装后台服务、
删除/迁移用户数据的钩子、全局 npm/pnpm 包或桌面默认关联。desktop/MIME/图标缓存由
`desktop-file-utils`、`shared-mime-info`、`gtk-update-icon-cache` 的 pacman 钩子处理。

安装后核对：

```bash
pacman -Ql selis
desktop-file-validate /usr/share/applications/selis.desktop
gio mime application/epub+zip
```

并从文件管理器或 `gio open` 打开一册合成 EPUB，确认 `%U` 把路径传给应用。

## 本轮验证状态

| 项目 | 结果 |
| --- | --- |
| `bash -n packaging/aur/PKGBUILD` | 通过 |
| 本地源码归档两次生成 SHA-256 一致 | 通过，值见上 |
| 用临时目录模拟 `package()` 检查安装路径和 desktop 内容 | 通过（不是 makepkg） |
| `makepkg --printsrcinfo > .SRCINFO` | 已用 Arch `makepkg 7.1.0` 生成；只解析 PKGBUILD，不是 Arch 构建 |
| `makepkg` 构建、依赖解析、安装 | **未执行** |
| Arch 上的文件关联、图标和升级 | **未验证** |

本机是 Ubuntu 26.04.1/WSL2，没有安装 `makepkg`、`pacman`，也没有可用的容器/隔离 Arch 环境。
`.SRCINFO` 是从 Arch 官方 pacman 包中解出 `makepkg` 后单独运行 `--printsrcinfo` 得到的字段
快照；没有执行依赖解析、编译或安装，不能作为 Arch 构建通过的证据。Bash 语法和
`--printsrcinfo` 通过都不等于 Arch 构建通过；本轮停在明确标注的脚本候选，等待 Arch 环境或
维护者复核。

## 正式发行前还要做

1. 等包含本批 Linux 支持的上游 tag 和发行归档出现，把 `source` 改为该 tag 的真实归档
   地址，重新生成并核对 `sha256sums`。
2. 在干净的 Arch x86-64 环境执行一次 `makepkg --printsrcinfo > .SRCINFO` 和完整
   `makepkg`，再按上面的安装清单核对。
3. 经用户明确授权后再注册/上传 AUR；本包目前没有执行这些动作。
