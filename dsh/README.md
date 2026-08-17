# DeepSeek Harness 插件（bundle）

本目录把 recruiting-copilot 打包成 DeepSeek Harness 的 **profile bundle**：

- `package.json`（仓库根）声明 `"dsh": { "bundle": { "patch": "./dsh/cordis.patch.yml" } }`，
  这是 DSH 识别插件包的约定（与 `@deepseek-ai/dsh-base` 等内置 bundle 同构），
  同时声明 `dsh.client.platform: "web"` + `exports["./client"]`，让本包同时成为
  一个**客户端模块**（右侧浏览器面板）。
- `cordis.patch.yml` 是 profile 的 patch 层：启用宿主 `skill-filesystem` 行，
  把本包 `skills/` 目录挂为全局自定义 skill 根（rank 300，custom 源），并挂载
  本包自身（host 插件 + 客户端面板）。
- `lib/index.js` 是 host 插件：通过 CDP 把 boss-cli 的浏览器变成一只可远程操作的
  浏览器——`Page.startScreencast` 推帧 + `Input.*` 收事件，暴露
  `/plugins/recruiting-view/*` 路由（无第三方依赖，只用 Node 内置
  fetch/WebSocket/child_process）。
- `client.js` 是浏览器端模块：注册进 `shell.overlay` 插槽，在 Web UI 右侧渲染
  可操作的浏览器面板，**dock 列形态**（打开时给 `#root` 加 `margin-right` 让出
  宽度，聊天不被遮挡，视觉与 DSH 内置列一致）：MJPEG 画面、鼠标/滚轮/键盘/IME
  回传、地址栏与标签页、贴合视口、整屏/折叠/调宽（宽度记忆到 localStorage）。

## 安装 / 更新 / 卸载

```bash
# 安装（web 界面 profile 示例；headless 等其它 profile 同理）
dsh plugin --profile web add git+https://github.com/Viy1204/recruiting-copilot.git

# 更新（git 依赖会重新拉取最新提交）
dsh plugin --profile web update recruiting-copilot

# 卸载
dsh plugin --profile web remove recruiting-copilot
```

安装后**重启 DSH 会话**：

1. `skills/` 下 7 个 skill（ask-viy、recruit-init、recruit-grill、recruit-daily、
   resume-review、interview-schedule、market-talent-mapping）在任意工作区可用。
2. Web UI 右侧出现「招聘浏览器」面板：一只可以直接用的浏览器。

## 浏览器默认无头

面板拉起的浏览器**默认无头**（`RECRUIT_BROWSER_HIDDEN` 不等于 `false` 即无头）。

实测原因：想过用「离屏有头」（`--window-position=-32000,-32000`）来隐藏窗口，但在 Windows 上
**创建可见窗口必然激活它**，照样抢键盘焦点，加 `--no-startup-window` 也只是把激活推迟到建 tab 那一刻。
而无头下面板依赖的每条 CDP 能力（screencast 推帧、`Emulation` 贴合、`Input.*` 派发、
`captureScreenshot`）与有头**零退化**，截图字节数逐字节相同。

**要看浏览器在做什么就用这个面板** —— 这正是它存在的理由。真要有头窗口（例如需要在真窗口里人工操作）：

```bash
RECRUIT_BROWSER_HIDDEN=false     # 三方共读：本插件 / boss-cli / liepin-cli
```

已有实例在跑时改变量不生效（端口上已有实例会被复用），得先 `boss shutdown` / `liepin quit` 关掉那只。
判断在跑的那只是什么模式：`state.json` 里每个源的 `headless` 字段，或直接读
`http://127.0.0.1:<port>/json/version` 的 `User-Agent` 是否含 `HeadlessChrome`。

无头下额外带 `--screen-info={0,0 1920x1080 workAreaBottom=40}`：无头虚拟屏默认 800x600 是已知的
强自动化指纹，`--window-size` **抬不动它**，只有 `--screen-info` 能（Chrome 142+，仅无头有效）。
四个 workArea 参数必须分开写（`workAreaTop/Bottom/Left/Right`），写成 `workArea=` 会让 Chrome 直接起不来。

## 招聘浏览器面板

- **原理**：boss-cli 固定占用 CDP 调试端口 `53470`（见 boss-cli 的
  `REMOTE_DEBUGGING_PORT`），浏览器跨命令常驻；host 半区并行挂到同一只浏览器上，
  `Page.startScreencast` 推 JPEG 帧（有变化才推），经
  `/plugins/recruiting-view/stream.mjpg` 以 MJPEG 长连接喂给面板的 `<img>`；
  面板把鼠标/滚轮/键盘/IME 事件回传 `/input`，host 转成 `Input.*` 派发。
