---
name: verify-recruit-mirror
description: 修改浏览器镜像熔断、自愈、视口还原的异步边界或人工解除时，验证风险后不再发起新的视口写入并保留首次依据。
---

# 验证浏览器镜像熔断

性质：风险置位后不能派发新的自动视口写入；入口已熔断时不发起自愈／贴合；首次风险依据保留到人工解除。
损害：异步等待后继续写入会违背停止自动动作的承诺，并可能干扰人工处理验证页。

从仓库根复跑：

```bash
node scripts/verify-state-machines.mjs mirror
```

需要检验验证能力时直接运行下列命令，它已包含基线、TLC、临时源码副本中的突变和恢复检查，无需先重复执行上一条。整套维护可一次执行 `node scripts/verify-state-machines.mjs --mutations`。

验证检查能抓住真实保护条件被删除：

```bash
node scripts/verify-state-machines.mjs mirror --mutations
```

每次核对本次 `Evidence` 目录中的 `mirror-implementation.out`、`mirror-tlc.out` 和 `summary.json`；确认实际执行的测试数、退出码、全部 invariant 和无死锁结果。参照 `verification/formal/models/Mirror.view.mjs` 解释熔断及异步返回顺序。只有需要重绘状态图时，才由用户直接调用 `/pstack:statechart`，不能改用内部 worker 绕过限制；未重绘应明确说明，历史图不能代替本轮结果。发现反例必须逐步重放真实 `BrowserMirror`，先排除模型错误，不修改性质来求通过。

## 已修复的异步反例

提交基线 `80d623348799711ded9ea78eaf5c8961e1556a69` 曾违反 `NoViewportDispatchAfterRisk`：首条视口还原命令等待期间熔断，返回后仍发送清除命令。原始异步顺序测试及标识 `FORMAL_MIRROR_ASYNC_RISK` 必须保留。

当前覆盖已同步至提交 `eb790519332fc30cde6157bcd029ef443f76dddc`（含上述异步熔断修复及 `set-mode` 移除，`coverage-mirror.json` 记录实际源码摘要）。源码在首条返回后使旧贴合缓存失效、保留还原未完成状态，再检查风险；熔断时直接结束本次调用，人工解除后才能续办。完成标记只在清除命令返回后设置。

真实实现检查包括 341 条长度 0–4 的守卫事件序列、原始异步顺序回归、人工解除后重试且成功后不重发、等待还原期间重新请求相同贴合时不复用旧覆盖。原始实现和 TLC 现在都应通过，不能继续把异步失败当作已知豁免。

## 覆盖和边界

- `lib/index.js`：`BrowserMirror._checkRiskUrl`、`clearRisk`、`_applyFit` 入口及无需求还原分支的两次 await、`tick` 自愈入口守卫。
- 模型：`verification/formal/models/Mirror.tla` 及配置。2 类风险来源、自愈前置条件布尔抽象、1 个在途视口还原调用。首条发送、首条返回后的风险检查与可选发送、第二条返回分别建模；等待期间允许风险和人工解除。
- 当前风险仍在时，`FirstCommandReturns` 回到 idle，不派发新命令、不更新最近派发的风险观察量；人工解除后的 `TryFit` 可重新开始。两条 CDP 命令没有被合成一个原子步。
- 缓存失效、重试和成功后只还原一次由真实入口回归检查，不宣称 TLA 模型穷举全部缓存状态。浏览器和传输均替身化，不接触平台或真实登录态。
- 不覆盖真实浏览器及帧流、启动进程内部 await、模式切换／CLI 锁、HTTP `/control` 与 `/input`、用户输入、卸载还原及所有风险 URL 的识别完整性。已经发送的命令不要求撤回。

四个突变必须分别捕获：

| 移除的保护 | 断言标识 |
| --- | --- |
| 自愈入口风险谓词 | FORMAL_MIRROR_NO_RECOVERY |
| 贴合入口早退 | FORMAL_MIRROR_NO_FIT |
| 首次风险依据早退 | FORMAL_MIRROR_FIRST_RISK |
| await 返回后的风险复核 | FORMAL_MIRROR_ASYNC_RISK |

突变只写临时源码副本；必须正常执行后由对应断言失败，语法或导入错误不算。丢弃副本后，原始实现必须重新全部通过。

源摘要与突变位于 `verification/formal/coverage-mirror.json`，总表为 `verification/formal/coverage.json`。摘要漂移使命令失败；先核对 await 边界与新增自动写入入口，再更新模型、实现检查和突变。只有核对过新提交才推进同步提交。未提交工作树继续明确记录其状态。TLC 1.7.4、Java 11+ 由共享入口定位。

历史变更未核对时使用 `/pstack:maintain-formal-verification-skill` 重新对齐。
