# 来源与贡献者 / Attribution

## PR #1 的部分移植

本次中英文支持与界面展示改进提取并改编自：

- 原始 PR：[XHTimmo/js-pcb#1 — Refactor 1.6.0 interaction with multi-language support and fixes](https://github.com/XHTimmo/js-pcb/pull/1)
- 原贡献者：**summving <summving@easyeda.com>**，GitHub：[@easyeda2021](https://github.com/easyeda2021)
- 来源提交：`2b18d934047c80a281b3b3b7d8689604ead98a3e`、`81c3b5a8d27c9f2fbe8b5e65806b0e96103cff9b`
- 修改范围：中英文词条与加载模块、蓝色主题、参数布局、数字步进按钮、底部日志、关于弹窗及预览配色。

移植时保留了当前工程的历史记录、手动获取 DSN、手动导入/导出 SES、参数默认值和原有 Worker 协议；语言切换会重新渲染日志及历史记录。界面文案根据这些实际行为作了调整。PR #1 的算法、焊盘层处理、过孔规则、自动导入与新 Worker 协议不属于本次移植范围。

This is a partial adaptation of PR #1, contributed by summving (@easyeda2021), rather than a merge of the complete PR. The original contributor's attribution is retained in the adapted source files and the About dialog.

提交本次改动时可保留以下共同作者信息：

```text
Co-authored-by: summving <summving@easyeda.com>
```

## 许可证与原有声明

本扩展整体按 **GNU General Public License version 2 (GPL-2.0)** 分发，全文见 [LICENSE](LICENSE)。`package.json`、根包锁文件与 `extension.json` 的许可证声明保持一致。第三方组件的原有许可证及版权声明继续保留，不因本次元信息更新而被删除。

- **JS-PCB**：来源 [vygr/JS-PCB](https://github.com/vygr/JS-PCB)，按项目原有说明采用 GPL-2.0。核心移植代码位于 `iframe/jspcb/`。
- **嘉立创EDA扩展 SDK 模板**：保留原有版权声明 `Copyright [2024] JLCEDA <support[#]lceda.cn>`。原仓库的 Apache-2.0 许可证文本及声明保存于 [LICENSES/Apache-2.0.txt](LICENSES/Apache-2.0.txt)，供对应的 SDK 模板来源参考。
- **D3**：`iframe/jspcb/d3.v4.min.js` 的原有版权头保持原样。
- **PR #1 的界面与翻译贡献**：保留上述 summving / easyeda2021 的作者与来源信息。