- **看得清的关键是「贴合」**：host 用 `Emulation.setDeviceMetricsOverride` 把页面视口固定成
  一个**按源写死**的尺寸（`client.js` 的 `FIXED_VIEWPORT`：BOSS `958×1149`，猎聘 `1440×1149`），
  与面板大小解耦——面板随意拖宽只影响显示缩放，不影响页面渲染尺寸。关掉贴合则显示浏览器真实
  窗口画面（会被缩小）。
  两家尺寸不同是量出来的：猎聘在 958 下会出横向滚动条，且候选人卡片右侧的「立即沟通」按钮被
  挤出可视区——那是手动打招呼的唯一入口。**切源时必须重发贴合**（`sourceName` 要进 `useEffect`
  的依赖数组），否则从 BOSS 切到猎聘还用着 958。
  取消贴合必须**先用 0 宽高把覆盖接管到当前会话、再 `clearDeviceMetricsOverride`**，
  只发 clear 清不掉别的（已断开）会话留下的覆盖——插件 dispose 时也走这条路径，
  免得关掉 DSH 后真实浏览器卡在面板尺寸。
  **贴合时不传 `screenWidth`/`screenHeight`**：传了会把 `window.screen` 一起盖成视口尺寸
  （958×1149 这种竖屏、且 `availHeight === height` 没有任务栏），本身就是自动化指纹。
  实测不传时 `innerWidth`/`innerHeight` 依然精确等于目标值，面板效果一字不差，而真实
  screen（无头下由 `--screen-info` 给定）能透出来。
- **浏览器没起时**：面板里点「在这里启动浏览器」，host 用与 boss-cli 相同的
  user-data-dir（`~/.boss-cli/.cache/browser-data`）和调试端口拉起 Chrome，登录态
  通用；之后跑 boss 命令会 `probe` 到这只已存在的实例直接复用，不会另开一只。
- **screencast 静默时**：看门狗自动回落到 `Page.captureScreenshot` 轮询（面板底部状态栏会
  显示「轮询」）。**无头下只用 `fromSurface:true`** —— `fromSurface:false` 是文档化的
  headful-only（"works only in headful mode"），无头下会返回一张空/降级图；若不加区分地
  退到它，`fromSurface:true` 失败的那一刻会把废图当成有效帧发布，面板显示假画面，
  比没有兜底更糟。
- **坐标**：面板传归一化坐标（0..1），host 乘当前视口尺寸，因此面板缩放/letterbox
  都不影响命中；实测面板点 (x,y) 与页面 (x,y) 逐像素对齐。
- **键盘**：面板里有个透明 textarea 承接按键，点画面即聚焦；中文走
  `compositionend` → `Input.insertText`，粘贴同理。功能键发 `rawKeyDown`，
  可打印字符发带 `text` 的 `keyDown`。
- **两个源**：boss 占 `53470`，liepin 占 `53471`（`liepin-cli` 的
  `LIEPIN_BROWSER_REMOTE_DEBUGGING_PORT`）。面板顶部在 `sources.length > 1` 时自动
  出现源切换按钮。两个 CLI 的浏览器都**跨命令常驻**（命令结束只断 CDP），所以面板
  能一直连着；要真正关掉用 `boss shutdown` / `liepin quit`。
  猎聘源探不到端口时，空态文案会明确指向「liepin-cli 版本过旧（旧版用随机端口）」——
  否则用户只会以为是浏览器没开，点了启动按钮也没有任何反应。
- **路由**：`state.json`（状态+标签+视口）、`stream.mjpg`（实时画面）、
  `frame.jpg`（单帧兜底）、`input`（POST 事件批）、`control`（POST：launch /
  navigate / reload / back / forward / new-tab / close-tab / set-target /
  activate / fit / unfit）。

## 原理速览

- DSH 的 `dsh plugin` 命令把剩余参数转发给 profile 目录里的 `pnpm`，
  装完后按「安装状态」对账 `dsh.profile.bundles`：装进来的包若声明了
  `dsh.bundle.patch` 就自动加入 bundle 层栈。
- patch 里的 `!!js` 表达式在加载器 ctx 作用域求值：`ctx.baseUrl` 即 profile
  目录，因此能定位到 `node_modules/recruiting-copilot/skills`，无需硬编码路径。
- 内置 profile 把宿主 `skill-filesystem` 行 disabled（preset 各自做 per-agent
  发现）；本 patch 重新启用并注册 custom 根，属于官方注释认可的
  "deployment-level provider" 用法。
- host 插件不声明必选 `inject`（headless 无 webServer 也能挂载），路由注册放在
  `ctx.inject({ webServer: {} }, ...)` 子纤维里，等服务可用再注册。
- 客户端模块契约：`window.__ModuleLoader__.load({ id, factory })`，`factory`
  里 `require("react")` 等共享模块，`apply(ctx)` 里注册进 `shell.overlay`
  （list 插槽，需 `id`）。**`slots` 是 cordis 服务，必须 `ctx.inject(["slots"], …)`
  才能访问**——直接读 `ctx.slots` 会以
  `cannot get property "slots" without inject` 整个模块加载失败。

## 本地验证（改动后必做）

```bash
cd 本仓库
node --test "tests/*.test.mjs"  # 单测：坐标换算、输入参数、贴合/还原调用序列
node --check client.js && node --check lib/index.js
npm pack                         # 产物应包含 dsh/、skills/、lib/、client.js

# 真机联调（不起 DSH，直接把 host 插件挂裸 http 上）：
node tests/harness-live.mjs 3081
curl http://127.0.0.1:3081/plugins/recruiting-view/state.json
node tests/input-e2e.mjs 3081    # 端到端验证鼠标/滚轮/键盘真的进了页面

# 隔离验证（不碰在跑的 GUI）：
DSH_HOME=$(mktemp -d) dsh plugin --profile web add link:$(pwd)
DSH_HOME=同上 dsh --profile web --port 3082   # 起隔离实例
curl http://127.0.0.1:3082/plugins/recruiting-copilot/client.js
```
