# SeLis Licensing

Copyright © 2026 HeRenFor.

Project: <https://github.com/herenfor/epub-read>

> This document is intended as a licensing guide. In case of conflict, the
> applicable license text in [LICENSE](LICENSE) controls.

## Current license

Except for third-party components, which are identified as such, the original
code in this repository that is copyright HeRenFor is made available — from
`v0.4.0` onward — under the:

**GNU General Public License v3.0 (`GPL-3.0-only`)**

The complete, unmodified license text is in [LICENSE](LICENSE). Its canonical
location is <https://www.gnu.org/licenses/gpl-3.0.html>.

GPL-3.0 is a strong **copyleft** Open Source license approved by the Open
Source Initiative (OSI) and the Free Software Foundation (FSF).

## Summary of rights and obligations under GPL-3.0

Under the terms and conditions of the GNU General Public License v3.0:

- **Freedom to use, study, and modify** — You may run the program for any
  purpose, study how it works, and modify it to suit your needs.
- **Copyleft on redistribution** — If you distribute copies of SeLis, modified
  versions of SeLis, or larger works that incorporate original SeLis code
  (whether free of charge or for a fee), the entire distributed work must be
  licensed as a whole under **GPL-3.0**, and you must make the **Complete
  Corresponding Source** available to all recipients under the same license.
- **No closed-source derivatives** — You may not distribute modified builds or
  incorporate SeLis code into proprietary, closed-source applications without a
  separate written license from the copyright holder.
- **Preservation of notices** — You must retain all copyright notices, license
  notices, and warranty disclaimers on all copies and substantial portions, and
  prominently mark any modified files as changed.
- **No warranty** — The software is provided "as is", without warranty of any
  kind, to the extent permitted by applicable law.

## Brand, name, and application identity

In accordance with Section 7 of the GNU General Public License v3.0, this
license does **not** grant permission to use the trade names, trademarks,
service marks, or product names of the project — including **SeLis**,
**SeLis AI**, and **EPUB Reader** — or the official application icons and
application identifiers (`dev.epubreader.app`, `dev.epubreader.ai`,
`dev.herenfor.epubreader`), except as required for reasonable and customary use
in describing the origin of the work.

If you distribute a modified version or a third-party build of this software,
you must:

- change the user-visible application name and icon so that it is clearly
  distinguished from official **SeLis** releases; and
- change the package / bundle identifier (`identifier` / `applicationId`) and
  signing keys so that your build does not collide with or impersonate official
  installations.

## Third-party components

This license applies only to original HeRenFor code.

It does **not** change the license of any third-party component, and it does not
relicense anything HeRenFor does not own. Every third-party component —
including Tauri, React, Rust crates, npm packages, WebView2, SQLite, and all
MIT, Apache-2.0, MPL-2.0, BSD, ISC, Zlib, Unicode-3.0 and CC-licensed
components and assets — remains subject to its own license and copyright terms.

Third-party license texts, notices, and source locations are kept in:

- [THIRD_PARTY_LICENSES.md](THIRD_PARTY_LICENSES.md)
- [third-party-licenses/](third-party-licenses/)

As a special exception under Section 7 of the GNU General Public License v3.0,
the copyright holder of original code in SeLis grants permission to link or
combine the work with the third-party components listed in
[THIRD_PARTY_LICENSES.md](THIRD_PARTY_LICENSES.md) (including, in the
experimental AI edition, the Live2D Cubism runtime used by
`pixi-live2d-display`) and to distribute the resulting combination, provided
that all other requirements of the GNU General Public License v3.0 are met for
all parts of the work other than those third-party components.

## Alternative licensing

Original code in this repository is solely owned by HeRenFor. Uses that cannot
comply with the terms of the GNU General Public License v3.0 (such as
integration into proprietary closed-source products) require a separate written
license from the copyright holder.

For licensing inquiries, contact the repository owner through GitHub:
<https://github.com/herenfor/epub-read>

## Contributions

We welcome bug reports, feedback, and discussions in GitHub Issues. If you
would like to contribute code, please open an Issue first to align on scope and
design before submitting a Pull Request.

By submitting a contribution to this repository, you certify that you have the
right to submit it and agree that your contribution is licensed under
`GPL-3.0-only`, and that you grant the project maintainer (`HeRenFor`) a
perpetual, worldwide, non-exclusive, royalty-free license to use, modify,
distribute, and relicense the contribution as part of SeLis.

