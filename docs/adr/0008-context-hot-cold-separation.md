# ADR 0008：`CONTEXT.md` 冷热分离、决策归档与上下文健康检查

日期：2026-11-27

状态：提案实施中。

## 问题

`CONTEXT.md` 被设计为所有工作流开工必读的唯一事实源，同时模板与多份工作流说明鼓励向「六、已对齐决策」滚动追加历史记录。持续运行数周后，这种“必读热文件 + 只追加不收敛”的写模式会引发四类退化：

1. **上下文无限膨胀（Context Rot）**：历史决策、单次寻源战报、脚本排障记录不断堆进 `CONTEXT.md`，体量快速增至数十至上百 KB，显著稀释模型对核心标准的注意力并推高每轮 token 成本。
2. **多层自然语言覆写冲突**：调整旧口径时不是原地更新生效条款，而是叠加新的“冲突时以本节为准”段落，导致同一岗位的薪资、学历或寻源规则在文中多处打架。
3. **表格结构静默截断**：高频手工/多会话编辑容易在「在招岗位与优先级」表格中引入空行，`readRoles()` 按首个非表格行终止读取，后续岗位对看板隐身却无明显提示。
4. **失效条款残留**：被否决或待删除的旧规则仅靠括号标注“AI 不执行”留在热文件中，在长上下文里存在被误执行的合规风险。

## 决策

1. **建立热配置 / 冷审计分离模型**：
   - **`CONTEXT.md`（热文件，开工必读）**：只保存**当前生效态**（公司背景、通用方法论、当前初筛硬规则、在招岗位表、术语表、最近少量关键决策摘要与待定事项）。改口径时**原地更新生效条款**，禁止写入每日执行战报（归 `runtime/reports/`）与脚本临时补丁说明；被否决的旧条款直接删除。
   - **`runtime/decisions-log/YYYY-MM.md`（冷日志，只追加）**：承载完整的历史决策依据、变更前后值与拍板人，供人类追溯审计；**AI 日常开工默认不读取**。
2. **新增确定性健康检查与归档 CLI（`skills/recruit-board/scripts/context-hygiene.mjs`）**：
   - `audit`：只读体检 `CONTEXT.md`，输出字节/行数/决策条数预算告警、小节占比分布，并确定性检测岗位表空行截断（`ROLES_TABLE_TRUNCATED`）、多层自然语言覆写冲突（`OVERRIDE_LAYER_STACK`）、执行战报/补丁残留（`EXECUTION_LOG_POLLUTION`）及失效条款残留（`DEPRECATED_RULE_RESIDUE`）。
   - `archive-decisions`：使用独占锁、`expectedRevision`（SHA-256）乐观并发检查、原子写入与自动备份，将「已对齐决策」中超出近期窗口（默认保留最近 10 条，或按 `--before YYYY-MM-DD`）的条目按月幂等归档至 `runtime/decisions-log/YYYY-MM.md`，保留原文编码与换行符，并在原节保留一句归档索引。
   - `log-decision`：直接向 `runtime/decisions-log/YYYY-MM.md` 幂等追加结构化冷决策记录，不增加热文件负担。
   - `list-archive`：列出已归档的冷日志文件及条目数。
3. **同步更新模板与工作流指引**：更新 `skills/recruit-init/templates/CONTEXT.md`、`ask-viy`、`recruit-grill` 与 `recruit-daily/references/channels.md`，明确“热口径原地覆写、历史依据进冷日志、执行战报留 `runtime/reports/`”。
4. **明确不做的范围**：不修改 `model.mjs`、`reader.mjs` 或 `roles.mjs` 的既有契约，不破坏现有工作区兼容性，不引入任何外部运行时依赖。

## 验收

- 精简健康的 `CONTEXT.md` 通过 `audit`（`healthy: true`）；包含截断岗位表、超预算体积、多层覆写、战报污染或失效条款残留的虚构文档能被精准检出对应错误/告警码。
- `archive-decisions` 按月安全归档、保留原文编码/换行符与原文备份，重复执行幂等，过期 `expectedRevision` 返回 `409 CONTEXT_CONFLICT`。
- `log-decision` 不改动 `CONTEXT.md`，相同 `id` 重放不重复写入。
- 既有全部单测、安装测试与形式化验证基线零破坏。
