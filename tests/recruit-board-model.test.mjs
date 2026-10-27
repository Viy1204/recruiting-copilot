import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildSnapshot, candidateStatus, createRun, LEDGER_COLUMNS, MAX_RUN_RESULTS, readCandidates, readConfig, readRoles, ROLE_SCOPES,
  runSummary, selectRole, selectRoles, selectTask, stageForStatus, summarizeRunResults, transitionRun, validateRun
} from '../skills/recruit-board/model.mjs';

const header = `${LEDGER_COLUMNS.join(',')}\n`;
const row = (name, role, status, rating = 'A') => ['1', name, role, '', rating, status, 'test', '', '私密备注不进入快照'].join(',');
const now = '2026-10-22T01:00:00.000Z';
const later = '2026-10-22T01:01:00.000Z';
const context = '## 四、在招岗位与优先级\n\n| 状态 | 对外 JD | 岗位 | 优先级 |\n|---|---|---|---|\n| 在招 | x | 合成程序岗 | P0 |\n| 已关闭 | y | 合成动画岗 | P1 |\n| 在招 | z | 空岗位 | P2 |\n';
const sources = (ledger = header, runFiles = { status: 'missing' }) => ({
  workspace: 'synthetic', generatedAt: now,
  ledger: { status: 'ok', text: ledger, updatedAt: now },
  context: { status: 'ok', text: context, updatedAt: now }, runFiles
});

test('九列 CSV 支持 BOM、quoted 逗号、转义引号、CRLF 与引号内换行，不泄漏私密列', () => {
  const csv = '﻿' + header.replace('\n', '\r\n') + '1,"合成,甲","合成""岗位",背景,A,已回复,test,private.pdf,"联系方式\r\n私密备注"\r\n';
  const { candidates } = readCandidates(csv);
  assert.deepEqual(candidates.map(c => [c.name, c.role, c.rawStatus, c.stage]), [['合成,甲', '合成"岗位', '已回复', 'talking']]);
  assert.equal(JSON.stringify(candidates).includes('联系方式'), false);
  assert.equal(JSON.stringify(candidates).includes('private.pdf'), false);
});

test('CSV 损坏、空文件、列数错误与无去重键均显式报错', () => {
  for (const bad of ['', 'wrong header\n', `${header}1,"未闭合`, `${header}1,甲,岗,,,,`, `${header}1,甲"乙,岗,,,,,,`, `${header}1,"甲"尾,岗,,,,,,`, `${header}1,,岗,,,,,,`, `${header},,,,,,,,`, `${header}""\n`]) {
    assert.throws(() => readCandidates(bad), /CSV/);
  }
  assert.deepEqual(readCandidates(header).candidates, []);
});

test('所有约定状态精确映射；未知、包含状态字样的文本均未归类', () => {
  const expected = [
    ['未初筛', 'screen'], ['待初筛', 'screen'], ['初筛通过', 'contact'], ['已打招呼', 'talking'], ['已回复', 'talking'],
    ['待确认', 'decision'], ['观望', 'decision'], ['已约谈', 'interview'], ['面试中', 'interview'],
    ['offer', 'offer'], ['已发offer', 'offer'], ['已接受offer', 'offer'], ['入职', 'joined'], ['已入职', 'joined'],
    ['初筛不合适', 'ended'], ['已拒', 'ended'], ['已排除', 'ended'], ['  OFFER  ', 'offer'],
    ['可能已入职', 'unclassified'], ['offer待确认', 'unclassified'], ['', 'unclassified']
  ];
  for (const [status, stage] of expected) assert.equal(stageForStatus(status), stage, status);
});

test('姓名＋岗位去重，状态冲突计一人但保留未能决定状态，同名异岗独立', () => {
  const parsed = readCandidates(header + [row('合成甲', '程序', '初筛通过'), row('合成甲', '程序', '已回复'), row('合成甲', '动画', '已回复'), row('合成乙', '程序', 'offer'), row('合成乙', '程序', 'OFFER')].join('\n'));
  assert.equal(parsed.candidates.length, 3);
  const conflict = parsed.candidates.find(c => c.role === '程序' && c.name === '合成甲');
  assert.equal(conflict.rawStatus, null);
  assert.equal(conflict.stage, 'unclassified');
  assert.equal(conflict.conflict, true);
  assert.deepEqual(conflict.statuses, ['初筛通过', '已回复']);
  assert.match(candidateStatus(conflict), /冲突/);
  assert.ok(parsed.diagnostics.some(d => d.code === 'DUPLICATE_CONFLICT'));
  assert.equal(parsed.candidates.find(c => c.name === '合成乙').stage, 'offer');
  const ratingConflict = readCandidates(header + [row('合成丙', '程序', '初筛通过', 'A'), row('合成丙', '程序', '初筛通过', 'B')].join('\n'));
  assert.equal(ratingConflict.candidates[0].conflict, true);
  assert.equal(ratingConflict.candidates[0].stage, 'unclassified');
  assert.equal(ratingConflict.candidates[0].rawStatus, '初筛通过');
  assert.equal(ratingConflict.candidates[0].rating, null);
  assert.match(candidateStatus(ratingConflict.candidates[0]), /评级冲突/);
});

