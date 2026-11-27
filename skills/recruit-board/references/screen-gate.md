# 单岗上下文编译与硬门槛预筛（`_shared/screening-rules.json`）

当工作区同时在招多个岗位时，不建议每次筛选一份简历都把全量岗位规则读一遍。推荐用 `skills/recruit-board/scripts/screen-gate.mjs` 把筛选拆成两步：

1. **脚本层（O(1) 确定性）**：读取「全岗位统一规则 + 仅本岗差异覆盖」，先用代码毫秒级过一遍客观硬门槛，并只为通过的人拼出**单岗精简上下文包**；
2. **大模型层（语义深评）**：只看通过硬门槛的候选人，结合本岗一份对内笔记做命脉技能、项目深度和沟通判断。

## 配置文件：`_shared/screening-rules.json`（可选）

```json
{
  "schemaVersion": 1,
  "defaults": {
    "maxAge": 35,
    "minDegree": "本科",
    "requireFullTime": true,
    "excludeEducationTypes": ["专升本", "非全日制"],
    "maxGapMonths": 6,
    "maxRecentJobs": 3,
    "exemptIfLongestTenureMonths": 24,
    "maxInactiveDays": 30
  },
  "schoolEquivalents": {
    "虚构理工学院": "211"
  },
  "excludedSchools": ["虚构独立学院"],
  "roles": {
    "星图程序岗": {
      "minSchoolTier": "211",
      "maxSalaryK": 30,
      "allowedCities": ["深圳"]
    },
    "云帆资深岗": {
      "maxAge": null,
      "minExperienceByDegree": { "本科": 5, "大专": 7 },
      "minDegree": "大专"
    }
  }
}
```

### 继承规则

- `defaults`：所有岗位默认生效的统一硬门槛。
- `roles[roleKey]`：**只写与统一规则不同的差异项**（支持标准岗位名或固定 `roleId`）；
  - 未写的字段自动继承 `defaults`；
  - 写具体值则覆盖 `defaults`；
  - 显式写 `null` 表示**本岗取消/放宽该全局限制**（例如上例中 `云帆资深岗` 的 `"maxAge": null` 取消了全局 35 岁上限）。

## 共用 CLI：`skills/recruit-board/scripts/screen-gate.mjs`

```bash
# 1. 校验规则配置与各岗位合并后区间一致性
node skills/recruit-board/scripts/screen-gate.mjs validate --workspace <目录>

# 2. 查看单个岗位的生效规则及每项来源（default / role-override / relaxed-by-role）
node skills/recruit-board/scripts/screen-gate.mjs effective-rules --workspace <目录> --role 星图程序岗

# 3. 编译单岗极简上下文包（全局统一政策 + 本岗合并规则 + 仅本岗一份对内笔记，不含其他岗位与历史决策）
node skills/recruit-board/scripts/screen-gate.mjs pack --workspace <目录> --role 星图程序岗 --format md

# 4. 单人客观硬门槛预筛（返回 PASS_HARD_GATES / REJECT_HARD_GATE / NEED_DETAIL）
node skills/recruit-board/scripts/screen-gate.mjs evaluate \
  --workspace <目录> \
  --role 星图程序岗 \
  --input '{"name":"样例甲","age":31,"degree":"本科","fullTime":true,"school":"虚构理工学院","experienceYears":6,"expectedSalaryK":26,"gapMonths":1,"recentJobCount":2,"inactiveDays":3,"city":"深圳"}'

# 5. 批量预筛候选人卡片数组（先过滤掉明显不符项，再把通过者交给大模型深评）
node skills/recruit-board/scripts/screen-gate.mjs evaluate-batch \
  --workspace <目录> \
  --role 星图程序岗 \
  --input-file runtime/candidates-batch.json
```
