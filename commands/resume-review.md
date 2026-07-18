---
description: 收取或评估简历（本地文件，或飞书邮箱的猎聘/BOSS 简历邮件）
---

读取并严格执行 `${CLAUDE_PLUGIN_ROOT}/skills/resume-review/SKILL.md` 的流程。如 $ARGUMENTS 指定本地简历，直接评估；如要求查飞书邮箱，按其时间范围收取猎聘/BOSS 附件后评估；未指定任何输入则询问要评估本地文件还是收取邮箱简历。标准从工作区 CONTEXT.md 现读；只收取、评估和落档，不对外做任何动作。