test('岗位仅解析指定段落里的 header 表，列顺序可变，关闭岗位保留，忽略模板占位与历史', () => {
  const text = `${context}| 在招 | z | （待梳理） | |\n\n## 六、已对齐决策\n\n| 状态 | 岗位 | 优先级 |\n|---|---|---|\n| 在招 | 历史岗位 | P0 |\n`;
  const roles = readRoles(text);
  assert.deepEqual(roles.map(role => role.name), ['合成程序岗', '合成动画岗', '空岗位']);
  assert.equal(roles[1].status, '已关闭');
  assert.throws(() => readRoles('## 历史\n' + context.split('\n').slice(2).join('\n')), /未读取岗位配置/);
  assert.throws(() => readRoles('## 在招岗位与优先级\n尚未填写\n### 历史决定\n' + context.split('\n').slice(2).join('\n')), /未读取岗位配置/);
});

test('空表是零人；未配置岗位从 CSV 回退且不推断开关；已读空岗位可选为零', () => {
  const snapshot = buildSnapshot(sources());
  assert.equal(snapshot.status, 'ok');
  assert.equal(selectRole(snapshot, '空岗位').total, 0);
  assert.equal(selectRole(snapshot, '不存在的岗位').total, null);
  assert.ok(snapshot.roles.some(role => role.name === '空岗位' && role.configured));
  const input = sources(header + row('合成甲', '台账岗位', '其他'));
  input.context = { status: 'missing' };
  const fallback = buildSnapshot(input);
  assert.equal(fallback.status, 'partial');
  assert.deepEqual(fallback.roles, [{ name: '台账岗位', priority: null, status: null, configured: false }]);
  assert.ok(fallback.diagnostics.some(d => d.code === 'ROLES_UNREADABLE'));
});

test('缺失或坏台账人数未知；有上次成功快照时保留并显式标陈旧，恢复后清除', () => {
  const input = sources(); input.ledger = { status: 'missing' };
  const missing = buildSnapshot(input);
  assert.equal(missing.status, 'error');
  assert.equal(missing.candidates, null);
  assert.ok(missing.stages.every(stage => stage.count === null));
  const good = buildSnapshot(sources(header + row('合成甲', '合成程序岗', '已约谈')));
  input.ledger = { status: 'ok', text: 'bad' };
  const stale = buildSnapshot(input, good);
  assert.equal(stale.status, 'stale');
  assert.equal(stale.sources.ledger.status, 'stale');
  assert.equal(stale.candidates.length, 1);
  assert.equal(stale.ledgerUpdatedAt, now);
  assert.equal(buildSnapshot(sources(), stale).status, 'ok');
});

const compatibility = (value = {}) => ({ schemaVersion: 1, statusStages: {}, roleAliases: {}, ...value });
const configSource = value => ({ status: 'ok', text: JSON.stringify(compatibility(value)), updatedAt: now });

test('本地完整状态精确映射，保留原文与未知明细；自定义覆盖不消除重复冲突', () => {
  const config = readConfig(JSON.stringify(compatibility({ statusStages: { ' 已沟通-待答复 ': 'talking', ' Custom ': 'decision', 观望: 'contact' } })));
  assert.equal(stageForStatus('已沟通-待答复', config.statusStages), 'talking');
  assert.equal(stageForStatus('CUSTOM', config.statusStages), 'decision');
  assert.equal(stageForStatus('观望', config.statusStages), 'contact');
  assert.equal(stageForStatus('观望'), 'decision');
  assert.equal(stageForStatus('已沟通-待答复-补充', config.statusStages), 'unclassified');
  const parsed = readCandidates(header + [row('合成甲', '原岗位', '已沟通-待答复'), row('合成乙', '原岗位', '陌生状态'), row('合成丙', '原岗位', '陌生状态')].join('\n'), config);
  assert.equal(parsed.candidates[0].rawStatus, '已沟通-待答复');
  assert.equal(parsed.candidates[0].stage, 'talking');
  assert.deepEqual(parsed.unknownStatuses, [{ status: '陌生状态', count: 2 }]);
  assert.ok(parsed.diagnostics.some(item => item.code === 'UNKNOWN_STATUS' && /陌生状态.*2/.test(item.message)));
  assert.ok(parsed.diagnostics.every(item => !/合成甲|合成乙|合成丙/.test(item.message)));
  const intentional = readCandidates(header + row('合成甲', '原岗位', '含义待核'), { statusStages: { 含义待核: 'unclassified' } });
  assert.equal(intentional.candidates[0].stage, 'unclassified');
  assert.deepEqual(intentional.unknownStatuses, []);
  assert.ok(!intentional.diagnostics.some(item => item.code === 'UNKNOWN_STATUS'));
  const conflicts = readCandidates(header + [row('合成甲', '原岗位', '已沟通-待答复'), row('合成甲', '原岗位', '已回复')].join('\n'), config);
  assert.equal(conflicts.candidates[0].stage, 'unclassified');
  assert.equal(conflicts.candidates[0].rawStatus, null);
});

