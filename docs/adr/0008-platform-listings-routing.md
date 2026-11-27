# ADR 0008：可选外部平台职位 M:N 路由表（`_shared/listings.json`）

日期：2026-11-27

状态：提案实施中。

## 问题

v0.9.0（[ADR 0007](0007-state-log-separation-and-deterministic-workspace-cli.md)）已通过 `CONTEXT.md` 7 列表引入了不可变的内部岗位代理键 `role_id`，但尚未覆盖**外部招聘平台职位与内部 `role_id` 之间的多对多（M:N）路由关系**：

1. **1 帖 → N 岗（合并帖）**：一个平台合并发布帖可能同时承接多个内部 `role_id` 方向。
2. **N 帖 → 1 岗（多平台/多坑位）**：同一个内部 `role_id` 可能在 BOSS、猎聘及其他平台分别对应不同原始职位 ID 或不同标题。
3. **1 帖 → 0 岗（显式忽略）**：平台账号下挂着的校招帖、历史旧帖或无关岗位需要确定性跳过，而不是靠在 `CONTEXT.md` 里写自然语言口诀防误触。

## 决策

1. **单一事实源，严禁复制岗位表**：新增可选纯文本文件 `_shared/listings.json`（`schemaVersion: 1`），**只存外部平台职位绑定 `listings[]`**，直接引用 `CONTEXT.md` 7 列表的原生 `role_id`（复用 `model.mjs` 的 `ROLE_ID_PATTERN`）；绝不复制 `roles[]`、`aliases[]` 或同步层，避免双事实源漂移。未创建该文件的工作区行为完全不变。
2. **复合主键与四态路由策略**：
   - 每条记录以 `(platform, externalJobId)` 为复合唯一键（`title` 仅供展示参考，平台改名不破坏绑定）。
   - `policy` 支持 `active`（正常寻源）、`inbound_only`（仅处理主动投递）、`paused`（暂停）与 `ignore`（显式忽略）。
   - 严格引用完整性：`policy === "ignore"` 必须 `roleIds: []`；非 `ignore` 至少绑定 1 个存在于 `CONTEXT.md` 的有效 `role_id`。
3. **共用锁与 fail-closed 校验**：
   - 新增 `skills/recruit-board/listings-domain.mjs` 与 `skills/recruit-board/scripts/listings.mjs`（`list` / `resolve` / `upsert` / `remove` / `validate`）。
   - 写入共用 `runtime/recruit-board/roles/context.lock`（与 `roles.mjs` 互斥）、SHA-256 `expectedRevision` 乐观并发检查、原子替换与自动备份，提交前同时复验 `CONTEXT.md` 未变化。
   - `listings.mjs validate` 遇 Schema 错误或悬空 `role_id` 返回 `ok: false` 与退出码 `1`，并直接接入 `workspace.mjs validate` 统一体检（对指向非在招岗位的活跃职位额外给出 `LISTING_ROLE_INACTIVE` 告警）。
4. **接入 `recruit-daily`**：在 `skills/recruit-daily/SKILL.md` 的寻源步骤补充可选路由指引——当工作区存在 `_shared/listings.json` 时，按 `(platform, externalJobId)` 或 `role_id` 通过 `listings.mjs resolve` 确定性路由并跳过 `ignore` 职位。

## 验收

- `_shared/listings.json` 完整覆盖 1:1、1:N、N:1 与 1:0（`ignore`）路由，严格校验 `ROLE_ID_PATTERN` 与引用完整性。
- 写入与 `context.lock` 互斥，过期 `expectedRevision` 返回 `409 LISTINGS_CONFLICT`，符号链接越权被拦截。
- `listings.mjs validate` 与 `workspace.mjs validate` 均在非法 JSON、缺 `role_id` 列或悬空 `role_id` 时返回 `ok: false`（CLI 退出码 `1`）。
- 既有全部单测、安装测试与 8 套形式化验证基线零破坏。
