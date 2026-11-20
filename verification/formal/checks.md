# 状态机验证记录

日期：2026-11-09。提交基线仍为 `80d623348799711ded9ea78eaf5c8961e1556a69`；当前验证覆盖该基线上未提交的熔断竞态修复，实际源码摘要保存在 `coverage-mirror.json`，没有提前推进同步提交。

工具：Node 24.9.0、Temurin 25.0.5、SHA-256 固定的 TLC 发布包 1.7.4。TLC 使用单 worker、fingerprint 0，检查有限安全性质与无死锁，不证明最终成功。

## 修复后统一结果

```bash
node scripts/verify-state-machines.mjs --mutations
```

实际退出 0：8 套模型与 24 项实现检查全部通过，19 种临时源码破坏全部被各自断言抓住。删除临时副本后，原始实现再跑全部通过。没有保留失败豁免，原始异步断言和全部 invariant 均保留。

| 子系统 | 实现检查 | TLC 可达状态 | 模型结论 | 突变被发现 |
| --- | --- | ---: | --- | ---: |
| Runs | 4/4 通过 | 66 | 通过 | 2/2 |
| Decisions | 2/2 通过 | 7 | 通过 | 2/2 |
| Events | 3/3 通过 | 60 | 通过 | 2/2 |
| Snapshots | 3/3 通过 | 195 | 通过 | 1/1 |
| Materials | 4/4 通过 | 38 | 通过 | 4/4 |
| Roles | 3/3 通过 | 54 | 通过 | 2/2 |
| Live | 1/1 通过 | 10 | 通过 | 2/2 |
| Mirror | 4/4 通过 | 60 | 通过 | 4/4 |

[机器可读结果](results.json)记录每套原始退出码、测试计数、突变结果、工作树摘要和状态图生成状态。[完整形式化验证输出](evidence/all-formal.out)、[当前镜像 TLC 输出](evidence/mirror-tlc.out)及全部基线／突变输出保存在 `evidence/`。

## 回归测试

```bash
npm test
```

238 项全部通过，失败、取消、跳过均为 0，退出 0。原始输出见[完整回归日志](evidence/regression.out)。

另外将镜像既有测试与形式化真实入口检查一起执行，共 50 项通过：

```bash
node --test verification/formal/mirror.test.mjs tests/mirror.test.mjs
```

## 熔断修复与异步测试

- 首条视口还原命令返回后，旧贴合缓存失效、视图不再标为已贴合，还原仍为未完成；随后重新检查风险，熔断时不再发送清除命令。
- 人工解除后可以重试；还原成功后不重复发送。等待还原期间重新请求相同尺寸的贴合，也会实际重新应用覆盖，不能沿用已经失效的缓存。
- 保留原始 `FORMAL_MIRROR_ASYNC_RISK` 测试及其事件顺序，另加上述两项恢复检查。原有 341 条长度 0–4 的守卫事件序列仍通过。
- 模型 `FirstCommandReturns` 在风险仍生效时回到 idle、不派发下一条命令；未熔断时才进入等待清除回执。`NoViewportDispatchAfterRisk`、`NoMaintenanceAdmittedInRisk`、`FirstRiskIsRetained`、`TypeOK` 与无死锁全部通过。配置中的 invariant 与修复前逐字一致。
- 第四个镜像突变 `clear-after-risk-await` 仅删除 await 后的风险复核，重新触发原始异步断言；详见[失败证据](evidence/mirror-clear-after-risk-await.out)。原始实现通过、隔离破坏版本失败、恢复后再通过。

模型只含一个在途还原调用、两类风险来源及有限守卫状态。缓存恢复由真实入口回归验证；传输、浏览器启动均为替身，没有连接实际浏览器或招聘平台。不证明真实 CDP、其他异步分支、完整缓存空间或外部授权。

## 状态图刷新与历史证据

[修复前结果](history/before-mirror-fix/results.json)、[旧模型](history/before-mirror-fix/models/Mirror.tla)、[异步失败输出](history/before-mirror-fix/evidence/mirror-implementation.out)与[原始 statechart 报告](history/before-mirror-fix/charts/mirror/report.md)均保留。旧模型在 statechart 中完整探索了 96 个状态，普通 TLC 于首个违例处停止时为 32 个；这些都是历史计数，不用于当前通过结果。

用户直接调用 `/pstack:statechart` 后，已完成[当前镜像图](charts/mirror/chart.mmd)和[报告](charts/mirror/report.md)。本次检查 60 个模型状态、300 个步骤；图显示为 6 个状态、11 条箭头，自动折叠 176 条停留在同一可见状态内的步骤。`TypeOK`、`FirstRiskIsRetained`、`NoMaintenanceAdmittedInRisk`、`NoViewportDispatchAfterRisk` 和无死锁均通过，没有未检查规则。风险来源、盯梢条件及不改变可见状态的守卫检查被合并，首条在途与返回后的熔断中止路径明确保留。图集和机器可读结果已更新，修复前反例仍在历史目录。

两个用户流程图和其他七个子系统模型未改变；其既有图仍保留原聚合边界。完整技能与执行范围见[交付说明](../../docs/verification/state-machines.md)，已修复反例的过程见[修复记录](findings.md)。
