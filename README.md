[简体中文](#chinese) · [English](#english)

<a id="chinese"></a>

这是一个为嘉立创EDA专业版（JLCEDA Pro）开发的自动布线扩展插件，集成了开源项目 [JS-PCB](https://github.com/vygr/JS-PCB) 的布线引擎。

## 功能特性

- **一键布线**：自动获取当前 PCB 的 DSN 数据进行布线。
- **参数配置**：支持调整过孔代价、网格分辨率、采样次数等高级布线参数。
- **中英文界面**：打开时跟随嘉立创EDA或浏览器语言，也可通过窗口右上角的语言按钮切换。
- **界面展示**：蓝色主题、参数步进按钮、底部日志及关于弹窗；日志和历史记录随语言切换更新。
- **历史记录**：自动保存布线历史，支持导出历史版本的 SES 文件。
- **布线控制**：显示实时进度，支持停止和重新开始；超时或无法布通的网络会停止重试并保留可用结果。
- **导入方式**：保留手动导入，可选择开启“完成后自动导入”（默认关闭）；部分布通或超时结果需要确认。
- **规则兼容**：修复 DSN 解析、间距、过孔尺寸和焊盘层处理，预览及布线支持多路径板框。

## 使用方法

1. 安装本扩展。
2. 打开 PCB 文档。
3. 点击顶部菜单：JSPCB - 自动布线
4. 在弹出的窗口中配置布线参数（或保持默认）。
5. 点击 **开始布线**。
6. 等待布线完成，点击 **导入 SES**。

![界面示例](images/dialog.jpg)

## 已知局限性与贡献说明

由于 JS-PCB 引擎本身的算法特性限制，**当前的自动布线效果可能较为一般**，特别是对于元件密度较高或规则复杂的 PCB，可能会出现：

- 布通率较低，无法完成所有网络的连接。
- 走线路径不够优化，存在绕线或冗余过孔。
- 网格布线难以完整表达所有复杂设计规则，导入后仍需检查连接与 DRC。
- 超时按每次采样计算，默认 3600 秒，0 表示不限制。

本项目的主要目的是**提供一个将自动布线器集成到 JLCEDA Pro 的技术框架与参考实现**。

我们非常欢迎社区开发者参与进来，基于此框架：

- 优化现有的布线参数配置逻辑。
- 改进底层布线算法。
- 引入或移植其他更强大的开源布线引擎。

希望能通过社区的力量，共同打造一个好用的开源自动布线扩展！

## 贡献来源

本次多语言与界面展示改进部分提取并改编自 [PR #1](https://github.com/XHTimmo/js-pcb/pull/1)，感谢原贡献者 （[@easyeda2021](https://github.com/easyeda2021)）。保留历史记录与手动导入/导出流程；详细来源及第三方版权声明见 [NOTICE.md](NOTICE.md)，本次 PR 描述草稿见 [docs/pr-1-ui-backport.md](docs/pr-1-ui-backport.md)。

后续通过 [PR #3](https://github.com/XHTimmo/js-pcb/pull/3) 整合的 DSN、布线、焊盘层和过孔修复，同时保留主线的历史记录、手动操作、双语界面与署名。完整来源见 [NOTICE.md](NOTICE.md)。

## 开发验证

```bash
npm ci
npm run test:ui
npm run test:routing
node iframe/jspcb/test_runner.js
npm run build
```

`test:ui` 验证语言加载与界面兼容逻辑，`test:routing` 验证实际布线引擎和 DSN→SES 转换；命令行测试默认读取 `tests/fixtures/` 下的样例，也支持传入 DSN 路径。原有 `npm test` 中的 `tests/autorouter/` 测试引用了当前仓库缺失的 `src/autorouter/` 模块，需要另行补齐；构建成功不代表已完成真实 PCB 的布线或 DRC 验证。

## 第三方开源组件说明

本项目在自动布线功能中移植并使用了以下第三方开源项目代码：

- **JS-PCB** (https://github.com/vygr/JS-PCB)
    - 许可证：GNU General Public License v2.0 (GPL-2.0)
    - 原始代码位置：`iframe/jspcb/` 目录下的核心逻辑文件（如 `router.js`, `worker.js`, `mymath.js` 等）。
    - 修改说明：
        - `iframe/jspcb/index.html`: 修改了 UI 布局和样式以适配 EDA 扩展风格。
        - `iframe/jspcb/main.js`: 增加了与 JLCEDA API 通信的胶水代码（DSN 获取与 SES 导入）。
        - 修复了在 IFrame 环境下 Worker 加载的跨域/安全问题。

**注意**：本扩展包遵循 GPL-2.0 协议分发，许可证全文见 [LICENSE](LICENSE)。SDK 模板原有的 Apache-2.0 许可证与 JLCEDA 版权声明保留于 [LICENSES/Apache-2.0.txt](LICENSES/Apache-2.0.txt)。如果您分发本扩展包或其衍生作品，请确保遵守相应许可证条款。

---

<a id="english"></a>

# JS-PCB Autorouter for EasyEDA Pro

An automatic routing extension for EasyEDA Pro (JLCEDA Pro), powered by the open-source
[JS-PCB](https://github.com/vygr/JS-PCB) routing engine.

## Features

- **One-click routing**: automatically obtains the current PCB's DSN data and starts routing.
- **Parameter configuration**: adjust via cost, grid resolution, sample count and other advanced routing parameters.
- **Chinese/English UI**: follows the language of EasyEDA or the browser when opened; it can also be switched with the language button in the top-right corner.
- **Interface**: blue theme, parameter stepper buttons, bottom log panel and About dialog; the log and history update when the language changes.
- **History**: routing history is saved automatically, and SES files from previous runs can be exported.
- **Routing control**: live progress display, support for stopping and restarting; when the timeout is reached or a net cannot be routed, retries stop and the available result is kept.
- **Import**: manual import is retained, with an optional "auto import when finished" setting (off by default); partial or timed-out results require confirmation.
- **Rule compatibility**: fixes for DSN parsing, clearance, via size and pad-layer handling; the preview and router support multi-path board outlines.

## Usage

1. Install the extension.
2. Open a PCB document.
3. Click **JSPCB - Auto Route** in the top menu.
4. Configure the routing parameters in the window (or keep the defaults).
5. Click **Start routing**.
6. Wait for routing to finish, then click **Import SES**.

![Interface example](images/dialog.jpg)

## Known Limitations and Contributions

Due to the algorithmic characteristics of the JS-PCB engine, **the current routing quality may be
moderate**. For dense boards or boards with complex rules, you may see:

- A low completion rate, with some nets left unconnected.
- Non-optimal paths, including detours or redundant vias.
- Grid-based routing cannot fully express all complex design rules; connectivity and DRC must still be checked after import.
- The timeout is applied per sample. The default is 3600 seconds; 0 means unlimited.

The main purpose of this project is to **provide a technical framework and reference implementation
for integrating an autorouter into JLCEDA Pro**.

Community contributions are very welcome. Based on this framework, you can:

- Improve the existing routing parameter configuration.
- Improve the underlying routing algorithm.
- Integrate or port other, more powerful open-source routing engines.

We hope to build a useful open-source autorouting extension together with the community.

## Contribution Sources

The multilingual and UI improvements were extracted and adapted from
[PR #1](https://github.com/XHTimmo/js-pcb/pull/1). Thanks to the original contributor
([@easyeda2021](https://github.com/easyeda2021)). The history feature and the manual import/export
flow are retained. See [NOTICE.md](NOTICE.md) for detailed attribution and third-party copyright
notices, and [docs/pr-1-ui-backport.md](docs/pr-1-ui-backport.md) for the PR description draft.

The DSN, routing, pad-layer and via fixes integrated through
[PR #3](https://github.com/XHTimmo/js-pcb/pull/3) retain the mainline history, manual operations,
bilingual UI and attribution. See [NOTICE.md](NOTICE.md) for the complete provenance.

## Development and Validation

```bash
npm ci
npm run test:ui
npm run test:routing
node iframe/jspcb/test_runner.js
npm run build
```

`test:ui` verifies language loading and UI compatibility logic; `test:routing` verifies the actual
routing engine and DSN-to-SES conversion. The command-line tests read sample files from
`tests/fixtures/` by default and also accept explicit DSN paths.

The existing `npm test` suite under `tests/autorouter/` references the `src/autorouter/` modules,
which are missing from the current repository and must be restored separately. A successful build
does not mean that routing or DRC has been verified on a real PCB.

## Third-Party Open-Source Components

This project ports and uses code from the following third-party open-source project in its
autorouting feature:

- **JS-PCB** (https://github.com/vygr/JS-PCB)
    - License: GNU General Public License v2.0 (GPL-2.0)
    - Original code location: core logic files under `iframe/jspcb/` (such as `router.js`, `worker.js`, `mymath.js`, etc.).
    - Modifications:
        - `iframe/jspcb/index.html`: UI layout and styles adapted to the EDA extension style.
        - `iframe/jspcb/main.js`: glue code for communicating with the JLCEDA API (DSN fetching and SES import).
        - Fixed Worker loading under the iframe cross-origin/security environment.

**Note**: This extension is distributed under GPL-2.0. The full license text is in [LICENSE](LICENSE).
The Apache-2.0 license and JLCEDA copyright notice from the original SDK template are retained in
[LICENSES/Apache-2.0.txt](LICENSES/Apache-2.0.txt). If you distribute this extension or a derivative
work, please comply with the applicable license terms.
