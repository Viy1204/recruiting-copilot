# 跨轮事项与每轮重点

本参考供六个招聘工作流和普通聊天中的事项处理共用。看板只展示文件中已记录的事实，不会自动读取聊天全文或替你执行招聘平台操作。

## 开工与收尾

先确认当前招聘工作区绝对路径，定位同一套 skill 下的 `scripts/actions.mjs`、`scripts/decisions.mjs` 和 `scripts/progress.mjs`，以下分别记为 `<actions>`、`<decisions>`、`<progress>`。

每轮先读事项总览，核对相关未解决事项、现行决定、资料待同步和待执行动作，再按 [`progress.md`](progress.md) 创建真实 run、进入真实步骤。只查看或回答已有事项时不创建完整招聘 run。

```bash
node "<actions>" workspace-overview --workspace "<workspace>"
```

- 主动请求的任务在 start 时传 `--trigger manual`；明确由调度启动传 `--trigger scheduled`；无法确认来源不猜，使用默认 `unknown`。
- 源码维护不建立招聘运行记录；初始化仅在目标工作区已经建立后记录。
- 如果总览报错或未接入，明确说明状态未知，不能用空列表声称没有待确认。普通不依赖事项的工作继续；无法确认授权的动作等待。
- 同一决定已有记录时复用，只有新增证据才追加 evidence；没有变化不每轮新建事项和提醒。
- 核实后及时写入逐人结果及少量重点，结束 run 前写简短 summary。重点记录和 summary 不是业务步骤完成判据，仍需逐步 complete／skip。

## 哪些事进入待确认

只有必须由用户拍板、授权或补充关键信息的事进入长期清单：岗位规则取舍、单个人选例外、特定动作授权等。普通核实薪资、跟进回复、取回附件等属于招聘工作本身，放候选进展；其中确实缺用户决定的部分再登记事项。

身份由 `identity.subjectKey + questionKey + scope` 确定，跨轮复用同一身份。subjectKey 使用已核实的岗位或候选稳定标识，不用名单排序、随机ID或相似姓名猜同一个人。不同岗位、不同候选人、岗位通用规则与单人例外分别建项。系统返回的事项 id 用于后续读写和关联 result，不自行拼算。

每次写入有 `requestId` 和 `expectedRevision`：一次逻辑操作固定一个 requestId，因超时重试时保留原 payload；新的操作用新的 requestId。register 首次版本为 0，后续以总览返回的当前 revision 为准。版本冲突先重新读取并核对，不将 expectedRevision 盲目改成最新值后覆盖决定。

## 对象关联与事件细节

新记录在对象已核实时同时写结构化字段，便于网页直接显示人选、岗位和事件。旧格式缺少这些字段仍可读，不要求先迁移历史文件。

`context` 可选，格式为 `{scope:'candidate'|'role'|'workspace', candidateId?:string, role?:string}`：

| scope | 必填与约束 |
|---|---|
| `candidate` | 必须有 `candidateId`，值为 `JSON.stringify([姓名, 原岗位])` 的规范字符串；通常仅写 scope 与 candidateId，不用展示别名重建 ID |
| `role` | 必须有已核实的 `role`；不附候选身份 |
| `workspace` | 不得附 `candidateId` 或 `role`；只用于明确属于整个工作区的记录 |

对象未知就省略 context，不把未知当成工作区级。多对象来源保留已核实关联，不随意挑其中一人代表；不能凭自由文本中的姓名自动绑定岗位，同名异岗仍是不同身份。事项的展示 context 与 `identity.scope` 的决定适用范围是两件事，补充展示关联不改变事项 identity 或 id。

`register`／`import` 可提供 context；`evidence` 在追加已核实依据时也可补充或更正 context，仍需 `source`、`evidence`、当前 `expectedRevision` 与固定 `requestId`，历史保留更改记录。省略 context 保留已有值；不要仅为改展示绕过版本检查或改变决定。

重点 `highlight` 还可带 `details:[{label,value}]`，最多 8 项，label 最多 80 字符、value 最多 300 字符，均为非空单行短文本。只写该事件适用且已经核实的细节，例如日程创建后的“预约时段”“面试官”；不抄整份简历、联系方式或本机路径，不为非面试事件填面试字段。预约时段是事件内容，`occurredAt` 是事件发生时间，`updatedAt` 是记录更新时间，三者不互相替代。