test('兼容配置整份校验版本、精确键、阶段值、别名目标和链，说明元数据不参与执行', () => {
  const roles = readRoles(context);
  const valid = compatibility({ roleAliases: { ' 原岗位 ': ' 合成程序岗 ' }, description: '仅说明', source: { note: '不参与执行' }, verifiedAt: '2026-10-22' });
  assert.deepEqual(readConfig(JSON.stringify(valid), roles).roleAliases, { 原岗位: '合成程序岗' });
  const invalid = [
    '{', 'null', '[]', JSON.stringify({ schemaVersion: 2 }),
    JSON.stringify(compatibility({ statusStages: { ' ': 'talking' } })),
    JSON.stringify(compatibility({ statusStages: { a: 'talking', ' A ': 'ended' } })),
    JSON.stringify(compatibility({ statusStages: { a: 'unknown-stage' } })),
    JSON.stringify(compatibility({ statusStages: [] })),
    JSON.stringify(compatibility({ roleAliases: { ' ': '合成程序岗' } })),
    JSON.stringify(compatibility({ roleAliases: { 原岗位: '合成程序岗', ' 原岗位 ': '合成动画岗' } })),
    JSON.stringify(compatibility({ roleAliases: { 原岗位: '不存在岗位' } })),
    JSON.stringify(compatibility({ roleAliases: { 原岗位: '中间岗位', 中间岗位: '合成程序岗' } })),
    JSON.stringify(compatibility({ roleAliases: { 原岗位: '原岗位' } })),
    JSON.stringify(compatibility({ unexpected: true }))
  ];
  for (const text of invalid) assert.throws(() => readConfig(text, roles), /配置|JSON|别名/);
});

test('岗位别名用于筛选但仍按原岗位去重，同名归组碰撞不丢记录且组合岗位不猜归属', () => {
  const input = sources(header + [row('合成甲', '旧程序岗', '已回复'), row('合成甲', '合成程序岗', '待确认'), row('合成乙', '旧程序岗', '已回复'), row('合成丙', '程序/动画复合岗', '已回复')].join('\n'));
  input.config = configSource({ roleAliases: { 旧程序岗: '合成程序岗' } });
  const snapshot = buildSnapshot(input);
  assert.equal(snapshot.candidates.length, 4);
  assert.equal(selectRole(snapshot, '合成程序岗').total, 3);
  assert.equal(selectRole(snapshot, '程序/动画复合岗').total, 1);
  assert.equal(snapshot.candidates[0].id, JSON.stringify(['合成甲', '旧程序岗']));
  assert.equal(snapshot.candidates[0].rawRole, '旧程序岗');
  assert.equal(snapshot.candidates[0].role, '合成程序岗');
  assert.ok(!snapshot.roles.some(role => role.name === '旧程序岗'));
  assert.equal(snapshot.sources.config.status, 'ok');
  const collision = snapshot.diagnostics.find(item => item.code === 'ROLE_ALIAS_COLLISION');
  assert.equal(collision.level, 'info');
  assert.match(collision.message, /同名跨岗位记录未合并/);
  assert.ok(!collision.message.includes('合成甲'));
  const historical = readRoles(context + '| 历史复合岗 | x | 程序/动画复合岗 | |\n| 待核 | y | 待核岗位 | |\n| 非本项目 | z | 外部岗位 | |\n');
  assert.deepEqual(historical.slice(-3).map(role => role.status), ['历史复合岗', '待核', '非本项目']);
});

test('配置缺失沿用标准模式；首次配置非法整体不应用，岗位表失败不能应用别名', () => {
  const csv = header + row('合成甲', '旧程序岗', '已沟通-待答复');
  const standard = buildSnapshot(sources(csv));
  assert.equal(standard.sources.config.status, 'missing');
  assert.equal(standard.candidates[0].rawRole, '旧程序岗');
  assert.equal(standard.candidates[0].stage, 'unclassified');
  assert.ok(!standard.diagnostics.some(item => item.source === 'config'));
  const input = sources(csv);
  input.config = configSource({ statusStages: { '已沟通-待答复': 'talking' }, roleAliases: { 旧程序岗: '不存在岗位' } });
  const invalid = buildSnapshot(input);
  assert.equal(invalid.sources.config.status, 'error');
  assert.equal(invalid.candidates[0].stage, 'unclassified');
  assert.equal(invalid.candidates[0].role, '旧程序岗');
  assert.ok(invalid.diagnostics.some(item => item.code === 'CONFIG_INVALID_ALIAS'));
  input.config = configSource({ statusStages: { '已沟通-待答复': 'talking' }, roleAliases: { 旧程序岗: '合成程序岗' } });
  input.context = { status: 'missing' };
  const noRoles = buildSnapshot(input);
  assert.equal(noRoles.sources.config.status, 'error');
  assert.equal(noRoles.candidates[0].role, '旧程序岗');
  assert.equal(noRoles.candidates[0].stage, 'unclassified');
  assert.ok(noRoles.roles.every(role => !role.configured && role.status === null));
});

