---
description: 分轮批量梳理一个岗位的真实招聘要求
---

读取并严格执行 `${CLAUDE_PLUGIN_ROOT}/skills/recruit-grill/SKILL.md` 的流程，对 $ARGUMENTS 指定的岗位（未指定且无法从上下文确定时再问岗位）先读已有资料，分轮批量确认关键缺口，产出对外 JD、对内笔记、CONTEXT.md 更新和初始搜索词。
