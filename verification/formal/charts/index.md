# 状态图与模型检查报告

图集包含两张业务执行约定图和八张源码子系统图，聚合不缩小模型检查范围。用户直接触发 /pstack:statechart 后，修复后的镜像图已重新生成：60个模型状态全部通过，显示为6个状态与11条箭头。修复前反例单独保留在历史目录；当前结果见 results.json，范围见各验证技能。

[验证记录](../checks.md) · [已修复反例](../findings.md) · [机器可读结果](../results.json)

## 从筛选到约面进展可见

[模型](../models/RecruitingFlow.tla) · [配置](../models/RecruitingFlow.cfg) · [view](../models/RecruitingFlow.view.mjs) · [原始 Mermaid](recruiting-flow/chart.mmd) · [完整报告](recruiting-flow/report.md)

TLC reached 9 states and 12 steps. The chart draws 9 states and 11 arrows.
The chart does not draw 1 steps that stay in one chart state.

```mermaid
---
title: "招聘主流程 从筛选到约面进展可见"
---
stateDiagram-v2
  state "Legend" as legend {
    lg0: 完成
    lg1: 待处理
    lg2: 进行
  }
  class lg0 teal
  class lg1 orange
  class lg2 blue
  s0: 读取已确认岗位标准
  s1: 取简历#12289;筛选并记录依据
  s2: 等待用户决定
  s3: 已暂缓#65292;保留事项
  s4: 已获授权#65292;等待执行
  s5: 外部已成功#65292;档案待同步
  s6: 结果不确定#65292;先核实外部状态
  s7: 档案事件已写#65292;待回读总览
  s8: 进展已核实可见
  [*] --> s0
  s0 --> s1: 按现行标准开工
  s1 --> s2: 发现需要确认的后续动作
  s2 --> s3: 用户选择暂缓
  s2 --> s4: 用户批准本次动作
  s3 --> s2: 继续讨论此事项
  s4 --> s5: 约面动作核实成功
  s4 --> s6: 返回结果不足以判断成功
  s5 --> s7: 用稳定事件身份同步档案
  s6 --> s4: 核实尚未执行#65292;可按有效授权续办
  s6 --> s5: 核实已经成功#65292;避免重复执行
  s7 --> s8: 回读总览#65292;确认事件可达
  class s0 blue
  class s1 blue
  class s2 orange
  class s3 orange
  class s4 blue
  class s5 orange
  class s6 orange
  class s7 blue
  class s8 teal
```

## 约面与部分同步续办

[模型](../models/InterviewFlow.tla) · [配置](../models/InterviewFlow.cfg) · [view](../models/InterviewFlow.view.mjs) · [原始 Mermaid](interview-flow/chart.mmd) · [完整报告](interview-flow/report.md)

TLC reached 22 states and 36 steps. The chart draws 9 states and 11 arrows.
The chart does not draw 13 steps that stay in one chart state.

```mermaid
---
title: "约面流程 日程成功之后仍需核实同步"
---
stateDiagram-v2
  state "Legend" as legend {
    lg0: 完成
    lg1: 待处理
    lg2: 执行
  }
  class lg0 teal
  class lg1 orange
  class lg2 blue
  s0: 核对候选档案与面试要素
  s1: 建日前请用户确认
  s2: 按已确认要素创建日程
  s3: 日程已核实#65292;准备候选人邀约
  s4: 创建结果不明#65292;回查日程
  s5: 分别同步档案排期 台账 进展事件
  s6: 部分同步失败#65292;明确保留缺项
  s7: 三处已同步#65292;回读总览
  s8: 人岗日期时段可达#65292;约面收尾
  [*] --> s0
  s0 --> s1: 核实要素与面试官空闲
  s1 --> s2: 用户确认本次日程
  s2 --> s3: 会议链接及全部面试官已核实
  s2 --> s4: 超时或返回不足以证明创建结果
  s3 --> s5: 默认交付邀约话术#65292;授权代发则核实发送
  s4 --> s2: 核实未创建#65292;按有效授权重试
  s4 --> s3: 回查已创建且要素一致
  s5 --> s6: 报告未完成的同步项
  s6 --> s5: 只补缺项#65292;不重复创建日程
  s5 --> s7: 三处写入分别核实成功
  s7 --> s8: 回读事件及人岗日期时段
  class s0 blue
  class s1 orange
  class s2 blue
  class s3 blue
  class s4 orange
  class s5 blue
  class s6 orange
  class s7 blue
  class s8 teal
```

## 浏览器镜像 修复后熔断检查

