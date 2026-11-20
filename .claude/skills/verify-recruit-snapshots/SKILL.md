---
name: verify-recruit-snapshots
description: 修改招聘看板候选台账读取、兼容配置回退、整套陈旧快照或原人岗投影时，验证坏源不冒充零人且不混入新旧视图。
---

# 候选快照可信性验证

性质：坏或缺台账没有可信前态时，人数必须未知；已有兼容配置失效，或该映射下台账读取失败时，候选、岗位、未知状态、版本与时间必须整套沿用最后可信视图，并明确标陈旧。

损害：把读取失败显示为零人会误导招聘决策；只保留旧候选、却套用新岗位或新映射，会把同一批人按另一套口径重新计算。

同步基线 syncCommit：`eb790519332fc30cde6157bcd029ef443f76dddc`。
覆盖记录：`verification/formal/coverage-snapshots.json`；总表只引用该片段，源码 SHA-256 只保存在片段中。

## 代码与交付

| 函数或保护 | 代码位置 | 对应验证 |
| --- | --- | --- |
| `readCandidates` | `skills/recruit-board/model.mjs:88` | CSV 读取投影；补充合同验证原人岗身份不因别名合并，阶段仅由状态映射得出 |
| `buildSnapshot` | `skills/recruit-board/model.mjs:529` | 模型的 `ProjectSnapshot`；`557-570` 的已用配置保护、`583-591` 的台账失败回退、`638-640` 的未知人数 |
| `preserveCandidates` | `skills/recruit-board/model.mjs:559` | 整套保留候选、岗位、未知状态、contextRevision 与来源时间 |
| `readSnapshot` | `skills/recruit-board/scripts/reader.mjs:54` | 合同直接调用公开文件系统入口；三个来源独立读取后交给纯函数 |

模型、配置和中文读图投影分别为 `verification/formal/models/Snapshots.tla`、`Snapshots.cfg`、`Snapshots.view.mjs`；真实源码合同为 `verification/formal/snapshots.test.mjs`。

## 复跑与判读

在仓库根执行：

```bash
node scripts/verify-state-machines.mjs snapshots
```

需要检验验证能力时直接运行下一条；它已包含基线、TLC、突变和恢复检查，无需先执行上一条。整套维护可一次运行 `node scripts/verify-state-machines.mjs --mutations`。

```bash
node scripts/verify-state-machines.mjs snapshots --mutations
```

只调试真实入口合同：

```bash
node --test verification/formal/snapshots.test.mjs
```

合同的全部产品模块，包括表头和间接依赖，都从 `process.env.FORMAL_SOURCE_ROOT || repoRoot` 导入；fixture 仅含虚构数据，位于 `os.tmpdir()`，在 `finally` 中删除。

每次核对本次 `Evidence` 目录中的 `snapshots-implementation.out`、`snapshots-tlc.out` 和 `summary.json`；确认实际执行的测试数、退出码、全部 invariant 和无死锁结果。通过时参照 `Snapshots.view.mjs` 解释抽象流程；违例时解释最短路径中的代码操作、可见损害及对应 guard。解析或运行失败不算通过。只有需要重绘状态图时，才由用户直接调用 `/pstack:statechart`；未重绘应明确说明，历史图不能代替本轮结果。不要把读取阶段解释为候选推进状态机。

当前基线：3 项合同通过；TLC 检查 `TypeOK`、`SnapshotTruth` 与死锁，195 个可达状态，无违例。模型终态有 `Done` 自环。

`--mutations` 在外部临时源码副本中删除 `if (!config && hadConfig) preserveCandidates()` 这一真实保护分支，改为直接读取当前源。它必须以正常执行后的 `ERR_ASSERTION` 失败，并包含 `SNAPSHOTS_TRUSTED_VIEW_PRESERVED`；语法或导入失败不算抓错。丢弃变体后必须复跑基线。变体内容与唯一匹配文本以 coverage 片段为准。

## Bounds、假设与不覆盖

- 有限模型检查一次刷新，前态为无已用配置、已可信配置、已陈旧配置三种。台账分非空、有效空、损坏、缺失；岗位表与兼容配置分成功、损坏、缺失。读取失败与格式失败按相同回退含义聚合。
- 使用两代不可变 payload 代号；人数只区分未知、零及两个非零代表值。版本与时间是代号，非真实时钟、人口容量上限或 SHA-256 数值。
- 冷启动分支限定岗位表有效、无兼容配置；已用配置分支带岗位别名，故岗位表失效也会使该配置不可用。没有枚举全部合法配置、CSV 文本或每个状态字符串。
- `ReadLedger`、`ReadContext`、`ReadConfig` 分开建模，代表各次独立观察完成；没有把 `Promise.all` 当成多文件原子读取。同步纯函数 `buildSnapshot` 才是一个投影步骤。不保证全部成功文件来自同一次外部写入。
- 不覆盖任务轮次、总览事件、并发文件替换、恶意 CSV 的所有编码情况、完整别名空间或 UI 渲染。别名身份合同是补充真实入口检查，不宣称模型已证明所有身份场景。

读图聚合：隐藏姓名、具体阶段、payload 代号、版本时间及具体故障原因；可信和陈旧前态的相同读取阶段合并。终态保留“陈旧”“人数未知”“有效零人”“新视图”四种用户结果。所有命名动作均有中文 step，没有额外隐藏动作；实跑图为 8 个阅读节点、7 条箭头。模型保留终态自环，图自动折叠 76 条留在同一可见状态内的步骤。

## 代码变化后的维护

先对照上述函数、保护条件和提交基线重审模型及合同。若语义改变，先修改性质对应的模型、合同与变体，再运行带 `--mutations` 的完整检查并解读本次 TLC 结果。确认仍描述真实代码后，更新本片段的 `sources[].sha256`，推进总表 `verification/formal/coverage.json` 的 `syncCommit`，同步本技能的 syncCommit；不要通过只重算哈希消除漂移。

若当前代码出现违例，保留 finding、最短路径和合同失败，不修改产品源码，不把未知人数改成零或缩小性质以求通过。模型与代码失同步时，可用 `/pstack:maintain-formal-verification-skill` 协助重审。
