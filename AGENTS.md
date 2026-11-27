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
skills/recruit-daily/          每日招聘流水线（+ 双通道命令参考、台账日报格式、日报卡片推送）
skills/market-talent-mapping/  某岗市场人才深度盘点（+ 渠道与统计参考、报告模板）
skills/resume-review/          本地/飞书邮箱简历收取与评估（单份或批量）
skills/interview-schedule/     面试预约：飞书日程+视频会议+拉面试官+档案同步
skills/recruit-board/          本地招聘工作台：看板服务、模型、状态同步与前端界面
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

## 仓库维护规则与强制检查

提交维护改动前运行 `npm run check`（本地与 `.github/workflows/test.yml` 共用同一入口；仅跑防呆静态检查可用 `npm run lint:guardrails`）。

| 规则 | 强制检查 / 单点实现 |
|---|---|
| 模板仓库根目录不得写入用户工作区数据（`CONTEXT.md`、`01-jd/`、`02-sourcing/`、`03-interview/`、`_shared/`、`runtime/`） | `scripts/check-repo-guardrails.mjs`（`template-repo-clean-root`） |
| 新建或已迁移的 `recruit-board` 脚本不得手写 `lstat`/`realpath`/`readFile`/`TextDecoder`，统一复用 `workspace-io.mjs` | `skills/recruit-board/scripts/workspace-io.mjs` + `scripts/check-repo-guardrails.mjs`（`no-adhoc-workspace-io`） |
| 禁止私建未登记 `.lock` 文件；工作区写锁共用 `WORKSPACE_LOCK_FILES` 与 `withWorkspaceLock` | `skills/recruit-board/scripts/workspace-io.mjs` + `scripts/check-repo-guardrails.mjs`（`no-rogue-lock-files`） |
| 测试文件禁止直接调用 `symlink()`，必须使用 `tests/helpers/symlink.mjs`（`linkDir` / `tryLinkFile`）以保证 Windows 无特权通过 | `tests/helpers/symlink.mjs` + `scripts/check-repo-guardrails.mjs`（`no-raw-symlink-in-tests`）+ `.github/workflows/test.yml`（`test-windows`） |
| 禁止再手写 `CONTEXT.md` 岗位表解析器，禁止引入已否决的 `_shared/roles.json` 双事实源（ADR 0007） | `skills/recruit-board/model.mjs`（`readRoleTable`/`readRoles`）+ `scripts/check-repo-guardrails.mjs`（`no-duplicate-role-table-parser`、`no-rejected-dual-source`） |
| `docs/adr/` 编号必须从 `0001` 连续递增且不重号；文档与技能内相对 Markdown 链接不得悬空 | `scripts/check-repo-guardrails.mjs`（`adr-sequence-valid`、`markdown-local-links-exist`） |
| `package.json`、`package-lock.json`、`.claude-plugin/plugin.json`、`README.md`、默认 BOSS CLI 与各宿主技能软链保持同步 | `tests/version-sync.test.mjs` + `tests/register-workspace-skills.test.sh` |
| 修改形式化验证受控源码后，须按对应 `.claude/skills/verify-recruit-*/SKILL.md` 复核并跑 `node scripts/verify-state-machines.mjs --mutations`，禁止机械刷哈希 | `scripts/check-repo-guardrails.mjs`（`formal-coverage-sha256-sync`）+ `.github/workflows/formal-verification.yml` |
| 临时例外只能写在违规行，须含原因、到期日与审批人：`// guardrail-allow: <rule> \| reason: <why> \| expires: YYYY-MM-DD \| approved: @<human>` | `scripts/check-repo-guardrails.mjs`（`guardrail-exception-malformed`、`guardrail-exception-expired`） |
| 对外不可逆动作默认先经用户确认 | 人工确认 + 技能流程门禁（判断类，无静态检查） |