test('曾成功配置变坏、消失或别名依据失效时保留整份旧映射快照，不混入新源', () => {
  const input = sources(header + row('合成甲', '旧程序岗', '已沟通-待答复'));
  input.config = configSource({ statusStages: { '已沟通-待答复': 'talking' }, roleAliases: { 旧程序岗: '合成程序岗' } });
  const good = buildSnapshot(input);
  const changed = sources(header + row('合成乙', '旧程序岗', '已排除'));
  changed.generatedAt = later; changed.ledger.updatedAt = later; changed.context.updatedAt = later;
  for (const config of [{ status: 'ok', text: '{', updatedAt: later }, { status: 'error' }, { status: 'missing' }, configSource({ roleAliases: { 旧程序岗: '不存在岗位' } })]) {
    changed.config = config;
    const stale = buildSnapshot(changed, good);
    assert.equal(stale.status, 'stale');
    assert.equal(stale.sources.config.status, 'stale');
    assert.equal(stale.sources.config.updatedAt, now);
    assert.equal(stale.sources.ledger.status, 'stale');
    assert.equal(stale.sources.context.status, 'stale');
    assert.equal(stale.ledgerUpdatedAt, now);
    assert.deepEqual(stale.candidates, good.candidates);
    assert.deepEqual(stale.roles, good.roles);
    assert.deepEqual(stale.unknownStatuses, good.unknownStatuses);
    const stillStale = buildSnapshot(changed, stale);
    assert.deepEqual(stillStale.candidates, good.candidates);
  }
  changed.config = input.config;
  changed.context = { status: 'missing' };
  assert.equal(buildSnapshot(changed, good).sources.config.status, 'stale');
  changed.context = input.context;
  changed.ledger = { status: 'missing' };
  const ledgerStale = buildSnapshot(changed, good);
  assert.equal(ledgerStale.sources.config.status, 'stale');
  assert.deepEqual(ledgerStale.candidates, good.candidates);
  changed.ledger = sources(header + row('合成乙', '旧程序岗', '已排除')).ledger;
  const recovered = buildSnapshot(changed, good);
  assert.equal(recovered.sources.config.status, 'ok');
  assert.equal(recovered.sources.ledger.status, 'ok');
  assert.equal(recovered.candidates[0].stage, 'ended');
});

test('首次有效配置未能应用到台账时不算配置成功，移除后可恢复标准新记录', () => {
  const standard = buildSnapshot(sources(header + row('合成甲', '合成程序岗', '已回复')));
  const broken = sources();
  broken.ledger = { status: 'ok', text: 'broken' };
  broken.config = configSource({ statusStages: { '已回复': 'decision' } });
  const restored = sources(header + [row('合成甲', '合成程序岗', '已回复'), row('合成乙', '合成程序岗', '已回复')].join('\n'));
  for (const previous of [standard, null]) {
    const failed = buildSnapshot(broken, previous);
    if (previous) {
      assert.deepEqual(failed.candidates, standard.candidates);
      assert.equal(failed.sources.config.status, 'missing');
    } else assert.equal(failed.candidates, null);
    const recovered = buildSnapshot(restored, failed);
    assert.equal(recovered.status, 'ok');
    assert.equal(recovered.sources.config.status, 'missing');
    assert.equal(recovered.candidates.length, 2);
    assert.ok(recovered.candidates.every(candidate => candidate.stage === 'talking'));
    assert.ok(!recovered.diagnostics.some(item => item.code === 'LEDGER_INVALID' || item.source === 'config'));
  }
});

test('步骤状态区分完成/跳过/等待/失败/取消；未完成不得整体结束；时间可注入', () => {
  let run = createRun({ id: 'daily-1', workflow: 'daily', ownerSessionId: 'session-test', now });
  assert.equal(run.steps.length, 9);
  assert.equal(run.ownerSessionId, 'session-test');
  assert.throws(() => transitionRun(run, { type: 'complete' }, later), /全部步骤/);
  run = transitionRun(run, { type: 'step', step: 'unread' }, later);
  assert.throws(() => transitionRun(run, { type: 'step', step: 'sourcing' }, later), /当前步骤/);
  run = transitionRun(run, { type: 'wait', reason: '等待用户确认' }, later);
  assert.equal(run.status, 'waiting');
  assert.equal(run.steps[0].status, 'running');
  run = transitionRun(run, { type: 'complete', step: 'unread' }, later);
  for (const step of run.steps.slice(1)) run = transitionRun(run, { type: 'skip', step: step.id, reason: '本轮只查未处理' }, later);
  run = transitionRun(run, { type: 'complete' }, later);
  assert.equal(run.status, 'completed');
  assert.throws(() => transitionRun(run, { type: 'wait', reason: 'x' }, later), /已经结束/);
  const waiting = createRun({ id: 'review-1', workflow: 'resume-review', now });
  assert.throws(() => transitionRun(waiting, { type: 'skip', step: 'mail' }, later), /理由/);
  assert.equal(transitionRun(waiting, { type: 'fail', step: 'mail', reason: '读取失败' }, later).status, 'failed');
  assert.equal(transitionRun(waiting, { type: 'cancel', reason: '用户取消' }, later).status, 'cancelled');
  assert.throws(() => transitionRun(waiting, { type: 'step', step: 'context' }, '2026-01-01T00:00:00.000Z'), /倒退/);
});

