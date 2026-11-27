# ADR 0007 状态与日志分离及工作区确定性 CLI

**日期.** 2026-11-27

**状态.** 已接受。本决策在保留 [ADR 0001](0001-cross-round-decisions.md) 至 [ADR 0006](0006-responsive-triage-and-staged-decisions.md) 中 `candidateId` 语义、跨轮事项分离和单网页看板的基础上，规范工作区热态文件上限、七列岗位表、冷日志拆分与脚本化写入接口。

## 背景

对真实招聘工作区的审计暴露出四类退化问题，使日常轮次和弱模型执行同时受损。

1. **`CONTEXT.md` 体积膨胀至 162 KB.** 各轮 Agent 把带日期的规则补丁直接追加进 `CONTEXT.md` 的规则区和已对齐决策区，共堆积了 259 处日期标签和 168 段历史覆写块。每次新会话被迫先读完 162 KB 全文，挤占推理窗口并导致早期条款覆盖最新规则。
2. **3 个在招岗位从看板过滤消失.** Agent 手工修改 Markdown 表格时把变动说明写进状态单元格，例如填写`在招（2026-11-09 恢复）`。看板只按纯字符串匹配 `在招`，使这 3 个岗位被归入未知状态并从“在招”视图漏出。
3. **对内档案达 73 KB 且 70% 至 91% 为历史寻源流水.** `01-jd/_internal/<slug>.md` 把每轮搜索词记录全量追加在同一张大表中，日常初筛只用当前有效词，却每次都要加载整份流水账。
4. **`02-sourcing/dedup-ledger.csv` 出现 52 条脏状态.** Agent 手改 CSV 时把拒绝理由、日期或说明塞进 `状态` 列，甚至直接覆盖已拒或已入职的终态记录。弱模型在长上下文里手拼 Markdown 表格、CSV 转义、别名去重与终态保护容易出错。

## 决策

1. **状态与日志分离，控制热态文件体积.**
   - `CONTEXT.md` 仅保存当前生效的公司背景、方法论、通用初筛硬规则、岗位表、术语表与未解决的待定决策，体积上限为 16 KB。规则变动时原地覆写当前条款，历史变更与拍板原因改为追加写入冷日志 `docs/CHANGELOG.md`。
   - `recruit-daily`、`resume-review` 与 `market-talent-mapping` 在日常执行时不读取 `docs/CHANGELOG.md`。

2. **采用 7 列岗位表、不可变 `role_id` 与纯状态枚举.**
   - `CONTEXT.md`「在招岗位与优先级」固定使用 7 列表头：`role_id | 岗位 | 优先级 | 状态 | 对外 JD | 对内档案 | 最近变更`。
   - `role_id` 使用大写 ASCII 字母、数字和连字符，长度为 2 到 24 位（`ROLE_ID_PATTERN` 为 `/^[A-Z0-9][A-Z0-9-]{1,23}$/`），分配后保持不变。
   - `优先级` 限定 `ROLE_PRIORITIES`（`最高`、`急岗`、`常规`、`低`、`停`）；`状态` 仅允许 `KNOWN_ROLE_STATUSES` 纯枚举（`在招`、`已下架`、`已关闭`、`暂停`、`待核`、`待梳理`）。日期和变更说明写入 `最近变更` 列和 `docs/CHANGELOG.md`。

3. **拆分对内档案热卡与逐轮寻源冷日志.**
   - `01-jd/_internal/<slug>.md` 保持在 20 KB 以内，用紧凑的 `## 当前搜索词卡片`（控制在 15 行左右）替代无限增长的关键词大表。
   - 每轮寻源流水追加写入 `01-jd/_internal/logs/<slug>-sourcing-log.md`，日常任务不整份加载；只有当有效词、无效词或正负信号发生变化时，才原地更新 `## 当前搜索词卡片`。

