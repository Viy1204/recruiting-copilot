# recruit-grill 批量访谈验证

日期：2026-11-04

## 修改依据

- 当前流程把“一次只问一个问题”和“按七组顺序走”写成强制要求，问题参考包含 20 个连续编号问题。
- 已通过 GitHub API 核对 Matt Pocock 当前源码：[grill-me](https://github.com/mattpocock/skills/blob/4ae2317ddb22b046e26455e4f9c9b3aaaf62212d/skills/productivity/grill-me/SKILL.md) 是入口，转到 [grilling](https://github.com/mattpocock/skills/blob/4ae2317ddb22b046e26455e4f9c9b3aaaf62212d/skills/productivity/grilling/SKILL.md)。后者要求每轮一起问前提已满足的决策，收到答复再展开依赖问题。
- 所查主分支为 `4ae2317ddb22b046e26455e4f9c9b3aaaf62212d`；grilling 文件最近修改为 `7739eaed7f8f3915437a8def198a6d0d7206dbc7`（2026-10-29）。

## 本次范围

主技能与问题参考改为按缺口分轮批量提问，已确认标准直接复用；寻源公司、搜索词和渠道由 AI 先拟为待验证假设；用户要求先出稿时停止追问；关键标准未确认不进入生效硬规则或宣告可正式初筛。

同步更新 `commands/recruit-grill.md`、`skills/ask-viy/SKILL.md`、README、DESIGN 和看板进度映射的相关说明。原有跨轮事项与看板改动保留，未修改运行时代码、用户招聘数据或安装副本。

## 静态检查

- `quick_validate.py`：recruit-grill 与 ask-viy 均通过。
- 主技能、问题参考、目录技能共 6 个相对 Markdown 引用均可解析。
- 当前入口与说明已无“一次一问”“一次只问一个”“按顺序走”“半小时”等旧要求。
- 相关文件 `git diff --check` 通过；Git 提示两份文件未来检出时可能转换为 CRLF，无差异格式错误。

## 环境限制

技能注册回归最初在 Windows Git Bash 未通过：默认模式生成的路径不被识别为符号链接，报告 `FAIL: missing link`；指定 `MSYS=winsymlinks:nativestrict` 复核后，`ln -s` 报 `Operation not permitted`。2026-11-04 后续已在现有 WSL Ubuntu 中重跑安装器与工作区注册回归，均通过；未修改注册脚本或提高权限。

## 对话场景

使用两个虚构场景，分别对当前修改版和修改前快照进行独立执行；各执行一次。看板和招聘资料写入均为模拟，只验证提问、草稿与拟更新行为，不代表实际招聘工作区全链路验收，也不据执行耗时宣称提速。

| 场景 | 修改前快照 | 修改版 | 判定 |
|---|---|---|---|
| 新岗位，方向和约束未定 | 先铺七组完整事项，实际只问 Q1 | 同时问岗位方向、汇报定位、工作方式和预算四题 | 批量提问生效，依赖方向的能力判断留后 |
| 同一场景下一轮只答部分，并要求先出稿 | 停止追问，给草稿 | 停止追问，给草稿，并区分事实、建议与待定 | 两版均守住未确认标准不生效的边界 |
| 已在招岗位只改每周远程两天 | 直接增量更新拟议范围 | 直接增量更新拟议范围 | 两版均不重启访谈、不扩展到其他岗位 |

新岗位场景修改版通过 6 项检查、旧版通过 5 项；增量修改两版均通过 4 项。差异集中在批量提问，不以多数两版均通过的检查夸大改进。每场景每版本仅一次，未测重复运行稳定性、真实访谈总轮数或耗时。

新旧对话输出与逐项证据由 skill-creator 原有查看器生成，保留在本地验收材料中。场景输入、旧版快照、逐轮输出和执行记录保存在 `.audit/recruit-grill-20261104/`（不进入发行包）。

## 工作区同步与 PR

2026-11-04 用户授权同步已有工作区，随后明确改为先发 PR、暂不发版。

- 日常工作区四套入口（skills、.claude/skills、.agents/skills、.qoder/skills）共更新 16 个文件，二次检查剩余差异为 0。保留已有看板联动与目录技能中的定制说明。
- 同步前取得原有共用锁；228 个业务、配置与规则文件同步前后哈希一致，16 份原件备份及安装后哈希验证通过，维护锁已释放。
- 备份位于日常工作区 `runtime/recruit-board/deployments/2026-11-04T08-40-30.744Z-grill-batching/`，含 `previous/`、`manifest.json`、`result.json`。未写招聘业务数据、未联系候选人。
- 独立主线副本完整回归 135 项通过；撤回版本号修改后，版本一致性测试 2 项通过。安装器和注册器在 WSL Ubuntu 通过，24 处本地文档引用与差异格式检查通过。
- 已推送 `feat/grill-batched-questions`，提交 `743270822d638189b50b30aa27320072fead970e`，创建 [PR 53](https://github.com/Viy1204/recruiting-copilot/pull/53)。只含本次 8 个文件；原工作分支及既有未提交改动保持原样。
- 版本保持 0.8.0，未打新标签、未合并、未创建 Release。创建 PR 后应用尚未显示 CI 结果，不将本地测试通过等同于远端 CI 通过。
