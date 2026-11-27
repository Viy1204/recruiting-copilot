# 固定岗位 ID 与多平台职位映射（`_shared/roles.json`）

当工作区需要管理多个招聘平台、多位负责人、一帖多方向或外部 ATS 需求单时，可选用 `_shared/roles.json` 为每个岗位建立**永久不变的固定 ID**，并将平台原始职位 ID 映射到这些固定 ID，避免改名断链和在 `CONTEXT.md` 里手工维护映射口诀。

未创建 `_shared/roles.json` 的标准工作区不受任何影响。

## 文件结构

```json
{
  "schemaVersion": 1,
  "roles": [
    {
      "id": "role-star-eng",
      "name": "星图程序岗",
      "priority": "P0",
      "status": "在招",
      "owner": "lin",
      "atsRequisitionId": "J10001",
      "aliases": ["星图旧岗", "星图程序工程师"],
      "jdPath": "01-jd/星图程序岗.md",
      "internalPath": "01-jd/_internal/星图程序岗.md"
    }
  ],
  "listings": [
    {
      "platform": "boss",
      "externalJobId": "boss-job-1001",
      "title": "星图开发（合并帖）",
      "roleIds": ["role-star-eng", "role-star-qa"],
      "policy": "active"
    },
    {
      "platform": "liepin",
      "externalJobId": "lp-99001",
      "title": "测试工程师（在校/应届）",
      "roleIds": [],
      "policy": "ignore",
      "note": "仅校招，社招流程跳过"
    }
  ]
}
```

### 字段与不变量

- `roles[]`：
  - `id`（必填）：固定岗位 ID，1–64 位，允许字母、数字、`.`、`_`、`-`，须以字母或数字开头，全表唯一。岗位展示名修改时 `id` 保持不变。
  - `name`（必填）：当前标准展示名，全表唯一。
  - `priority` / `status` / `owner` / `atsRequisitionId` / `jdPath` / `internalPath`（均可选）：`status` 限 `在招`、`已下架`、`已关闭`、`暂停`、`待核`；多个 `role.id` 可共享同一 `atsRequisitionId`（支持 1 个 ATS 需求单对应多个初筛画像）；路径字段仅接受工作区相对正斜杠路径，拒绝 `..` 或绝对路径。
  - `aliases`（可选）：历史/旧名称数组，不能与任何正式 `name`、`id` 或其他岗位别名冲突。
- `listings[]`：
  - `(platform, externalJobId)` 复合唯一；`platform` 为小写标识（如 `boss`、`liepin`、`zhaopin`、`51job`）。
  - `policy`（必填）：`active`（正常寻源）、`inbound_only`（仅处理主动投递）、`paused`（暂停）、`ignore`（显式忽略）。
  - `roleIds`（必填）：
    - `policy === "ignore"` 时必须为 `[]`；
    - 其他策略至少关联 1 个存在于 `roles[]` 中的 `id`；支持 `1 帖 → N 岗`（合并帖）和 `N 帖 → 1 岗`（跨平台/多坑位）。

## 共用 CLI：`skills/recruit-board/scripts/role-registry.mjs`

所有写入命令共用独占文件锁、SHA-256 `expectedRevision` 乐观并发检查、原子替换与自动备份（存放在 `runtime/recruit-board/roles/`），版本冲突返回错误码 `REGISTRY_CONFLICT`（HTTP/语义状态 409）。

```bash
# 1. 从现有 CONTEXT.md 和可选 recruit-board.config.json 一键初始化（不改 CONTEXT.md）
node skills/recruit-board/scripts/role-registry.mjs init --workspace <目录>
# CONTEXT.md 新增岗位后增量导入（保留既有固定 ID 与平台映射）
node skills/recruit-board/scripts/role-registry.mjs init --workspace <目录> --merge

# 2. 列出注册岗位与当前 revision（支持按负责人、状态、平台筛选）
node skills/recruit-board/scripts/role-registry.mjs list --workspace <目录> --owner lin

# 3. 确定性反查（供脚本或工作流直接调用，替代猜岗位名）
node skills/recruit-board/scripts/role-registry.mjs resolve --workspace <目录> --platform boss --external-job-id boss-job-1001
node skills/recruit-board/scripts/role-registry.mjs resolve --workspace <目录> --role-id role-star-eng
node skills/recruit-board/scripts/role-registry.mjs resolve --workspace <目录> --name 星图旧岗
node skills/recruit-board/scripts/role-registry.mjs resolve --workspace <目录> --ats-req-id J10001

# 4. 新增/更新岗位与平台职位映射（支持 --input JSON 或 --input-file 工作区内 JSON）
node skills/recruit-board/scripts/role-registry.mjs upsert-role --workspace <目录> --input '{"expectedRevision":"<sha256|null>","role":{"id":"role-star-eng","name":"星图程序岗","priority":"P0","status":"在招","owner":"lin"}}'
node skills/recruit-board/scripts/role-registry.mjs upsert-listing --workspace <目录> --input '{"expectedRevision":"<sha256>","listing":{"platform":"boss","externalJobId":"boss-job-1001","roleIds":["role-star-eng"],"policy":"active"}}'

# 5. 删除映射或未被平台职位引用的岗位
node skills/recruit-board/scripts/role-registry.mjs remove-listing --workspace <目录> --input '{"expectedRevision":"<sha256>","platform":"boss","externalJobId":"boss-job-1001"}'
node skills/recruit-board/scripts/role-registry.mjs remove-role --workspace <目录> --input '{"expectedRevision":"<sha256>","roleId":"role-star-eng"}'

# 6. 校验 Schema、引用完整性及与 CONTEXT.md 的漂移
node skills/recruit-board/scripts/role-registry.mjs validate --workspace <目录>

# 7. 将固定 ID 与 aliases 同步到 _shared/recruit-board.config.json 的 roleAliases
#    同步后，台账中使用固定 role.id 或历史别名的记录在现有看板中自动归入标准岗位
node skills/recruit-board/scripts/role-registry.mjs sync-aliases --workspace <目录>
```