## Historical releases

License changes in this repository are **not retroactive**. They do not revoke
any license already validly granted for an earlier release, and Git history is
preserved intact:

- **`v0.2.2` and earlier**: published under the **Apache License 2.0**. Copies
  of those versions remain usable under the Apache-2.0 terms that applied when
  they were published.
- **`v0.2.3` through `v0.3.11`**: published under the **PolyForm Strict License
  1.0.0**. Copies of those versions remain subject to the PolyForm Strict 1.0.0
  terms they were published with.
- **`v0.4.0` and later**: published under the **GNU General Public License v3.0
  (`GPL-3.0-only`)**.

---

## 中文说明（仅供参考）

> 本节是上面英文说明的中文对照，便于阅读。如有歧义或冲突，以
> [`LICENSE`](LICENSE) 中的 GNU General Public License v3.0 正式英文原文为准。

- **当前许可证**：除明确标注的第三方组件外，本仓库中由 HeRenFor 拥有版权的
  原创代码，自 **`v0.4.0` 起**以 **GNU General Public License v3.0
  （`GPL-3.0-only`）** 开源许可证提供。完整、未修改的许可证正文见
  [`LICENSE`](LICENSE)。
- **性质与核心规则（Copyleft）**：`GPL-3.0` 是经 OSI 与 FSF 认证的强互惠型
  （Copyleft）开源许可证：
  - 你可以自由运行、研究、修改本软件；
  - 如果你分发本软件的副本、修改版，或将本项目的原创代码整合进其他软件中对外发
    布（无论免费还是收费），**整个衍生作品必须同样以 `GPL-3.0` 许可整体开源**，
    并向所有接收者提供完整的对应源代码（Complete Corresponding Source）；
  - **禁止闭源套壳或闭源派生**：未经版权所有者另行书面授权，不得将修改版或包含
    本项目代码的衍生软件以闭源形式分发；
  - 必须在所有副本中保留原有的版权声明、许可证声明与免责声明，并对修改过的文件
    作出明确标记。
- **名称、品牌与应用标识保留**：依据 GPL-3.0 第 7 条，本许可证**不授予**使用
  **SeLis**、**SeLis AI**、**EPUB Reader** 等项目名称、商标、应用图标及官方应用
  包名（`dev.epubreader.app`、`dev.epubreader.ai`、`dev.herenfor.epubreader`）
  的权利（合理说明软件来源除外）。任何第三方修改版或二次打包分发版本**必须更换
  应用名称、图标与包名**，不得冒充官方版本或与官方安装包冲突。
- **第三方组件**：本许可证仅适用于 HeRenFor 原创代码，**不改变**任何第三方组件
  原本的许可证与版权归属；完整清单与许可证文本见
  [`THIRD_PARTY_LICENSES.md`](THIRD_PARTY_LICENSES.md) 与
  [`third-party-licenses/`](third-party-licenses/)。对于 AI 实验版中列于
  `THIRD_PARTY_LICENSES.md` 的第三方组件（如 `pixi-live2d-display` 使用的
  Live2D Cubism 运行时），版权所有者依据 GPL-3.0 第 7 条额外授予与之链接组合的
  许可例外。
- **单独授权**：如需将本项目代码用于无法遵守 GPL-3.0 开源义务的场景（如集成进
  商业闭源产品），须另行获得版权所有者的单独书面授权。许可咨询请通过 GitHub 联
  系仓库所有者（<https://github.com/herenfor/epub-read>）。
- **代码贡献**：提交代码前建议先在 Issue 中沟通方案。向本仓库提交贡献即表示你
  有权提交该内容，同意按 `GPL-3.0-only` 授权，并授予项目维护者（`HeRenFor`）在
  SeLis 项目中永久、全球、非排他、免版税地使用、修改、分发及再许可该贡献的权利。
- **历史版本授权边界**：许可证变更不具有追溯力，不改写 Git 历史：
  - **截至 `v0.2.2`（含）**：依据 **Apache License 2.0** 发布；
  - **`v0.2.3` 至 `v0.3.11`**：依据 **PolyForm Strict License 1.0.0** 发布；
  - **`v0.4.0` 及之后**：依据 **GNU General Public License v3.0
    （`GPL-3.0-only`）** 发布。
