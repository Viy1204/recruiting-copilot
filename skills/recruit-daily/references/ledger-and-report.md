# 台账补录 + 日报

## 台账 `02-sourcing/dedup-ledger.csv`（唯一事实源）

去重键 = **姓名 + 应聘岗位**（对应看板 `candidateId = JSON.stringify([姓名, rawRole])`）。**所有查询与写入统一走确定性 CLI `skills/recruit-board/scripts/ledger.mjs`**，禁止手工拼接 CSV 行或直接在状态列写入原因文本：

1. **查看允许的标准状态**：
   ```bash
   node skills/recruit-board/scripts/ledger.mjs statuses --workspace "<workspace>"
   ```
2. **写前 / 打招呼前查重**：
   ```bash
   node skills/recruit-board/scripts/ledger.mjs lookup --workspace "<workspace>" --name "<姓名>" [--role "<role_id或岗位名>"]
   ```
   支持按 `role_id` 或岗位名检索，并自动跨 `_shared/recruit-board.config.json` 中的 `roleAliases` 查重。
3. **新增或更新台账行**（可先加 `--dry-run` 预演）：
   ```bash
   node skills/recruit-board/scripts/ledger.mjs upsert --workspace "<workspace>" --role "<role_id或岗位名>" --name "<姓名>" --status "<标准状态>" --bg "<现职/背景>" --rating "<评级>" --round "<轮次>" [--resume "<路径>"] [--note "<事实与原因>"] [--dry-run]
   ```
   - `upsert` 保留固定 9 列表头与原行 `rawRole`（维持既有 `candidateId` 与档案/事项关联稳定）。
   - 已进入终态阶段（`ended` / `joined`，如 `初筛不合适`、`已拒`、`已排除`、`入职`、`已入职`）的候选人默认受保护，直接覆盖会报错并退出（exit code `3`），除非用户明确要求覆盖并显式传入 `--force-update`。
   - 原行若已推进到更高阶段，不降级状态，只通过 `--note` 补充"今日重发/重触达"等事实。

列（表头固定 9 列，顺序不变）：

```
序号,姓名,应聘岗位,现职/背景,评级,状态,来源轮次,简历路径,备注
```

- **序号**：由 `ledger.mjs` 自动接末行递增。
- **姓名**：boss 人才库/猎聘搜索是打码名（`张**`），同岗多个同姓打码名加后缀区分（`张**(后端)`）避免键碰撞。
- **应聘岗位**：支持传入 `role_id` 或 CONTEXT「在招岗位与优先级」表里的岗位名；`upsert` 新增行时写入标准岗位名，更新旧行时保留原 `rawRole`。
- **评级**：⭐~⭐⭐⭐（命脉强 = ⭐⭐⭐）。
- **状态**：**只能填标准枚举值**，严禁把原因、日期或说明塞进状态格：
  `未初筛 / 待初筛 / 初筛通过 / 初筛不合适 / 观望 / 已打招呼 / 已回复 / 待确认 / 已约谈 / 面试中 / offer / 已发offer / 已接受offer / 入职 / 已入职 / 已拒 / 已排除`。
  打了招呼 = `已打招呼`；仅记录待用户确认 = `待确认`；命中硬规则 = `初筛不合适` 或 `已排除`（原因写进 `--note` / `备注`，**不自动点平台"不合适"**）。
- **来源轮次**：`YYYYMMDD` + 渠道入口，如 `20260709boss推荐` / `20260709boss搜索` / `20260709liepin`。
- **简历路径**：下了简历才填工作区内的相对路径；没下留空。已核实属于候选人的外部文件或平台缓存截图，用 `recruit-board/scripts/materials.mjs` 的 `importCandidateMaterial` 复制归档到 `runtime/resumes/local/`，保留来源与 hash，再写归档路径并明确关联原人岗 ID；不留外部缓存路径，不把日志或沟通记录冒充原始简历。
- **备注**：技能摘要 + 关键判断 + **猎聘写 `rid=<resume_id>`**（对应 `--note` 参数）。

补录后可通过 `ledger.mjs lookup` 或 `actions.mjs workspace-overview` 核验条数与状态分布。

## 日报（从台账同步，不另立事实源）

**载体二选一，结构相同：**
- 有 `lark-cli` 且已配置 → 飞书云文档：把内容写成文件落在 cwd 相对路径，
  `lark-cli docs +create --content @<相对路径> --as user`（`@file` 只认 cwd 相对路径；
  超长内容内联易触发限制，走文件）。建完把文档 URL 回给用户。
- 没有 → 本地 `runtime/reports/YYYY-MM-DD.md`，写完把路径回给用户。

**结构建议（非死模板）：**

1. 一句话总结（今天干了什么、最重要的 1-2 个人选）
2. 今日概况：未读处理数 / 寻源覆盖岗位与渠道 / 打招呼数 / 台账新增与更新数
3. 岗位优先级（从 CONTEXT 同步，提醒老板当前主攻方向）
4. **按岗人选表**：姓名 ｜ 年龄/学历 ｜ 背景技能 ｜ 评级 ｜ 来源（命脉信号加粗）
5. 渠道观察（今天哪边池子肥/额度情况/异常）
6. 待办与待确认：按 [`跨轮事项与重点`](../../recruit-board/references/decisions.md) 读取整个工作区的未解决事项，区分“待你确认”“已暂缓”“历史待核对”和“已决定待执行”。列出必要对象、决定内容及来源，不把每轮相同问题复制成新事项；候选普通跟进单列。新事项与重点同步按已核实事实写 `context`，重点按需补 `details`，不只留日报自由文本，也不为缺失对象猜关联。与 CONTEXT 待定决策清单有出入时核对原始依据，不猜已处理。对外日报仍按接收范围脱敏，不整份外发本地事项历史。

**对外红线**：CONTEXT 标注的商业敏感信息不进日报；平台打码名在日报里保持打码；
候选人联系方式不进日报正文（留在台账/简历文件里）。

## 关键词迭代闭环（每轮寻源后）

从本轮「初筛通过/强匹配」的真实简历反向提取有效搜索词：
1. **追加冷日志**：向 `01-jd/_internal/logs/<slug>-sourcing-log.md` 追加本轮记录（日期、轮次、渠道、有效词、无效词、积极信号、拒绝模式）。
2. **原地更新热卡**：仅当有效词、已证无效词、积极信号或拒绝模式发生变化时，原地覆写 `01-jd/_internal/<slug>.md` 中的 `## 当前搜索词卡片`（控制在 15 行以内，保持 `_internal` 文件 < 20 KB）。下一轮寻源由 `role-context.mjs` 读取热卡。