test('不合法/不一致的 run 输入被拒绝；快照独立处理进度错误，不据时间推断成功', () => {
  assert.throws(() => createRun({ id: '../escape', workflow: 'daily', now }), /runId/);
  const run = createRun({ id: 'daily-1', workflow: 'daily', now });
  assert.throws(() => validateRun({ ...run, status: 'completed' }), /未完成步骤/);
  const good = buildSnapshot(sources(header, { status: 'ok', files: [{ name: 'daily-1.json', text: JSON.stringify(run) }] }));
  assert.equal(good.runs[0].status, 'running');
  const input = sources(header, { status: 'ok', files: [{ name: 'daily-1.json', text: '{' }] });
  input.generatedAt = '2027-01-01T00:00:00.000Z';
  const stale = buildSnapshot(input, good);
  assert.equal(stale.sources.runs.status, 'stale');
  assert.equal(stale.runs[0].status, 'running');
  assert.equal(stale.runs[0].updatedAt, now);
  assert.ok(stale.diagnostics.some(d => d.code === 'RUN_INVALID'));
  const missingDirectory = buildSnapshot(sources(header, { status: 'missing' }), good);
  assert.equal(missingDirectory.sources.runs.status, 'stale');
  assert.equal(missingDirectory.runs[0].status, 'running');
  const twoInvalid = buildSnapshot(sources(header, { status: 'ok', files: [{ name: 'daily-1.json', text: '{' }, { name: 'unknown.json', text: '{' }] }), good);
  assert.equal(twoInvalid.sources.runs.status, 'stale');
  const noValidRuns = buildSnapshot(sources(header, { status: 'ok', files: [{ name: 'unknown.json', text: '{' }] }));
  assert.equal(noValidRuns.runs, null);
  assert.equal(noValidRuns.sources.runs.status, 'error');
});

const result = (value = {}) => ({ id: 'screen-1', stepId: 'screen', candidateId: JSON.stringify(['合成甲', '原岗位']), action: '初筛', outcome: '经历需核实', attention: 'none', nextAction: null, ...value });
const writeResult = (run, value = {}, at = later) => transitionRun(run, { type: 'result', result: result(value) }, at);

test('旧轮次未记录结果与新轮次已记录零人有区别，摘要不暴露收据正文', () => {
  const run = createRun({ id: 'new-results', workflow: 'daily', now });
  assert.deepEqual(run.results, []);
  assert.deepEqual(summarizeRunResults(run), { total: 0, decisions: 0, notices: 0, updatedAt: null, revision: 0 });
  const { results, resultsRevision, ...old } = run;
  assert.equal(validateRun(old).results, null);
  assert.equal(validateRun(old).resultsRevision, 0);
  assert.equal(validateRun({ ...old, results: null }).results, null);
  assert.equal(summarizeRunResults(validateRun(old)), null);
  const snapshot = buildSnapshot(sources(header, { status: 'ok', files: [{ name: `${run.id}.json`, text: JSON.stringify(run) }, { name: 'old-results.json', text: JSON.stringify({ ...old, id: 'old-results' }) }] }));
  assert.deepEqual(snapshot.runs.find(item => item.id === run.id).resultSummary, { total: 0, decisions: 0, notices: 0, updatedAt: null, revision: 0 });
  assert.equal(snapshot.runs.find(item => item.id === 'old-results').resultSummary, null);
  assert.ok(snapshot.runs.every(item => !Object.hasOwn(item, 'results')));
});

test('稳定收据ID按内容幂等upsert，不改候选或步骤，等待状态及步骤完全保留', () => {
  let run = createRun({ id: 'waiting-results', workflow: 'daily', now });
  run = transitionRun(run, { type: 'step', step: 'screen' }, now);
  run = transitionRun(run, { type: 'wait', reason: '等待确认初筛标准' }, now);
  const before = structuredClone(run);
  run = writeResult(run, { attention: 'decision', nextAction: '确认是否推进面试' });
  assert.equal(run.status, before.status);
  assert.equal(run.reason, before.reason);
  assert.deepEqual(run.steps, before.steps);
  assert.deepEqual(before.results, []);
  const muchLater = '2026-10-22T01:02:00.000Z';
  const repeated = writeResult(run, { attention: 'decision', nextAction: '确认是否推进面试' }, muchLater);
  assert.deepEqual(repeated, run);
  const updated = writeResult(run, { outcome: '已确认可继续', attention: 'none' }, muchLater);
  assert.equal(updated.results.length, 1);
  assert.equal(updated.results[0].updatedAt, muchLater);
  assert.equal(updated.updatedAt, muchLater);
  assert.equal(updated.status, 'waiting');
  assert.equal(updated.reason, before.reason);
  assert.deepEqual(updated.steps, before.steps);
  assert.equal(run.results[0].outcome, '经历需核实');
  assert.throws(() => writeResult(updated, { candidateId: JSON.stringify(['合成乙', '原岗位']) }, muchLater), /候选或步骤不可变更/);
  assert.throws(() => writeResult(updated, { stepId: 'ledger' }, muchLater), /候选或步骤不可变更/);
  assert.throws(() => writeResult(updated, {}, now), /倒退/);
});

