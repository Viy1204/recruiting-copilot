# DeepSeek Harness 插件（bundle）

本目录把 recruiting-copilot 打包成 DeepSeek Harness 的 **profile bundle**：

- `package.json`（仓库根）声明 `"dsh": { "bundle": { "patch": "./dsh/cordis.patch.yml" } }`，
  这是 DSH 识别插件包的约定（与 `@deepseek-ai/dsh-base` 等内置 bundle 同构），
  同时声明 `dsh.client.platform: "web"` + `exports["./client"]`，让本包同时成为
  一个**客户端模块**（右侧浏览器面板）。
- `cordis.patch.yml` 是 profile 的 patch 层：启用宿主 `skill-filesystem` 行，
  把本包 `skills/` 目录挂为全局自定义 skill 根（rank 300，custom 源），并挂载
  本包自身（host 插件 + 客户端面板）。
- `lib/index.js` 是 host 插件：通过 CDP 把 boss-cli 的浏览器实时镜像成 JPEG 帧，
  暴露 `/plugins/recruiting-view/*` 路由（无第三方依赖，只用 Node 内置
  fetch/WebSocket）。
- `client.js` 是浏览器端模块：注册进 `shell.overlay` 插槽，在 Web UI 右侧渲染
  实时浏览器面板（轮询帧流、可折叠/调宽、可选源与标签）。

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
2. Web UI 右侧出现「招聘浏览器」面板：运行 boss-cli 命令时实时显示其操作界面。

## 招聘浏览器面板

- **原理**：boss-cli 固定占用 CDP 调试端口 `53470`（见 boss-cli 的
  `REMOTE_DEBUGGING_PORT`），浏览器跨命令常驻；本插件的 host 半区并行挂到同一
  只浏览器上，每秒抓一帧 JPEG，经 `/plugins/recruiting-view/frame.jpg` 供面板轮询。
- **依赖**：boss-cli 的 Chrome 在跑（或由任意 boss 命令拉起）。浏览器没开时
  面板显示「浏览器未运行」，不报错。
- **liepin**：liepin-cli 目前用 `puppeteer.launch()` 且无固定调试端口，暂不能
  镜像；等 liepin-cli 支持固定端口后，在 profile 的 `cordis.patch.yml` 里给
  `recruiting-copilot` 的 `config.sources` 加一项
  `{ name: "liepin", port: <端口>, match: "liepin\\.com" }` 即可，无需改本仓库。
- **路由**：`state.json`（状态+标签列表）、`frame.jpg`（最新帧）、
  `set-target`（切换抓取标签）。

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
  里 `require("react")` 等共享模块，`apply(ctx)` 里 `ctx.slots.register` 进
  `shell.overlay`（list 插槽，需 `id`）。

## 本地验证（改动后必做）

```bash
cd 本仓库
npm pack            # 产物应包含 dsh/、skills/、lib/、client.js
node --check client.js && node --check lib/index.js
# 隔离验证（不碰在跑的 GUI）：
DSH_HOME=$(mktemp -d) dsh plugin --profile web add link:$(pwd)
DSH_HOME=同上 dsh --profile web --port 3081   # 起隔离实例
curl http://127.0.0.1:3081/plugins/recruiting-copilot/client.js
curl http://127.0.0.1:3081/plugins/recruiting-view/state.json
curl -o f.jpg http://127.0.0.1:3081/plugins/recruiting-view/frame.jpg
```
