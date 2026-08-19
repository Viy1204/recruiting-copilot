# recruiting-copilot —— AI 招聘副驾

给 HR / 猎头用的一套 AI 招聘工作流：**逼问式梳理岗位真实要求 → Boss直聘 + 猎聘双通道每日寻源初筛 → 打招呼 → 约面试 → 候选人台账 → 日报**。
另有市场人才盘点、简历评估，以及从飞书邮箱按需收取猎聘 / BOSS 的简历附件。

配合任意 AI 编程助手使用：Claude Code、Codex、workbuddy、qoderwork、MiniMax Code、Z code 等——
只要你的工具能读工作区里的 `AGENTS.md`，就能跑这套流程。

> ### ⚠️ 账号安全须知（2026-08-19 更新，务必读）
>
> **两条规则：不要开无头模式；日常招聘动作走 CLI 命令，别在「招聘浏览器」面板里手动点操作。**
>
> **关于无头**：浏览器现在**默认有头**（真窗口，启动时会抢一次键盘焦点）。2026-08-19 之前
> 默认是无头，已改回来——一个账号被 BOSS **限制 web 端登录 24 小时**，页面文案写明「检测到
> 您的账号存在使用第三方招聘管理系统、插件、外挂、软件等辅助工具」；另一个团队用上游版
> （默认有头）长期无事，他们的 AI 擅自改走无头之后当天封号。无头 Chrome 的 UA 自报
> `HeadlessChrome`，而 Client Hints 仍说 `Google Chrome`，这个自相矛盾是零误报的信号。
> **别设 `RECRUIT_BROWSER_HIDDEN=true`**，抢焦点是体验问题，被限 web 端登录是业务问题。
>
> 顺便：被限期间**只有 web 端受限**，BOSS直聘 APP 和 PC 客户端照常能用，不必停工。
>
> 原因：boss-cli 的反检测保护（拦风控 SDK、把上报端点用 204 假装成功、注入页面守卫等四层）
> 全部挂在 **CLI 进程自己的 CDP session** 上，**进程一退出就全部失效**。已实测确认。所以浏览器
> 跨命令常驻期间是完全裸奔的，面板操作和面板发起的导航都在这个裸奔时段里，不受任何保护。
>
> 同一个测试账号在 2026-08-18 被限制两次：一次是排查时并挂第二个 host 加反复切贴合（页面秒级
> 反复 resize），限制几小时；一次是点面板的**有头/无头切换**（同一会话内 UA 在 `HeadlessChrome`
> 与 `Chrome` 之间突变），**限制 24 小时**。
>
> 本版本已做的加固：
>
> - **摘掉有头/无头切换按钮**——默认已经是有头，正常不需要切模式；同一会话内切模式会造成
>   UA 突变，那正是第二次被限的原因。
> - **面板默认折叠、默认只读**，且折叠状态持久化。展开会让 host 持续订阅画面并开启崩溃自愈；
>   要手动操作需按工具栏 🔒 显式打开。
> - **风控页熔断**：一旦页面落到 403 / verify / security-check，host 立刻停掉自愈重启、停掉
>   贴合重发、拒绝一切导航与启动，面板顶部显示红色提示条，需人工确认后才解除。
>   （被限期间继续访问会把恢复时间一路延长。）
>
> 如果你之前装过旧版本并在面板里手动操作过，建议 `git pull` 更新后重启 DSH 会话。
> 细节与后续计划见 [#33](https://github.com/Viy1204/recruiting-copilot/issues/33)。

## 它帮你做什么

- **岗位梳理**：一次一问的访谈，把「我要一个厉害的 XX」问成一份可执行的初筛标准——硬门槛、命脉技能、排除信号、目标公司、搜索词。同时产出对外 JD 与对内寻源笔记。
- **每日招聘**：说一句「处理今天的招聘」，AI 就去查两个平台的未读、按你的标准主动搜人、初筛、经你确认后打招呼，然后补台账、出日报。
- **市场盘点**：某个岗到底好不好招？一次深度调研说清市场供给、薪资水位、目标公司的人挖不挖得动，并附可推进名单。
- **简历收取与评估**：直接丢本地简历，或让 AI 去飞书邮箱翻近期的猎聘 / BOSS 简历邮件，去重下载附件后走同一套 review、台账与面试档案流程。
- **约面试**：查面试官忙闲、建带视频会议链接的日历日程、拉面试官进会、生成候选人邀约话术，面试档案自动同步。
- **越用越准**：每轮从命中的真实简历反向提取搜索词，回填关键词迭代表，下一轮搜索更准。
- **安全红线**：对外不可逆的动作（打招呼、点「不合适」、通知候选人）默认先经你确认，绝不自动拒人。

## 前置条件（所有工具通用）

1. [Node.js](https://nodejs.org) ≥ 20，本机装有 Chrome。
2. 运行下方「安装与使用」里的依赖安装脚本。脚本装的 Boss CLI 是
   [`Viy1204/boss-cli`](https://github.com/Viy1204/boss-cli) 维护版——它跟着 Boss 前端改版走，
   带着当前的兼容与安全基线。macOS 上如果 npm 全局命令不在 `PATH`，脚本会幂等地改一次当前
   shell 的配置文件（zsh 写 `~/.zprofile`，bash 写 `~/.bash_profile`）。
3. 两个平台各扫码登录一次（登录态存在浏览器的 user-data-dir 里，一次能管很久）：
   ```bash
   boss login
   liepin login
   ```
   两个 CLI 平时跑的都是无头浏览器，但 `login` 会自动换成可见窗口给你扫码——
   端口上已有无头实例时也会先关掉再以有头拉起，登录态不会丢。
4. **可选**：飞书用户装 lark-cli 并配置凭证 → 日报出飞书云文档、约面试直接建日历日程和视频会议，
   还能从飞书邮箱收取猎聘 / BOSS 简历附件；不装则日报输出本地 Markdown、约面试给你一份手动建会清单、
   简历需本地提供。寻源、本地简历 review 和台账功能都不受影响。

## 安装与使用

### 方式一：通用（Codex / workbuddy / qoderwork / MiniMax Code / Z code / 任何 agent 工具）

```bash
git clone <本仓库地址>
cd recruiting-copilot
sh skills/recruit-init/scripts/install-dependencies.sh
```

用你的 AI 工具打开这个目录，说：**「帮我初始化招聘工作区」**。
AI 会检查依赖、在你指定的位置建好工作区、注册各工具认得的项目级 skill，
然后逐个岗位跟你梳理招聘要求。

> 补充：用 `~/.agents/skills` 约定的工具，也可以 `npx skills add Viy1204/recruiting-copilot`
> 把这套 skill 装成全局。不装也没关系——工作区里已经带了一份。

之后每天：用 AI 工具打开**你自己的工作区目录**，说 **「处理今天的招聘」**。
任何时候不确定该干什么，说一句 **「这套工具怎么用」**，AI 会按总目录带你走。

### 方式二：Claude Code 插件（额外获得 slash 命令与自动触发）

```
claude plugin marketplace add <本仓库地址>
claude plugin install recruiting-copilot
```

然后：

- `/recruit-init` —— 初始化工作区（首次一次）
- `/recruit-grill <岗位>` —— 梳理某个岗位的要求
- `/recruit-daily` —— 处理今天的招聘（日常也可以直接说「处理今天的招聘」）
- `/recruit-mapping <岗位>` —— 深度盘点某岗的市场人才
- `/resume-review` —— 评估本地简历，或收取飞书邮箱的猎聘 / BOSS 简历附件后评估
- `/interview-schedule` —— 约面试：日历 + 视频会议 + 拉面试官，档案台账同步
- `/ask-viy` —— 不知道该用哪个？问它

### 方式三：DeepSeek Harness 插件（任意工作区都能用这套招聘 skill）

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（`dsh`）用户，
在任意目录执行：

```bash
dsh plugin --profile web add git+https://github.com/Viy1204/recruiting-copilot.git
```

（`web` 是 Web 界面 profile；`headless` 等其他 profile 同理，把 `web` 换成名字即可。）

安装后**重启 DSH 会话**，本仓库 `skills/` 下的 7 个 skill 就会出现在任意工作区的
skill 目录里（不必把仓库克隆成工作区）：
`ask-viy`、`recruit-init`、`recruit-grill`、`recruit-daily`、`resume-review`、
`interview-schedule`、`market-talent-mapping`。

**附带功能——Web UI 右侧「招聘浏览器」面板**：DSH Web 界面右侧是一只**能直接上手操作的浏览器**，
鼠标、滚轮、键盘、中文输入法、粘贴全都直通。**BOSS 和猎聘都是可用的源**，面板顶部一键切换；
浏览器没起时在面板里点一下就能拉起——用的是两个 CLI 各自的 user-data-dir 和固定调试端口，
登录态通用，之后跑 `boss` / `liepin` 命令会直连同一只，不会另开一只。

两只浏览器**默认有头**（真窗口，启动时抢一次键盘焦点）。**不要为了不被打扰而改成无头**——
无头的 `HeadlessChrome` UA 已实测招来 web 端登录限制，见开头的安全须知。面板的价值在于
不用切窗口就能看到页面：它默认开着「贴合」，把页面视口固定成按源写死的尺寸
（BOSS `958×1149`、猎聘 `1440×1149`），所以面板里的文字是原生大小，而不是整页缩小后的糊图。

真要无头（清楚这是在拿账号冒险）：设 `RECRUIT_BROWSER_HIDDEN=true`（本插件 / boss-cli /
liepin-cli 三方共读）。端口上已经有实例在跑时改这个变量不生效——那只会被直接复用，
得先 `boss shutdown` / `liepin quit` 关掉它。

面板接管需要 `@viyzhu/boss-cli-fork` ≥ 0.7.0、`@viyzhu/liepin-cli` ≥ 0.2.0：更早的版本要么用随机调试端口，
要么命令跑完就关浏览器，面板连不上。装旧版时面板的空态文案会直接告诉你是版本问题。

更新 / 卸载：

```bash
dsh plugin --profile web update recruiting-copilot   # 拉到最新提交
dsh plugin --profile web remove recruiting-copilot   # 卸载
```

> 原理与本地验证见 [`dsh/README.md`](dsh/README.md)：仓库根 `package.json`
> 声明 `dsh.bundle`，装好后作为 profile 的 patch 层，启用宿主 skill-filesystem
> 并把本仓库 `skills/` 注册为全局自定义 skill 根；同一个包还带 host 插件（CDP 抓帧）
> 与客户端模块（右侧面板）。

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
└── runtime/
    ├── reports/          ← 本地日报与 review 汇总
    └── resumes/          ← 邮件简历附件 + 导入去重索引
```

三个隐藏目录里只放指向 `skills/` 的链接，不会复制出三套内容。其他工具即使没有自己的
skill 注册目录，也能从根目录 `AGENTS.md` 路由到同一套流程。ZCode 可以直接读 `AGENTS.md`；
想让技能出现在 ZCode 面板里，可在 Settings → Skills 中从 Codex 或 Claude Code 来源导入到当前 Project。

## 设计原则（为什么长这样）

- **本地文件是唯一事实源**：台账、JD、面试档案都是你目录里的纯文本。AI 换了、工具换了，数据都还在。
- **标准与执行分离**：筛选标准全在 `CONTEXT.md`（你的），工作流文档不写死任何数字（通用的）——改标准只改一处。
- **对内对外分离**：寻源策略、排除信号、薪资带宽放 `_internal/` 不外发；对外 JD 干净到可以直接发布。
- **不可逆动作必经确认**：AI 可以帮你筛一千份简历，但拒绝一个人、联系一个人，默认由你拍板。
- **邮箱只是输入渠道**：只读收取，不标已读、不移动 / 删除、不回复 / 转发；风险邮件和不可信附件不自动下载。

想了解这些取舍背后的原因，读 [设计思路与理念](docs/DESIGN.md)。

## 绝活日资料包

[绝活日分享资料包](https://bytedance.larkoffice.com/docx/JAbcdCacEoxAbNxEqTjcbBotnUh)
