---
name: verify-recruit-live
description: 修改招聘看板异步刷新、暂停恢复、失效排队或读取超时时，验证单飞及过期响应隔离。
---

# 验证看板异步刷新

性质：上一轮读取真正结束之前不能开始第二轮；暂停、保存后失效或超时的响应不能再交付。
损害：违反后会并发读取、把旧数据覆盖到用户刚保存或切换后的视图。

从仓库根执行：

```bash
node scripts/verify-state-machines.mjs live
```

需要检验验证能力时直接运行下列命令，它已包含基线、TLC、临时源码副本中的突变和恢复检查，无需先重复执行上一条。整套维护可一次执行 `node scripts/verify-state-machines.mjs --mutations`。

检验验证能力（在临时源码副本删除保护，再回跑原始实现）：

```bash
node scripts/verify-state-machines.mjs live --mutations
```

每次核对本次 `Evidence` 目录中的 `live-implementation.out`、`live-tlc.out` 和 `summary.json`；确认实际执行的测试数、退出码、全部 invariant 和无死锁结果。通过时参照 `verification/formal/models/Live.view.mjs` 解释状态流转；失败时按最短路径逐步调用真实控制器，先排除模型错误。只有需要重绘状态图时，才由用户直接调用 `/pstack:statechart`；未重绘应明确说明，历史图不能代替本轮结果。不得为获得通过而削弱性质。

## 覆盖和边界

- 源码：`skills/recruit-board/public/live.mjs`，`createSnapshotController`，特别是 `start` 的 current/timeout 检查、`refresh` 的 flight guard、`suspend` 与 `resume`。
- 模型：`verification/formal/models/Live.tla` 和同目录配置。将任意代数压缩为无请求／当前请求／过期请求，因为被测逻辑只比较代数是否相等；模型枚举该抽象下全部可达状态，不证明真实网络的最终响应。
- 实现检查：`verification/formal/live.test.mjs`，穷举 9,331 条长度 0–5 的公开事件序列；每步排空微任务，使用可控超时及不响应 abort 的加载器。覆盖暂停、恢复、普通刷新、失效、返回成功、超时；不覆盖错误响应、随机微任务交错、退避时长、页面 DOM 或 workspace key 校验。
- 原子性：同步的公开调用与一次 Promise 续体分别为一步；超时独立于请求结束，abort 不等于结束。排队新读取在旧请求 finally 内同步开始。
- 突变：移除成功响应 current/timeout guard；绕过 refresh 的 flight guard。两者必须分别被 `FORMAL_LIVE_OBSOLETE_PUBLICATION` 和 `FORMAL_LIVE_SINGLE_FLIGHT` 抓住。

最后核对源码的提交：`80d623348799711ded9ea78eaf5c8961e1556a69`。精确文件摘要与突变锚点在 `verification/formal/coverage.json` 的 `live` 项，原始覆盖记录为 `verification/formal/coverage-live.json`。源码摘要变动会使命令失败，即使模型通过也不能继续沿用旧结论。

变更后先读取覆盖函数，确认同步步骤及取消语义仍匹配模型；语义变化时再改模型、真实实现检查和突变。直接运行带 `--mutations` 的完整检查并解读本次 TLC 结果，无需重复执行普通基线命令。确认匹配后更新 `coverage-live.json` 的源摘要，只有核对过新提交才前移总表同步提交。发现实现问题保留反例，未经用户要求不修改产品代码。历史改动未核对时使用 `/pstack:maintain-formal-verification-skill` 重新对齐。