旧记录优先利用已校验的来源 run＋result 引用恢复候选姓名和原岗位，再按有效岗位别名归组。原岗位关闭或人选已离开台账仍保留原对象，当前资料不可用就提示；缺失或歧义标“关联待确认”，岗位未知归“岗位待确认”，明确工作区记录归“工作区事项”。恢复只影响读取展示，不改写终态 run 或自动解决旧事项。

## 写入入口

将操作内容保存为工作区内普通 UTF-8 JSON 文件，用 `--input-file` 传入，避免跨 shell 引号差异。也可用 `--input <JSON>`，二者互斥。以下示例字段中的对象、理由、来源均须替换为真实已核实内容；按用户工作区时区确定时刻后，转换为 `YYYY-MM-DDTHH:mm:ss.sssZ` 形式的 ISO UTC 时间再写入。

```bash
node "<decisions>" register --workspace "<workspace>" --input-file "<workspace>/runtime/decision-input.json"
```

register 示例：

```json
{
  "requestId": "role-location-first",
  "expectedRevision": 0,
  "identity": {
    "subjectKey": "role:confirmed-role-key",
    "questionKey": "accept-remote",
    "scope": "该岗位的工作地点要求"
  },
  "title": "该岗位是否接受异地",
  "context": { "scope": "role", "role": "已核实的岗位名" },
  "source": { "runId": "当前已创建的run-id" },
  "blocking": true
}
```

候选收据使用 `progress result ... --attention decision --decision <返回的事项id> --next-action "需要决定的具体问题"`。岗位或工作区事项不伪造候选收据。来源 run 已结束时仍可处理既有事项；普通聊天中处理旧事项不需要新建 run。

操作总览：

| 命令 | 主要内容 | 行为 |
|---|---|---|
| register | identity、title、source、expectedRevision:0，可选 context | 首次登记；同一身份不复制新项 |
| evidence | id、expectedRevision、requestId、source、evidence，可选 context | 补充核实依据、来源和展示对象，不自动推翻已有决定 |
| decide | id、expectedRevision、requestId、decision、actions | 记录明确答复和需要落实的动作 |
| revise | 与 decide 相同，注明修订原因 | 记录用户明确修订，不用旧 run 覆盖新决定 |
| reopen | id、expectedRevision、requestId、reason | 新证据需要重新决定时重开，并说明原因 |
| snooze | id、expectedRevision、requestId、until、reason | 暂缓；until:null 不生成虚构到期日 |
| action | id、expectedRevision、requestId、actionId、status | 更新单个后续动作的真实状态 |
| close | id、expectedRevision、requestId、reason | 已决定且全部动作落实后收口 |
| cancel / invalidate | id、expectedRevision、requestId、reason；invalidate 还需 evidence | 明确取消／有依据失效，保留历史 |
| resolve-history | id、expectedRevision、requestId、resolution、reason | 核对旧标记后转为当前真实状态 |

对象关联有新证据时，用 evidence 更新原事项。例如下列输入在提供真实来源及当前 revision 后，可补明候选对象；它不改变决定或自动解决事项。

```json
{
  "id": "总览返回的事项id",
  "expectedRevision": 1,
  "requestId": "verified-candidate-context-1",
  "source": { "runId": "已核实的来源run-id", "resultId": "已核实的收据id" },
  "evidence": "已逐项核对来源收据中的姓名和原岗位",
  "context": { "scope": "candidate", "candidateId": "[\"合成人选\",\"合成岗位\"]" }
}
```

```bash
node "<decisions>" evidence --workspace "<workspace>" --input-file "<workspace>/runtime/decision-input.json"
```

## 用户在聊天里作决定

先对应对象、问题与适用范围。明确且能唯一对应的回答直接记录；“可以”可能对应多项时只问必要的消歧问题。“都同意”只适用于用户明确看到的那组事项，不扩展到未列出的事项。查看、没有回复、暂缓到期都不是批准。

例如把下列内容写入输入文件后调用 decide：

```json
{
  "id": "总览返回的事项id",
  "expectedRevision": 1,
  "requestId": "reply-location-1",
  "decision": {
    "text": "此岗位接受异地，其他标准不变",
    "scope": "该岗位的工作地点要求",
    "authority": "用户本次明确答复"
  },
  "actions": [
    { "id": "sync-context", "label": "更新岗位正式要求", "kind": "sync" }
  ]
}
```