test('已记录人选按姓名原岗去重，跨步骤none不隐式消解待确认，仅原收据更新能消解', () => {
  let run = createRun({ id: 'result-summary', workflow: 'daily', now });
  run = writeResult(run, { attention: 'decision', nextAction: '确认初筛结论' });
  run = writeResult(run, { id: 'ledger-1', stepId: 'ledger', action: '补台账', outcome: '已写入', attention: 'none' });
  run = writeResult(run, { id: 'notice-1', stepId: 'greet', action: '联系', outcome: '已回复', attention: 'notice' });
  run = writeResult(run, { id: 'another-role', candidateId: JSON.stringify(['合成甲', '另一原岗']), attention: 'notice' });
  assert.equal(run.results.length, 4);
  assert.deepEqual(summarizeRunResults(run), { total: 2, decisions: 1, notices: 1, updatedAt: later, revision: 4 });
  run = writeResult(run, { attention: 'none' });
  assert.deepEqual(summarizeRunResults(run), { total: 2, decisions: 0, notices: 2, updatedAt: later, revision: 5 });
  run = writeResult(run, { id: 'notice-1', stepId: 'greet', action: '联系', outcome: '已回复', attention: 'none' });
  assert.deepEqual(summarizeRunResults(run), { total: 2, decisions: 0, notices: 1, updatedAt: later, revision: 6 });
  assert.equal(runSummary(run).resultSummary.total, 2);
});

test('结果字段、规范候选标识、工作流步骤、有限条数与结果时间严格校验，失败不修改输入', () => {
  const run = createRun({ id: 'invalid-results', workflow: 'daily', now });
  const invalid = [
    { id: '' }, { id: '../escape' }, { id: 'a'.repeat(65) }, { stepId: 'parse' },
    { candidateId: 'bad-json' }, { candidateId: '["合成甲", "原岗位"]' }, { candidateId: '[" 合成甲","原岗位"]' },
    { candidateId: '["合成甲",""]' }, { candidateId: '["合成甲",1]' }, { candidateId: '["合成甲"]' },
    { action: '' }, { action: 'a'.repeat(81) }, { outcome: '' }, { outcome: '结'.repeat(301) },
    { attention: 'maybe' }, { attention: 'decision' }, { attention: 'decision', nextAction: '' },
    { nextAction: '后'.repeat(301) }, { nextAction: undefined }, { outcome: '非法\u0000字符' }, { updatedAt: later }
  ];
  const before = structuredClone(run);
  for (const value of invalid) assert.throws(() => writeResult(run, value));
  const missing = result(); delete missing.outcome;
  assert.throws(() => transitionRun(run, { type: 'result', result: missing }, later));
  assert.deepEqual(run, before);
  const valid = writeResult(run);
  assert.throws(() => validateRun({ ...valid, results: 'bad' }), /结果记录/);
  assert.throws(() => validateRun({ ...valid, results: [...valid.results, ...valid.results] }), /重复 ID/);
  assert.throws(() => validateRun({ ...valid, results: [{ ...valid.results[0], updatedAt: '2026-10-22T01:02:00.000Z' }] }), /结果更新时间/);
  assert.throws(() => validateRun({ ...valid, results: [{ ...valid.results[0], updatedAt: '2026-10-21T01:00:00.000Z' }] }), /结果更新时间/);
  assert.throws(() => createRun({ id: 'invalid-date', workflow: 'daily', now: '2026-02-30T01:00:00.000Z' }), /ISO/);
  const full = { ...run, results: Array.from({ length: MAX_RUN_RESULTS }, (_, index) => ({ ...result({ id: `receipt-${index}` }), updatedAt: now })) };
  assert.equal(validateRun(full).results.length, 2000);
  assert.throws(() => writeResult(full), /最多 2000/);
  assert.equal(writeResult(full, { id: 'receipt-1', outcome: '更新已有结果' }).results.length, 2000);
  assert.throws(() => validateRun({ ...full, results: [...full.results, { ...result(), updatedAt: now }] }), /最多 2000/);
});

test('完成、失败与取消保留结果，终态不可追加；仅结果变化也改变摘要版本', () => {
  const recorded = writeResult(createRun({ id: 'terminal-results', workflow: 'daily', now }));
  for (const type of ['fail', 'cancel']) {
    const ended = transitionRun(recorded, { type, reason: '本轮结束' }, later);
    assert.deepEqual(ended.results, recorded.results);
    assert.deepEqual(validateRun(ended).results, recorded.results);
    assert.throws(() => writeResult(ended, { id: 'late-result' }), /已经结束/);
  }
  let completed = recorded;
  for (const step of completed.steps) completed = transitionRun(completed, { type: 'skip', step: step.id, reason: '合成轮次已交付' }, later);
  completed = transitionRun(completed, { type: 'complete' }, later);
  assert.deepEqual(completed.results, recorded.results);
  assert.throws(() => writeResult(completed), /已经结束/);
  const updated = writeResult(recorded, { outcome: '结论已更新' }, '2026-10-22T01:02:00.000Z');
  assert.deepEqual(updated.steps, recorded.steps);
  assert.notDeepEqual(runSummary(updated), runSummary(recorded));
  assert.equal(runSummary(updated).resultSummary.updatedAt, '2026-10-22T01:02:00.000Z');
  const sameTime = writeResult(recorded, { outcome: '同毫秒更正结论' });
  assert.equal(sameTime.updatedAt, recorded.updatedAt);
  assert.equal(sameTime.resultsRevision, recorded.resultsRevision + 1);
  assert.notDeepEqual(runSummary(sameTime), runSummary(recorded));
  assert.equal(runSummary(sameTime).resultSummary.revision, 2);
  assert.deepEqual(writeResult(sameTime, { outcome: '同毫秒更正结论' }), sameTime);
  assert.equal(transitionRun(sameTime, { type: 'step', step: 'screen' }, later).resultsRevision, 2);
  for (const revision of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1, null, '1']) assert.throws(() => validateRun({ ...recorded, resultsRevision: revision }), /安全整数/);
});

