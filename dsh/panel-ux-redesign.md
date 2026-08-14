# 招聘浏览器面板 —— UX 改造计划（2026-08-14）

> 现状：面板功能全部可用（鼠标/滚轮/键盘/IME/贴合/多标签），但「形态」不贴
> DeepSeek Harness Web UI：一只常驻工作区被做成了悬浮弹窗卡片。本文档给三档
> 改造方向 + 社区可抄的方案，改动全部落在 `client.js`（面板）与 `lib/index.js`
> （传输层），不碰 DSH 本体。

## 一、为什么「不够适配」（诊断）

1. **挂载语义**：面板挂在 `shell.overlay`（list 插槽，官方注释定位是"浮在整个应用
   之上的表面"——审批/提问等瞬态层），但招聘浏览器是**常驻工作区**。DSH 常驻右栏
   是 `details` 列（`dsh-client-ui-layout` 的 AppFrame：`sidebar | center | details`
   三列网格，原生拖拽把手、300–520px、可关闭），它被会话的 DetailsPanel（轨迹/工具
   详情）占用，是 single 插槽，直接抢会顶掉会话详情。
2. **视觉语言**：`position:fixed` + 10px 边距 + `border-radius:12px` +
   `shadow-lv3` 大阴影 + 自定义 pill = 典型"第三方弹窗"。DSH 的列是
   `border-left + 通栏贴边 + 无圆角无阴影`。`--dsw-*` token 只当了 fallback，
   多数颜色硬编码。
3. **控制区过载**：head 一排 9 个文字按钮 + 标签行 + footer 行；DSH 风格是
   icon-button + 克制的状态行。
4. **画面层**：`<img>` + MJPEG：断流要重挂 src（闪断）、无缩放/平移、
   letterbox 黑边、码率不可调、无操作可视化。
5. **空态弱**：浏览器没起时只有一个按钮 + 一段小字。

## 二、三档改造方向

### A 档 · 形态贴合（低风险，约 1 天，只改 client.js）
- 面板改「贴边 dock 列」外观：`right:0; top:0; bottom:0`，无圆角无大阴影，
  `border-left:1px solid var(--dsw-alias-border-l2)`，背景
  `var(--dsw-alias-bg-layer-1)`——视觉上就是第四列，不挡聊天。
- 头部对齐 DSH 细节列：标题 + 折叠钮，工具栏全部 icon-button（用 `--dsw-*`
  fill/border/label token），去掉文字按钮；折叠态 = 右侧贴边小圆钮。
- 全部颜色/字体/圆角只走 `--dsw-*`（alias 集：bg-base/layer-1/layer-2、
  border-l1..l3、label-primary..tertiary、fill-l2/l3、button-floating-*、
  state-success/error/warn），不留硬编码 hex。
- 空态重做（icon + 标题 + 副文案 + 主按钮），footer 只留「推流/轮询/空闲 +
  视口」。

### B 档 · 渲染与交互升级（中风险，2–3 天，改两端）
- 传输：MJPEG `<img>` → **WebSocket + Canvas**。协议直接照抄
  vercel-labs/agent-browser（见下）：`{type:"frame",seq,data,metadata}` +
  `{type:"status"}`，输入走同一 socket；**最新帧优先 + ack pacing**（服务端只
  发最新帧、客户端回 seq ack），彻底解决积压与断流闪断（canvas 保留上一帧）。
- 画面交互：滚轮默认滚页面，Ctrl+滚轮或工具栏缩放；Fit/100%/滑杆；Figma 式
  平移（空格或中键拖）。
- **三态接管**（抄 gsd-browser Live Viewer）：`AI 在操作 | 你接管 | 只读`。
  接管时高亮边框 + 顶部状态横幅；对招聘场景很实用——agent 跑寻源时盯着看，
  关键时刻自己上手。
- 可选：帧上叠加操作标记（点击闪光/坐标十字）。当前 agent 通过 bash 驱动
  boss-cli，host 拿不到动作，需等 C 档或接 boss-cli 事件。

