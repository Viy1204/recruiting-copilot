# 共享进度协议

六个工作流共用 `model.mjs` 的 `WORKFLOWS` 表。步骤 ID 与顺序以表为准，先执行一次 `node "<board目录>/scripts/progress.mjs" workflows` 读取；不在各 skill 复制命令列表。`ask-viy` 只路由，不创建 run。

## 默认记录与降级

六个执行入口在已确认的用户招聘工作区内、脚本可用时默认记录；开工动作统一按 [`hosts.md`](hosts.md) 执行。先 `start` 并立即进入真实 `step`，再探测服务、尽早交接网页，完成这次交接后才做耗时寻源或处理。`ask-viy` 路由、源码维护、纯评级回查和只查看看板不 start。

定位同一套 `skills/` 下的 `recruit-board/scripts/progress.mjs`，以下记为 `<progress>`；`<workspace>` 必须是本次用户工作区的绝对路径。单独安装 skill、旧工作区缺少脚本、没有 Node 或记录失败时，明确报告“本轮未记录进度”及原因，继续原招聘流程，不自动升级或覆盖 skills。网页脚本或宿主能力不可用时按 hosts 说明看板不可用或交付已确认的本机链接。看板读取与进度记录故障不阻断招聘本体，也不代表业务步骤完成。

普通流程开工时保留 `start` 返回的 `id` 到本轮上下文，后续命令始终显式带此 ID；并行、嵌套流程各自创建独立 ID，绝不用全局 current 文件。交付 connect 返回的完整 `runUrl`，保留工作区键和 `run` query，不手拼或删参数。`init` 例外：只有目标目录实际建立后才能 start；此时把已做完的依赖检查与建目录两步逐一记为 step→complete，依赖失败但按 init 规则继续时记 skip 和具体原因，再进入当前阶段。目录尚未建立，不为了显示进度在源码仓库创建 runtime。

```bash
node "<progress>" start --workspace "<workspace>" --workflow daily --role "<岗位>"
```

```bash
node "<progress>" step --workspace "<workspace>" --run "<id>" --step unread
```

```bash
node "<progress>" complete --workspace "<workspace>" --run "<id>" --step unread
```

`--workflow` 只能是 `init / grill / daily / resume-review / interview-schedule / mapping`。`--role` 可选，不传即全工作区；初次 start 可显式传 `--run <安全ID>`，不传生成 UUID。主动请求传 `--trigger manual`，明确调度触发传 `--trigger scheduled`，未知不猜（默认 `unknown`）。能从宿主 API 确认本会话 ID 时可加 `--session <会话ID>`；未知就不传，不从私有日志或猜测环境变量获取。没有绑定 ID 的面板显示“工作区任务”，不声称是左侧当前会话。

## 记录时机

- 进入 WORKFLOWS 对应业务阶段时 `step`，达到原 skill 的完成判据后才 `complete --step`。一次仅一个步骤执行中；批量候选人的阶段进度按工作流阶段记录，不为每人重复整套步骤，逐人结果另记下方 `result`。
- 整轮因等用户确认、缺输入或外部结果而无法继续时 `wait --reason "<短理由>"`。只有部分动作依赖确认时，先按 [`跨轮事项与重点`](decisions.md) 登记事项，其余已授权工作继续，不把全轮挂起。同一步恢复用 `step`；结果已核实也可直接完成该执行中步骤。
- 本轮不适用的阶段用 `skip --step <ID> --reason "<具体原因>"`。例如仅本地简历的 mail、单份无需汇总的 summary、用户未要求 IM 的 card。初筛无候选与未授权联系也要写清跳步理由。
- 失败用 `fail [--step <ID>] --reason "<短理由>"`；用户终止用 `cancel --reason "<理由>"`。理由限 300 字符；`run.reason` / `step.reason` 只写流程阻塞短句，不复制候选结论，因为会进入轮询快照，也不抄联系方式、简历正文或本机路径。
- 所有步骤已 complete 或明确 skip 后，按 [`跨轮事项与重点`](decisions.md) 写 `summary`（有重点／明确无变化），再执行不带 `--step` 的 `complete` 结束 run。它不会替你完成剩余步骤；失败/取消/完成的 run 不复用，后续开新 ID。独立事项可以继续处理，不需要为等用户决定而阻止本轮收尾。