test('正常快照与所有进度陈旧回退仅含摘要，正文和candidateId均不进入快照', () => {
  const run = writeResult(createRun({ id: 'private-results', workflow: 'daily', now }), { candidateId: JSON.stringify(['未入台账哨兵', '原岗哨兵']), action: '动作正文哨兵', outcome: '结论正文哨兵', attention: 'decision', nextAction: '下一步正文哨兵' });
  const initial = buildSnapshot(sources(header, { status: 'ok', files: [{ name: 'private-results.json', text: JSON.stringify(run) }] }));
  const legacyPrevious = { ...initial, runs: [run] };
  for (const previous of [initial, legacyPrevious]) {
    const snapshots = [initial, ...[{ status: 'missing' }, { status: 'error' }, { status: 'ok', files: [{ name: 'private-results.json', text: '{' }] }].map(runFiles => buildSnapshot(sources(header, runFiles), previous))];
    for (const snapshot of snapshots) {
      assert.deepEqual(snapshot.runs[0].resultSummary, { total: 1, decisions: 1, notices: 0, updatedAt: later, revision: 1 });
      for (const text of ['"results"', 'candidateId', '未入台账哨兵', '原岗哨兵', '动作正文哨兵', '结论正文哨兵', '下一步正文哨兵']) assert.equal(JSON.stringify(snapshot).includes(text), false, text);
    }
  }
});

test('共享岗位范围支持在招、关注、全量与未知状态，搜索仅缩小选项且不改汇总', () => {
  assert.deepEqual(ROLE_SCOPES, [{ id: 'active', label: '在招' }, { id: 'following', label: '关注' }, { id: 'all', label: '全部' }]);
  const input = sources(header + [row('合成甲', '合成程序岗', '已回复'), row('合成乙', '合成动画岗', '待确认'), row('合成丙', '无配置岗', 'offer'), row('合成丁', '无状态岗', '已约谈'), row('合成戊', '探索岗', '初筛通过'), row('合成己', '历史待核岗', '初筛通过')].join('\n'));
  input.context.text += '|  | x | 无状态岗 | P2 |\n| 探索线 | x | 探索岗 | P2 |\n| 历史待核 | x | 历史待核岗 | P2 |\n| 已下架 | x | 下架岗 | P2 |\n| 暂停 | x | 暂停岗 | P2 |\n| 待核 | x | 待核岗 | P2 |\n';
  const snapshot = buildSnapshot(input);
  const active = selectRoles(snapshot);
  assert.deepEqual(active.roles.map(item => item.name), ['合成程序岗', '空岗位', '无状态岗', '探索岗', '历史待核岗', '无配置岗']);
  assert.equal(active.total, 5);
  assert.equal(active.selectedRole, null);
  assert.equal(active.outsideScope, false);
  assert.equal(active.selectionMissing, false);
  assert.match(active.label, /状态未知/);
  assert.equal(active.stages.find(stage => stage.id === 'interview').count, 1);
  const searched = selectRoles(snapshot, { query: '探索' });
  assert.deepEqual(searched.roles.map(item => item.name), ['探索岗']);
  assert.equal(searched.total, active.total);
  assert.deepEqual(searched.stages, active.stages);
  assert.equal(selectRoles(snapshot, { query: '无匹配' }).total, 5);
  assert.deepEqual(selectRoles(snapshot, { query: '无匹配' }).roles, []);
  const following = selectRoles(snapshot, { scope: 'following', following: ['合成动画岗', '空岗位', '合成动画岗', '不存在'] });
  assert.deepEqual(following.roles.map(item => item.name), ['合成动画岗', '空岗位']);
  assert.equal(following.total, 1);
  assert.equal(selectRoles(snapshot, { scope: 'all' }).total, 6);
  assert.equal(selectRoles(snapshot, { scope: 'all' }).roles.length, snapshot.roles.length);
  const empty = selectRoles(snapshot, { scope: 'following' });
  assert.deepEqual(empty.roles, []);
  assert.equal(empty.total, 0);
  assert.ok(empty.stages.every(stage => stage.count === 0));
  assert.equal(selectRoles({ ...snapshot, candidates: null }, { scope: 'following' }).total, null);
});

