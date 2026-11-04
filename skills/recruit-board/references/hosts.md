# 网页开工与宿主接入

网页是所有 Agent 共用的唯一招聘看板界面，包括 Claude Desktop、Codex App、WorkBuddy。先用当前宿主实际提供的服务、浏览器工具管理前台服务并打开或复用页面；没有打开工具就交付明确的本机链接。能否自动显示在右侧取决于本次会话的工具能力，不承诺自动停靠。

## 统一开工动作

`<board>` 是本次使用的 `skills/recruit-board/` 绝对路径，`<workspace>` 是已确认的用户招聘工作区绝对路径。源码仓库维护、目录路由、纯评级回查及只查看看板都不创建 run；只查看时从服务探测开始。不为读取状态联系招聘平台，也不打开平台浏览器。

1. **先读事项，再落真实进度**：六个执行入口先按 [`decisions.md`](decisions.md) 读取相关未解决事项、现行决定和后续执行，再按 [`progress.md`](progress.md) 读取 WORKFLOWS 并 `start`，注明主动／定时来源，保存返回的 `id`，立即对实际进入的业务阶段记 `step`。不要只开一个尚无步骤的 run，就去做耗时寻源。`init` 仅在目标工作区实际建立后读取并 start，按共享协议补记已观测步骤，再进入当前阶段；不向源码仓库写 runtime。
2. **探测可复用服务**：用下方 connect 命令探测，只有 `ready` 才能复用。宿主已提供其他端口的地址时显式传 `--url`，不要仍猜 4318。
3. **必要时前台启动并复核**：没有可复用服务时，按宿主能力表启动。等待 stdout 的 `ready` 行，再用它给出的 origin 运行 connect；经 health 确认后才交付链接。不能只凭端口有响应、页面标题或 HTTP 200 判断可复用。
4. **尽早交接网页**：在耗时寻源、取数或简历处理前，首次默认打开 connect 的 `url`，让工作区首页 live 跟随最新任务，同时交付 `runUrl` 明确本轮；用户明确要看本轮时用 `runUrl` 固定。两种链接都保留 helper 的完整查询参数。已有同工作区页面时复用：live 页面会跟随最新任务；历史固定、候选详情、完整结果或岗位编辑中的页面保持原位置，给本轮链接供用户选择，不强制导航。
5. **后续只更新记录**：逐人核实后记 `result`，重要进展记 `highlight`，需要用户决定的登记独立事项。只暂停依赖确认的动作；整轮确实等待时才记 `wait`，结束前写 `summary` 再按共享协议收口。跨轮读写细节见 [`decisions.md`](decisions.md)。新事项与重点按已核实对象写 `context`，重点按需写事件 `details`；旧格式仍可读。无需每个 step 重开页面。

首次记录的命令形态如下；workflow、步骤和完成判据以实际业务为准，不能把示例步骤当作已发生事实。

```bash
node "<board>/scripts/progress.mjs" start --workspace "<workspace>" --workflow daily --role "<岗位>"
```

```bash
node "<board>/scripts/progress.mjs" step --workspace "<workspace>" --run "<返回的id>" --step unread
```

## 只读探测与服务契约

connect 只做 probe，不 spawn、不放到后台、不自动打开浏览器，也不写业务文件。

```bash
node "<board>/scripts/connect.mjs" --workspace "<workspace>" --run "<id>" --require workspace-overview,run-highlights
```

默认探测 `http://127.0.0.1:4318`。宿主已有服务地址或刚启动了其他端口时，加 `--url "<loopback HTTP origin>"`；此参数只传 origin，不传页面路径或 query。仅查看已有看板时可省略 `--run`。新版入口保留 `--require workspace-overview,run-highlights`：旧服务缺少跨轮事项或历史重点能力时返回 incompatible，不能因旧三项能力正常就误报新联动已接入。输出 JSON 字段为 `status`、`url`、`runUrl`、`workspaceKey`、`message`。

| status | 处理 |
|---|---|
| `ready` | 服务身份、协议能力及工作区匹配，可以复用返回的链接 |
| `unavailable` | 没有可用服务；按当前宿主能力启动前台服务后再探测 |
| `workspace-mismatch` | 已有服务属于其他工作区；不复用、不 kill，另开端口 |
| `incompatible` | 服务身份或协议能力不兼容；不复用、不 kill，已有端口被占用则另开 |

使用 connect 返回的完整 `url` / `runUrl`，保留其中的 `workspace=<canonical hash>`；`runUrl` 还带 `run=<id>`。这些参数防止端口被其他工作区占用后串数据。不要手拼工作区路径、另算 hash、删掉 helper query，或拿默认 4318 替换实际端口；不是 `ready` 时不把返回值当作可用链接。

服务仍以前台方式运行，无额外 npm 依赖。默认端口未占用时使用第一条；冲突且宿主支持动态端口时使用第二条，两者选一。

```bash
node "<board>/scripts/server.mjs" --workspace "<workspace>" --port 4318
```

```bash
node "<board>/scripts/server.mjs" --workspace "<workspace>" --port 0
```

`--port 0` 自动分配端口。若 preview 工具要求固定端口，先选未占用的固定端口再启动，仍需 health 核验；不能为抢占 4318 停止别的服务。监听成功后 stdout 输出一行 JSON，示意如下。

```json
{"event":"ready","service":"recruiting-board","url":"http://127.0.0.1:<实际端口>/","workspaceKey":"<工作区键>"}
```

