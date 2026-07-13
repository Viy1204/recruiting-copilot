# AGENTS.md —— recruiting-copilot 模板仓库

> 你（AI agent，无论是 Claude Code、Codex、workbuddy、qoderwork、MiniMax Code、Z code 还是其他工具）
> 现在打开的是 **recruiting-copilot 的模板仓库**，不是用户的招聘工作区。
> 这个仓库的唯一用途：帮用户**初始化一个属于他自己的招聘工作区**。

## 用户在这个仓库里说任何话，几乎都意味着一件事

用户说"帮我初始化"、"开始"、"怎么用"、"帮我搭招聘环境"，或任何表达开始意图的话 →
**读取并严格执行 [`skills/recruit-init/SKILL.md`](skills/recruit-init/SKILL.md)**：
检查前置依赖 → 在用户指定的位置创建招聘工作区（本仓库 `skills/` 会被拷进去）→ 逐岗梳理要求。

初始化完成后，用户的日常招聘工作在**他自己的工作区目录**里进行（那里有自己的 AGENTS.md 做路由），
不再需要回到本仓库。

## 本仓库结构

```
skills/recruit-init/     初始化流程 + 工作区脚手架模板（templates/）
skills/recruit-grill/    逐岗逼问式梳理岗位真实要求（+ 问题清单）
skills/recruit-daily/    每日招聘流水线（+ 双通道命令参考、台账日报格式）
.claude-plugin/          Claude Code 插件清单（其他工具忽略即可）
commands/                Claude Code slash 命令薄壳（其他工具忽略即可）
```

## 红线（对所有 agent 生效）

- 本仓库是**模板**：不要把用户的岗位数据、候选人信息写进本仓库，全部写进用户自己的工作区。
- 对外不可逆动作（在招聘平台打招呼、点"不合适"、约面试、发 offer）的安全规则见
  `skills/recruit-daily/SKILL.md`——默认先经用户确认。