test('显式历史岗位独立于范围和搜索保留；刷新岗位消失时人数未知，旧selectRole接口不变', () => {
  const snapshot = buildSnapshot(sources(header + [row('合成甲', '合成程序岗', '已回复'), row('合成乙', '合成动画岗', '待确认')].join('\n')));
  const selected = selectRoles(snapshot, { scope: 'active', query: '程序', role: '合成动画岗' });
  assert.equal(selected.selectedRole.name, '合成动画岗');
  assert.equal(selected.outsideScope, true);
  assert.equal(selected.selectionMissing, false);
  assert.equal(selected.total, 1);
  assert.match(selected.label, /不在当前范围/);
  assert.equal(selected.stages.find(stage => stage.id === 'decision').count, 1);
  assert.deepEqual(selected.roles.map(item => item.name), ['合成程序岗']);
  assert.equal(selectRoles(snapshot, { scope: 'following', role: '合成动画岗' }).total, 1);
  assert.equal(selectRoles(snapshot, { scope: 'all', role: '合成动画岗' }).outsideScope, false);
  assert.equal(selectRoles(snapshot, { role: '空岗位' }).total, 0);
  const gone = selectRoles({ ...snapshot, roles: snapshot.roles.filter(item => item.name !== '合成动画岗') }, { role: '合成动画岗' });
  assert.equal(gone.selectedRole, null);
  assert.equal(gone.selectionMissing, true);
  assert.equal(gone.total, null);
  assert.equal(gone.candidates, null);
  assert.ok(gone.stages.every(stage => stage.count === null));
  assert.deepEqual(selectRole(snapshot, '合成动画岗'), { candidates: selected.candidates, total: 1, stages: selected.stages });
  assert.equal(selectRole(snapshot).total, 2);
});

const task = (id, createdAt = now, updatedAt = createdAt) => ({ ...runSummary(createRun({ id, workflow: 'daily', now: createdAt })), updatedAt });

test('任务live跟随创建时间最新，旧任务后更新不抢占，同刻ID确定且不改输入顺序', () => {
  const old = task('old-task', now, '2026-10-22T02:00:00.000Z');
  const latest = task('new-task', later);
  const runs = Object.freeze([old, latest]);
  const initial = selectTask(runs, { mode: 'live', runId: null });
  assert.deepEqual(initial, { selection: { mode: 'live', runId: 'new-task' }, run: latest, latestRunId: 'new-task', newerRunId: null });
  assert.deepEqual(selectTask(runs, { mode: 'live', runId: 'old-task' }), initial);
  assert.deepEqual(runs.map(run => run.id), ['old-task', 'new-task']);
  const tied = task('a-task', later);
  for (const order of [[latest, tied], [tied, latest]]) assert.equal(selectTask(order, initial.selection).run.id, 'a-task');
  const withOwner = [{ ...old, ownerSessionId: 'current-session' }, { ...latest, ownerSessionId: 'other-session' }];
  assert.equal(selectTask(withOwner, { mode: 'live', runId: null }).run.id, 'new-task');
});

test('任务pinned保留原ID并提示最新，消失不跳且恢复同一选择', () => {
  const old = task('old-task');
  const latest = task('new-task', later);
  const selection = Object.freeze({ mode: 'pinned', runId: 'old-task' });
  const pinned = selectTask([old, latest], selection);
  assert.deepEqual(pinned, { selection, run: old, latestRunId: 'new-task', newerRunId: 'new-task' });
  assert.deepEqual(selectTask([latest], pinned.selection), { selection, run: null, latestRunId: 'new-task', newerRunId: 'new-task' });
  for (const missing of [null, []]) {
    const view = selectTask(missing, selection);
    assert.deepEqual(view, { selection, run: null, latestRunId: null, newerRunId: null });
    assert.equal(selectTask([old, latest], view.selection).run.id, 'old-task');
  }
  const noId = selectTask([latest], { mode: 'pinned', runId: null });
  assert.equal(noId.run, null);
  assert.equal(noId.selection.runId, null);
  assert.equal(noId.newerRunId, 'new-task');
});

test('任务live hold保留原ID包括消失，释放后跟随；空选择仍可接收最新且读源缺失可恢复', () => {
  const old = task('old-task');
  const latest = task('new-task', later);
  const selection = { mode: 'live', runId: 'old-task' };
  assert.deepEqual(selectTask([old, latest], selection, true), { selection, run: old, latestRunId: 'new-task', newerRunId: 'new-task' });
  const missing = selectTask([latest], selection, true);
  assert.deepEqual(missing, { selection, run: null, latestRunId: 'new-task', newerRunId: 'new-task' });
  assert.equal(selectTask([latest], missing.selection).run.id, 'new-task');
  assert.equal(selectTask([latest], { mode: 'live', runId: null }, true).run.id, 'new-task');
  for (const runs of [null, []]) {
    for (const hold of [false, true]) {
      const view = selectTask(runs, selection, hold);
      assert.deepEqual(view, { selection, run: null, latestRunId: null, newerRunId: null });
      assert.equal(selectTask([old, latest], view.selection).run.id, 'new-task');
    }
  }
});