[当前模型](../models/Mirror.tla) · [配置](../models/Mirror.cfg) · [view](../models/Mirror.view.mjs) · [当前图](mirror/chart.mmd) · [完整报告](mirror/report.md)

TLC reached 60 states and 300 steps. The chart draws 6 states and 11 arrows.
The chart does not draw 176 steps that stay in one chart state.

四项不变量与无死锁检查均通过。原来的出错路径现在在首条返回后检查到熔断，停止后续写入并等待人工解除。图合并风险来源、盯梢条件及不改变可见状态的守卫步骤；完整模型仍检查全部60个状态。

[修复前历史图](../history/before-mirror-fix/charts/mirror/chart.mmd)及[原始反例报告](../history/before-mirror-fix/charts/mirror/report.md)另行保留。

```mermaid
---
title: "浏览器镜像 异步还原返回后重新核对熔断"
---
stateDiagram-v2
  state "Legend" as legend {
    lg0: 熔断
    lg1: 正常
  }
  class lg0 orange
  class lg1 teal
  s0: 未熔断 可以自动维护
  s1: 首条视口命令等待返回
  s2: 已熔断 自动维护入口被拦截
  s3: 还原命令已发出 等待返回
  s4: 已熔断 首条视口命令仍在途
  s5: 命令发出后才熔断 等待返回
  [*] --> s0
  s0 --> s1: 入口检查后开始视口还原
  s0 --> s2: 观察到风险页
  s1 --> s3: 首条返回 检查通过后发送清除命令
  s1 --> s4: 观察到风险页
  s2 --> s0: 用户处理后显式解除
  s3 --> s0: 清除命令返回
  s3 --> s5: 观察到风险页
  s4 --> s1: 用户处理后显式解除
  s4 --> s2: 首条返回 熔断中止后续还原
  s5 --> s3: 用户处理后显式解除
  s5 --> s2: 清除命令返回
  class s0 teal
  class s1 teal
  class s2 orange
  class s3 teal
  class s4 orange
  class s5 orange
```

## 任务轮次与步骤收尾

[模型](../models/Runs.tla) · [配置](../models/Runs.cfg) · [view](../models/Runs.view.mjs) · [原始 Mermaid](runs/chart.mmd) · [完整报告](runs/report.md)

TLC reached 66 states and 226 steps. The chart draws 5 states and 8 arrows.
The chart does not draw 83 steps that stay in one chart state.

```mermaid
---
title: "本轮结束结果可信 步骤收尾后完成 终态保持不变"
---
stateDiagram-v2
  state "Legend" as legend {
    lg0: 已结束
    lg1: 处理中
  }
  class lg0 teal
  class lg1 blue
  s0: 本轮正在处理
  s1: 本轮失败#65292;记录已冻结
  s2: 本轮取消#65292;记录已冻结
  s3: 本轮暂停#65292;等待确认或外部条件
  s4: 步骤全部收尾#65292;本轮已完成
  [*] --> s0
  s0 --> s1: 本轮失败并冻结记录
  s0 --> s2: 取消本轮并冻结记录
  s0 --> s3: 等待用户或外部条件
  s3 --> s1: 本轮失败并冻结记录
  s3 --> s2: 取消本轮并冻结记录
  s3 --> s0: 继续处理本轮步骤
  s0 --> s4: 所有步骤完成或写明跳过理由#65292;结束本轮
  s3 --> s4: 所有步骤完成或写明跳过理由#65292;结束本轮
  class s0 blue
  class s1 teal
  class s2 teal
  class s3 blue
  class s4 teal
```

## 跨轮事项版本与重放

[模型](../models/Decisions.tla) · [配置](../models/Decisions.cfg) · [view](../models/Decisions.view.mjs) · [原始 Mermaid](decisions/chart.mmd) · [完整报告](decisions/report.md)

TLC reached 7 states and 22 steps. The chart draws 3 states and 2 arrows.
The chart does not draw 18 steps that stay in one chart state.

```mermaid
---
title: "事项依据不被旧版本覆盖 同一请求只登记一次"
---
stateDiagram-v2
  state "Legend" as legend {
    lg0: 依据已登记
    lg1: 等待后续依据
  }
  class lg0 teal
  class lg1 blue
  s0: 事项已登记#65292;等待新增依据
  s1: 已登记一份新依据
  s2: 两份依据均已登记
  [*] --> s0
  s0 --> s1: 版本一致#65292;登记一份新依据
  s1 --> s2: 版本一致#65292;登记一份新依据
  class s0 blue
  class s1 blue
  class s2 teal
```

