# 外部平台职位 M:N 路由表（`_shared/listings.json`）

v0.9.0 已在 `CONTEXT.md` 7 列表为每个内部岗位分配了不可变 `role_id`。当工作区存在**多平台多职位、1 帖多方向（合并帖）或需显式忽略的平台旧帖/校招帖**时，可选用 `_shared/listings.json` 建立外部职位 `(platform, externalJobId)` 到内部 `role_id` 的确定性路由表。

- **单一事实源**：本文件**不复制**岗位名称、状态或别名，所有 `roleIds` 直接引用 `CONTEXT.md` 的 `role_id`。
- **完全可选**：未创建 `_shared/listings.json` 的工作区不受任何影响。

## 文件结构

```json
{
  "schemaVersion": 1,
  "listings": [
    {
      "platform": "boss",
      "externalJobId": "boss-1001",
      "title": "星图研发工程师（合并帖）",
      "roleIds": ["STAR-ENG", "STAR-QA"],
      "policy": "active"
    },
    {
      "platform": "liepin",
      "externalJobId": "lp-2001",
      "title": "星图研发工程师",
      "roleIds": ["STAR-ENG"],
      "policy": "inbound_only"
    },
    {
      "platform": "liepin",
      "externalJobId": "lp-99001",
      "title": "测试工程师（在校/应届）",
      "roleIds": [],
      "policy": "ignore",
      "note": "仅校招，社招工作流跳过"
    }
  ]
}
```

### 字段约束

- `platform`（必填）：小写平台标识（1–32 位字母/数字/下划线/连字符，如 `boss`、`liepin`、`zhaopin`、`51job`）。
- `externalJobId`（必填）：平台原始职位 ID（1–128 字符）；`(platform, externalJobId)` 全表唯一。
- `title`（可选）：平台当前标题，仅供展示参考，改名不破坏映射。
- `policy`（必填）：`active`（正常寻源）、`inbound_only`（仅处理主动投递）、`paused`（暂停）、`ignore`（显式忽略）。
- `roleIds`（必填）：
  - `policy === "ignore"` 时必须为 `[]`；
  - 其他策略至少包含 1 个符合 `ROLE_ID_PATTERN` 且存在于 `CONTEXT.md` 中的 `role_id`。

## 共用 CLI：`skills/recruit-board/scripts/listings.mjs`

写入命令与 `roles.mjs` 共用 `runtime/recruit-board/roles/context.lock` 互斥锁、SHA-256 `expectedRevision` 乐观并发检查、原子替换与自动备份。

```bash
# 1. 列出路由表与当前 revision（支持按平台、role_id、策略筛选）
node skills/recruit-board/scripts/listings.mjs list --workspace "<workspace>" [--platform boss] [--role-id STAR-ENG] [--policy active]

# 2. 按平台职位 ID 反查内部 role_id 与策略（给 recruit-daily 跳过 ignore / 路由合并帖）
node skills/recruit-board/scripts/listings.mjs resolve --workspace "<workspace>" --platform boss --external-job-id boss-1001

# 3. 按内部 role_id 反查该岗在各平台绑定的全部外部职位
node skills/recruit-board/scripts/listings.mjs resolve --workspace "<workspace>" --role-id STAR-ENG

# 4. 新增或更新一条平台职位绑定（首次创建文件时 expectedRevision 传 null）
node skills/recruit-board/scripts/listings.mjs upsert --workspace "<workspace>" --input '{"expectedRevision":null,"listing":{"platform":"boss","externalJobId":"boss-1001","title":"星图研发（合并帖）","roleIds":["STAR-ENG","STAR-QA"],"policy":"active"}}'

# 5. 移除一条绑定
node skills/recruit-board/scripts/listings.mjs remove --workspace "<workspace>" --input '{"expectedRevision":"<sha256>","platform":"boss","externalJobId":"boss-1001"}'

# 6. 校验路由表 Schema 与引用完整性（存在非法或悬空 role_id 时返回 ok:false 且退出码 1）
#    workspace.mjs validate 也会自动包含本项校验
node skills/recruit-board/scripts/listings.mjs validate --workspace "<workspace>"
```