4. **在 `skills/recruit-board/model.mjs` 中实行宽容读取.**
   - 新增 `parseRoleStatus`，剥离中英文括号附注并提取基础状态（例如将 `在招（2026-11-09 恢复）` 解析为 `在招`），避免未迁移工作区的在招岗位丢失。
   - `readRoleTable` 兼容旧版 3 至 5 列结构及 `对内笔记` 表头，同时完整解析 7 列表的 `roleId`、`jdPath`、`internalPath` 与 `lastChange`。
   - 当 `buildSnapshot` 检测到带括号附注的状态时，保持快照状态为 `ok`，并输出 `info` 级别诊断 `ROLE_STATUS_ANNOTATED`，提示运行 `workspace.mjs migrate`。

5. **提供四个确定性工作区 CLI 替代手工文本编辑.**
   所有脚本位于 `skills/recruit-board/scripts/`：
   - `roles.mjs` 提供 `list`、`set-status` 和 `upsert`，校验 `role_id`、优先级与纯状态枚举，更新 `最近变更` 并向 `docs/CHANGELOG.md` 追加 `--reason`。
   - `ledger.mjs` 提供 `statuses`、`lookup` 和 `upsert`，自动按 `roleAliases` 跨别名查重，写入时保留 9 列 `LEDGER_COLUMNS` 与原 `rawRole` 以稳定 `candidateId`，默认拦截覆盖 `TERMINAL_STAGE_IDS`（`ended` 和 `joined`）并返回退出码 `3`（仅在传入 `--force-update` 时放行）。
   - `role-context.mjs` 按 `--role`（`role_id` 或岗位名）抽取全局规则、目标岗位元数据与目标岗对内档案，对旧版长关键词表自动截取最近 2 轮（`--max-rounds 2`），支持 `markdown` 或 `json` 输出。
   - `workspace.mjs` 提供 `validate`、`migrate --dry-run` 和 `migrate`，检查文件体积上限与表结构合法性，并幂等地把旧工作区升级到 7 列表、冷日志和热卡格式。

## 备选方案

- **用 `roles.json` 取代 `CONTEXT.md` 中的岗位表.** 已否决。用人经理和招聘人员会直接在任意文本编辑器里打开 `CONTEXT.md` 核对在招岗位与状态，现有看板与手工备份也围绕单份 `CONTEXT.md` 运转。保留 Markdown 7 列表并通过 `roles.mjs` 写入，可兼顾人类可读性与脚本校验。
- **给 `dedup-ledger.csv` 新增第 10 列 `role_id`，或把 `candidateId` 改为 `[姓名, role_id]`.** 已否决。现有 `runtime/recruit-board/decisions/`、`_shared/recruit-board.files.json` 和历史 run 收据都以 `JSON.stringify([姓名, 原岗位])` 作为 `candidateId` 索引。改动列结构或键格式会切断历史人选关联。保留 9 列 CSV 与原 `rawRole`，由 `ledger.mjs` 在查询与写入时映射 `role_id` 与 `roleAliases`，可在零破坏前提下解决重复与脏状态问题。
- **仅靠提示词让 AI 手工重写长版 `CONTEXT.md` 完成迁移.** 已否决。模型面对超过 100 KB 的规则历史时容易截断遗漏条款，重复执行也无法得到一致格式。采用 `workspace.mjs migrate --dry-run` 预览加幂等 `migrate` 执行，能够让旧工作区安全收敛。

## 后果与迁移路径

- **新工作区起点.** `skills/recruit-init/templates/` 提供精简版 `CONTEXT.md`、新建的 `CHANGELOG.md`（初始化复制到工作区 `docs/CHANGELOG.md`）、热卡版 `jd-internal.md` 与新版 `AGENTS.md`，从建仓阶段就启用状态与日志分离。
- **老工作区零中断过渡.** 未迁移的工作区先由 `model.mjs` 的宽容读取规则继续正常展示在招岗位和看板；需要升级时，严禁 AI 手工改写旧 `CONTEXT.md`，必须先运行 `node skills/recruit-board/scripts/workspace.mjs migrate --workspace "<workspace>" --dry-run` 并交由用户确认，再执行 `migrate` 与 `validate`。
- **工作流与看板联动.** `recruit-init`、`recruit-grill`、`recruit-daily`、`resume-review`、`market-talent-mapping` 与 `recruit-board` 统一按 `role-context.mjs` 渐进读取单岗信息，并将岗位表和台账写入收口到 `roles.mjs` 与 `ledger.mjs`。
