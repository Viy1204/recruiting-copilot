import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  compileEffectiveRules,
  evaluateCandidate,
  validateScreeningRules
} from '../skills/recruit-board/screen-gate-domain.mjs';
import {
  evaluateCandidateBatch,
  evaluateSingleCandidate,
  getEffectiveRoleRules,
  packRoleScreeningContext,
  screenGateCLI,
  screenGateError,
  validateScreeningRulesWorkspace
} from '../skills/recruit-board/scripts/screen-gate.mjs';

const sampleRules = {
  schemaVersion: 1,
  defaults: {
    maxAge: 35,
    minDegree: '本科',
    requireFullTime: true,
    excludeEducationTypes: ['专升本', '非全日制'],
    maxGapMonths: 6,
    maxRecentJobs: 3,
    exemptIfLongestTenureMonths: 24,
    maxInactiveDays: 30
  },
  schoolEquivalents: {
    虚构理工学院: '211'
  },
  excludedSchools: ['虚构独立学院'],
  roles: {
    星图程序岗: {
      minSchoolTier: '211',
      maxSalaryK: 30,
      allowedCities: ['深圳']
    },
    云帆工艺岗: {
      maxAge: null,
      minDegree: '大专',
      minExperienceByDegree: { 本科: 5, 大专: 7 },
      maxSalaryK: 22
    },
    'role-probe': {
      maxAge: 40
    }
  }
};

const sampleContext = [
  '# CONTEXT.md —— 虚构工作区',
  '',
  '## 一、公司与业务背景',
  '虚构研发公司，主营仪器仪表。',
  '',
  '## 二、招聘底层方法论',
  '- 懂原理 > 会用工具。',
  '',
  '## 三、初筛硬规则（全岗位通用）',
  '- 绝不自动在平台点不合适。',
  '',
  '## 四、在招岗位与优先级',
  '| 岗位 | 优先级 | 状态 | 对外 JD | 对内笔记 |',
  '|---|---|---|---|---|',
  '| 星图程序岗 | P0 | 在招 | `01-jd/星图程序岗.md` | `01-jd/_internal/星图程序岗.md` |',
  '| 云帆工艺岗 | P1 | 在招 | `01-jd/云帆工艺岗.md` | `01-jd/_internal/云帆工艺岗.md` |',
  '',
  '## 六、已对齐决策',
  '- 2026-11-01 这条历史决策不应被带进单岗上下文包。',
  ''
].join('\n');

async function createWorkspace(t, { rules = sampleRules, context = sampleContext, registry = null } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'recruit-screen-gate-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, '_shared'), { recursive: true });
  await mkdir(path.join(root, '01-jd/_internal'), { recursive: true });
  if (rules !== null) await writeFile(path.join(root, '_shared/screening-rules.json'), `${JSON.stringify(rules, null, 2)}\n`);
  if (context !== null) await writeFile(path.join(root, 'CONTEXT.md'), context);
  if (registry !== null) await writeFile(path.join(root, '_shared/roles.json'), `${JSON.stringify(registry, null, 2)}\n`);
  await writeFile(path.join(root, '01-jd/_internal/星图程序岗.md'), '# 星图程序岗对内笔记\n命脉：底层通信协议调优。\n');
  await writeFile(path.join(root, '01-jd/_internal/云帆工艺岗.md'), '# 云帆工艺岗对内笔记\n命脉：SMT 回流焊良率排查。\n');
  return root;
}

