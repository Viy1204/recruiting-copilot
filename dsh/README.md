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

## 招聘浏览器面板

- **原理**：boss-cli 固定占用 CDP 调试端口 `53470`（见 boss-cli 的
  `REMOTE_DEBUGGING_PORT`），浏览器跨命令常驻；host 半区并行挂到同一只浏览器上，
  `Page.startScreencast` 推 JPEG 帧（有变化才推），经
  `/plugins/recruiting-view/stream.mjpg` 以 MJPEG 长连接喂给面板的 `<img>`；
  面板把鼠标/滚轮/键盘/IME 事件回传 `/input`，host 转成 `Input.*` 派发。
- **看得清的关键是「贴合」**：host 用 `Emulation.setDeviceMetricsOverride` 把页面
  视口固定为 **958×1149**（用户确认 BOSS 页面在这个尺寸下渲染最完整），与面板大小
  解耦——面板随意拖宽只影响显示缩放，不影响页面渲染尺寸。关掉贴合则显示浏览器真实
  窗口画面（会被缩小）。
  取消贴合必须**先用 0 宽高把覆盖接管到当前会话、再 `clearDeviceMetricsOverride`**，
  只发 clear 清不掉别的（已断开）会话留下的覆盖——插件 dispose 时也走这条路径，
  免得关掉 DSH 后真实浏览器卡在面板尺寸。
- **浏览器没起时**：面板里点「在这里启动浏览器」，host 用与 boss-cli 相同的
  user-data-dir（`~/.boss-cli/.cache/browser-data`）和调试端口拉起 Chrome，登录态
  通用；之后跑 boss 命令会 `probe` 到这只已存在的实例直接复用，不会另开一只。
- **窗口被遮挡/最小化**：screencast 会静默，看门狗自动回落到
  `Page.captureScreenshot` 轮询（面板底部状态栏会显示「轮询」）。
- **坐标**：面板传归一化坐标（0..1），host 乘当前视口尺寸，因此面板缩放/letterbox
  都不影响命中；实测面板点 (x,y) 与页面 (x,y) 逐像素对齐。
- **键盘**：面板里有个透明 textarea 承接按键，点画面即聚焦；中文走
  `compositionend` → `Input.insertText`，粘贴同理。功能键发 `rawKeyDown`，
  可打印字符发带 `text` 的 `keyDown`。
- **liepin**：liepin-cli 目前用 `puppeteer.launch()` 且无固定调试端口，暂不能
  接管；等 liepin-cli 支持固定端口后，在 profile 的 `cordis.patch.yml` 里给
  `recruiting-copilot` 的 `config.sources` 加一项
  `{ name: "liepin", port: <端口>, match: "liepin\\.com" }` 即可，无需改本仓库。
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