```bash
node "<decisions>" decide --workspace "<workspace>" --input-file "<workspace>/runtime/decision-input.json"
```

- `decision` 保存用户的原意、适用范围、授权依据，有限期时填 `expiresAt`。其中 `scope` 必须与该事项的 `identity.scope` 完全一致；范围变了就另建对应事项，不能靠改描述扩大范围。用户拒绝一个动作同样是明确决定，不为被拒绝的动作创建待执行项。
- actions 使用稳定动作 id，kind 为 `sync`（资料同步）、`external`（对外动作）或 `other`；初始 pending，不将批准直接写成 done。
- 涉及规则调整时真实更新 `CONTEXT.md` 和该岗相关材料，再记录 sync 成功。仅人选例外不能改全岗标准。
- 只把已获授权且当场可执行的动作继续落实。接受异地不等于授权联系所有异地候选人；岗位标准变化不自动重跑全部历史人选。
- 决定已保存但资料未同步要明确提示。命令失败时不能宣称“已记录”；不要仅凭聊天答复更新面板假状态。
- 明确改口使用 revise，明确列出新决定所需动作；旧决定、旧动作和修订原因仍可回查。不能把旧版资料同步的成功当成新版标准已同步，也不能在撤回批准后继续旧动作。执行中或结果不确定的动作先核查实际效果，再修订或归档。重要新证据使用 reopen 提请再确认，不让程序自行把批准改成拒绝。

## 后续执行与续办

动作写入只记录事实，不执行外部动作。读取事项确认授权和实际条件，再用原工作流完成业务操作，最后记录结果。

```json
{
  "id": "总览返回的事项id",
  "expectedRevision": 2,
  "requestId": "context-written-1",
  "actionId": "sync-context",
  "status": "done",
  "evidence": "已核对 CONTEXT 中该岗位的地点要求"
}
```

```bash
node "<decisions>" action --workspace "<workspace>" --input-file "<workspace>/runtime/decision-input.json"
```

动作状态：pending／running／done／failed／uncertain／cancelled。失败写 `reason`，完成写可核查的 `evidence`。超时后无法确认外部效果使用 uncertain，先查实际平台状态，不能盲目重发消息或重建日程。uncertain 转为任何后续状态时都提交 `verification`，说明核对了什么、实际结果如何；failed 重试为 pending／running 时同样提交该记录，说明为何确认尚未执行。

下一轮读取后续执行清单：

1. 核对当前决定是否修订、对象和条件是否仍适用、授权是否仍有效。
2. 查实际完成情况。已经完成就补核实记录，未执行才进入续办。
3. 仅在本轮执行范围内继续；只读巡检不能转为外发。每日招聘的“合适的直接打”本轮持续授权不会因保存事项而延续到下轮，缺有效授权重新提请确认。
4. 分别更新多项动作的状态；一项成功不表示整件事完成。资料未同步、执行失败都保留在“后续执行”。

只暂停依赖未决事项的动作，其余已授权工作照常。结束 run 前可以说明“可执行工作已完成，另有待确认／待执行事项”；不清空独立事项。全部必要动作落实后 close，没有后续动作的决定也可直接收口。

## 暂缓、失效与历史核对

- snooze 的 until 使用明确时区日期；用户说“先放着”用 null。到期恢复待处理展示，不自动批准。应用关闭期间，下次打开或运行任务时补上。
- 只有明确取消，或有证据证明岗位关闭、候选退出等事实使该事项失去意义，才 cancel／invalidate。源文件缺失、未检索到、很久没回复都不是失效证据。
- 普通聊天中的答复与同一套读写规则一致；历史 run 仍显示当时事实，事项展示现在的处理结果。

显式接入某个旧 run 的 decision 收据：

```bash
node "<decisions>" import-history --workspace "<workspace>" --run "<旧run-id>"
```

`import-history` 从合法原收据生成 candidate context，不接收猜测的人岗；内部 import 写入同样校验 context。已有导入项不因再次引入而改写，对象关联需要更正时使用带依据、来源和当前版本的 evidence。旧记录先归 history_review，重复引入不重复生成。同名和相似措辞不足以合并旧事项；有明确处理证据时通过 resolve-history 记录结果。resolution 可为 open／decided／closed／cancelled／invalidated，已决定或关闭时提供明确 decision；close 不允许仍有未完成动作。

## 每轮重点