`GET /api/health` 返回服务身份及绑定工作区，connect 按此契约确认兼容性。

```json
{"service":"recruiting-board","schemaVersion":1,"capabilities":["snapshot","run-results","run-activity","workspace-overview","run-highlights"],"workspaceKey":"<工作区键>"}
```

健康检查不要求台账或岗位文件正常。服务健康但源文件缺失、非法或陈旧时，由 UI 展示 source 错误；不要通过重启服务掩盖数据问题。服务仅监听 loopback，不承诺跨机访问、24 小时守护或自动重启。生命周期交给宿主或用户可管理的前台终端；不偷偷 daemon、改 settings 或安装工具。

## 按实际宿主能力选择入口

先检查本会话真实可调用的工具与已有入口，下面的宿主支持说明不等于存在可硬编码的 agent API。四类入口共用上面的探测、工作区核验和链接交接协议。

| 宿主 | 启动与打开方式 | 能力边界 |
|---|---|---|
| Claude Desktop Code | 本环境有 `preview_start` 时，必须由它管理 HTTP 服务，不用 Bash 起服务；通过实际可用的 Browser/Preview 工具打开或复用页面 | 使用已有且适用的服务配置；无法调用或配置不适用时说明受限，不擅改设置。使用与其他 Agent 相同的网页 |
| Codex App | 使用会话实际暴露的服务、Browser 工具；已确认存在且可用的 local environment action 也可作为前台启动入口 | Browser 支持 localhost 与 split view；没有相应工具时给本机链接，由用户打开或安排分屏，不凭空写机器路径配置或假称自动停靠 |
| WorkBuddy | 有专用服务、Browser 工具时使用实际工具；服务 ready 后交付本机链接，支持时在右侧 Browser 查看 | 官方记载点击聊天 URL 可在右侧打开，具体入口可能随版本变化；HTML 产物预览不能替代动态看板所需的 HTTP 服务，不编造 agent API |
| 纯 CLI / 无专用服务工具 | 仅在没有专用 server 工具且用户能管理时，用可见终端前台运行 server；探测 ready 后返回完整本机链接，用普通浏览器打开 | 终端关闭后服务可能结束；不用隐藏后台进程实现常驻，也不声称能自动打开右侧 |

## 降级

缺 Node、旧工作区或单独安装的工具库缺少 progress / connect / server 脚本时，不为看板自动覆盖旧 skills 或强行迁移。进度写入失败说明“本轮未记录进度”及原因；网页无法启动或核验说明“看板不可用”及原因，继续招聘本体。进度不可用但网页已确认 ready 时，可交付 helper 的 `url` 查看已有本地数据，不伪造本轮 ID。服务已 ready 但没有浏览器工具时，直接交付完整本机链接；没有确认 ready 时不假称已打开或服务可用。

## 原生入口退役与升级

当前源码仅维护网页。独立 `recruiting-board` 插件、原生 `/recruiting-board` 注册、宿主专用测试与预览同步已退役；主 `recruiting-copilot` 插件及其 `recruit-board` Skill 保留。固定 v0.8.0 及更早发行包仍是历史版本，升级应核对目标版本确已包含单网页改动。

删除源码入口不会停用或卸载用户电脑、其他工作区、插件缓存和开发会话中的旧副本。先按实际安装来源处理，不扫描未知目录或自动删除：

1. **marketplace 安装的独立插件**：用 `claude plugin list` 或宿主插件管理页核对 `recruiting-board@recruiting-copilot` 的来源与安装范围。用户决定停用后，可运行下列命令，`<实际范围>` 替换为已核实的 `user`、`project` 或 `local`；保留主插件，不使用停用全部插件的选项。

   ```bash
   claude plugin disable recruiting-board@recruiting-copilot --scope <实际范围>
   ```

2. **工作区旧副本或显式 plugin-dir**：先备份已确认的旧 `skills/recruit-board/`，核对 `.claude/skills` 等入口是否指向它。网页文件升级不会清除旧文件；在用户另行授权的停用中，将该副本的原生 `hooks/` 和嵌套 `.claude-plugin/` 移出发现目录或由宿主停用该来源，并移除该来源的显式 plugin-dir 启动参数。不要删除整个网页 Skill、共享 `model.mjs`、`types/` 或 `scripts/`，也不要覆盖插件缓存。
3. **独立开发预览**：在创建它的宿主开发入口停用已核实的 `recruiting-board-preview` 等预览来源。源码中的预览同步脚本已移除，不再用它更新已安装副本。
4. **升级与复核**：按原安装渠道更新主插件，或在备份后同步新网页 Skill 与六个工作流文档，保留工作区本地约定和业务文件。重新打开或重载会话，确认旧原生入口不再加载；按上文启动并用 connect 核验网页。旧任务、事项、候选台账和 `runtime/recruit-board/` 都保留，无需批量迁移后才能读取。

以上是用户升级时的操作指引，本次源码维护不执行停用、卸载或真实工作区升级。历史原生方案与验收记录保留用于追溯，当前交付以源码仓库的 `docs/adr/0003-web-only-board.md` 为准。

官方宿主支持参考：[Codex App Browser](https://developers.openai.com/codex/app/browser)、[WorkBuddy 右侧栏](https://www.workbuddy.cn/docs/workbuddy/From-Beginner-to-Expert-Guide/Function-Description/Right-Sidebar)。
