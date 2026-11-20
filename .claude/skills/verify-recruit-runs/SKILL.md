---
name: verify-recruit-runs
description: 修改招聘任务创建、步骤转换、轮次完成或终态写入防护时，验证结束结果可信，防止假完成或结束后被改写。
---

# 招聘任务结束规则验证

性质：所有步骤完成或有理由跳过后才能完成本轮，已结束轮次不能被新的进度动作改写。破坏后，用户会看到尚未做完的招聘任务被报为完成，或已经交付的结果事后变化。

## 覆盖与代码基线

已核对的基线 commit 为 `eb790519332fc30cde6157bcd029ef443f76dddc`。

- `skills/recruit-board/model.mjs`：`createRun`（316）、`validateRun`（331，完成状态校验 348）、`transitionRun`（394，终态检查 412、步骤及完成 469–493）。
- `skills/recruit-board/scripts/progress.mjs`：`recordProgress`（21），调用域转换后单个 run 文件发布（47–74）。
- 模型：`verification/formal/models/Runs.tla`；配置与中文视图为同名 `.cfg`、`.view.mjs`。
- 真实源码契约：`verification/formal/runs.test.mjs`。
- 源码 SHA-256 和两项删除 guard 的变体：`verification/formal/coverage-runs.json`。总入口 `verification/formal/coverage.json` 的 `subsystems.runs` 引用此片段；`syncCommit` 统一在总表维护。

## 执行

在仓库根目录运行：

```bash
node scripts/verify-state-machines.mjs runs
```

需要检验验证能力时直接运行下一条；它已包含基线、TLC、突变和恢复检查，无需先执行上一条。整套维护可一次运行 `node scripts/verify-state-machines.mjs --mutations`。

```bash
node scripts/verify-state-machines.mjs runs --mutations
```

第二条命令必须确认两个变体均被对应契约断言抓住，并在删除临时副本后回跑基线。变体分别删除终态写入检查和 `validateRun` 的假完成输入检查；失败标识是 `RUNS_TERMINAL_GUARD`、`RUNS_VALIDATE_COMPLETION_GUARD`。不以语法错误、导入错误或其他无关失败作为抓住防护的证据。

单独诊断真实实现：

```bash
node --test verification/formal/runs.test.mjs
```

契约从 `FORMAL_SOURCE_ROOT` 或仓库根动态导入全部被测入口；默认仅在 `os.tmpdir()` 创建虚构工作区，并在 `finally` 删除。不要传入真实招聘工作区，也不要在仓库根创建招聘 `CONTEXT.md`。

工具使用 Node 内置测试，不新增 npm 依赖；校验器使用固定 TLA+ tools v1.7.4（TLC 输出版本 2.19）和 Java，当前已核验 Temurin 25。统一脚本解析工具、校验 jar，并将证据写到系统临时目录。

每次核对本次 `Evidence` 目录中的 `runs-implementation.out`、`runs-tlc.out` 和 `summary.json`；退出码、实际执行的测试数、全部 invariant 和无死锁结果都要确认，不能只看 PASS 字样。通过时参照 `Runs.view.mjs` 解释中文状态流转；失败时按最短路径解释用户损害，工具错误先修复执行问题。只有需要重绘状态图时，才由用户直接调用 `/pstack:statechart`，提供 `Runs.tla`、配置和视图；未重绘应明确说明，历史图不能当作本轮证据。

## 界限与解释

模型有限：一轮、两项可区分步骤；run 包含 running、waiting、completed、failed、cancelled，步骤包含 pending、running、completed、skipped、failed。正常基线有 66 个可达状态，不用状态裁剪，终态保留自环。模型只检查 `TypeOK` 与 `RunFinalizationIsTrustworthy`。

一步对应一次同步 `transitionRun` 纯域转换。`sealed` 是首次结束时保存的观察量，不是产品额外的锁。模型不把进度 JSON、事项初始化等多个文件的修改当成全局事务。时间与合法理由抽象为已验证输入，不假设固定步骤顺序，也不要求先写 summary。历史重点请求可以在终态原样回放，返回不变记录符合冻结性质。

契约遍历真实转换的两项步骤投影，并验证全部真实工作流的逆序跳过、等待续办、不先写摘要的正常完成、持久化拒绝和历史回放。中文视图合并步骤组合与同状态内的推进，只展示轮次状态变化，正常图约 8 条箭头；违反性质的状态保留独立标签。它不穷举收据正文、重点更正、文件锁竞争、崩溃恢复、所有工作流步骤数量及活性。

## 代码变化后的同步

先打开 coverage 片段列出的源码，对照上述基线和当前拟同步 commit，确认每个 guard、转换顺序、原子步骤仍与模型、契约、变体一致，再运行带 `--mutations` 的完整检查并解读本次 TLC 结果。只有这些核对完成后，才计算实际源码字节的 SHA-256 并更新 `coverage-runs.json`；只有确认模型仍描述目标 commit，才推进总表 `syncCommit`。不要为了消除漂移提示直接刷新摘要。

真实代码若违反性质，保留失败和最短反例，说明是哪次进度动作造成假完成或改写终态；未经授权不改产品代码，也不删 guard 对应断言或弱化性质。若是模型错误，应以真实公开行为为依据修正抽象，并重新运行全部检查。
