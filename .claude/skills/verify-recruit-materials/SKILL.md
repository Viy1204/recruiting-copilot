---
name: verify-recruit-materials
description: 修改招聘看板资料映射保存、本地原件导入、候选资料归属或内容校验时，验证旧 revision 不覆盖新清单并核对身份隔离与归档读取。
---

# 候选资料清单验证

主要性质：保存和携带 revision 的导入使用同一份旧清单版本时，最多一个有变化的请求能提交；旧请求必须拒绝，不能覆盖或复活用户后来更正、清空的资料关联。

损害：旧表单覆盖新清单会丢掉更正后的关联，或把已移除资料重新挂回人选。补充合同还防止同名跨原岗串档，以及篡改后的归档原件继续被当作可信资料读取。

同步基线 syncCommit：`80d623348799711ded9ea78eaf5c8961e1556a69`。
覆盖记录：`verification/formal/coverage-materials.json`；总表只引用该片段，不重复保存源码摘要。

## 代码与交付

| 函数或保护 | 代码位置 | 对应验证 |
| --- | --- | --- |
| `setCandidateMaterials` | `skills/recruit-board/scripts/materials.mjs:195` | `202-203` 在共用锁内比较调用方 revision；合同用旧版本覆盖新清单，必须返回 `MATERIALS_CONFLICT` |
| `importCandidateMaterial` | `skills/recruit-board/scripts/materials.mjs:259` | `272-273` 比较可选 revision；合同覆盖带 revision 的旧导入与有效归档 |
| `commitMapping` | `skills/recruit-board/scripts/materials.mjs:168` | `175,189` 对当前捕获版本复核；`190` 的 rename 是清单提交点 |
| `archiveOriginal` | `skills/recruit-board/scripts/materials.mjs:219` | `246` 的 link 单独发布归档，不与清单 rename 合并 |
| `candidateRecords` | `skills/recruit-board/scripts/records.mjs:235` | 经公开 `readCandidateDetail:354` 检查同名跨原岗未确认不自动关联、确认清空保持为空 |
| `inspectDocument` | `skills/recruit-board/scripts/records.mjs:98` | `127` 的原件 SHA-256 校验；经公开 `readCandidateDocument:358` 验证可读与篡改阻断 |
| `locked`、`withItemLock` | `skills/recruit-board/scripts/materials.mjs:159`、`skills/recruit-board/scripts/storage.mjs:55` | 保存与导入共用 files 写锁；争用时拒绝或在后续获取锁时拒绝旧 revision |

片段也记录 `model.mjs` 与 `reader.mjs` 的实际哈希，因为候选身份与可读性由这些依赖共同决定。所有测试所需产品模块均从 `process.env.FORMAL_SOURCE_ROOT || repoRoot` 导入。

模型、配置、中文投影：`verification/formal/models/Materials.tla`、`Materials.cfg`、`Materials.view.mjs`。真实源码合同：`verification/formal/materials.test.mjs`。

## 复跑与抓错

在仓库根执行：

```bash
node scripts/verify-state-machines.mjs materials
```

需要检验验证能力时直接运行下一条；它已包含基线、TLC、突变和恢复检查，无需先执行上一条。整套维护可一次运行 `node scripts/verify-state-machines.mjs --mutations`。

```bash
node scripts/verify-state-machines.mjs materials --mutations
```

单独调试入口合同：

```bash
node --test verification/formal/materials.test.mjs
```

fixture 的虚构工作区和外部待导入 TXT 原件都在同一个 `os.tmpdir()` sandbox 的不同子目录中，`finally` 删除整个 sandbox；不读取真实简历。

每次核对本次 `Evidence` 目录中的 `materials-implementation.out`、`materials-tlc.out` 和 `summary.json`；确认实际执行的测试数、退出码、全部 invariant 和无死锁结果。通过时参照 `Materials.view.mjs` 解释争用、拒绝、分别归档和提交；违例时说明最短路径及用户损害。解析、环境或运行失败不能视为通过。只有需要重绘状态图时，才由用户直接调用 `/pstack:statechart`；未重绘应明确说明，历史图不能代替本轮结果，也不能推出跨原件复制和 manifest 的全局原子性。

当前基线：4 项合同通过；TLC 检查 `TypeOK`、`NoStaleMappingOverwrite` 与死锁，38 个可达状态，无违例。终态由 `Done` 自环保持。

四个可执行源码变体由片段记录：

| 删除的真实保护 | 必须出现的断言标识 |
| --- | --- |
| 保存入口调用方 revision guard | `MATERIALS_STALE_SET_REJECTED` |
| 导入入口调用方 revision guard | `MATERIALS_STALE_IMPORT_REJECTED` |
| 自动档案关联的 uniqueName guard | `MATERIALS_AMBIGUOUS_IDENTITY_ISOLATED` |
| 已归档原件内容哈希 guard | `MATERIALS_TAMPERED_ARCHIVE_BLOCKED` |

每个变体必须正常解析、执行，然后以退出码 1、`ERR_ASSERTION` 和指定标识被合同抓住。删除调用方 revision guard 后，`commitMapping` 的内部复核仍只比较本次捕获的当前版本，不能代替用户的旧版本保护。变体只写外部临时副本；丢弃后复跑基线。

## Bounds、假设与不覆盖

- 有限模型含两个带同一 revision 的请求：一次保存、一次导入；二者针对同一份清单。只允许每请求尝试一次，状态不超过两次可能写入，具体路径和哈希均抽象为有限代号。
- 写入者遵守同一 files 锁；版本哈希不碰撞，本轮不发生内容回退的 ABA。候选和目录已通过入口检查，选择的文件有效。无变化的幂等保存与导入不带 revision 的分支不在主要模型内。
- 锁获取、读取并比较版本、最后复核、rename、释放锁分别建模。temp 复制、sync、备份是未改变所建模用户视图的内部步骤，不被宣称为一次原子事务。
- 导入原件的 link 与清单 rename 分开；允许归档后抛错、finally 正常释放锁而留下未关联原件。模型不证明断电或进程崩溃恢复、不保证跨复制和 manifest 的全局原子、不保证没有孤儿文件。
- 身份消歧、确认清空、文档标识隔离及 TXT 内容篡改由补充真实入口合同验证；TLC 的主要证明范围是旧版本写入保护。没有证明所有文档格式、所有路径攻击、锁恢复或无限重试。
- 不覆盖不遵守锁的外部写入者在最后检查与 rename 间修改清单的竞争，也不把文件内容哈希抽象当作对密码学碰撞的证明。

读图聚合：保存和导入处于同一用户步骤时合并，保留“原件已归档、清单尚未提交”和“导入已中断、原件保留、清单未提交”两个独立阶段。隐藏 actor 身份、具体文件与哈希、备份字节和异常细节。旧版本拒绝有独立状态，所有命名动作都有中文 step。实跑图为 10 个阅读节点、14 条箭头；模型保留争用动作与终态自环，图自动折叠 16 条留在同一可见状态内的步骤。

## 维护

代码变化先重读函数与保护，核对模型的调用方 revision 与内部 captured revision 是否仍不同，再重审合同和唯一匹配的 before/after。带 `--mutations` 的完整检查通过并解读本次 TLC 结果后，才更新本片段 `sources[].sha256`、总表 `verification/formal/coverage.json` 的 `syncCommit` 和本技能同步基线。

若当前实现违反性质，保留 finding 与反例，不改产品、不删失败断言、不把归档和清单合成虚假的原子步骤。需要整体重审时使用 `/pstack:maintain-formal-verification-skill`。
