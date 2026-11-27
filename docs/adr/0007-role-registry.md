# ADR 0007：引入可选固定岗位 ID 与多平台职位映射注册表

日期：2026-11-27

状态：提案实施中。

## 问题

当前工作区直接将 `CONTEXT.md`「在招岗位与优先级」表中的中文展示岗位名当作隐式主键，并用 `_shared/recruit-board.config.json` 的扁平 `roleAliases` 应付历史改名。一旦工作区扩展到多平台（BOSS、猎聘及其他渠道）、多负责人或一个外部需求对应多个初筛方向时，仅靠中文显示名会暴露四类结构性问题：

1. **改名即断链**：岗位对外标题或内部简称调整后，台账、对内笔记与脚本参数需要到处手工替换字符串。
2. **多对多（M:N）映射缺失**：一个平台合并帖可能同时承接多个初筛画像（1 帖 → N 岗），同一画像也可能挂在多个平台或多个坑位（N 帖 → 1 岗），部分在挂职位（如校招/历史旧帖）则需要显式忽略（1 帖 → 0 岗），无法仅靠扁平 `旧名 -> 标准名` 表达。
3. **ATS 需求单与初筛画像混淆**：同一 ATS 需求单号（如 `J10001`）下可能拆出多个独立评估方向，不能简单把外部单号等同于单一岗位名。
4. **规则靠散文兜底**：平台职位 ID 映射、忽略名单与负责人分工散落在 `CONTEXT.md` 自由文本中，导致上下文不断膨胀且易出现并发改写冲突。

## 决策

1. **新增可选纯文本注册表 `_shared/roles.json`（`schemaVersion: 1`）**：保持零外部依赖与本地纯文本事实源定位；不使用该文件的工作区保持原有行为完全不变。
2. **三层解耦建模**：
   - `roles[]` 以不可变的固定 `id`（`roleId`）为唯一锚点，承载标准展示名 `name`、可选 `priority` / `status` / `owner` / `atsRequisitionId` / `aliases[]` / `jdPath` / `internalPath`。允许多个 `role.id` 共享同一 `atsRequisitionId`。
   - `listings[]` 以 `(platform, externalJobId)` 复合唯一键绑定平台原始职位 ID，通过 `roleIds[]` 与 `policy`（`active` / `inbound_only` / `paused` / `ignore`）完整表达 1:1、1:N、N:1 以及显式忽略（`policy: "ignore"` 且 `roleIds: []`）。
3. **提供确定性 CLI `skills/recruit-board/scripts/role-registry.mjs`**：
   - `init`（支持 `--merge`）：从现有 `CONTEXT.md` 与 `_shared/recruit-board.config.json` 一键初始化，生成稳定 `roleId` 并导入已有别名，不修改 `CONTEXT.md`。
   - `list` / `resolve`：支持按 `(platform, externalJobId)`、`roleId`、`name`/别名、`atsRequisitionId` 做确定性反查，替代由大模型猜岗位名。
   - `upsert-role` / `remove-role` / `upsert-listing` / `remove-listing`：采用与 `roles.mjs` 一致的 SHA-256 `expectedRevision` 乐观并发检查、独占写入锁、原子临时文件替换与 `runtime/recruit-board/roles/` 自动备份；删除岗位前强制检查引用完整性，防止孤儿平台映射。
   - `validate`：校验注册表 Schema、引用完整性以及与 `CONTEXT.md` 岗位表的漂移。
   - `sync-aliases`：显式将 `role.id` 与 `aliases[]` 同步到 `_shared/recruit-board.config.json` 的 `roleAliases`，使现有看板无需破坏既有人岗 2 元组契约即可按标准岗位归组。
4. **明确不做的范围**：本 ADR 不修改 `CONTEXT.md` 现有表格格式，不改变候选台账 9 列表头与 `candidateId = JSON.stringify([name, rawRole])` 全仓不变量，不引入数据库或外部运行时依赖。

## 验收

- 虚构工作区下 `init`、`list`、`resolve`、`upsert-*`、`remove-*`、`validate`、`sync-aliases` 与并发冲突/备份/安全路径拦截全部通过自动化测试。
- 岗位改名后固定 `id` 与全部平台职位映射保持稳定；被平台职位引用的岗位不可直接删除。
- 同步别名后，台账中使用固定 `role.id` 或历史别名的候选记录在现有 `readSnapshot` 中自动归入标准岗位且原人岗键不变。
- 既有全部单测与形式化验证契约零破坏。