逐人 result 保留完整处理记录，highlight 只提炼影响下一步行动的信息：值得关注的人选、已完成关键动作、待决定的新情况、异常或受阻。不能把计划、话术草稿或未核实发送写成成功。

```bash
node "<progress>" highlight --workspace "<workspace>" --run "<run-id>" --event "<稳定事件键>" --text "<已核实短结论>" --evidence "<简短依据>"
```

对象已核实时加 `--context '<JSON>'`，需要事件细节时加 `--details '<JSON数组>'`。以下为虚构格式示例，实际使用须替换为已核实的对象、时段与面试官，并按当前 shell 正确引用 JSON：

```bash
node "<progress>" highlight --workspace "<workspace>" --run "<run-id>" --event "<该人选本次预约的稳定事件键>" --text "面试日程已创建" --evidence "已回查日程核对时间和参会人" --context '{"scope":"candidate","candidateId":"[\"合成人选\",\"合成岗位\"]"}' --details '[{"label":"预约时段","value":"<已核实的日期、起止时间与时区>"},{"label":"面试官","value":"<已核实的面试官>"}]'
```

已知实际事件发生时间时另传 `--occurred-at "<ISO UTC时间>"`；不要把将来预约的时段写成这次记录的发生时间。首次记录没有可靠对象或细节时省略字段，保留可核实的原文及依据。更正已有重点时提交本版完整的 `context` 和 `details`；省略不会自动沿用上一版，撤销细节可传空数组。每版均保留当时的对象和细节供回查。

同一对象同一事件复用 event key；不同事件分开，不能仅凭同名合并。涉及事项加 `--decision <事项id>`。没有新事实不重复写旧提醒。先通过 `run-highlights` 读取该事件的 `revision`；同一轮修改已有事件正文、对象关联或事件细节时同时传 `--correction "<更正原因>" --expected-revision <事件版本> --request <本次逻辑请求ID>`。这里是事件自身版本，不是 run 的 highlightsRevision。一次逻辑更正固定 request，重试复用原参数；旧请求不会覆盖后来的更正，版本冲突需重读核对。脚本保留每次短结论、依据、时间及更正原因，不只保留上一版。

```bash
node "<progress>" summary --workspace "<workspace>" --run "<run-id>" --state highlights --text "<本轮最重要的结果及未解决事项>"
```

```bash
node "<progress>" summary --workspace "<workspace>" --run "<run-id>" --state no_change --text "本轮巡检完成，无重要变化"
```

两种 summary 按真实结果择一，在 run 完成前写入。无重要变化表示已完成约定检查后得出的结论；脚本未接入、流程没跑完、结果没写入、读取失败都不是 no_change。近期重点窗口默认 7 天，不删除历史，也不限制事项保留期。更早的重点通过 `actions.mjs run-highlights --workspace "<workspace>" --run "<id>"` 或网页执行记录读取，保留该轮摘要、触发来源和正文。

## 读数、持久化与降级

`workspace-overview` 的 decisions/highlights 按需读取；counts 分 open、snoozed、history、followUp。`effectiveState` 反映已到期暂缓的当前展示，state 保留已记录状态。null 计数表示未知，不显示成零；历史待核对单列，已决定未执行不混入待用户回答数量。

网页全部事项按岗位分组并保留状态筛选；组及组内优先展示已到真实期限／提醒时间或明确阻塞的当前事项，再显示其他待回答与历史待核对，同级按等待时间稳定排列。分组数量对应当前列表，工作区总数不受浏览筛选改变。事件／事项详情连接人选资料与来源，逐层返回恢复前一层、筛选和阅读位置，不叠加多层弹窗。

数据落在工作区 `runtime/recruit-board/`，需与台账一起备份，不能当临时缓存删除。并发更新以版本与锁保护；失败说明具体原因，只有确认没有写入进程才处理遗留锁，不按超时自动删锁。

旧工作区、缺脚本、CLI版本不兼容或写入失败时说明“本轮未记录重点／事项”及原因，不自动安装、覆盖技能或升级真实数据。已确认可继续且不依赖故障记录的招聘工作继续。面板读取失败时保留最后可信内容与时间，没有缓存就显示未知；外部动作结果不确定时先核实实际效果。

现有定时任务须实际调用本共享协议才能产生联动。部署时检查其提示词、使用的 skill 来源、脚本版本和工作区路径，不能因网页每秒刷新就声称所有巡检已经接入。
