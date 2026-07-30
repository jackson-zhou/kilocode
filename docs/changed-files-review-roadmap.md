# Changed Files / Review 路线记录

## Issue

- MVP：[#10711 — VS Code extension: persistent changed-files overview in chat UI](https://github.com/Kilo-Org/kilocode/issues/10711)
- 总追踪：[#12645 — interactive changed-files review roadmap](https://github.com/Kilo-Org/kilocode/issues/12645)

## 拆分

### 自用实现：Changed Files + 交互式 Review

- 在输入框上方显示会话级 Changed Files。
- 支持实时更新、折叠/展开文件列表。
- 点击进入已有的 Session Review。
- Undo All / Keep All / Review。
- 文件级 Undo File / Keep File。
- hunk 级 Undo / Keep，以及 Cmd 快捷键。
- Keep 推进待审队列；Undo 反向应用 Agent snapshot patch。
- Undo 前保存文件 checkpoint；Redo 仅在文件未被再次编辑时恢复，避免覆盖后续用户修改。
- Keep 状态保存在 VS Code workspace state 中，重载后继续生效。

## 维护者协作规则

- 维护者在 #10711 指出现有 `Show Changes` 已覆盖 Git/worktree diff，不接受重复实现。
- 已进一步说明本方案是 Agent/session snapshot review，不是 Git diff。
- 当前分支仅作为自用版本继续，不提交上游 PR；若维护者认可 Agent-scoped 语义，再重新拆分上游方案。

## 本地验证

- 分支：`codex/changed-files-mvp`。
- 自用扩展版本：`7.4.18-agent-review.0`。
- 本地 VSIX 不提交。