test('统一规则 + 单岗覆盖 + null 放宽合并准确且记录来源，非法规则被拒绝', () => {
  const star = compileEffectiveRules(sampleRules, '星图程序岗');
  assert.equal(star.rules.maxAge, 35);
  assert.equal(star.provenance.maxAge, 'default');
  assert.equal(star.rules.maxSalaryK, 30);
  assert.equal(star.provenance.maxSalaryK, 'role-override');
  assert.equal(star.rules.minSchoolTier, '211');

  // 云帆工艺岗用 null 放宽全局 maxAge
  const craft = compileEffectiveRules(sampleRules, '云帆工艺岗');
  assert.equal(Object.hasOwn(craft.rules, 'maxAge'), false);
  assert.equal(craft.provenance.maxAge, 'relaxed-by-role');
  assert.equal(craft.rules.minDegree, '大专');
  assert.equal(craft.provenance.minDegree, 'role-override');

  // 未配置单独覆盖的岗位自动继承 defaults
  const generic = compileEffectiveRules(sampleRules, '未覆写新岗');
  assert.equal(generic.hasRoleOverride, false);
  assert.equal(generic.rules.maxAge, 35);
  assert.equal(generic.rules.minDegree, '本科');

  // 非法配置校验
  assert.throws(() => validateScreeningRules({ schemaVersion: 2 }), error => error.code === 'SCREENING_RULES_INVALID');
  assert.throws(() => validateScreeningRules({ schemaVersion: 1, defaults: { maxAge: null } }), error => error.code === 'SCREENING_RULES_INVALID');
  assert.throws(() => validateScreeningRules({ schemaVersion: 1, defaults: { minAge: 40, maxAge: 30 } }), error => error.code === 'SCREENING_RULES_INVALID');
  assert.throws(
    () => compileEffectiveRules({ schemaVersion: 1, defaults: { minAge: 35 }, roles: { 甲岗: { maxAge: 30 } } }, '甲岗'),
    error => error.code === 'SCREENING_RULES_INVALID'
  );
});

test('确定性硬门槛预筛覆盖三态（通过 / 否决 / 缺字段）、院校等价、分学历年限与工龄豁免', () => {
  const star = compileEffectiveRules(sampleRules, '星图程序岗');

  // 1. 通过：院校等价命 211 + 跳槽 4 段但最长单段 30 月触发豁免
  const passed = evaluateCandidate(star, {
    name: '样例甲',
    age: 31,
    degree: '本科',
    fullTime: true,
    educationType: '统招',
    school: '虚构理工学院',
    expectedSalaryK: 28,
    gapMonths: 2,
    recentJobCount: 4,
    longestTenureMonths: 30,
    inactiveDays: 5,
    city: '深圳'
  });
  assert.equal(passed.verdict, 'PASS_HARD_GATES');
  assert.equal(passed.failedRules.length, 0);
  assert.equal(passed.missingFields.length, 0);

  // 2. 否决：超龄 + 专升本 + 黑名单院校 + 薪资超上限 + 城市不符
  const rejected = evaluateCandidate(star, {
    name: '样例乙',
    age: 38,
    degree: '本科',
    fullTime: true,
    educationType: '专升本',
    school: '虚构独立学院',
    expectedSalaryK: 36,
    gapMonths: 1,
    recentJobCount: 2,
    inactiveDays: 2,
    city: '北京'
  });
  assert.equal(rejected.verdict, 'REJECT_HARD_GATE');
  const failedNames = new Set(rejected.failedRules.map(item => item.rule));
  assert.ok(failedNames.has('maxAge'));
  assert.ok(failedNames.has('excludeEducationTypes'));
  assert.ok(failedNames.has('excludedSchools'));
  assert.ok(failedNames.has('maxSalaryK'));
  assert.ok(failedNames.has('allowedCities'));

  // 3. 缺字段：列表页缺 age 和 expectedSalaryK，且已提供字段均未触发否决 -> NEED_DETAIL
  const needDetail = evaluateCandidate(star, {
    name: '样例丙',
    degree: '本科',
    fullTime: true,
    schoolTier: '211',
    gapMonths: 0,
    recentJobCount: 1,
    inactiveDays: 1,
    city: '深圳'
  });
  assert.equal(needDetail.verdict, 'NEED_DETAIL');
  assert.ok(needDetail.missingFields.includes('age'));
  assert.ok(needDetail.missingFields.includes('expectedSalaryK'));

  // 4. 分学历年限门槛（云帆工艺岗：大专须 7 年，且全局 maxAge 已用 null 放宽）
  const craft = compileEffectiveRules(sampleRules, '云帆工艺岗');
  const seniorPass = evaluateCandidate(craft, {
    name: '样例丁',
    age: 42,
    degree: '大专',
    fullTime: true,
    experienceYears: 8,
    expectedSalaryK: 20,
    gapMonths: 0,
    recentJobCount: 1,
    inactiveDays: 4
  });
  assert.equal(seniorPass.verdict, 'PASS_HARD_GATES');

  const shortExpReject = evaluateCandidate(craft, {
    name: '样例戊',
    age: 29,
    degree: '大专',
    fullTime: true,
    experienceYears: 5,
    expectedSalaryK: 18,
    gapMonths: 0,
    recentJobCount: 1,
    inactiveDays: 4
  });
  assert.equal(shortExpReject.verdict, 'REJECT_HARD_GATE');
  assert.equal(shortExpReject.failedRules[0].rule, 'minExperienceByDegree');
});

