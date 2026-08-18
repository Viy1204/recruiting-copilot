# boss-cli 为什么拦掉 BOSS 的风控 SDK

调研票：[#21](https://github.com/Viy1204/recruiting-copilot/issues/21)　所属地图：[#20](https://github.com/Viy1204/recruiting-copilot/issues/20)

**这份笔记只交事实，不做「拦还是不拦」的决定**（那属于对照实验票 #26）。
每条结论都标了【事实】或【推断】。红线：本调研不涉及「怎么让风控失效」，只回答「当初为什么拦」。

调研对象：`~/boss-cli-repo`（main，fork of `joohw/boss-cli`，发布名 `@viyzhu/boss-cli-fork`）
被调研的代码：`src/common/boss_page_guards.ts:19-23`

```ts
const BLOCKED_SECURITY_SCRIPT_PATTERNS = [
  { urlPattern: '*zhipin-security/web/boss/*', requestStage: 'Request' },
  { urlPattern: '*zhipin-boss*risk-detection*', requestStage: 'Request' },
  { urlPattern: '*bosszhipin.com/static/zhipin/geek/sdk/*', requestStage: 'Request' },
] as const;
```

---

## 摘要

| 问题 | 答案 | 性质 |
|---|---|---|
| 1. 谁加的 | 上游 `joohw/boss-cli`，commit `e435521`，2026-04-27。本 fork 一个字没改过 | 事实 |
| 2. 为解决什么症状 | commit message 没说。但**同一个 commit 附带了 `docs/anti-detection.md`**，动机写在那里：属于「反自动化检测」整体方案的第三层，目的是不让安全模块加载、从而不产生检测与上报。从未有任何 issue/PR 讨论过这三条的增删 | 事实 |
| 3. 三个 SDK 是什么 | ①腾讯云 zpAegis（指纹/WASM/鼠标轨迹）②risk-detection.js（DOM 注入+合成点击完整性检测，6 个 code，只上报不破坏）③geek/sdk 目录（**实测只有 `browser-check-v2.js` 一个 IE 兼容检查**，不含验证码 SDK） | 事实 |
| 4. 去掉最坏会怎样 | **没有找到任何「拦掉是为了避免已知崩溃/卡死」的记录。已知的因果关系是反过来的**：拦掉安全脚本会导致 SPA 自救式 reload，这是本 fork `ea6d854` 必须加熔断的原因之一 | 事实 |

**风险等级：低。** 理由见文末。

---

## 问题 1：这三条 pattern 是 fork 加的还是上游继承的？

【事实】**完全继承自上游，本 fork 从未改动。**

`git blame` 显示 19-23 行五行全部归属同一个 commit：

```
e435521b (joo   2026-04-27 19) const BLOCKED_SECURITY_SCRIPT_PATTERNS = [
e435521b (joo   2026-04-27 20)   { urlPattern: '*zhipin-security/web/boss/*', ... },
e435521b (joo   2026-04-27 21)   { urlPattern: '*zhipin-boss*risk-detection*', ... },
e435521b (joo   2026-04-27 22)   { urlPattern: '*bosszhipin.com/static/zhipin/geek/sdk/*', ... },
e435521b (joo   2026-04-27 23) ] as const;
```

- commit：`e435521b70e3d4384c90a393f02a7fb9588cb9e2`
- 作者：`joo <1546635571@qq.com>`（上游作者，非本 fork）
- 日期：2026-04-27
- `git branch -r --contains e435521` 同时列出 `upstream/main` 和 `origin/main` → 确认是上游提交，fork 只是继承。

【事实】`src/common/boss_page_guards.ts` 全历史只有 3 个 commit：

| commit | 作者 | 说明 |
|---|---|---|
| `e435521` | joo（上游，2026-04-27） | 引入本文件与三条 pattern |
| `f4fdff2` | joo（上游，2026-04-29） | 移除 beforeunload 守卫（v0.3.2），与本议题无关 |
| `ea6d854` | yifan（本 fork，2026-07-27） | 风控页反弹加熔断，**没有动这三条 pattern** |

【事实】`REPORT_REQUEST_PATTERNS`（`:25-32`，日志上报 204 fulfill）**是同一个 commit `e435521` 同时引入的**，紧邻在下面。所以票里的猜测成立：两组 pattern 动机共通，是同一套方案的两半。

---

## 问题 2：引入它的提交 / PR / issue 说了什么？

### 2.1 commit message 没说

【事实】全文如下，没有提到任何症状：

```
feat: 页面防护、CDP 会话与文档（v0.3.0）

- 新增 boss_page_guards 与 boss_session_page 集成
- 重构 cdp_browser、browser_session
- 新增 anti-detection / browser-session 文档与 guard-out 脚本
- 版本号升至 0.3.0

Made-with: Cursor
```

### 2.2 动机在同批提交的文档里

【事实】**动机不在代码注释里，也不在 commit message 里，在同一个 commit 新增的 `docs/anti-detection.md`（712 行）里。** 这是本调研找到的最重要的一手材料，路径 `~/boss-cli-repo/docs/anti-detection.md`，上游公开版本：<https://github.com/joohw/boss-cli/blob/main/docs/anti-detection.md>。

该文档「概述」章节自述目的（原文）：

> Boss 直聘的前端安全体系由多个检测模块组成，在 CDP 控制的浏览器中打开页面时，其安全模块会通过多种手段判断浏览器是否被自动化控制，并在检测到后执行数据上报、关闭/跳转/返回上一页等破坏性操作。

文档 §三「防御措施」把整套方案分三层，这三条 pattern 属于**第三层：网络请求拦截（CDP Fetch.enable）**，该节开头明确写着「位置：`src/common/boss_page_guards.ts`（`installBossPageGuards` → `ensurePageRequestGuard`）」，并把 pattern 原样列出、逐条注明拦的是什么：

```text
*zhipin-security/web/boss/*         → 拦截 aegis_bg.wasm + index.js
*zhipin-boss*risk-detection*        → 拦截 risk-detection.js
*bosszhipin.com/static/zhipin/geek/sdk/* → 拦截 browser-check + 验证码 SDK
```

### 2.3 上游 issue / PR：从未讨论过这三条

【事实】检索了上游仓库全部 issue / PR / discussion（REST API），结论：

- `joohw/boss-cli` 为 public、非 fork、issues 开启，98 star，创建于 2026-03-31，最后 push 2026-07-19。
- `search/issues` 关键词 `security` / `block` / `SDK` 全部 **0 命中**；`risk` 只命中 #9/#10（`boss_availability` 基线机制），`风控` 命中 #7/#10/#11，`拦截` 命中 #1/#10。
- **没有任何一条 issue 或 PR 的标题或正文在讨论「要不要拦 zhipin-security / risk-detection / geek sdk」。**
- 两个仓库均未开启 discussions（`has_discussions: false`）。
- `joohw/boss-cli` 的 README 搜「反检测 / anti-detection / 风控 / 安全 / 拦截」→ **零命中**，README 完全不提这套防御。
- `Viy1204/boss-cli`（本 fork）**关闭了 issues**，所以 fork 侧的 bug 都报到了 `recruiting-copilot` 仓库。

【事实】上游确实存在「页面被主包重载导致命令失败」的症状票，但它指向的是**导航守卫**，不是 SDK 拦截：

- [joohw/boss-cli#1](https://github.com/joohw/boss-cli/issues/1)（open）「Boss 反爬升级（846.js v10194）：所有命令报"登录状态校验失败"，根因是 Boss 主包主动重载页面」。带 CDP 抓包证据，`Network.requestWillBeSent` 的 initiator stack 指向主包自己发起的 Document 导航，导致读不到 `.menu-list`。报告者建议方向是加强 `boss_page_guards` 的 **navigation 守卫**。
- [#3](https://github.com/joohw/boss-cli/issues/3) / [#5](https://github.com/joohw/boss-cli/issues/5)「会不会有封号的风险」：**作者从未回复**；#5 只有第三方用户回复「会的，频繁自动化会限制登陆」。**不存在作者层面关于「封号 ↔ 这三条拦截」的任何正式说明。**

### 2.4 结论

【推断】**动机是「预防性的通用反检测设计」，而不是「修某个具体 bug」。** 依据：
- commit 是一次性引入「文档 + 三层防御 + guard-out 脚本」的成套方案，形态是设计驱动而非 bug 驱动；
- 文档通篇是逆向分析 + 威胁面梳理，没有任何一处写「我们遇到过 X 症状所以加了这条」；
- 三条 pattern 至今零测试覆盖（见 4.6）；
- 上游 issue 区从未讨论过它们的增删。

【事实】**这个动机方向与地图 #20 的红线不一致。** 文档标题就叫「Boss 反自动化检测：防御策略文档」，明确目标是让 CDP 驱动的浏览器不被判定为自动化；而 #20 的红线是「只消除我们自己制造的伪异常信号，**不做让平台识别不出自动化方向的对抗**」。也就是说：这三条拦截是从一个我们已经明确不采纳的目标继承下来的。

---

## 问题 3：这三个 SDK 各自是干什么的？

来源说明：以下全部来自**仓库内已有的记录**——`docs/anti-detection.md` 的逆向分析，以及 `docs/research/boss-online-js/` 下 10 份历史抓取快照（2026-07-01 ~ 07-17，含 `manifest.json` + `analysis.md` + `raw/` 原始脚本）。**本调研未访问 zhipin.com / bosszhipin.com 任何真站 URL。**

### 先看一张实测表：三条 pattern 在 10 份快照里各自命中了什么

把三条 pattern 对每份快照 `manifest.json` 的 `entries` 做 fnmatch 匹配：

| 快照 | 抓到的脚本数 | `zhipin-security/web/boss/*` | `zhipin-boss*risk-detection*` | `bosszhipin.com/.../geek/sdk/*` |
|---|---|---|---|---|
| 2026-07-01 | 22 | 0 | 1 | 0 |
| 2026-07-05 | 46 | 0 | 1 | 1 |
| 2026-07-07 | 46 | 0 | 1 | 1 |
| 2026-07-08 | 46 | 0 | 1 | 1 |
| 2026-07-09 | 46 | 0 | 1 | 1 |
| 2026-07-13 | 46 | 0 | 1 | 1 |
| 2026-07-14 | 47 | 0 | 1 | 1 |
| 2026-07-15 | 47 | 0 | 1 | 1 |
| 2026-07-16 | 13 | 0 | 1 | 1 |
| 2026-07-17 | 47 | 0 | 1 | 1 |

【事实】aegis 那条 **10 份快照 0 命中**；另两条各稳定命中恰好 1 个文件。

### ① `*zhipin-security/web/boss/*` — 腾讯云 zpAegis

【事实】文档 §二.4 记载的文件：

| 文件 | 路径 |
|---|---|
| JS 加载器 | `https://www.zhipin.com/zhipin-security/web/boss/index.js` |
| WASM 模块 | `https://www.zhipin.com/zhipin-security/web/boss/aegis_bg.wasm` |

【事实】文档描述的检测内容：浏览器指纹、WebAssembly 环境检测、系统进程扫描、鼠标轨迹分析、键盘输入节奏分析、剪贴板/粘贴行为检测、简历可见性检测、iframe 可见性检测。

【事实】**上游自己对它的判断留了余地**，原文：

> 此模块更有可能做的是性能检测的行为，与反自动化检测不直接相关。

【事实】它在快照里唯一的踪迹在 `unresolvedScriptUrls`，且是 404：

```
https://static.zhipin.com/zhipin-security/web/boss/index.js: HTTP 404 Not Found
  while fetching ... (from https://static.zhipin.com/zhipin-boss/index/v10753/static/js/613.js)
```

从 v10576 到 v10753 每一版都是同样的 404。

【推断】404 有两种解释，**现有材料不足以区分**：
- (a) 抓取器把相对路径解析到了 `static.zhipin.com`，而真实地址是文档写的 `www.zhipin.com`，所以抓不到；
- (b) 该模块确实已经下线。

无论哪种，**都没有证据表明这条 pattern 目前拦下过任何东西**。要定论需要在登录态下观察一次实际请求（属于对照实验票的范围）。

### ② `*zhipin-boss*risk-detection*` — risk-detection.js

【事实】这是**三条里唯一确认稳定命中真实文件**的 pattern，10 份快照每份恰好命中 1 个：

```
2026-07-01 → https://static.zhipin.com/zhipin-boss/index/v10493/static/js/risk-detection.js
2026-07-09 → .../index/v10641/static/js/risk-detection.js
2026-07-17 → .../index/v10753/static/js/risk-detection.js
```

【事实】文档 §二.3 的定位：webpack 入口模块 `42302`，独立的「DOM 注入 + 全局污染 + 合成点击」完整性检测器。不依赖 console 副作用、不依赖 DevTools 开关，只看页面 DOM/window/click 形态有无被外部改动。

【事实】6 个检测 code 及上游自评的命中情况（原文表格）：

| code | 触发条件 | 我们这侧是否触发（上游自评） |
|---|---|---|
| `99000` | body 动态插入白名单外的 `<script src>` | ❌ 不触发（走 `evaluateOnNewDocument`，不进 DOM） |
| `99001` | body 动态插入 DOM 元素 | ❌ 不触发（只改 prototype 和实例 own property） |
| `99002` | body 动态插入内联 `<script>` | ❌ 不触发 |
| `99003` | `window.onload` 后出现 known-list 外的 window 键名 | ❌ 不触发（守卫脚本全在 IIFE 闭包里） |
| `99004` | `click` 且 `isTrusted === false` **或** `pageX <= 0 && pageY <= 0` | ⚠️ 仅当显式传 `{x:0,y:0}` 才踩 |
| `99005` | 连续 10 次 click 间隔 ≤ 50ms | ⚠️ 批量点击需保留 ≥ 60ms 间隔 |

【事实】文档明确写了它**只上报、不破坏页面**：

> **触发后果**：本模块本身**只上报、不破坏页面**。破坏动作（`window.close` / `history.back` / `location.href` 重写）在 §1（主包反 DevTools 模块）和 §2（Passport 控制逻辑）里。

【事实】完整风险链路（文档 §二.3）：`risk-detection` 上报 → 后端打分 → 下次接口下发 `code: 35/36` 之类 → Passport 触发跳转（403 / 滑块验证页）。

【事实】而且上报通道**已经被另一组 pattern 独立堵住了**，文档原文：

> 即使本模块漏过加载、检测出问题、入队 `h[]` 想发出去，最终调的是 `iBossRoot.sendAction`——而 `sendAction` 内部出网最终落在 `logapi.zhipin.com/dap/api/json` 等域，已被 §三.3 的 CDP 拦截 204 掉，**外层即使触发也无法上报到后端**。

【推断】**拦 risk-detection.js 与 204 掉 logapi 上报，二者是冗余关系。** 按上游自己的分析：6 个 code 有 4 个我们本来就不触发，剩下 2 个可以靠「点击间隔 ≥ 60ms、不传 (0,0) 坐标」在调用侧规避；即便触发，上报也出不去。这条 pattern 提供的增量保护，仅限于「本地检测发生」本身。

### ③ `*bosszhipin.com/static/zhipin/geek/sdk/*` — Boss Geek SDK 目录

【事实】文档 §二.7 声称这个目录下有两类东西：

| 文件 | 状态（文档原话） |
|---|---|
| `browser-check.min.js` | ✅ 已排除（仅 IE 兼容检查） |
| 同目录下其他 SDK 文件（极验、阿里、网易易盾等验证码 SDK） | 🚫 已拦截 |

【事实】**抓取快照不支持后半句。** 该目录在 10 份快照里只出现过一个文件：

```
https://img.bosszhipin.com/static/zhipin/geek/sdk/browser-check-v2.js
```

【事实】验证码 SDK 实际都在**另外的路径**上，pattern 匹配不到：

```
https://static.zhipin.com/assets/zhipin/geek/verify-sdk/verify-sdk-v5.js
https://static.zhipin.com/assets/zhipin/geek/verify-sdk/verify-sdk-v4.2.js?t=20250928
https://static.zhipin.com/assets/zhipin/geek/verify-sdk/verify-sdk-v4.1.js
https://static.zhipin.com/assets/zhipin/geek/verify-sdk/jiyan/gt.0.5.0.js
https://static.zhipin.com/library/js/plugins/gt.js
https://static.zhipin.com/library/js/sdk/verify-sdk-v2.js
```

注意两处差异：域名是 `static.zhipin.com` 不是 `img.bosszhipin.com`，路径段是 `verify-sdk` 不是 `sdk`。

【事实】**上游自己的快照分析也是这么写的**，与 §二.7 的说法互相矛盾。`docs/research/boss-online-js/2026-07-05/analysis.md:129` 原文：

> `src/common/boss_page_guards.ts` already covers the new direct risk script URL via `*zhipin-boss*risk-detection*` and the login **`browser-check-v2.js`** URL via `*bosszhipin.com/static/zhipin/geek/sdk/*`.

即：快照分析认定第三条覆盖的就是 `browser-check-v2.js`，只字未提验证码 SDK。

【事实】仓库里存着 `browser-check-v2.js` 原文（`docs/research/boss-online-js/2026-07-17/raw/static/zhipin/geek/sdk/browser-check-v2.js`，1241 字节）。读其逻辑：取 UA 判断浏览器类型，若是 msie/trident **或** 一段现代 JS 语法（箭头函数 / 模板串 / class / async-await / 解构 / 具名捕获组 / `Promise.prototype.finally`）`new Function` 失败，就跳转到 `/web/common/nonsupport.html`；否则直接 return。Chrome 两个条件都不命中，脚本什么也不做。

【推断】**这条 pattern 实际只拦掉了一个对 Chrome 而言的空操作脚本。**

【推断】**这一点对地图很重要**：既然验证码 SDK 根本不在拦截范围内，那么「因为拦了 SDK 所以面板里做不完滑块验证」这条假设**不成立**。#20 验收线第 1 条（面板内走完滑块验证）的障碍要到别处找——更可能是事实 A 的鼠标轨迹稀疏问题。

---

## 问题 4：去掉之后最坏会发生什么？

### 4.1 有没有「拦掉是为了避免某个已知崩溃/卡死/被踢下线」的硬理由？

【事实】**没有找到。** 检索范围：
- `git log -S` 三条 pattern 字符串（`--all`，含 `upstream/main`）——只找到引入 commit 和后续 baseline 复查 commit，没有任何 bugfix；
- `boss_page_guards.ts` 全部 3 个 commit 的完整 message；
- `docs/anti-detection.md` 全文 712 行；
- 10 份 baseline review 记录；
- 上游 `joohw/boss-cli` 全部 issue / PR（见 2.3）。

没有一处把这三条拦截与某个具体故障关联起来。

### 4.2 已知的因果关系是**反过来的**：拦截本身会制造故障

【事实】这是本调研最硬的一条发现。本 fork 的 commit `ea6d854`（yifan，2026-07-27，"fix: 风控页反弹加熔断，避免一次风控变成无限刷新"）message 原文点名了这个失败模式：

> 阻断只对偶发误伤有效，真风控必须交还给人。因此加熔断：反弹超阈值后停止跳回、放行并展示验证页让人工过验证，命令层抛 `BossPageRiskError` 明确停下；同时覆盖「**安全脚本被拦后 SPA 自刷新**」和「命令启动时已停在验证页」两种进入方式。

【事实】`docs/anti-detection.md` 的熔断表格把它列为一条独立的熔断触发条件：

| 触发条件 | 阈值 | 熔断后行为 |
|---|---|---|
| 风控页反弹 | 60s 内 > 3 次 | 停止跳回；摘掉 `RISK_NAVIGATION_PATTERNS` 放行验证页；导航到验证页交人工 |
| 同一 URL 自刷新 | 15s 内 commit ≥ 5 次 | 不再干预，仅记录状态（覆盖「**安全脚本被拦 → SPA 自救式 reload**」） |
| 命令启动时已停在验证页 | 立即 | 直接熔断，不做任何跳转 |

【事实】对应的用户可见症状记录在 [recruiting-copilot#7](https://github.com/Viy1204/recruiting-copilot/issues/7)（已关闭）："boss-cli 登录 BOSS 后页面持续刷新，无法正常执行 recommend/greet"，环境 `@joohw/boss-cli 0.6.6`，现象含「登录后页面持续自动刷新」与「推荐牛人连续打招呼 10–20 人后页面频闪并停止」。

【推断】所以在「去掉的风险」这一栏，账要反着记一部分：**这三条拦截自身是一个已确认的故障源**，为了兜住它，fork 额外写了一整套熔断机制。去掉拦截，「安全脚本被拦 → SPA 自刷新」这条路径随之消失。

### 4.3 熔断放行验证页时，安全脚本仍然是被拦的

【事实】`relaxRiskNavigationBlocking()`（`boss_page_guards.ts:448-458`）在熔断后重新 `Fetch.enable`，patterns 只去掉了 `RISK_NAVIGATION_PATTERNS`，**`BLOCKED_SECURITY_SCRIPT_PATTERNS` 原样保留**：

```ts
await cdp.send('Fetch.enable', {
  patterns: [...BLOCKED_SECURITY_SCRIPT_PATTERNS, ...REPORT_REQUEST_PATTERNS],
});
```

【推断】也就是说，「把验证页交还给人工」这条逃生通道，是在安全脚本仍被拦的状态下交出去的。结合问题 3 ③ 的发现（验证码 SDK 不在拦截范围内），**这一条目前不构成实际阻碍**，但它说明这套拦截从未按「人要能过验证」这个场景设计过。

### 4.4 拦截本身是不一致的 —— 与地图事实 B 相互印证

【事实】`ensurePageRequestGuard`（`:541-550`）把拦截挂在 CLI 自建的 CDP session 上：

```ts
const cdp = await page.createCDPSession();
cdpSessionByPage.set(page, cdp);
await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });
await cdp.send('Fetch.enable', { patterns: [...BLOCKED_SECURITY_SCRIPT_PATTERNS, ...] });
```

这与 #20 事实 B 一致：拦截随 CLI 命令生命周期存在，命令跑完即消失；人在 DSH 面板里操作时，三个 SDK 正常加载、正常上报。

【推断】**同一个账号因此呈现两种截然不同的前端形态**：跑命令时完全没有安全模块，人工操作时安全模块齐全。这种不一致本身可能比「一直拦」或「一直不拦」都更像异常信号。从这个角度看，去掉拦截是把形态统一到「一直不拦」，反而消除了一个我们自己制造的信号——这正是 #20 终点描述的方向。

### 4.5 去掉之后的真实风险面

【推断】按上面的证据逐条折算：

| pattern | 去掉后新增的实际暴露 | 风险 |
|---|---|---|
| `*zhipin-security/web/boss/*` | 未知。10 份快照 0 命中，可能本来就没在拦东西；若真存在，会恢复指纹 / 鼠标轨迹 / 键盘节奏采集 | **中**，唯一需要实测确认的一条 |
| `*zhipin-boss*risk-detection*` | risk-detection.js 恢复运行。6 个 code 里 4 个我们不触发，2 个可靠调用侧节奏规避；上报仍被 logapi 204 独立堵住 | **低** |
| `*bosszhipin.com/static/zhipin/geek/sdk/*` | 仅 `browser-check-v2.js` 恢复运行，对 Chrome 是空操作 | **极低** |

### 4.6 零测试覆盖

【事实】`ea6d854` 新增了 `tests/boss_page_guards.test.mjs`，但它只测熔断，**对三条 pattern 零断言**（文件内 `zhipin-security` / `BLOCKED_SECURITY` / `geek/sdk` 出现次数为 0）。四个用例是：

```
风险页反弹超过阈值后熔断，不再无限跳回沟通页
同一页面反复自刷新时熔断并给出原因
命令启动时页面已停在验证页则立即熔断
正常沟通页不触发熔断
```

【推断】所以去掉这三条不会让任何测试变红——**反过来说，也没有任何测试能在去掉后替我们发现回归**。这对 #26 的实验设计有直接影响：判据必须来自真站观测，不能指望测试。

### 4.7 一条常驻运维负担（顺带记录）

【事实】这三条 pattern 是**每次 Boss 前端发版都要人工复核的常驻防线**。`docs/research/boss-online-js/*/analysis.md` 的 Recommendation 一节反复出现同一句：

> Re-check `src/common/boss_page_guards.ts` request patterns against any new risk, security, or reporting script URLs.

（出现在 07-05 / 07-07 / 07-08 / 07-09 / 07-13 / 07-14 等多份快照中。）

【推断】即去掉它们除了改变风险面，还会减掉一项每次发版的人工复核成本。

---

## 风险等级结论

**低。** 三条理由：

1. 【事实】没有任何记录表明这三条拦截修过某个具体故障；引入它的 commit 是一次成套的预防性设计，动机写在 `docs/anti-detection.md` 里，方向是「让 CDP 浏览器不被判定为自动化」——**这个方向恰好是地图 #20 明确不采纳的**。上游 issue 区从未讨论过这三条的增删。
2. 【事实】已知的因果关系是反的：拦截会引发「安全脚本被拦 → SPA 自救式 reload」，本 fork 为此专门加了熔断（`ea6d854` / recruiting-copilot#7）。去掉拦截同时去掉这个故障源。
3. 【推断】按快照证据折算，三条里两条的实际保护面接近于零（一条 10 份快照 0 命中，一条只拦了个对 Chrome 空操作的 IE 检查），真正有实质作用的只有 risk-detection.js，而它「只上报不破坏」且上报通道已被 `REPORT_REQUEST_PATTERNS` 独立堵住。

**唯一需要实测确认的不确定性**：`*zhipin-security/web/boss/*`（zpAegis）在登录态下到底加不加载。它是三条里唯一可能有实质暴露的。

【推断】给 #26 的两条建议：
- 对照实验优先测这一条；
- **按 pattern 分别开关**，而不是三条捆在一起开关——三条的证据强度差了一个数量级，捆在一起会让结论无法归因。

---

## 原始出处清单

| 材料 | 位置 |
|---|---|
| 引入 commit | `e435521b70e3d4384c90a393f02a7fb9588cb9e2`（joo，2026-04-27，upstream `joohw/boss-cli`） |
| 上游第二个 commit | `f4fdff2`（joo，2026-04-29，移除 beforeunload，无关） |
| 熔断 commit（fork） | `ea6d854043dbf7facfa4af56a5987b0cae1d86b4`（yifan，2026-07-27） |
| 动机文档 | `~/boss-cli-repo/docs/anti-detection.md`（e435521 随同引入，712 行）／ <https://github.com/joohw/boss-cli/blob/main/docs/anti-detection.md> |
| 被调研代码 | `~/boss-cli-repo/src/common/boss_page_guards.ts:19-23`（pattern）、`:448-458`（熔断放行）、`:541-550`（安装拦截） |
| 测试 | `~/boss-cli-repo/tests/boss_page_guards.test.mjs`（只测熔断，不测 pattern） |
| 抓取快照 | `~/boss-cli-repo/docs/research/boss-online-js/2026-07-01 … 2026-07-17`（10 份，manifest + analysis + raw） |
| browser-check 原文 | `~/boss-cli-repo/docs/research/boss-online-js/2026-07-17/raw/static/zhipin/geek/sdk/browser-check-v2.js` |
| 快照分析自证（第三条只拦 browser-check） | `~/boss-cli-repo/docs/research/boss-online-js/2026-07-05/analysis.md:129` |
| 上游症状票（导航守卫，非 SDK 拦截） | [joohw/boss-cli#1](https://github.com/joohw/boss-cli/issues/1) |
| 上游封号提问（作者未回复） | [joohw/boss-cli#3](https://github.com/joohw/boss-cli/issues/3)、[#5](https://github.com/joohw/boss-cli/issues/5) |
| fork 侧症状记录 | [recruiting-copilot#7](https://github.com/Viy1204/recruiting-copilot/issues/7) |

### 调研边界声明

- 未访问 zhipin.com / bosszhipin.com 任何真站页面或脚本 URL；SDK 行为分析全部基于仓库内已有的抓取快照与逆向文档。
- 未改动任何代码。
- 本票不决定拦或不拦。
