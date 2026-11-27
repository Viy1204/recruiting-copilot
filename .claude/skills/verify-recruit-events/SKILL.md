---
name: verify-recruit-events
description: 修改约面任务收尾、档案事件关联、事件读取诊断或重点导入时，验证 calendar 收据对应候选人的档案事件必须在收尾前被回读核实。
---

# 约面收尾的档案事件验证

性质：有 calendar 收据的约面任务，只有在收尾检查读到每位对应候选人来源本轮的有效档案事件，且该候选人没有坏事件或读取失败诊断时，才能完成。破坏后，用户会收到已完成的预约任务，却没有可核实、可追溯的候选人进展依据。

## 覆盖与代码基线

已核对的基线 commit 为 `c7ba748e12ba9cdf38737441a94bf3937ff58183`。

- `skills/recruit-board/scripts/progress.mjs`：`recordProgress`（21），约面 summary/整轮 complete 的事件 guard（49–53）、导入重点（54–58）、内存转换和单 run 发布（60、68–74）。
- `skills/recruit-board/scripts/events.mjs`：`readArchiveEvents`（61）、`recordCandidateEvent`（98），通过真实档案记录与读取事件；稳定 ID 重放及冲突检查（110–115）。
- `skills/recruit-board/model.mjs`：`transitionRun` 的 highlight（583）、summary（610）与 complete（635）分支。
- `skills/recruit-board/scripts/records.mjs`：`readCandidateArchives`（330）、`readCandidateDetail`（354），提供已关联档案及文档身份。
- 模型与中文视图：`verification/formal/models/Events.{tla,cfg,view.mjs}`；契约：`verification/formal/events.test.mjs`。
- SHA-256 与删除 guard 的变体：`verification/formal/coverage-events.json`。总入口 `verification/formal/coverage.json` 的 `subsystems.events` 引用此片段，`syncCommit` 统一保存在总表。

## 执行

在仓库根目录运行：

```bash
node scripts/verify-state-machines.mjs events
```

需要检验验证能力时直接运行下一条；它已包含基线、TLC、突变和恢复检查，无需先执行上一条。整套维护可一次运行 `node scripts/verify-state-machines.mjs --mutations`。

```bash
node scripts/verify-state-machines.mjs events --mutations
```

必须抓住删除完整 calendar 档案 guard 的变体，以及仅删除档案诊断检查的变体，分别出现 `EVENTS_CALENDAR_GUARD`、`EVENTS_DIAGNOSTIC_GUARD` 断言失败。第二个变体在仍有一条合法关联事件、但档案同时含坏记录时必须被抓住，避免只测缺失事件。语法错误或导入错误不算；删除临时变体后必须再次通过原始基线。

独立诊断：

```bash
node --test verification/formal/events.test.mjs
```

测试动态从 `FORMAL_SOURCE_ROOT` 或仓库根导入全部被测入口和依赖入口。台账、CONTEXT、档案、事件备份和任务 JSON 全部在系统临时目录内虚构，`finally` 删除；禁止使用真实招聘工作区，禁止在仓库根落招聘数据。

不新增 npm 依赖；Node 原生测试配合固定 TLA+ tools v1.7.4（TLC 输出版本 2.19）及 Java，当前已核验 Temurin 25。统一脚本管理工具校验与临时日志。

每次核对本次 `Evidence` 目录中的 `events-implementation.out`、`events-tlc.out` 和 `summary.json`；确认实际执行的测试数、退出码、全部 invariant 和无死锁结果。通过时参照 `Events.view.mjs` 说明档案补齐、回读核实、内存整理、任务发布的顺序；失败时用最短路径指出哪份未核实依据被允许收尾。只有需要重绘状态图时，才由用户直接调用 `/pstack:statechart`，提供模型、配置与中文视图；未重绘应明确说明，历史图不能代替本轮结果。

## 界限、原子性与用户含义

有限模型固定一轮、一个有 calendar 收据的候选人、一份身份关联已固定的档案；各步骤均已完成或有理由跳过，不约束此前执行顺序。档案读数分为缺失、未关联来源、关联别轮、正确关联、坏记录、不可读六类。正常 60 个可达状态，无裁剪，完成状态有自环；主要性质为 `CalendarCompletionHasObservedEvent`，另检查 `TypeOK`。

模型将单档案缓冲区的有效性归类后，分别建模档案变化、回读、内存检查、纯域转换、单 run 文件发布。允许档案在回读之后和任务完成之后被修改或删除，所以性质针对**收尾时观察到的快照**，不保证档案永久存在，也不假设档案与任务跨文件原子提交。固定台账/文档身份与单档案原子替换，是此模型的环境假设，不是全工作区一致性证明。

真实契约补充两名候选人的全量覆盖：甲的事件不能替代乙；未关联来源、别轮来源、坏记录及不可读档案均不能收尾。另验证有效事件正常完成、summary 导入重点、稳定 ID 原样重放和冲突拒绝，以及 complete 不重复导入重点。中文视图合并各类不合格原因，不展示读后档案变化导致的相同标签内部步骤；不隐藏动作，正常图约 9 条箭头，违规完成状态独立显示。

代码只核对候选人身份、来源 run 和上述诊断；不证明事件类型或预约时段与 calendar 收据逐项一致，不证明外部日历实际创建、邀约已发送、所有并发读取或中途崩溃恢复。不要将通过解释成预约事实的端到端证明。

## 代码变化后的同步

先读取 coverage 片段列出的源码，对照基线与拟同步 commit，核实 guard 的触发条件、每位候选人的匹配、诊断优先、回读与发布边界及重点幂等。带 `--mutations` 的完整检查、TLC 结果解读和抽象对应关系复核完成后，才更新 `coverage-events.json` 的实际源码 SHA-256；确认目标 commit 的语义仍一致，才推进总表 `syncCommit`。不可只改摘要跳过核对。

真实代码若违反主要性质，保留最短反例和失败断言，不改产品代码、不把性质改弱。若只是模型错误，依据真实入口的读写边界修正模型并重跑；跨文件证据被删除等已说明限制不能误报为本性质已证明的永久保证。
