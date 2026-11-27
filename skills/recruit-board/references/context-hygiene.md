# `CONTEXT.md` 冷热分离与上下文健康检查

为防止 `CONTEXT.md` 随招聘推进不断膨胀、出现多层口头覆写冲突或表格空行截断，工作区遵循**热口径与冷审计分离**：

| 文件 | 定位 | AI 开工是否必读 | 写入原则 |
| --- | --- | :---: | --- |
| `CONTEXT.md` | 当前生效口径（热文件，建议 ≤ 16 KB / 200 行） | 是 | 改规则**原地覆写**；被否决条款直接删除；「已对齐决策」仅留最近摘要（建议 ≤ 15 条） |
| `runtime/decisions-log/YYYY-MM.md` | 历史决策与变更依据（冷审计日志） | **否**（仅追溯时查阅） | 只追加（Append-only），记录原值→新值、依据、拍板人 |
| `runtime/reports/` | 每日寻源战报、执行过程与排障记录 | 否 | 单次执行结果只写日报，不回灌 `CONTEXT.md` |

## 共用 CLI：`skills/recruit-board/scripts/context-hygiene.mjs`

```bash
# 1. 只读体检 CONTEXT.md（检查体积/行数/决策条数预算、岗位表空行截断、多层覆写、战报与失效条款残留）
node skills/recruit-board/scripts/context-hygiene.mjs audit --workspace <目录>

# 2. 将「已对齐决策」中旧条目按月归档到 runtime/decisions-log/YYYY-MM.md（带锁、乐观版本校验与原文备份）
node skills/recruit-board/scripts/context-hygiene.mjs archive-decisions \
  --workspace <目录> \
  --expected-revision <audit返回的sha256> \
  --keep-recent 10

# 也可按截止日期归档（早于 2026-11-15 的条目迁入冷日志）
node skills/recruit-board/scripts/context-hygiene.mjs archive-decisions \
  --workspace <目录> \
  --expected-revision <audit返回的sha256> \
  --before 2026-11-15

# 3. 直接记录一条结构化决策到冷日志（不膨胀 CONTEXT.md，重复 ID 幂等）
node skills/recruit-board/scripts/context-hygiene.mjs log-decision \
  --workspace <目录> \
  --input '{"date":"2026-11-27","scope":"role","summary":"调整星图程序岗年龄上限","previousValue":"<=32","newValue":"<=35","reason":"市场盘点显示资深候选人集中在33-35岁","authority":"用人经理","targetFile":"01-jd/_internal/星图程序岗.md"}'

# 4. 查看已归档的冷日志文件清单
node skills/recruit-board/scripts/context-hygiene.mjs list-archive --workspace <目录>
```

## 常见告警码说明

- `ROLES_TABLE_TRUNCATED`（`error`）：「在招岗位与优先级」表格中间出现空行或断行，导致看板 `readRoles()` 截断漏读后续岗位，应立即删除多余空行。
- `CONTEXT_SIZE_BUDGET` / `CONTEXT_LINE_BUDGET` / `DECISIONS_UNARCHIVED`（`warning`）：热文件超出建议体积/行数/决策条数预算，执行 `archive-decisions` 沉降历史记录。
- `OVERRIDE_LAYER_STACK`（`warning`）：多个小节同时出现“以本节为准”覆写声明，建议合并并原地更新生效条款。
- `EXECUTION_LOG_POLLUTION`（`warning`）：检测到单次执行战报或脚本备份记录混入 `CONTEXT.md`，应迁至 `runtime/reports/`。
- `DEPRECATED_RULE_RESIDUE`（`warning`）：检测到带“AI 不执行 / 待删除”标注的旧条款残留，建议直接物理删除。