```bash
node "<progress>" wait --workspace "<workspace>" --run "<id>" --reason "等待日程确认"
```

```bash
node "<progress>" skip --workspace "<workspace>" --run "<id>" --step card --reason "未要求 IM 通知"
```

```bash
node "<progress>" fail --workspace "<workspace>" --run "<id>" --reason "台账写入失败"
```

```bash
node "<progress>" cancel --workspace "<workspace>" --run "<id>" --reason "用户取消本轮"
```

```bash
node "<progress>" complete --workspace "<workspace>" --run "<id>"
```

## 逐人结果收据

候选处理动作完成、结论已核实且与现有证据/台账相符时，立即逐人写 `result`，不等日报结束。初筛未通过、处理失败或跳过也记录实际动作与理由；计划、拟好的话术和未核实的发送不能写成成功。收据只是本地观察记录，不执行平台动作、不改变台账状态，也不增加原流程的授权或确认要求。

```bash
node "<progress>" result --workspace "<workspace>" --run "<id>" --result "<稳定收据ID>" --step screen --name "<原姓名>" --role "<原岗位>" --action "初筛" --outcome "<已核实的短结论>" --attention decision --decision "<已登记的事项ID>" --next-action "<需要用户决定什么>"
```

`--step` 取本 run 的步骤 ID。`run.results` 持久化为 `null | RunResult[]`：旧 run 缺字段读作 `null`，表示未记录逐人结果；新 `start` 为 `[]`。脚本用 `resultsRevision` 标识结果版本，只有内容改变才递增；面板按版本同步，同一毫秒内更正也不会遗漏。每轮最多 2000 条，单条字段如下。

| 字段 | 约束 |
|---|---|
| `id` | `--result` 指定的本轮稳定收据 ID，1–64 字符安全串 |
| `stepId` | 本 run 的步骤 ID |
| `candidateId` | `JSON.stringify([姓名, 原岗位])`，由原姓名和原应聘岗位确定 |
| `action` | 动作文本，1–80 字符 |
| `outcome` | 已核实的简短结论，1–300 字符 |
| `attention` | 必填：`none` 无需关注；`notice` 提示风险；`decision` 待用户决定 |
| `nextAction` | `null` 或 1–300 字符文本；`decision` 时必须明确需要用户决定什么 |
| `updatedAt` | 脚本维护的最后更新时间 |
| `decisionId` | 可选，`--decision` 关联独立事项；终态后的处理从事项读取，不改写原收据 |

候选身份始终使用姓名＋原应聘岗位；岗位别名只影响展示/筛选，不重建 ID，同名异岗分开。收据 ID 可用台账固定序号＋step；未入账者首次分配一次并在本轮复用，不用每次 random 或列表排序位置重建。结果按 `id` upsert：已有 ID 不得换候选身份或 step，同内容重试为 no-op；同人同 step 用原 ID 改写，不同 step 可有多条。终态 run 不追加结果，及时在结束前记录。

需要用户决定时，先按 [`跨轮事项与重点`](decisions.md) 登记独立事项，再用 `--decision <事项ID>` 关联 `attention=decision` 收据。岗位、工作区问题直接登记事项，不伪造候选人。用户批准或拒绝后更新事项，资料同步和实际动作分别记结果；原 run 尚未结束时可更新原收据反映本轮已知结论，终态 run 保持原样。

旧收据仍保留原规则：同候选任一收据为 `decision`，本轮历史确认名单就保留它，别的 `none` 不抵消。这个名单表示该轮记录，不再冒充当前跨轮未解决清单；未关联事项的旧收据可显式引入“历史待核对”。

结果字段只保留动作、短结论与必要下一步，不抄联系方式、简历正文或本机路径。任务区的“本轮已记录 N 人”按原 `candidateId` 去重，仅表示收据覆盖人数，不宣称全量处理完成；业务完成仍以各 skill 原判据为准。尚未入台账的人也可显示收据，但不得冒认同名者资料；旧 run 不从台账来源轮次或备注猜补历史。

## 重点与事项的结构化记录

