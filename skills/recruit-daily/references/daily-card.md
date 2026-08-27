# 日报卡片推送（可选补充环节）

日报落地成文档之后，多加一步：往 IM 里推一张**互动卡片**，让老板/自己在手机上三秒看完结论，
需要细节再点按钮跳文档。这是 [`ledger-and-report.md`](ledger-and-report.md) 第 7 步「出日报」的补充，
**不替代文档**——卡片是通知层，文档是内容层，两者从同一份台账同步。

**没有 IM 通道（没装 lark-cli 或不用飞书）→ 整步跳过**，把日报文件路径回给用户就算完。不要为了凑步骤伪造推送。

## 什么时候做

- 每日流水线跑完、日报文档/文件已生成，且用户希望在 IM 收到提醒。
- 用户明确说「日报也发我卡片」「推到群里」「发飞书」。
- 一旦用户提过一次要卡片，后续每天默认都出卡片（这属于交付格式偏好，不是每次都要重新确认的对外动作——
  但**发送对象变了要重新确认**：私聊换群、加新收件人，都要问）。

## 铁律：校验通过 ≠ 可以发

卡片有两道门禁，缺一道就会推出去一张「技术上合法、看起来很业余」的卡：

1. **Schema 校验**（机器）：JSON 结构、字段名、枚举值合法。
2. **美观度自评**（人/AI 自查）：结构是否承载得起内容。

第 2 道最容易被跳过。判据很简单——**如果一张卡只有 header + 几大块 markdown + 一个按钮，就是不合格的**，
因为它没有任何结构化承载：数字没有指标面、状态没有标签、长明细没有折叠、重点人选和普通信息一个颜色。
自查四问：

- 第一屏 3 秒内能读出「今天什么情况 / 最重要的是谁 / 要我做什么」吗？
- 每个数字是否落在指标面里，而不是埋在句子中间？
- 每个状态标签是否对应真实状态（`已打招呼` / `待你拍板` / `0 人可打`），而不是为了好看凑的？
- 单块文本是否一屏内可扫读（经验值：**单块 ≤180 字符**，超了就拆成结构，而不是拆成更多段散文）？

## 日报卡片的标准骨架

按这个顺序搭，内容多寡自行增删，但**五层结构别缺**：

1. **首屏指标面** —— 4 格分栏，放当天最硬的四个数字：`未读处理` / `打招呼` / `台账新增` / `待你确认`。
   待确认数用警示色（橙），其余默认色。这一层就是「3 秒结论」。
2. **重点人选卡（每人一块）** —— 一块只放一个人：姓名 ｜ 岗位 ｜ 状态标签，第二行放年龄/学历/城市/带宽，
   第三行放命脉信号（加粗命中的硬要求）。用底色区分性质：
   - 常规推进（已打招呼、已回复）→ 中性灰面
   - **需要老板拍板**（如强候选但撞硬门槛）→ 警示面（橙），标签写 `待你拍板`
3. **待确认清单** —— 信息面（蓝），编号列出等用户拍板的事项，每条一句话、带上「为什么需要你」。
4. **其余岗位明细** —— 收进**折叠面板**，默认收起。每岗一行摘要 + 状态标签（`打招呼 N` / `0 人可打` / `保留 N`）。
   这是控制卡片长度的关键：主线放外面，长尾折进去。
5. **跳转按钮** —— 主按钮填充样式、文案用具体动词（`打开完整日报`），链接指向第 7 步生成的日报文档。
   **链接必须是真实生成的 URL**；文档没建成就别放按钮，改成一行文字说明日报在本地哪个路径。

## 内容红线（与日报同源）

- 平台打码名在卡片里**保持打码**（`张**`），别为了好看补全。
- 候选人联系方式（手机/微信/邮箱）**一律不进卡片**，留在台账与简历文件里。
- 商业敏感信息（薪资带宽对外口径、竞品、内部代号）按 CONTEXT 的标注决定能不能进；
  发到**群**里比私聊风险高一档，群发前把敏感项摘掉。
- 数字必须来自台账，不许估。台账里没有的口径（比如「转化率」）就不放这一格。

## 飞书实现（Card JSON 2.0）

有卡片生成 skill（如 `create-lark-card`）就走它，能拿到官方 schema 与校验器；没有就照上面骨架手写，
再用下面这套字段清单自查。**别用 schema 1.0 的写法**（`tag: "action"` 之类在 2.0 里不合法）。

对应关系：

| 骨架层 | 组件 | 关键字段 |
|---|---|---|
| 首屏指标面 | `column_set` + 4 × `column` | `flex_mode: "bisect"`、`background_style`、每列 `padding` |
| 重点人选卡 | `interactive_container` | `background_style`、`corner_radius`、`padding`、**`behaviors: []`**（无交互也必填） |
| 状态标签 | markdown 内联 | `<text_tag color='green'>已打招呼</text_tag>` |
| 待确认清单 | `interactive_container` | 同上，底色用信息面 |
| 其余岗位明细 | `collapsible_panel` | `expanded: false`、`header.title` / `header.expanded_title` |
| 跳转按钮 | `button` | `type`、`width`、`behaviors: [{ type: "open_url", default_url: <真实URL> }]` |

**实测踩过的字段坑**（校验器会报 `additionalProperties`）：

- `column_set` **不接受** `padding` / `corner_radius` —— 内边距要下放到每个 `column`。
- `collapsible_panel` 的底色字段是 **`background_color`**，不是 `background_style`（`interactive_container` 才用后者）。
- `img` 组件**必须有真实 `img_key`**（先上传拿 key）。没有可用图就整个不写图片组件，
  **绝不写 `TODO_IMG_KEY` 之类占位 key**，否则渲染直接报 `card contains invalid image keys`。
- 发 `interactive` 消息时，`--content` 传**卡片对象本身**，不要再包一层 `{"msg_type":"interactive","card":...}`。

发送（先取收件人 open_id，再发）：

```bash
# 发给自己：先拿 open_id
lark-cli contact +get-user --as user

# 发送（有 jq）
lark-cli im +messages-send --user-id <ou_xxx> --msg-type interactive --content "$(jq -c . card.json)" --as bot

# 发送（没有 jq，Windows 常见；注意先设 UTF-8 否则中文/emoji 报 GBK 编码错）
export PYTHONIOENCODING=utf-8
CONTENT=$(python -c "import json;print(json.dumps(json.load(open('card.json',encoding='utf-8')),ensure_ascii=False,separators=(',',':')))")
lark-cli im +messages-send --user-id <ou_xxx> --msg-type interactive --content "$CONTENT" --as bot
```

发群把 `--user-id` 换成 `--chat-id oc_xxx`。`--as bot` 报权限错再试 `--as user`。

## 完成判据

- 卡片过了 schema 校验，且过了上面四问的美观度自查（**两道都过才发**）。
- 五层结构齐：指标面 / 重点人选 / 待确认 / 折叠明细 / 真实链接按钮。
- 卡片里的数字与台账一致；打码名保持打码；无联系方式、无占位 img_key、无编造链接。
- 发送成功后把 `message_id` 与收件人回给用户；失败则报清楚缺的是权限、登录还是收件人 ID，别静默重试。