## 约面档案事件与完成条件

[模型](../models/Events.tla) · [配置](../models/Events.cfg) · [view](../models/Events.view.mjs) · [原始 Mermaid](events/chart.mmd) · [完整报告](events/report.md)

TLC reached 60 states and 420 steps. The chart draws 7 states and 9 arrows.
The chart does not draw 356 steps that stay in one chart state.

```mermaid
---
title: "约面任务收尾前 须回读到关联本轮的候选人档案事件"
---
stateDiagram-v2
  state "Legend" as legend {
    lg0: 已完成
    lg1: 核对通过
    lg2: 待核对
  }
  class lg0 teal
  class lg1 blue
  class lg2 orange
  s0: 步骤已收尾#65292;档案事件待补齐
  s1: 档案事件已关联本轮#65292;等待回读
  s2: 回读未找到合格的档案事件
  s3: 已读到本轮候选人的合格档案事件
  s4: 档案核对通过#65292;等待整理完成记录
  s5: 完成记录已生成#65292;等待写入任务
  s6: 本轮已完成#65292;收尾时已核对档案事件
  [*] --> s0
  s0 --> s1: 档案内容发生变化
  s0 --> s2: 回读已关联候选人的档案事件
  s1 --> s0: 档案内容发生变化
  s1 --> s3: 回读已关联候选人的档案事件
  s2 --> s0: 拒绝收尾#65292;补齐或核实后重试
  s3 --> s4: 核对候选人#12289;来源任务和事件有效性
  s2 --> s1: 拒绝收尾#65292;补齐或核实后重试
  s4 --> s5: 整理任务重点与完成记录
  s5 --> s6: 将完成记录写入本轮任务
  class s0 orange
  class s1 orange
  class s2 orange
  class s3 orange
  class s4 blue
  class s5 blue
  class s6 teal
```

## 候选快照与来源降级

[模型](../models/Snapshots.tla) · [配置](../models/Snapshots.cfg) · [view](../models/Snapshots.view.mjs) · [原始 Mermaid](snapshots/chart.mmd) · [完整报告](snapshots/report.md)

TLC reached 195 states and 268 steps. The chart draws 8 states and 7 arrows.
The chart does not draw 76 steps that stay in one chart state.

```mermaid
---
title: "候选快照保留可信视图"
---
stateDiagram-v2
  state "Legend" as legend {
    lg0: 来源待恢复
    lg1: 可核对
  }
  class lg0 orange
  class lg1 blue
  s0: 开始读取候选台账
  s1: 台账读取结束#65292;等待岗位表
  s2: 岗位表读取结束#65292;等待兼容配置
  s3: 来源已读取#65292;等待生成候选投影
  s4: 整套沿用最后可信视图并标陈旧
  s5: 台账有效#65292;确认为零人
  s6: 按本次可用来源展示候选
  s7: 台账不可读#65292;人数明确未知
  [*] --> s0
  s0 --> s1: 独立读取候选台账
  s1 --> s2: 独立读取正式岗位表
  s2 --> s3: 独立读取兼容配置
  s3 --> s4: 核对来源并生成完整视图
  s3 --> s5: 核对来源并生成完整视图
  s3 --> s7: 核对来源并生成完整视图
  s3 --> s6: 核对来源并生成完整视图
  class s0 blue
  class s1 blue
  class s2 blue
  class s3 blue
  class s4 orange
  class s5 blue
  class s6 blue
  class s7 orange
```

## 候选资料保存与导入

[模型](../models/Materials.tla) · [配置](../models/Materials.cfg) · [view](../models/Materials.view.mjs) · [原始 Mermaid](materials/chart.mmd) · [完整报告](materials/report.md)

TLC reached 38 states and 51 steps. The chart draws 10 states and 14 arrows.
The chart does not draw 16 steps that stay in one chart state.

