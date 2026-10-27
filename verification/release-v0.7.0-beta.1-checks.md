# v0.7.0-beta.1 发布验收

2026-10-23 对现有招聘看板及流程接入做发布前复验。所有业务写入只针对 `verification/recruit-board-demo/` 合成目录，不读取或更新真实招聘工作区。

## 发布范围

主包、主插件与可选原生看板统一为 `0.7.0-beta.1`。GitHub 发行使用预发布标签，正式版仍为 `v0.6.6`；固定版本安装、已有工作区升级和回退见 [试用说明](../docs/releases/v0.7.0-beta.1.md)。不包含开发期整窗截图、私有部署记录、真实工作区业务汇总或本机 Preview 配置。

## 自动化验证

- 本机 Node v24.9.0：`npm test` 130 项通过，0 失败、0 跳过。包括主包、主插件和原生插件版本同步约束。
- 现成 2.1.299 引擎的 `plugin test skills/recruit-board`：41 项通过，0 失败。匹配引擎严格插件校验通过；主插件与 marketplace 结构校验通过。
- 依赖安装脚本回归通过。工作区注册脚本在 WSL Ubuntu 上直接运行仓库 LF 文件通过；Git Bash 原生符号链接权限不足的失败保持为环境限制，不记为该环境成功。
- 实际生成并解包 npm 包，核对网页、模型、脚本、原生 hooks、版本与试用文档；解包脚本可列出六类工作流，Linux 可执行包内安装脚本帮助。

## 本轮修复

- 外部网页点击本机看板链接时，标准跨站顶层导航被原同源检查误拦为 403。新增公共回归先复现失败，最小修复只允许首页 GET 的 navigate/document 引导；API 跨站访问、异常 Origin、Host 与工作区键校验继续拒绝。相关 HTTP 回归通过。
- Windows `core.autocrlf` 会让 npm 包保留 CRLF，Linux sh 在 `set` 处解析失败。以 `.gitattributes` 固定全部 shell 脚本为 LF，规范本机脚本后重打包，WSL 注册回归与包内脚本执行通过。

## 实际网页验证

Preview 启动合成服务，connect 核验 service、capabilities 与 canonical 工作区键。页面可见任务等待状态、最近三条记录、5 人结果与 2 人待确认；点击合成候选资料，TXT、Markdown 和 PDF 入口按需列出，Markdown 正文实际可读。

独立合成任务完成 start → unread → screen → decision/wait → resolve → complete。页面跟随最新任务、固定阅读上下文和回到最新均可用，确认数从 1 变为 0，最终 2 个步骤完成、7 个明确跳过。创建的验证任务完成后清理，不加入发行演示数据。

网页将“测试研发岗”保存为暂停后，CLI 读回暂停；再由网页恢复在招。原 `CONTEXT.md` SHA256 完全恢复为 `0835b568ce49564e9c243ae2e882e1ebe365ff62a1d040681b1377560e314e6c`，备份文件保留本地但不加入发行。

控制台无运行错误。网络记录中有页面生命周期导致的已取消 snapshot 请求（HTTP 200、`ERR_ABORTED`），不将其称为零失败请求；保存请求与最终读取成功。

## 验证边界

原生 41 项测试使用模拟文件与进程，不等于新版原生布局、真实 Node/PATH 或其他宿主的实机验收。本轮未重新实机验证原生新版布局及 Codex App、WorkBuddy 内打开。PDF 本轮验证附件关联与读取接口，未把 HTTP 成功宣称为系统阅读器呈现成功。网页要求支持 `AbortSignal.timeout` 与 `AbortSignal.any` 的现代浏览器。

一周生产试用由此版本开始，当前结果不代表已完成该周期。
