# 已修复的状态机反例

## 风险置位后仍派发下一条视口还原写入

状态：已按用户要求修复，原始异步顺序测试保留。修改尚未提交；提交基线仍是 `80d623348799711ded9ea78eaf5c8961e1556a69`，当前源码摘要见 `coverage-mirror.json`。

源码：[lib/index.js:760](../../lib/index.js:760)，`BrowserMirror._applyFit()` 的无贴合需求还原分支。

性质 `NoViewportDispatchAfterRisk` 没有改变：风险置位后，不再派发新的自动视口写入。已经在途的命令无需撤回。

### 修复行为

首条 `Emulation.setDeviceMetricsOverride` 返回后，旧贴合缓存立即失效，视口不再标为已贴合，还原仍视为未完成。随后重新检查风险：仍在熔断时结束本次调用，不发送 `Emulation.clearDeviceMetricsOverride`；人工解除后可以重新还原，或按等待期间更新的贴合需求重新应用覆盖。只有清除命令返回后，才设置还原完成标记。

原有 `FORMAL_MIRROR_ASYNC_RISK` 断言与事件顺序保留，另增加人工解除后重试、成功后不重复还原、等待期间重新请求相同贴合时不复用旧缓存的回归检查。验证使用真实方法与可控 CDP 传输替身，不连接招聘平台。

模型的 `FirstCommandReturns` 对应真实返回后的复核：未熔断时才能进入等待清除返回状态，仍熔断则回到 idle，不派发新命令、不更新最近派发的风险观察量。两条 CDP 写入仍是独立步骤，性质和配置中的 invariant 均未删除。

### 修复前最短路径

以下是[历史 statechart 报告](history/before-mirror-fix/charts/mirror/report.md)的编号，已不代表当前模型：

0. 未熔断，可以自动维护。
1. 调用视口还原，首条命令派发后等待返回。
2. 观察到验证页，`_checkRiskUrl()` 置位；首条命令仍在途。
3. 首条返回后仍派发清除命令，违反性质。

原始历史派发记录：

| 命令 | 派发时已经熔断 |
| --- | --- |
| Emulation.setDeviceMetricsOverride | 否 |
| Emulation.clearDeviceMetricsOverride | 是 |

[修复前模型](history/before-mirror-fix/models/Mirror.tla)、[原始失败输出](history/before-mirror-fix/evidence/mirror-implementation.out)和[当时结果](history/before-mirror-fix/results.json)均保留。

### 复跑与抓错

```bash
node scripts/verify-state-machines.mjs mirror --mutations
```

修复后的基线应退出 0。第四个突变 `clear-after-risk-await` 只删除新增的 await 后风险复核，必须重新触发原始 `FORMAL_MIRROR_ASYNC_RISK`，证明旧反例仍能抓住问题；临时副本删除后基线必须再次通过。完整实跑结果见[验证记录](checks.md)。

### 图与范围

用户直接调用 `/pstack:statechart` 后已重绘[修复后状态图](charts/mirror/chart.mmd)。本次检查全部 60 个模型状态，四项不变量及无死锁均通过；显示为 6 个状态与 11 条箭头。原来的危险路径现在在首条返回后转入熔断等待，不再发送清除命令。新[报告](charts/mirror/report.md)与[图集](charts/index.md)已更新，修复前图和失败输出另存历史目录。

缓存恢复由真实入口回归检查，不宣称有限 TLA 模型证明所有缓存组合、其他异步分支、真实 CDP 或平台行为。