test('pack 按单岗编译上下文：仅加载全局政策 + 单岗规则 + 本岗对内笔记，绝不混入其他岗位和历史决策', async t => {
  const root = await createWorkspace(t);
  const packed = await packRoleScreeningContext(root, '星图程序岗');
  assert.equal(packed.stats.loadedRoleCount, 1);
  assert.equal(packed.internalNote.status, 'ok');
  assert.ok(packed.markdown.includes('虚构研发公司'));
  assert.ok(packed.markdown.includes('底层通信协议调优'));
  assert.ok(packed.markdown.includes('"maxSalaryK": 30'));
  // 不含其他岗位的对内笔记、不含历史决策、不含多岗总表
  assert.ok(!packed.markdown.includes('SMT 回流焊良率排查'));
  assert.ok(!packed.markdown.includes('这条历史决策不应被带进单岗上下文包'));
  assert.ok(!packed.markdown.includes('云帆工艺岗'));
});

test('与可选 _shared/roles.json 协同：支持用岗位名称反查按固定 roleId 配置的覆盖规则', async t => {
  const root = await createWorkspace(t, {
    registry: {
      schemaVersion: 1,
      roles: [{ id: 'role-probe', name: '探头硬件岗', internalPath: '01-jd/_internal/星图程序岗.md' }],
      listings: []
    }
  });
  const effective = await getEffectiveRoleRules(root, '探头硬件岗');
  assert.equal(effective.matchedRoleKey, 'role-probe');
  assert.equal(effective.rules.maxAge, 40);
  assert.equal(effective.provenance.maxAge, 'role-override');
  assert.equal(effective.internalPath, '01-jd/_internal/星图程序岗.md');
});

test('批量预筛、CLI 端到端与符号链接越权保护', async t => {
  const root = await createWorkspace(t);
  const validated = await validateScreeningRulesWorkspace(root);
  assert.equal(validated.valid, true);
  assert.equal(validated.roleOverrideCount, 3);

  const batch = await evaluateCandidateBatch({
    workspace: root,
    role: '星图程序岗',
    candidates: [
      { name: '合格甲', age: 30, degree: '本科', fullTime: true, schoolTier: '985', expectedSalaryK: 25, gapMonths: 0, recentJobCount: 1, inactiveDays: 1, city: '深圳' },
      { name: '超龄乙', age: 40, degree: '本科', fullTime: true, schoolTier: '985', expectedSalaryK: 25, gapMonths: 0, recentJobCount: 1, inactiveDays: 1, city: '深圳' },
      { name: '缺龄丙', degree: '本科', fullTime: true, schoolTier: '211', expectedSalaryK: 25, gapMonths: 0, recentJobCount: 1, inactiveDays: 1, city: '深圳' }
    ]
  });
  assert.deepEqual(batch.summary, { total: 3, pass: 1, reject: 1, needDetail: 1 });

  const single = await evaluateSingleCandidate({
    workspace: root,
    role: '星图程序岗',
    candidate: { name: '合格甲', age: 30, degree: '本科', fullTime: true, schoolTier: '985', expectedSalaryK: 25, gapMonths: 0, recentJobCount: 1, inactiveDays: 1, city: '深圳' }
  });
  assert.equal(single.verdict, 'PASS_HARD_GATES');

  const mdPack = await screenGateCLI(['pack', '--workspace', root, '--role', '星图程序岗', '--format', 'md']);
  assert.equal(typeof mdPack, 'string');
  assert.ok(mdPack.includes('单岗初筛上下文包：星图程序岗'));

  await assert.rejects(screenGateCLI(['unknown', '--workspace', root]), error => {
    const formatted = screenGateError(error);
    assert.equal(formatted.error.code, 'SCREEN_GATE_INPUT_INVALID');
    return true;
  });

  // 符号链接越权保护
  const outside = await mkdtemp(path.join(tmpdir(), 'recruit-outside-gate-'));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await writeFile(path.join(outside, 'rules.json'), JSON.stringify(sampleRules));
  await rm(path.join(root, '_shared/screening-rules.json'));
  await symlink(path.join(outside, 'rules.json'), path.join(root, '_shared/screening-rules.json'));
  await assert.rejects(validateScreeningRulesWorkspace(root), error => error.code === 'SCREEN_GATE_UNSAFE' && error.status === 403);
});
