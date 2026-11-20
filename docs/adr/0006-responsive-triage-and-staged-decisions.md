# ADR 0006 响应式分拣工作台与两阶段本地决策

**日期.** 2026-11-20

**状态.** 已接受。本决策替代 [ADR 0002](0002-board-progressive-disclosure.md) 第 6 条中"仅限聊天录入决策"的界面限制，保留 [ADR 0001](0001-cross-round-decisions.md) 的跨轮事项存储和决定与执行分离语义，同时保留 [ADR 0003](0003-web-only-board.md) 至 [ADR 0005](0005-progress-from-candidate-records.md) 的单网页、对象关联、资料原件入口和档案事件规则。

## 背景

招聘人员目前在 `recruit-board` 阅读简历和跨轮待确认问题后，仍须切回聊天窗口输入答复，或为每条事项反复开关 `#workspace-drawer` 弹窗。多轮联调验证中，弹窗式流转打断队列上下文，窄栏侧边停靠场景也会因双栏硬排产生横向溢出。

同时，网页看板必须守住 `RecruitingFlow.tla` 中的 `ConfirmationBeforeAction` 不变量。用户在看板点击决定或暂缓，只代表意图已经落盘，不代表平台消息已发出或本地岗位配置已同步。

## 决策

1. **提供本地两阶段决策接口 `POST /api/decisions`.** 看板保留 `GET /api/health` 的能力声明机制并新增 `'web-decisions'`。`POST /api/decisions` 复用现有 `X-Workspace-Key`、`X-CSRF-Token` 与同源检查，请求体仅接受 `operation` 与 `input` 两个顶层字段，并调用 `applyDecisionCommand` 原子写入 `runtime/recruit-board/decisions/<id>.json`。
2. **仅开放人类意图暂存操作.** `WEB_DECISION_OPS` 仅允许 `decide`、`snooze`、`revise`、`reopen`、`cancel` 与 `resolve-history`。接口拒绝 `register`、`import`、`evidence`、`action`、`close` 与 `invalidate`，并返回 HTTP `400` 与 `DECISION_OP_FORBIDDEN`。浏览器提交只能把事项写入 `decided` 且后续动作为 `pending`，并且 `decision.scope` 必须等于 `item.identity.scope`。BOSS、猎聘与飞书上的真实平台动作，以及 `CONTEXT.md` 或台账同步，仍留在后续已授权的 Agent 工作流轮次中执行并核实后再标记 `action` 状态。
3. **采用 `@container workbench` `900px` B+C 混合响应式分拣布局.** 当工作区容器宽度大于或等于 `900px` 时，总览事项区渲染双栏分拣工作台，左侧为队列，右侧为粘性 `#triage-inspector` 面板，支持单键决定、自动推进下一条待处理事项及 `Shift` 批量暂缓。当容器宽度小于 `900px` 时，布局自动切换为单栏内联手风琴卡片流，已决定条目折叠为单行状态条，状态标签保持 `flex-shrink: 0` 与 `white-space: nowrap` 以防窄屏纵向折行。
4. **将 `#workspace-drawer` 限定为深度阅读和关注配置.** `#workspace-drawer` 不再承担日常分拣表单，仅在用户点击查看完整原始候选档案、面试记录（`03-interview/*.md`）或编辑关注岗位列表时打开。

## 备选方案

- **继续把聊天作为唯一录入入口，或对每条事项弹模态抽屉.** 已否决。切窗成本高，模态抽屉在连续处理多项问题时反复中断队列浏览。
- **在所有宽度强制双栏分拣，或在桌面宽屏仅用单栏流.** 已否决。窄栏侧边停靠小于 `900px` 时双栏会溢出或挤压操作区；宽屏只用单栏会浪费横向空间并因展开长证据把后续条目挤出首屏。
- **允许浏览器直接调用 `action` 标记外部动作完成.** 已否决。网页端无法核实外部平台回执，放开 `action` 会违反 `ConfirmationBeforeAction` 与 ADR 0001 的核实原则。

## 后果与验收

- 聊天入口 `decisions.mjs` 与网页入口 `POST /api/decisions` 共用 `applyDecisionCommand`、同一份文件锁、同一 `expectedRevision` 版本并发保护和 `requestId` 幂等重放逻辑，写入后立即失效服务端 `previousOverview` 缓存，使下一次 `/api/workspace/overview` 轮询和 `actions.mjs workspace-overview` 读取立即可见最新状态。
- 验收须覆盖全部 HTTP 守卫（`X-CSRF-Token`、同源、`X-Workspace-Key`、`DECISION_OP_FORBIDDEN`、`DECISION_REVISION_CONFLICT`、`DECISION_REQUEST_CONFLICT`、`decision.scope` 校验）、`npm test`、`verification/deploy-ui.test.mjs`、`verify-state-machines.mjs` 模型与变异检查，以及 `1280px` 与 `390px` 实机浏览器分拣流程。
