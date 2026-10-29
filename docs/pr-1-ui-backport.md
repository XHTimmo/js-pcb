# PR 标题

feat: 从 #1 提取多语言与界面改进并统一许可证

# PR 描述

当前布线窗口仅有中文界面，日志覆盖预览区，且项目的 LICENSE、包元信息与扩展许可证声明不一致。本次提取 #1 的多语言与界面展示改进，提供中英文切换、蓝色主题、参数步进按钮、底部日志和关于弹窗，并统一整体分发许可证为 GPL-2.0。

## 来源与贡献者

- 部分提取自 [#1](https://github.com/XHTimmo/js-pcb/pull/1)，不是对该 PR 的整体合并。
- 原贡献者：[@easyeda2021](https://github.com/easyeda2021)。
- 来源提交：`2b18d934047c80a281b3b3b7d8689604ead98a3e`、`81c3b5a8d27c9f2fbe8b5e65806b0e96103cff9b`。
- 来源和署名保留在 NOTICE.md、相关源文件及关于弹窗中。

## 行为与范围

- 打开时读取 EDA 当前语言，浏览器环境使用浏览器语言；窗口内可切换中文与英文。
- 翻译菜单、参数、提示、历史记录和日志，切换语言后刷新已有日志及历史记录。
- 保留历史记录、DSN 获取按钮、手动导入/导出 SES 和现有参数默认值。
- 保留原有布线引擎、DSN/SES 转换及 Worker 协议；不包含 #1 的自动导入和算法改动。
- 将根 LICENSE 更新为 GPL-2.0，并同步包元信息；在 LICENSES/Apache-2.0.txt 保留原 SDK 模板的许可证全文和 JLCEDA 版权声明。

## 验证

已完成以下验证：

- `npm run test:ui`：7 项检查全部通过，覆盖语言检测、加载回退、快速切换、词条完整性和旧 Worker 日志翻译。
- `npm run build`：编译和扩展打包通过。
- `npx eslint src/index.ts`、14 个 JavaScript 文件的语法检查及换行格式检查通过（本仓库包元信息原有 CRLF，使用 `git -c core.whitespace=cr-at-eol diff --check`）。
- Edge 无头浏览器检查通过：中英文切换、底部日志布局、关于弹窗与焦点恢复、数字步进边界、历史记录、旧 Worker 完成消息、SES 下载及手动导入按钮。
- 浏览器中的 Worker 输出和 EDA API 使用模拟数据，确认布线完成不会自动导入；尚未在嘉立创EDA客户端进行真实布线、SES 导入或 DRC 验证。
- 当时的 `npm test -- --runInBand`：1 个测试套件通过、10 个套件因缺少 `src/autorouter/` 模块无法运行。这是本 PR 的历史验证记录；该旧套件后续已删除，当前测试入口见 [README](../README.md#开发验证)。

## 署名

文档与界面保留 [@easyeda2021](https://github.com/easyeda2021) 的 GitHub 署名；原始提交及共同作者信息保留在 Git 历史中。
