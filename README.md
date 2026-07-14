# recruiting-copilot —— AI 招聘副驾

给 HR / 猎头用的一套 AI 招聘工作流：**逼问式梳理岗位真实要求 → 每日 Boss直聘 + 猎聘双通道寻源初筛 → 打招呼 → 约面试 → 候选人台账 → 日报**，外加市场人才盘点和平台外简历评估。

配合任意 AI 编程助手使用：Claude Code、Codex、workbuddy、qoderwork、MiniMax Code、Z code 等——
只要你的工具能读工作区里的 `AGENTS.md`，就能跑这套流程。

## 它帮你做什么

- **岗位梳理**：一次一问的访谈，把"我要一个厉害的 XX"逼问成可执行的初筛标准——硬门槛、命脉技能、排除信号、目标公司、搜索词。产出对外 JD 和对内寻源笔记。
- **每日招聘**：一句"处理今天的招聘"，AI 自动查两平台未读、按你的标准主动搜人、初筛、（经你确认后）打招呼、补台账、出日报。
- **市场盘点**：某个岗好不好招心里没底？一次深度调研讲清市场供给、薪资水位、目标公司的人能不能挖，附可推进名单。
- **简历评估**：猎头推的、内推的、直投的简历，丢给 AI 按同一套标准评，评完进同一本台账。
- **约面试**：查面试官忙闲、建带视频会议链接的日历日程、拉面试官进会、生成候选人邀约话术，面试档案自动同步。
- **越用越准**：每轮从命中的真实简历反向提取搜索词，回填关键词迭代表，下一轮搜索更准。
- **安全红线**：对外不可逆动作（打招呼、点"不合适"、通知候选人）默认先经你确认，绝不自动拒人。

## 前置条件（所有工具通用）

1. [Node.js](https://nodejs.org) ≥ 20，本机装有 Chrome 或 Edge
2. 在下方“安装与使用”步骤中运行依赖安装脚本。脚本默认安装
   [`Viy1204/boss-cli`](https://github.com/Viy1204/boss-cli) 维护版，
   因为它包含当前 Boss 前端的兼容与安全基线更新。macOS 上如果 npm 全局命令
   不在 `PATH`，脚本会自动、可重复地更新当前 shell 的配置文件
   （zsh 为 `~/.zprofile`，bash 为 `~/.bash_profile`）。
3. 各扫码登录一次（登录态持久化）：
   ```bash
   boss login
   liepin login
   ```
4. **可选**：飞书用户装 lark-cli 并配置凭证 → 日报出飞书云文档、约面试直接建日历日程和视频会议；
   不装则日报输出本地 Markdown、约面试给你一份手动建会清单，其余功能不受影响。

## 安装与使用

### 方式一：通用（Codex / workbuddy / qoderwork / MiniMax Code / Z code / 任何 agent 工具）

```bash
git clone <本仓库地址>
cd recruiting-copilot
sh skills/recruit-init/scripts/install-dependencies.sh
```

用你的 AI 工具打开这个目录，说：**"帮我初始化招聘工作区"**。
AI 会检查依赖、在你指定的位置建好工作区、注册各工具能识别的项目级 skill，
然后逐个岗位跟你梳理招聘要求。

> 补充：支持 `~/.agents/skills` 约定的工具，也可以用 `npx skills add Viy1204/recruiting-copilot`
> 把这套 skill 装成全局。不装也没关系——工作区里已经带了一份。

之后每天：用 AI 工具打开**你自己的工作区目录**，说 **"处理今天的招聘"**。
任何时候不确定该干什么，说一句 **"这套工具怎么用"**，AI 会按总目录带你走。

### 方式二：Claude Code 插件（额外获得 slash 命令与自动触发）

```
claude plugin marketplace add <本仓库地址>
claude plugin install recruiting-copilot
```

然后：
- `/recruit-init` —— 初始化工作区（首次一次）
- `/recruit-grill <岗位>` —— 梳理某个岗位的要求
- `/recruit-daily` —— 处理今天的招聘（日常也可直接说"处理今天的招聘"）
- `/recruit-mapping <岗位>` —— 深度盘点某岗的市场人才
- `/resume-review` —— 评估猎头/内推/直投送来的简历
- `/interview-schedule` —— 约面试：日历+视频会议+拉面试官，档案台账同步
- `/ask-viy` —— 不知道该用哪个？问它

## 工作区长什么样

初始化后你会得到一个自足的招聘工作区（换任何 AI 工具打开都能接着干活）：

```
你的工作区/
├── CONTEXT.md            ← 唯一事实源：初筛硬规则、在招岗位与优先级、术语表、决策记录
├── AGENTS.md             ← 告诉 AI 工具在这里怎么干活（路由 + 红线）
├── skills/               ← 工作流文档的唯一内容源（随工作区走）
├── .agents/skills/       ← Codex / Agent Skills 项目级自动发现入口
├── .claude/skills/       ← Claude Code 项目级自动发现入口
├── .qoder/skills/        ← Qoder 项目级自动发现入口
├── 01-jd/                ← 对外 JD + _internal/ 对内寻源笔记（不外发）
├── 02-sourcing/          ← dedup-ledger.csv 候选人台账（唯一事实源）+ shortlist
├── 03-interview/         ← 面试档案（一人一文件）
├── 04-offer/  05-onboarding/
├── _shared/templates/    ← 新岗位/新面试的模板
└── runtime/reports/      ← 每日原始素材与本地日报（可删可重建）
```

三个隐藏目录里只有指向 `skills/` 的链接，不会复制出三套内容。其他工具即使没有自己的
skill 注册目录，也能从根目录 `AGENTS.md` 路由到同一套流程。ZCode 可直接读取
`AGENTS.md`；若希望技能出现在 ZCode 面板中，可在 Settings → Skills 中从 Codex 或
Claude Code 来源导入到当前 Project。

## 设计原则（为什么长这样）

- **本地文件是唯一事实源**：台账、JD、面试档案都是你目录里的纯文本，AI 换了、工具换了，数据都在。
- **标准与执行分离**：筛选标准全在 `CONTEXT.md`（你的），工作流文档不写死任何数字（通用的）——改标准改一处。
- **对内对外分离**：寻源策略、排除信号、薪资带宽在 `_internal/` 不外发；对外 JD 干净可直接发布。
- **不可逆动作必经确认**：AI 可以帮你筛一千份简历，但拒绝一个人、联系一个人，默认由你拍板。
