---
name: verify-recruit-decisions
description: 修改招聘事项 expectedRevision、requestId、依据登记或事项写入入口时，验证旧版本写入隔离和请求重放，防止最新事项或修订历史被覆盖。
---

# 招聘事项版本与重放验证

性质：旧版本请求不能覆盖已更新的事项，同一请求重放只返回回执，不能重复登记依据或回滚当前记录。破坏后，用户的新核实依据可能丢失，重试也可能被误当作一次新处理或无故报冲突。

## 覆盖与代码基线

已核对的基线 commit 为 `eb790519332fc30cde6157bcd029ef443f76dddc`。

- `skills/recruit-board/decisions-domain.mjs`：`applyDecision`（120），请求哈希与回放（123–128）、版本冲突（129）、依据登记（156–158）与历史追加（202–204）。
- `skills/recruit-board/scripts/decisions.mjs`：`readDecision`（41）、`applyDecisionCommand`（66），在单事项锁内读入当前记录并应用域转换，重放不重写事项 JSON。
- `skills/recruit-board/scripts/server.mjs`：`POST /api/decisions`（`8c73002` 新增），经 CSRF、同源与 `WEB_DECISION_OPS` 白名单校验后直接委托 `applyDecisionCommand`，不绕过版本锁或重放守卫；若后续新增或放开 web 写入口，须复核是否仍经由 `applyDecisionCommand`。
- `skills/recruit-board/scripts/storage.mjs`：`withItemLock`（55）、`writeJSONFile`（37），用于解释单事项正常写入边界。
- 模型与中文视图：`verification/formal/models/Decisions.{tla,cfg,view.mjs}`；契约：`verification/formal/decisions.test.mjs`。
- SHA-256 与变体：`verification/formal/coverage-decisions.json`。总入口 `verification/formal/coverage.json` 的 `subsystems.decisions` 引用此片段；`syncCommit` 只在总表维护。

## 执行

在仓库根目录运行：

```bash
node scripts/verify-state-machines.mjs decisions
```

需要检验验证能力时直接运行下一条；它已包含基线、TLC、突变和恢复检查，无需先执行上一条。整套维护可一次运行 `node scripts/verify-state-machines.mjs --mutations`。

```bash
node scripts/verify-state-machines.mjs decisions --mutations
```

必须分别抓住删除 expectedRevision 检查和删除 requestId 回放分支的两个临时变体。对应断言标识为 `DECISIONS_STALE_GUARD`、`DECISIONS_REPLAY_GUARD`。后者验证旧请求在后续修订后仍能成功取得原回执、返回当前记录；不能把版本冲突异常当作成功的重放。变体检查之后必须回跑未改动的源码基线，语法错误或导入失败不能算抓住防护。

单独诊断：

```bash
node --test verification/formal/decisions.test.mjs
```

测试从 `FORMAL_SOURCE_ROOT` 或仓库根动态导入所有被测模块，使用系统临时目录的虚构 source run 和事项，`finally` 删除工作区；不要在真实工作区或仓库根生成招聘数据。

无需新增 npm 依赖，使用 Node 原生测试。统一脚本使用固定 TLA+ tools v1.7.4（TLC 输出版本 2.19）及 Java，当前已核验 Temurin 25；执行日志位于系统临时目录。

每次核对本次 `Evidence` 目录中的 `decisions-implementation.out`、`decisions-tlc.out` 和 `summary.json`；确认实际执行的测试数、退出码、全部 invariant 和无死锁结果。通过时参照 `Decisions.view.mjs` 解释依据登记与拒绝/重放不改记录的含义；失败时用最短路径说明用户损害。只有需要重绘状态图时，才由用户直接调用 `/pstack:statechart`，提供模型、配置和中文视图；未重绘应明确说明，历史图不能代替本轮结果。

## 界限与解释

模型从成功 register 后的 revision 1 起步；省略这条已有注册历史，仅枚举两位客户端各一项 evidence 请求、重读、旧写拒绝、相同请求回放和请求身份冲突。最多两次新增依据，版本 1–3，正常有 7 个可达状态，无裁剪，达到边界后有自环。主要性质为 `DecisionWritesAreProtected`，另检查 `TypeOK`。

模型历史的 `base` 是转换前实际版本的观察量，`current` 投影最后新增的依据。一次 `applyDecision` 是同步纯转换；单项 JSON 的正常发布可由事项锁串行解释。模型不把来源 run 校验、事项 JSON 与 known 标记等跨文件步骤合并成事务，不证明锁恢复或崩溃一致性。

契约调用纯域入口和真实存储入口，覆盖两种客户端顺序、旧写拒绝、重新读取版本、后续修订后的旧请求回放、不同内容复用请求 ID 的拒绝，以及失败或回放时文件字节不变。视图合并客户端、快照版本和无变化回执，正常图 2 条登记箭头；同标签内的读取、拒绝、回放不单画，违规状态独立显示。

不覆盖 uncertain 动作核实、decide/revise 等完整业务状态空间、身份生成碰撞、不同事项并发、所有输入长度、进程崩溃或外部平台操作；通过只适用于上述版本与重放边界。

## 代码变化后的同步

先读取 coverage 片段中的源码，对照基线和拟同步 commit，逐项核实请求哈希、回放先于版本检查、旧写拒绝和历史追加顺序，确认模型、契约、变体仍对应真实入口。带 `--mutations` 的完整检查与 TLC 结果均复核后，才更新 `coverage-decisions.json` 的实际文件 SHA-256；确认与目标 commit 对齐后，才推进总表 `syncCommit`，不可机械刷新摘要消除漂移。

若真实代码违反性质，保留最短反例与失败断言，不改产品代码，不缩小性质使它通过。模型或执行错误则依据真实代码修正抽象或执行方式，重新跑完整检查。