### C 档 · 原生工具卡片（最贴 DSH 形态，大改，4–5 天）
- 把"浏览器操作"从 bash 调 boss-cli 升级为 host 注册的真 Tool（dsh tools
  注册表）。agent 每次操作在会话里渲染成**原生 tool card**（注册
  `tool.call.toolview` keyed 插槽，参照 web_search 卡片写法）：卡片内实时帧
  快照 + 状态 + 「打开面板」按钮；右侧面板降级为深查视图。
- 这才是真正"长在 DSH 形态里"，但需要重排 agent 调用方式 + host 注册 tool +
  client 注册 toolview。

## 三、社区方案（可直接抄/结合）

| 项目 | 做法 | 抄哪 |
|---|---|---|
| [vercel-labs/agent-browser](https://agent-browser.dev/streaming) | CDP 浏览器 + WebSocket 推流协议：frame/status/input 同 socket，最新帧优先 + ack pacing + seq | B 档传输层整份照抄 |
| [open-gsd/gsd-browser](https://github.com/open-gsd/gsd-browser) | Rust CDP daemon + Live Viewer：human takeover、annotation 标记、goal banner、command history、录制 | B 档三态接管 + 状态横幅 |
| [kasmtech/noVNC (KasmVNC)](https://github.com/kasmtech/noVNC) | WebP/JPEG 自动混用、按画面变化率动态调质量、IME、双向剪贴板 | B 档编码策略/帧率自适应 |
| [browser-use/web-ui](https://github.com/browser-use/web-ui) | Gradio UI + 复用本机浏览器 profile（BROWSER_PATH/BROWSER_USER_DATA）+ 持久会话 + 录制 | profile 复用已做；录制/回放可抄 |
| [zulfikawr/vbrowser](https://github.com/zulfikawr/vbrowser) / [m1k1o/neko](https://github.com/m1k1o/neko) / [selkies](https://github.com/selkies-project/selkies) | WebRTC 推流浏览器（60fps 低延迟） | 局域网单用户过重；未来做远程/多端再说 |
| [OpenClaw browser tool](https://docs.openclaw.ai/tools/browser) | 浏览器自动化 skill 循环（先 status/tabs 再操作、snapshot 前后对比、登录/验证码交人工） | 面板的「agent 状态」叙事参考 |

DSH 生态本身没有现成浏览器面板插件（harness 还是 rc，插件生态刚起步，
[GitHub](https://github.com/deepseek-ai/deepseek-harness) 5k star）；当前
profile bundle 模式（webServer 路由 + shell.overlay）就是官方认可的扩展方式，
不用换框架。

## 四、落地顺序建议

1. **A 档**（形态贴合）——立即可做，解决"不像 DSH"的主要观感。
2. **B 档**（WS+Canvas + 三态接管）——解决"不好用"（卡顿/闪断/不可缩放）。
3. **C 档**（原生 tool 卡片）——想让它彻底长进聊天流再做，成本最高。

推荐先做 A + B 里"WS 传输 + 三态接管"。C 档需要重排 agent 调用方式，单列评估。

## 五、社区对标补充：dsh-better-sidebar（2026-08-14）

[dsh-better-sidebar](https://github.com/omdsh-dev/DSH-better-sidebar)（v0.11.0）是社区里最接近
"把 DSH 变成 IDE 工作台"的插件：右侧栏 + 底部面板双工作台（文件树/编辑器/终端/Git/Diff/
子代理/浏览器 tab/9 种文件预览），工程质量高（TS + ~40 测试 + 设计文档 + i18n + 懒加载 +
信任围栏）。评估结论：

- **它的浏览器 tab 是沙箱 iframe**（无登录态、反嵌入站点进不去），对 BOSS 直聘场景无用；
  我们的 CDP 镜像真浏览器仍是正解，不用换。
- **最值得抄的是 layout-push 手法**：`#root { margin-right: var(--dsh-sidebar-width) }`，
  面板打开时应用真正让出宽度，聊天不被遮挡。已在本轮 A 档实施（`--rcp-dock-width`）。
- **可选的结合方式**：它暴露 `ctx.betterSidebar.registerTab()`，我们的面板可注册成
  `recruiting:boss-browser` tab 白拿 dock/tab 栏/会话持久化；代价是引入大依赖（node-pty
  原生二进制、Univer 23MB、全局链接拦截）和 DSH 升级断裂风险（依赖 `#root` DOM 结构）。
- 结论：轻量路径（抄手法，自研 dock）已实施；重型路径（装它 + registerTab）留给用户决定
  是否需要整个 IDE 工作台。

## 六、实施记录

### A 档 · 形态贴合（2026-08-14 已实施，仅 client.js）

- dock 推挤：`#root { margin-right: var(--rcp-dock-width) }`（借鉴 dsh-better-sidebar），
  折叠/整屏时归零；拖宽时禁用过渡（`body[data-rcp-dragging]`）。
- 面板改贴边列：无圆角无阴影、左边框；背景/边框/文字/按钮/状态色全走 `--dsw-*` token
  （含 `--ds-font-family-code` / `--ds-transition-duration-slow` / `--ds-ease-in-out`）。
- 工具栏 icon-button 化（24px 方形、hover 高亮、data-on 态）；footer 只留
  「视口×尺寸 · 推流/轮询/空闲 + 唤起窗口」；空态重做（图标 + 主色 CTA）。
- 面板宽度默认 42% / 720px，记忆到 localStorage（`rcp.panel.width`），刷新恢复。
- 验证：`node --check client.js` 通过；`node --test tests/mirror.test.mjs` 10/10 通过。
  等待用户在 3080 硬刷新后回收手感反馈。

### host 补丁：启动按钮与空态报错（2026-08-14，lib/index.js，需重启生效）

排查「浏览器未运行 + cdp not connected」时发现启动按钮在当前配置下从未真正可用：
`dsh/cordis.patch.yml` 的 boss 源没写 `userDataDir`，而 patch 提供的 `config.sources`
整组覆盖了 `DEFAULT_SOURCES`，导致 `launch()` 拒绝拉起。一并修复：

- 新增 `normalizeSources()`：patch 配置按源与内置默认合并（只写差异），
  userDataDir/homeUrl 自动补上；未知源（如未来 liepin）原样保留。
- 探针失败（浏览器没在跑）时清空 `state.error`：空态不再挂误导性的
  "cdp not connected"。
- 启动超时 15s 自动复位 `launching` 并给出明确错误，不再永远转圈。
- 新增 3 个单测，`node --test tests/mirror.test.mjs` 13/13 通过。

### 根因定位：Runtime.enable 触发 BOSS 反爬杀浏览器（2026-08-14）

"浏览器崩溃"最终定位为**不是 Chrome bug，是 BOSS 反爬**：镜像连接时发送的
`Runtime.enable` 被页面安全模块（zhipin-security WASM）当成调试器挂载信号，
主动关掉整个浏览器，并把 profile 标记为异常（表现为反复要求重新登录）。
证据（本机 Claude Code + 本会话多轮复测，拷贝 profile）：
- 只开 `Runtime.enable`、不抓帧 → 0/4 存活；
- 不开 `Runtime.enable`、screencast+screenshot 全量抓帧 → 4/4 存活。

修复（lib/index.js）：连接序列去掉 `Runtime.enable`（镜像不消费 Runtime 事件，
`Runtime.evaluate` 等命令不需要 enable）。⚠️ 教训：后续任何对 boss 登录态的
测试一律用拷贝 profile，绝不直接操作真实 profile。

### 附加：崩溃自愈 watch（2026-08-14，lib/index.js + client.js）

面板未折叠时向 host 发 `control("watch")`；镜像在「曾连上过 + 在盯梢 +
冷却 10s」时自动重新拉起意外掉线的浏览器。与根因修复配套，等重启生效。

### 贴合改固定视口 958×1149（2026-08-14，client.js，硬刷新即生效）

用户反馈"截得不够全、958×1149 刚好"：贴合不再跟随面板尺寸，页面视口固定为
`FIXED_VIEWPORT = { width: 958, height: 1149 }`（client.js 常量），面板拖宽只
影响显示缩放；黑边坐标由 normalize() 兜底。硬刷新即生效，无需重启 host。
