---
name: verify-recruit-roles
description: 修改招聘看板岗位别名、岗位状态、配置 revision 检查或共用写锁时，验证同版本旧保存请求不能覆盖新配置。
---

# 岗位配置旧写保护验证

性质：同一文件版本的两个有变化的岗位保存请求最多一个提交；较早读取的别名或状态请求不能覆盖已经保存的新值，另一份配置文件保持不变。

损害：旧页面保存会撤销刚完成的岗位归并或重新改写岗位状态，使候选归组和在招范围偏离用户的最新决定。

同步基线 syncCommit：`80d623348799711ded9ea78eaf5c8961e1556a69`。
覆盖记录：`verification/formal/coverage-roles.json`；总表只引用片段，源码摘要在该片段唯一保存。

## 函数与模型对应

| 函数或保护 | 代码位置 | 模型或真实合同 |
| --- | --- | --- |
| `setRoleAlias` | `skills/recruit-board/scripts/roles.mjs:151` | `158` 的共用锁、`168` 的调用方版本检查、`199-202` 的提交前版本核对、`203` 的单文件 rename |
| `setRoleStatus` | `skills/recruit-board/scripts/roles.mjs:213` | `219` 的共用锁、`227` 的首次检查、`240` 的最终检查、`241` 的 CONTEXT rename |
| `readRoleInfo`、`roleConfig`、`contextRevision` | `skills/recruit-board/scripts/roles.mjs:131`、`:86`、`:8` | 合同读取真实文件哈希；别名版本与岗位表版本分别携带，元数据改动也改变配置 revision |
| `replaceRoleStatus` | `skills/recruit-board/scripts/roles.mjs:27` | 状态合同核对仅状态单元格变化、原文备份及其他文件不变 |
| `readSnapshot`、`readCandidates` | `skills/recruit-board/scripts/reader.mjs:54`、`skills/recruit-board/model.mjs:88` | 补充合同验证别名变化后原人岗身份和候选数量仍保留 |

模型 `verification/formal/models/Roles.tla` 分别选择别名配置和岗位表文件运行两请求场景；它们不是同一个文件，也不作为一个原子事务提交。对应 `Roles.cfg`、`Roles.view.mjs`、`verification/formal/roles.test.mjs`。

`FirstVersionCheck` 和 `FinalVersionCheck` 对应两次真实检查；`RenameConfiguration` 才是提交。备份、temp 写入与 sync 不属于提交步骤。

## 复跑与解释

在仓库根执行：

```bash
node scripts/verify-state-machines.mjs roles
```

需要检验验证能力时直接运行下一条；它已包含基线、TLC、突变和恢复检查，无需先执行上一条。整套维护可一次运行 `node scripts/verify-state-machines.mjs --mutations`。

```bash
node scripts/verify-state-machines.mjs roles --mutations
```

单独调试合同：

```bash
node --test verification/formal/roles.test.mjs
```

所有被测模块及其测试依赖从 `process.env.FORMAL_SOURCE_ROOT || repoRoot` 导入。每份 fixture 是 `os.tmpdir()` 中的虚构工作区，含虚构岗位、同名跨原岗人选、CRLF 文本，`finally` 删除；不触碰仓库根 CONTEXT。

每次核对本次 `Evidence` 目录中的 `roles-implementation.out`、`roles-tlc.out` 和 `summary.json`；确认实际执行的测试数、退出码、全部 invariant 和无死锁结果。通过时参照 `Roles.view.mjs` 解释检查、替换与拒绝的流程；违例时按最短路径说明旧版本如何覆盖新值。工具、解析或运行错误不是通过。只有需要重绘状态图时，才由用户直接调用 `/pstack:statechart`；未重绘应明确说明，历史图不能代替本轮结果。

当前基线：3 项合同通过；TLC 检查 `TypeOK`、`NoNewValueOverwrite` 和死锁，54 个可达状态，无违例。`Done` 为终态自环。

变体删除相应入口的两道 revision guard，保留其他校验、锁、备份与 rename：

- 别名变体必须触发 `ROLES_STALE_ALIAS_REJECTED`。
- 岗位状态变体必须触发 `ROLES_STALE_STATUS_REJECTED`。

两个检查有冗余，只删其中一个仍可能由另一个拒绝；因此每个变体一起删除该入口首次检查与提交前检查，不声称证明每一道检查独立不可缺。before 是源码唯一精确片段，after 仅移除这两行；文件与标识以 coverage 为准。变体必须正常执行后以退出码 1、`ERR_ASSERTION` 和固定标识失败，语法或导入失败不算抓错。删除外部临时副本后再跑基线。

## Bounds、假设与不覆盖

- 有限模型有两个请求、一个共用锁、两个独立文件版本；每次选择其中一个文件做更新，另一文件稳定。每请求携带版本 0，仅尝试一次；两个提议都与原值不同。
- 别名取两个已配置的正式岗位与“取消归并”三个代表值；岗位状态的符号 `active/offShelf/closed/paused/review` 分别表示在招、已下架、已关闭、暂停、待核。实际提议选暂停和已关闭，不假设任何业务转移顺序。
- 假设写入者遵守 `context.lock`，文件与目录已通过入口校验，内容哈希不碰撞且本轮无内容回退 ABA。缺配置的创建、非法别名目标、所有编码、文件大小、外部链接和无限重试不是该模型的全称证明范围。
- 最后读版本和异步 rename 分开建模。共用锁使模型中的合作写入者不能在这两个步骤间改文件；不保证忽略锁的外部程序在此窗口编辑文件时永不丢更新。
- 只证明单文件同版请求的保护，不证明岗位表与别名配置跨文件原子更新。原人岗身份、原文字节和备份由补充公开入口合同核对，不将其扩张为全部身份或编码空间的形式化证明。
- 不检查任意平台文件系统的 rename 持久性、进程崩溃恢复、业务授权或前端状态同步。

读图聚合：合并两个请求的对称动作，以及别名配置和岗位表的相同步骤；隐藏具体岗位名、状态值、哈希、备份和 actor 编号。保留首次检查、最终检查、原子替换、拒绝及写锁占用；所有命名动作有中文 step，未额外隐藏动作；实跑图为 8 个阅读节点、9 条箭头。模型保留终态自环，图自动折叠 24 条留在同一可见状态内的步骤。读图中的数字或版本代号不是候选阶段。

## 变更后维护

先对照源码与 syncCommit 重审两次版本检查、共用锁及每个 rename 的提交边界；确认合同仍调用真实入口且变体唯一匹配。调整模型、性质或合同必须说明业务依据，不为消除失败弱化旧写保护。带 `--mutations` 的完整检查通过并解读本次 TLC 结果后，才更新对应片段的 `sources[].sha256`、总表 `verification/formal/coverage.json` 的 `syncCommit` 和本技能同步基线。

当前实现若违反性质，保留 finding 和最短路径，不修改产品代码，不把两份配置合成一个虚构原子步骤。漂移较大时可使用 `/pstack:maintain-formal-verification-skill` 重审。