```mermaid
---
title: "候选资料清单拒绝旧版本覆盖"
---
stateDiagram-v2
  state "Legend" as legend {
    lg0: 可读取
    lg1: 持有资料写锁
  }
  class lg0 blue
  class lg1 orange
  s0: 两份请求使用同一清单版本
  s1: 已取得资料写锁#65292;核对清单版本
  s2: 版本一致#65292;准备关联资料
  s3: 清单已复核#65292;等待原子替换
  s4: 原件已归档#65292;清单尚未提交
  s5: 导入已中断 原件保留 清单未提交
  s6: 新清单已保存#65292;等待释放写锁
  s7: 另一份同版请求待处理
  s8: 本轮资料请求均已结束
  s9: 旧请求已拒绝#65292;等待释放写锁
  [*] --> s0
  s0 --> s1: 取得资料写锁
  s1 --> s2: 核对请求版本
  s2 --> s3: 保存前复核清单
  s2 --> s4: 单独发布归档原件
  s3 --> s6: 原子替换资料清单
  s4 --> s5: 导入中断#65292;允许留下未关联原件
  s4 --> s3: 保存前复核清单
  s5 --> s7: 释放资料写锁
  s6 --> s7: 释放资料写锁
  s5 --> s8: 释放资料写锁
  s7 --> s1: 取得资料写锁
  s6 --> s8: 释放资料写锁
  s1 --> s9: 核对请求版本
  s9 --> s8: 释放资料写锁
  class s0 blue
  class s1 orange
  class s2 orange
  class s3 orange
  class s4 orange
  class s5 orange
  class s6 orange
  class s7 blue
  class s8 blue
  class s9 orange
```

## 岗位配置版本保护

[模型](../models/Roles.tla) · [配置](../models/Roles.cfg) · [view](../models/Roles.view.mjs) · [原始 Mermaid](roles/chart.mmd) · [完整报告](roles/report.md)

TLC reached 54 states and 72 steps. The chart draws 8 states and 9 arrows.
The chart does not draw 24 steps that stay in one chart state.

```mermaid
---
title: "岗位配置防止旧请求覆盖新值"
---
stateDiagram-v2
  state "Legend" as legend {
    lg0: 可读取
    lg1: 持有岗位写锁
  }
  class lg0 blue
  class lg1 orange
  s0: 同一版本的两个岗位保存请求
  s1: 已取得共用写锁#65292;核对配置版本
  s2: 替换内容已准备#65292;保存前再次核对
  s3: 版本匹配#65292;等待原子替换配置
  s4: 新岗位配置已提交#65292;等待释放写锁
  s5: 新配置已保存#65292;旧请求待核对
  s6: 本轮岗位保存请求均已结束
  s7: 旧版本请求已拒绝#65292;等待释放写锁
  [*] --> s0
  s0 --> s1: 取得岗位共用写锁
  s1 --> s2: 核对原始配置版本
  s2 --> s3: 保存前再次核对版本
  s3 --> s4: 原子替换当前配置文件
  s4 --> s5: 释放岗位写锁
  s4 --> s6: 释放岗位写锁
  s5 --> s1: 取得岗位共用写锁
  s1 --> s7: 核对原始配置版本
  s7 --> s6: 释放岗位写锁
  class s0 blue
  class s1 orange
  class s2 orange
  class s3 orange
  class s4 orange
  class s5 blue
  class s6 blue
  class s7 orange
```

## 刷新单飞与过期响应

[模型](../models/Live.tla) · [配置](../models/Live.cfg) · [view](../models/Live.view.mjs) · [原始 Mermaid](live/chart.mmd) · [完整报告](live/report.md)

TLC reached 10 states and 29 steps. The chart draws 6 states and 14 arrows.
The chart does not draw 2 steps that stay in one chart state.

```mermaid
---
title: "看板刷新 单次读取与过期响应隔离"
---
stateDiagram-v2
  state "Legend" as legend {
    lg0: 暂停
    lg1: 等待
    lg2: 读取
  }
  class lg0 tan
  class lg1 orange
  class lg2 blue
  s0: 已暂停
  s1: 正在读取当前工作区
  s2: 已连接#65292;等待下次读取
  s3: 已暂停#65292;等待旧读取结束
  s4: 旧读取失效#65292;新读取排队
  s5: 读取超时#65292;等待请求结束
  [*] --> s0
  s0 --> s1: 恢复查看
  s1 --> s2: 读取失败#65292;保留原快照 or 交付新快照
  s1 --> s3: 暂停查看
  s1 --> s4: 保存后请求刷新
  s1 --> s5: 本轮读取超时
  s2 --> s0: 暂停查看
  s2 --> s1: 开始下一次读取
  s3 --> s0: 旧读取结束#65292;不交付响应
  s3 --> s4: 恢复查看
  s4 --> s1: 旧读取结束#65292;开始排队的新读取
  s4 --> s3: 暂停查看
  s5 --> s2: 丢弃过期结果#65292;等待重试
  s5 --> s3: 暂停查看
  s5 --> s4: 保存后请求刷新
  class s0 tan
  class s1 blue
  class s3 tan
  class s4 orange
  class s5 orange
```