六入口及定时任务按 [`decisions.md`](decisions.md#对象关联与事件细节) 使用同一 `context`／`details` 契约。对象已核实时，新重点和事项同时记录结构化关联；单人用 `scope:candidate` 和规范的 `candidateId`，岗位用 `scope:role` 和 `role`，工作区用 `scope:workspace` 且不附人岗。重点只附事件适用的 `details`，最多 8 项；预约时段、事件发生时间和更新时间分别记录，不互相替代。

旧格式继续可读。缺少可靠关联就保留已知内容，不从自由文本姓名猜岗位；多对象事件不随意选一人代表。事项的 `register`／`import`／`evidence` 支持 `context`，既有身份与版本规则不变，具体输入见同一参考。

## 六入口映射

| 入口 | workflow | 按现有流程记录 |
|---|---|---|
| recruit-init | init | dependencies → workspace → register → roles → handoff；roles 调用的 grill 单独开子轮次；用户留待梳理的岗位写原因跳过，不伪称已梳理 |
| recruit-grill | grill | context → interview → jd → context-update → keywords；每轮批量提问后等待留在 interview，不把用户未确认的标准当完成 |
| recruit-daily | daily | unread → priorities → sourcing → screen → greet → ledger → report → card → keywords；按原流程完成判据，不通过进度记录扩大对外授权 |
| resume-review | resume-review | context → mail → parse → evaluate → records → ledger → summary；parse 包括输入与他人初评；summary 包括批量与邮箱汇总；只回查评级时不新建评估 run |
| interview-schedule | interview-schedule | details → interviewers → availability → calendar → invitation → records；建会确认留在 calendar 等待；改期/取消复用这组阶段；无飞书阶段按降级结果完成或有理由跳过 |
| market-talent-mapping | mapping | scope → sources → deep-dive → analysis → conclusions → report；盘点不联系候选人；报告之外的后续联系另按授权执行 |

## 存储与读数

轮次记录写 `runtime/recruit-board/runs/<id>.json`，版本 `schemaVersion: 1`，带 `createdAt/updatedAt`；跨轮事项由 [`decisions.md`](decisions.md) 的独立入口持久化。原子临时文件＋rename；同 run 的 `.lock` 独占写，竞争者明确报错。进程异常可能留下锁；只有确认没有写入进程时，人工移除该 run 的锁后再继续，不能按超时自动删锁。

面板始终显示“最后记录”与时刻。会话意外退出没有结束记录时仍保留 running/waiting，不按超时猜成功或失败。候选阶段只从九列台账当前 `状态` 精确映射；来源轮次、备注和面试档案不用于推断本轮进度或覆盖候选事实。进度与候选人阶段是两个独立维度。

网页任务选择显示类型、创建时间与可靠对象，时间相同且名称仍重名时才加简短序号，完整 ID 放在详情中。常规首页默认 live，按 `createdAt` 跟随最新 run；helper 的 `runUrl` 带 `run=<id>`，明确固定指定本轮，手动选历史也固定。看候选、完整结果或编辑岗位时，新 run 不抢当前阅读位置，提供“回到最新”。首次打开与已有页面复用的选择按 hosts 执行，不在每个 step 重开窗口。

前台每 1 秒单飞轮询，隐藏时降频、恢复可见立即读取；这表示页面取数状态，不是实时心跳或任务进程存活证明。首页跨轮事项与近期重点按需读取 `GET /api/workspace/overview`，CLI 使用共享的 `actions.mjs workspace-overview`；所选 run 的逐人动态与完整结果仍可从执行记录查看。全量快照仅含结果／事项 summary，不能把完整结论、事项历史、简历或私密资料塞入；演示只用隔离工作区。

完整结果仍按需读取：CLI 用 `actions.mjs run-results --workspace "<workspace>" --run "<id>"`，网页用 `GET /api/runs/results?run=<id>`；逐人动态用 `GET /api/runs/activity?run=<id>`。历史轮次重点用 `actions.mjs run-highlights --workspace "<workspace>" --run "<id>"` 或 `GET /api/runs/highlights?run=<id>`，不受首页 7 天窗口限制。页面请求保留 helper 建立的 workspace query 校验；所选 run 的结果独立于下方台账的岗位、阶段和搜索筛选。
