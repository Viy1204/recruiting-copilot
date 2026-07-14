---
name: recruit-init
description: >
  初始化招聘工作区：检查 boss-cli / liepin-cli / lark-cli 前置依赖，创建标准目录骨架
  （CONTEXT.md 事实源 + AGENTS.md 协作约定 + 01-jd~05-onboarding 漏斗目录 + 台账），
  把工作流文档拷进工作区，然后逐个岗位启动 /recruit-grill 梳理真实岗位要求。
  当用户说"初始化招聘工作区"、"帮我搭招聘环境"、"第一次用这套招聘工具"时使用。
disable-model-invocation: true
---

# recruit-init —— 初始化招聘工作区

首次使用时跑一次。目标：搭好一个「任何 AI 工具打开都能直接干活」的招聘工作区。

## Step 1 前置依赖检查

依次检查，缺什么引导装什么，装不上也**不阻塞建仓**（记入收尾提醒）：

1. `node --version` —— 需要 Node ≥ 20。没有 → 引导去 https://nodejs.org 装 LTS。
2. `boss --version` —— Boss 直聘 CLI。没有 → `npm install -g @joohw/boss-cli`。
3. `liepin --version` —— 猎聘 CLI。没有 → `npm install -g @viyzhu/liepin-cli`。
4. 本机装有 Chrome 或 Edge（两个 CLI 都靠它驱动真实浏览器）。
5. **可选**：`lark-cli --version` —— 有且已配置飞书应用凭证 → 日报出飞书云文档；
   没有 → 明确告知用户"日报将输出本地 Markdown 到 runtime/reports/，功能不受影响"。**不要求用户必须装。**

装好 CLI 后提醒用户各跑一次 `boss login` 和 `liepin login`（扫码登录，登录态持久化）。
如果用户此刻登录不了（比如手机不在身边），记入收尾提醒，继续建仓。

## Step 2 创建工作区骨架

**先探查，再动手**：问用户工作区放哪（推荐一个独立文件夹，如 `~/recruiting` 或桌面某目录），
看一眼目标位置——如果已存在 `CONTEXT.md` 或台账，说明是已有工作区，进入**修复模式**：
只补缺失的文件和目录，**绝不覆盖**已有的 CONTEXT/台账/JD，逐项报告补了什么。全新目录才走完整创建：

```
<workspace>/
├── AGENTS.md                 ← 从本 skill 的 templates/AGENTS.md 复制
├── CONTEXT.md                ← 从 templates/CONTEXT.md 复制
├── skills/                   ← 把模板仓库 skills/ 下除 recruit-init 外的目录全部拷入
│                                （recruit-grill / recruit-daily / market-talent-mapping /
│                                resume-review / interview-schedule / ask-viy，含 references/），
│                                工作区从此自足
├── 01-jd/
│   ├── _internal/            ← 对内笔记（不外发）
│   └── _dist/                ← 生成物（PDF/HTML 等）
├── 02-sourcing/
│   ├── dedup-ledger.csv      ← 从 templates/dedup-ledger.csv 复制（只有表头）
│   └── candidate-pool.md     ← 从 templates/candidate-pool.md 复制
├── 03-interview/
├── 04-offer/
├── 05-onboarding/
├── _shared/templates/        ← 复制 jd-internal.md / interview-record.md /
│                                candidate-pool.md / dedup-ledger.csv 四个模板
└── runtime/reports/          ← 每日原始素材与本地日报
```

要点：
- `AGENTS.md` / `CONTEXT.md` 原样复制模板，**不要现场即兴改写结构**——两份文件的分区是后续工作流的接口。
- 如果用户的工具是 Claude Code，可以额外把 `skills/` 同步一份到 `<workspace>/.claude/skills/`（获得自动触发）；其他工具靠 `AGENTS.md` 路由即可，不用做。

## Step 3 逐岗梳理

问用户当前在招几个岗位、分别叫什么，写进 `CONTEXT.md`「在招岗位与优先级」表（状态先标"待梳理"）。

然后**逐个岗位**走 `skills/recruit-grill/SKILL.md` 的流程（一次只梳理一个岗位，梳理完一个再下一个）。
用户如果说"今天先梳理一个，其他改天"，尊重——CONTEXT 里留着"待梳理"状态即可。

## Step 4 收尾

**假设用户不懂技术术语**：解释文件用途时说人话——CONTEXT.md 是"你的招聘标准手册，AI 每次干活前必读"，
台账是"所有候选人的总名单，防止重复联系"，不要说"事实源""幂等"这类词。

汇报三件事：
1. 建了什么（目录树 + 两个核心文件的作用一句话）；
2. 还欠什么（未装的 CLI、未登录的账号、未梳理的岗位）；
3. 怎么用：**以后每天打开这个工作区，说"处理今天的招聘"即可**（工作流见 `skills/recruit-daily/SKILL.md`）。
