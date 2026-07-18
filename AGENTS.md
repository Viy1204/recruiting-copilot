# AGENTS.md —— recruiting-copilot 源码/模板仓库

> 你（AI agent，无论是 Claude Code、Codex、workbuddy、qoderwork、MiniMax Code、Z code 还是其他工具）
> 现在打开的是 **recruiting-copilot 源码/模板仓库**，不是用户的招聘工作区。
> 它同时是 Claude Code 插件源、跨 Agent Skill 内容源和工作区脚手架；用户的岗位和候选人数据不得写入本仓库。

## 先判断是使用还是维护

用户说"帮我初始化"、"开始"、"怎么用"、"帮我搭招聘环境"，或任何表达开始意图的话 →
**读取并严格执行 [`skills/recruit-init/SKILL.md`](skills/recruit-init/SKILL.md)**：
检查前置依赖 → 在用户指定的位置创建招聘工作区 → 注册项目级 Skill 入口 → 逐岗梳理要求。

用户要求修改 Skill、修脚本、更新文档、测试或发布本项目 → 这是**仓库维护**，直接在功能分支工作；不要误跑 `recruit-init`，不要创建用户工作区。

初始化完成后，用户的日常招聘工作在**他自己的工作区目录**里进行（那里有自己的 AGENTS.md 做路由），
不再需要回到本仓库。

## 本仓库结构

```
skills/recruit-init/           初始化流程 + 工作区脚手架模板（templates/）
skills/recruit-grill/          逐岗逼问式梳理岗位真实要求（+ 问题清单）
skills/recruit-daily/          每日招聘流水线（+ 双通道命令参考、台账日报格式）
skills/market-talent-mapping/  某岗市场人才深度盘点（+ 渠道与统计参考、报告模板）
skills/resume-review/          本地/飞书邮箱简历收取与评估（单份或批量）
skills/interview-schedule/     面试预约：飞书日程+视频会议+拉面试官+档案同步
skills/ask-viy/                总目录：不知道用哪个流程时问它
docs/DESIGN.md                 设计思路与理念（为什么长这样）
.claude-plugin/                Claude Code 插件清单（其他工具忽略即可）
commands/                      Claude Code slash 命令薄壳（其他工具忽略即可）
tests/                         安装与工作区 Skill 注册回归测试
```

## 红线（对所有 agent 生效）

- 本仓库是**模板**：不要把用户的岗位数据、候选人信息写进本仓库，全部写进用户自己的工作区。
- 对外不可逆动作（在招聘平台打招呼、点"不合适"、通知候选人、发 offer）默认先经用户确认。
  打招呼的安全规则见 `skills/recruit-daily/SKILL.md`，约面试的确认规则见
  `skills/interview-schedule/SKILL.md`。
