# DeepSeek Harness 插件（bundle）

本目录把 recruiting-copilot 打包成 DeepSeek Harness 的 **profile bundle**：

- `package.json`（仓库根）声明 `"dsh": { "bundle": { "patch": "./dsh/cordis.patch.yml" } }`，
  这是 DSH 识别插件包的约定（与 `@deepseek-ai/dsh-base` 等内置 bundle 同构）。
- `cordis.patch.yml` 是 profile 的 patch 层：启用宿主 `skill-filesystem` 行，
  并把本包 `skills/` 目录挂为全局自定义 skill 根（rank 300，custom 源）。

## 安装 / 更新 / 卸载

```bash
# 安装（web 界面 profile 示例；headless 等其它 profile 同理）
dsh plugin --profile web add git+https://github.com/Viy1204/recruiting-copilot.git

# 更新（git 依赖会重新拉取最新提交）
dsh plugin --profile web update recruiting-copilot

# 卸载
dsh plugin --profile web remove recruiting-copilot
```

安装后重启 DSH 会话，`skills/` 下 7 个 skill（ask-viy、recruit-init、
recruit-grill、recruit-daily、resume-review、interview-schedule、
market-talent-mapping）会在任意工作区的 skill 目录出现。

## 原理速览

- DSH 的 `dsh plugin` 命令把剩余参数转发给 profile 目录里的 `pnpm`，
  装完后按「安装状态」对账 `dsh.profile.bundles`：装进来的包若声明了
  `dsh.bundle.patch` 就自动加入 bundle 层栈。
- patch 里的 `!!js` 表达式在加载器 ctx 作用域求值：`ctx.baseUrl` 即 profile
  目录，因此能定位到 `node_modules/recruiting-copilot/skills`，无需硬编码路径。
- 内置 profile 把宿主 `skill-filesystem` 行 disabled（preset 各自做 per-agent
  发现）；本 patch 重新启用并注册 custom 根，属于官方注释认可的
  "deployment-level provider" 用法。

## 本地验证（改动后必做）

```bash
cd 本仓库
npm pack            # 产物应包含 dsh/ 与 skills/
dsh plugin --profile web add ./recruiting-copilot-<version>.tgz
dsh --profile web --dump-config | grep -A 6 skill-filesystem
```
