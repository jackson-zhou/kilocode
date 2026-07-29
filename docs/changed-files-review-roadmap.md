# Changed Files / Review 路线记录

## Issue

- MVP：[#10711 — VS Code extension: persistent changed-files overview in chat UI](https://github.com/Kilo-Org/kilocode/issues/10711)
- 总追踪：[#12645 — interactive changed-files review roadmap](https://github.com/Kilo-Org/kilocode/issues/12645)

## 拆分

### PR 1：Changed Files MVP

- 在输入框上方显示会话级 Changed Files。
- 支持实时更新、折叠/展开文件列表。
- 点击进入已有的 Session Review。
- 不包含 Keep、Undo、hunk 操作或 checkpoint。

当前实现提交：`9a70faae73 feat(vscode): show session changed files`。

### PR 2：交互式 Review

- Undo All / Keep All / Review。
- 文件级 Undo File / Keep File。
- hunk 级 Undo / Keep，以及 Cmd 快捷键。
- 用户和 Agent 同时修改同一处时，以 Agent 首次修改前的 baseline 为准，Review 展示 baseline 到当前文件的 diff。
- Keep 推进 baseline；Undo 恢复 baseline。因此需要 checkpoint / Redo 兜底。

## 维护者协作规则

- 已在 #10711 说明 PR1/PR2 边界，并指向 #12645。
- 留出七个自然日征求意见；若到 2026-08-05 没有反对意见，从最新 `main` 开 PR1 Draft。
- 默认动作仅为开 Draft PR，不自动合并。

## 本地验证

- 分支：`codex/changed-files-mvp`。
- 已通过类型检查、lint、目标单测和生产构建。
- 本地安装包：`packages/kilo-vscode/kilo-code-changed-files-mvp.vsix`（不提交）。
