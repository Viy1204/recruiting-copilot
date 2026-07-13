# 双通道寻源命令与坑

命令细节的权威是 `boss help` / `liepin help`；这里只放**编排流程实际用到的调用形态**和实测踩过的坑。
两个 CLI 都驱动本机真实浏览器（Chrome/Edge），需要先各跑一次 `boss login` / `liepin login` 扫码登录，登录态持久化。

## Boss 直聘（`@joohw/boss-cli`）

| 目的 | 命令 |
|---|---|
| 查未读 | `boss list --unread` |
| 岗位槽位（拿"开放中"岗位名做 `--job` 匹配） | `boss positions` |
| 人才库搜索（**姓名打码**，全网牛人） | `boss search <关键词...> --job <岗位关键字> [--greet auto｜--greet 序号,序号]` |
| 推荐池（**姓名不打码**，每人标「可打招呼/已打招呼」） | `boss recommend <岗位关键字>` |
| 推荐/搜索页逐名打招呼 | `boss greet <姓名> --job <岗位关键字>` |
| 在线简历预览（**耗每日查看额度**，按需） | `boss preview <姓名> --job <岗位关键字>` |
| 打开会话 / 取简历 | `boss chat "<姓名>"` → `boss action resume` |

关键行为与坑：
- **`boss search --greet auto`**：同一次调用内读列表 → 按内置硬规则（学历+年龄标签，缺失保守跳过）自动筛 → 逐个点，
  自带间隔，连续 2 次无效果自动止损。⚠️ 列表每次调用重排，**序号只在同次调用内有效**——auto 最稳，
  想打特定人用 `boss greet <姓名>`，别靠序号跨调用。
- **已打过的人卡片按钮是「联系Ta」**——auto 会跳过，不算失败。
- **`boss recommend` + `boss greet <名>` 更稳**：推荐页按岗位圈定、名字不打码可精确打。
  循环打太快撞列表刷新会偶发失败，间隔 ≥3s + 失败重试一次即可。
- **取简历**：顺序执行、每批 3-5 人；失败加 `--strict` 重试，仍失败标"未获取"，别反复重试烧时间。

## 猎聘（`@viyzhu/liepin-cli`，招聘者端，`--json` 友好）

| 目的 | 命令 |
|---|---|
| 查未读 | `liepin chatlist --json`（过滤 `unread_count` 非 "0"） |
| 拿 ejobId（打招呼要绑职位） | `liepin joblist --json` |
| 搜索（返回 resume_id/im_id/user_id/age/degree...） | `liepin search "<关键词>" --city <城市> --json` |
| 推荐（**无 age 字段**，年龄硬规则难核） | `liepin recommend --json` |
| 投递池 | `liepin talent` |
| 查简历 | `liepin resume <talentId>` |
| 打招呼（自定义消息，绑职位） | `liepin greet <resume_id> --ejobId <职位ID> --message "话术" --json` |

关键行为与坑：
- `search`/`recommend` 输出的 JSON 前面有非 JSON 前缀（"正在跳转…"），解析时从第一个 `[` 截取。
- **打招呼绑的是 `resume_id`（不是 user_id）**，`--ejobId` 从 joblist 取；只有 resume_id 支持 `--message`。
- **recommend 无 age 字段**：如果 CONTEXT 有年龄硬规则，推荐池难核验——谨慎打，优先 search。
- **greet 前查 `liepin chatlist` 或台账去重**：对已建会话会**重发消息**，别重复骚扰已联系的人。
- 猎聘候选人的 `resume_id` 记进台账备注（`rid=<resume_id>`），后续打招呼/查简历要用。

## 渠道分工

哪个岗位哪边池子肥，是**跑出来的结论不是猜的**：每轮寻源后把"某岗某渠道有效/无效"的观察
写进你自己的 `CONTEXT.md`（渠道结论沉淀在"已对齐决策"或岗位表备注），下轮按结论分配精力。
没有结论之前，每岗两边都跑。

## 浏览器 / 稳定性坑

- **别在 boss 命令跑着的时候，用别的工具/脚本连同一个浏览器的调试端口**——会话竞争会把浏览器
  远程调试拧死，之后 boss 命令报超时。诊断脚本用完立即断开。
- **恢复方法**：结束掉 CLI 拉起的那个浏览器主进程（登录态在 profile 里持久化），下条命令自动重启且仍登录。
- **后台跑批量 greet 别用管道过滤**（`| sed` / `| tail`）再落文件——管道要等 EOF 才输出，
  会误判"空/卡住"；要么前台跑给足超时，要么全量落文件事后再筛。
- **平台改版高频**：选择器失效、新弹层出现是常态。命令报错先升级 CLI（`npm update -g`），
  再看是不是平台改版，别自己写浏览器脚本硬闯。
