import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { createRun, LEDGER_COLUMNS, ROLE_SCOPES, selectRoles, transitionRun, validateRun } from '../skills/recruit-board/model.mjs';
import { applyDecision, idForIdentity, validateDecision } from '../skills/recruit-board/decisions-domain.mjs';
import { applyDecisionCommand, decisionsCLI, readDecision } from '../skills/recruit-board/scripts/decisions.mjs';
import { importLegacyDecisions } from '../skills/recruit-board/scripts/import-history.mjs';
import { readWorkspaceOverview } from '../skills/recruit-board/scripts/overview.mjs';
import { progressCLI, recordProgress } from '../skills/recruit-board/scripts/progress.mjs';
import { readSnapshot } from '../skills/recruit-board/scripts/reader.mjs';
import { readRunHighlights } from '../skills/recruit-board/scripts/results.mjs';

const old = '2026-10-01T01:00:00.000Z', t0 = '2026-11-01T01:00:00.000Z', t1 = '2026-11-02T01:00:00.000Z', t2 = '2026-11-03T01:00:00.000Z', t3 = '2026-11-04T01:00:00.000Z';
const candidateId = JSON.stringify(['合成甲', '原岗位甲']);
const otherId = JSON.stringify(['合成甲', '原岗位乙']);
const candidateContext = { scope: 'candidate', candidateId };
const details = [{ label: '预约时段', value: '11 月 6 日 10:00–11:00' }, { label: '面试官', value: '合成面试官' }];
const identity = { subjectKey: 'location-review', questionKey: 'location', scope: '本轮条件' };
const registration = (extra = {}) => ({ requestId: 'register', expectedRevision: 0, identity, title: '是否接受异地', source: { runId: 'source' }, ...extra });
const subject = (id = candidateId) => { const [name, rawRole] = JSON.parse(id); return { candidateId: id, name, rawRole, role: rawRole }; };
const result = (id = 'result-a', candidate = candidateId) => ({ id, stepId: 'screen', candidateId: candidate, action: '初筛', outcome: '经历已核实，地点待确认', attention: 'decision', nextAction: '是否接受异地' });
const runFile = (root, id = 'source') => path.join(root, 'runtime/recruit-board/runs', `${id}.json`);
const decisionFile = (root, id) => path.join(root, 'runtime/recruit-board/decisions', `${id}.json`);
async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'board-clarity-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await recordProgress({ workspace: root, id: 'source', workflow: 'daily', action: { type: 'start' } }, () => old);
  return root;
}
const progress = (workspace, action, time = t0, id = 'source') => recordProgress({ workspace, id, action }, () => time);
const register = (root, extra = {}, time = t0) => applyDecisionCommand(root, 'register', registration(extra), () => time);

const invalidContexts = [
  null, [], {}, { scope: 'unknown' }, { scope: 'candidate' },
  { scope: 'candidate', candidateId: '合成甲' }, { scope: 'candidate', candidateId: '["合成甲", "原岗位甲"]' },
  { scope: 'candidate', candidateId: '[" 合成甲","原岗位甲"]' }, { scope: 'candidate', candidateId: '["合成甲",null]' },
  { scope: 'candidate', candidateId: '["合成甲",""]' }, { scope: 'candidate', candidateId, role: null },
  { scope: 'role' }, { scope: 'role', role: '' }, { scope: 'role', role: '岗位\n甲' },
  { scope: 'role', role: '岗'.repeat(301) }, { scope: 'role', role: '原岗位甲', candidateId },
  { scope: 'workspace', candidateId }, { scope: 'workspace', role: '原岗位甲' },
  { scope: 'workspace', role: null }, { scope: 'workspace', ignored: true }
];

test('context 三种范围在重点与事项入口一致校验，候选标识规范且上下文不改变身份', () => {
  const run = createRun({ id: 'validation', workflow: 'daily', now: t0 });
  const contexts = [candidateContext, { ...candidateContext, role: '标准岗位甲' }, { scope: 'role', role: '原岗位甲' }, { scope: 'workspace' }];
  for (const context of contexts) {
    const recorded = transitionRun(run, { type: 'highlight', highlight: { eventKey: 'event', text: '实际进展', context } }, t0);
    assert.deepEqual(recorded.highlights[0].context, context);
    const { item } = applyDecision(null, 'register', registration({ context }), t0);
    assert.deepEqual(item.context, context);
    assert.equal(item.id, idForIdentity(identity));
    assert.deepEqual(item.history[0].context, context);
    assert.deepEqual(validateDecision(item), item);
    assert.deepEqual(applyDecision(null, 'import', registration({ context, createdAt: old }), t0).item.context, context);
  }
  for (const context of invalidContexts) {
    assert.throws(() => transitionRun(run, { type: 'highlight', highlight: { eventKey: 'event', text: '实际进展', context } }, t0), undefined, JSON.stringify(context));
    assert.throws(() => applyDecision(null, 'register', registration({ context }), t0), error => error.code === 'DECISION_INPUT_INVALID', JSON.stringify(context));
    assert.throws(() => applyDecision(null, 'import', registration({ context }), t0), error => error.code === 'DECISION_INPUT_INVALID');
  }
  assert.deepEqual(run.highlights, []);
});

test('重点 details 最多八项，标签与值必须有界、单行、纯文本，旧格式仍可读取', () => {
  const run = createRun({ id: 'details', workflow: 'daily', now: t0 });
  const highlight = { eventKey: 'event', text: '实际进展' };
  const legacy = transitionRun(run, { type: 'highlight', highlight }, t0);
  assert.equal(legacy.highlights[0].context, undefined);
  assert.equal(legacy.highlights[0].details, undefined);
  assert.equal(validateRun(legacy).highlights[0].history[0].context, undefined);
  const boundary = Array.from({ length: 8 }, () => ({ label: '标'.repeat(80), value: '值'.repeat(300) }));
  for (const value of [[], details, boundary]) {
    const recorded = transitionRun(run, { type: 'highlight', highlight: { ...highlight, details: value } }, t0);
    assert.deepEqual(recorded.highlights[0].details, value);
    assert.deepEqual(recorded.highlights[0].history[0].details, value);
  }
  for (const value of [null, {}, 'text', Array(9).fill(details[0]), [null], [{}], [{ label: '标签', value: '' }], [{ label: '', value: '内容' }], [{ label: '标签', value: 1 }], [{ label: '标'.repeat(81), value: '内容' }], [{ label: '标签', value: '值'.repeat(301) }], [{ ...details[0], url: 'https://example.test' }]]) {
    assert.throws(() => transitionRun(run, { type: 'highlight', highlight: { ...highlight, details: value } }, t0));
  }
  for (const separator of ['\n', '\r', '\t', '\0', '\u007f', '\u0085', ' ', ' ']) for (const field of ['label', 'value']) {
    assert.throws(() => transitionRun(run, { type: 'highlight', highlight: { ...highlight, details: [{ label: '时段', value: '内容', [field]: `前${separator}后` }] } }, t0), /单行/);
  }
});

test('context/details 逐版保留且按内容幂等，跨进程重放旧修订不回滚，坏历史拒绝', async t => {
  const root = await fixture(t);
  const base = ['highlight', '--workspace', root, '--run', 'source', '--event', 'scheduled', '--text', '面试已预约'];
  const first = [...base, '--context', JSON.stringify(candidateContext), '--details', JSON.stringify(details), '--expected-revision', '0', '--request', 'scheduled-1'];
  const recorded = await progressCLI(first);
  const one = await readFile(runFile(root));
  assert.equal(recorded.highlights[0].revision, 1);
  await progressCLI(first);
  assert.deepEqual(await readFile(runFile(root)), one);
  const revisedDetails = [{ label: '预约时段', value: '11 月 7 日 10:00–11:00' }];
  const revisedContext = { scope: 'candidate', candidateId: otherId };
  const correction = [...base, '--context', JSON.stringify(revisedContext), '--details', JSON.stringify(revisedDetails), '--correction', '核实原岗位和预约时段', '--expected-revision', '1', '--request', 'scheduled-2'];
  await progressCLI(correction);
  await progressCLI([...base, '--context', JSON.stringify(revisedContext), '--details', JSON.stringify([]), '--correction', '撤销待重新预约的时段', '--expected-revision', '2', '--request', 'scheduled-3']);
  const latest = await readRunHighlights(root, 'source');
  const item = latest.highlights[0];
  assert.equal(item.revision, 3);
  assert.deepEqual(item.history.map(entry => entry.context), [candidateContext, revisedContext, revisedContext]);
  assert.deepEqual(item.history.map(entry => entry.details), [details, revisedDetails, []]);
  const before = await readFile(runFile(root));
  const cli = fileURLToPath(new URL('../skills/recruit-board/scripts/progress.mjs', import.meta.url));
  const { stdout } = await promisify(execFile)(process.execPath, [cli, ...correction]);
  assert.deepEqual(JSON.parse(stdout).highlights[0].details, []);
  assert.deepEqual(await readFile(runFile(root)), before);
  const changed = [...correction]; changed[changed.indexOf('--details') + 1] = JSON.stringify(details);
  await assert.rejects(progressCLI(changed), error => error.code === 'HIGHLIGHT_REQUEST_CONFLICT');
  const stale = [...correction]; stale[stale.indexOf('--request') + 1] = 'stale';
  await assert.rejects(progressCLI(stale), error => error.code === 'HIGHLIGHT_REVISION_CONFLICT');
  await assert.rejects(progressCLI([...base, '--context', '{}']), /context/);
  await assert.rejects(progressCLI([...base, '--details', '{']), /JSON/);
  for (const field of ['context', 'details']) {
    const corrupt = JSON.parse(before);
    corrupt.highlights[0][field] = field === 'context' ? candidateContext : details;
    assert.throws(() => validateRun(corrupt), /最新修订/);
  }
  const corrupt = JSON.parse(before);
  corrupt.highlights[0].history[0].details = [{ label: '坏数据', value: '不应\n出现' }];
  assert.throws(() => validateRun(corrupt), /单行/);
  assert.deepEqual(await readFile(runFile(root)), before);
});

test('旧重点增加结构化信息仍沿用事件身份，旧版历史缺可选字段保持可读', () => {
  const initial = transitionRun(createRun({ id: 'legacy', workflow: 'daily', now: t0 }), { type: 'highlight', highlight: { eventKey: 'legacy', text: '旧版进展' } }, t0);
  delete initial.highlights[0].history;
  delete initial.highlights[0].revision;
  const newer = transitionRun(initial, { type: 'highlight', requestId: 'enrich', expectedRevision: 1, highlight: { eventKey: 'legacy', text: '旧版进展', context: candidateContext, details, correction: '补充已核实对象和时段' } }, t1);
  assert.equal(newer.highlights[0].eventKey, 'legacy');
  assert.equal(newer.highlights[0].occurredAt, t0);
  assert.equal(newer.highlights[0].history[0].context, undefined);
  assert.equal(newer.highlights[0].history[0].details, undefined);
  assert.deepEqual(newer.highlights[0].history[1].context, candidateContext);
  assert.deepEqual(validateRun(JSON.parse(JSON.stringify(newer))), newer);
});

test('事项 context 追加和更正沿用版本、历史及请求保护，不变更已有决定', async t => {
  const root = await fixture(t);
  let { item } = await register(root);
  const initialId = item.id;
  assert.equal(item.context, undefined);
  const contextWrite = { id: item.id, expectedRevision: 1, requestId: 'context-2', source: { runId: 'source' }, evidence: '核实此事项适用于岗位', context: { scope: 'role', role: '原岗位甲' } };
  ({ item } = await decisionsCLI(['evidence', '--workspace', root, '--input', JSON.stringify(contextWrite)]));
  const afterEvidence = item.updatedAt;
  assert.equal(item.id, initialId);
  ({ item } = await applyDecisionCommand(root, 'decide', { id: item.id, expectedRevision: 2, requestId: 'answer', decision: { text: '继续核查', scope: identity.scope } }));
  assert.deepEqual(item.context, contextWrite.context);
  ({ item } = await applyDecisionCommand(root, 'evidence', { ...contextWrite, expectedRevision: 3, requestId: 'context-4', context: candidateContext, evidence: '核实实际为此人选事项' }));
  assert.equal(item.state, 'decided');
  assert.equal(item.decision.text, '继续核查');
  assert.deepEqual(item.history.map(entry => entry.context), [undefined, contextWrite.context, contextWrite.context, candidateContext]);
  const file = decisionFile(root, item.id), before = await readFile(file);
  const replay = await decisionsCLI(['evidence', '--workspace', root, '--input', JSON.stringify(contextWrite)]);
  assert.equal(replay.replayed, true);
  assert.equal(replay.appliedRevision, 2);
  assert.equal(replay.item.revision, 4);
  assert.deepEqual(replay.item.context, candidateContext);
  await assert.rejects(applyDecisionCommand(root, 'evidence', { ...contextWrite, context: { scope: 'workspace' } }), error => error.code === 'DECISION_REQUEST_CONFLICT');
  await assert.rejects(applyDecisionCommand(root, 'evidence', { ...contextWrite, requestId: 'stale' }), error => error.code === 'DECISION_REVISION_CONFLICT');
  await assert.rejects(applyDecisionCommand(root, 'evidence', { ...contextWrite, expectedRevision: 4, requestId: 'bad', context: null }), error => error.code === 'DECISION_INPUT_INVALID');
  assert.deepEqual(await readFile(file), before);
  assert.ok(item.updatedAt >= afterEvidence);
  const raw = JSON.parse(before);
  raw.context = { scope: 'workspace' };
  assert.throws(() => validateDecision(raw), /最后修订/);
  raw.context = item.context;
  raw.history[0].context = { scope: 'candidate' };
  assert.throws(() => validateDecision(raw), /candidateId/);
});

test('重复登记可补充 context 但不作为身份，遗漏 context 保留原关联', () => {
  const original = applyDecision(null, 'register', registration({ context: { scope: 'role', role: '原岗位甲' } }), t0).item;
  const changed = applyDecision(original, 'register', registration({ requestId: 'register-2', expectedRevision: 1, context: candidateContext }), t1).item;
  assert.equal(changed.id, original.id);
  assert.deepEqual(changed.identity, original.identity);
  assert.deepEqual(changed.history[0].context, original.context);
  assert.deepEqual(changed.history[1].context, candidateContext);
  const later = applyDecision(changed, 'register', registration({ requestId: 'register-3', expectedRevision: 2 }), t2).item;
  assert.deepEqual(later.context, candidateContext);
  assert.deepEqual(later.history[2].context, candidateContext);
});

test('历史事项仅由合法结果、规范对象键和显式 context 恢复，不从原文或台账推断', async t => {
  const root = await fixture(t);
  await progress(root, { type: 'result', result: result() });
  const { item: fromResult } = await register(root, { source: { runId: 'source', resultId: 'result-a' } });
  const { item: fromKey } = await register(root, { identity: { ...identity, subjectKey: otherId } });
  const { item: freeText } = await register(root, { identity: { ...identity, subjectKey: '合成甲在原岗位甲' }, title: '合成甲 原岗位甲 面试安排' });
  const { item: roleOnly } = await register(root, { identity: { ...identity, subjectKey: 'role-scope' }, context: { scope: 'role', role: '合成历史岗' } });
  const { item: wholeWorkspace } = await register(root, { identity: { ...identity, subjectKey: 'workspace-scope' }, context: { scope: 'workspace' } });
  const { item: explicit } = await register(root, { identity: { ...identity, subjectKey: 'explicit' }, context: { ...candidateContext, role: '另一个显示岗位' } });
  await progress(root, { type: 'highlight', highlight: { eventKey: 'linked', text: '确认前置条件', decisionId: fromResult.id } });
  await progress(root, { type: 'highlight', highlight: { eventKey: 'canonical', text: '确认另一人岗', subjectKey: otherId } });
  await progress(root, { type: 'highlight', highlight: { eventKey: 'unknown', text: '合成甲已安排原岗位甲面试', subjectKey: '合成甲 原岗位甲' } });
  await progress(root, { type: 'highlight', highlight: { eventKey: 'workspace', text: '共享资料已核实', context: { scope: 'workspace' } } });
  await mkdir(path.join(root, '02-sourcing'));
  await writeFile(path.join(root, '02-sourcing/dedup-ledger.csv'), `${LEDGER_COLUMNS.join(',')}\n1,合成甲,原岗位甲,隐私背景哨兵,A,已回复,旧轮次,秘密路径,联系方式哨兵\n`);
  await writeFile(path.join(root, 'CONTEXT.md'), '## 在招岗位与优先级\n| 岗位 | 优先级 | 状态 |\n|---|---|---|\n| 原岗位甲 | P0 | 已关闭 |\n');
  const before = await readFile(runFile(root));
  const overview = await readWorkspaceOverview(root, null, () => t1);
  const byId = new Map(overview.decisions.map(item => [item.id, item]));
  for (const item of [fromResult, explicit]) {
    assert.deepEqual(byId.get(item.id).subjects, [subject()]);
    assert.equal(byId.get(item.id).associationStatus, 'resolved');
  }
  assert.deepEqual(byId.get(fromKey.id).subjects, [subject(otherId)]);
  assert.deepEqual(byId.get(freeText.id).subjects, []);
  assert.equal(byId.get(freeText.id).associationStatus, 'unknown');
  assert.ok(byId.get(freeText.id).associationMessages.length);
  assert.deepEqual(byId.get(roleOnly.id).subjects, [{ candidateId: null, name: null, rawRole: '合成历史岗', role: '合成历史岗' }]);
  assert.equal(byId.get(wholeWorkspace.id).associationStatus, 'workspace');
  assert.deepEqual(byId.get(wholeWorkspace.id).subjects, []);
  const byEvent = new Map(overview.highlights.map(item => [item.eventKey, item]));
  assert.deepEqual(byEvent.get('linked').subjects, [subject()]);
  assert.deepEqual(byEvent.get('canonical').subjects, [subject(otherId)]);
  assert.equal(byEvent.get('unknown').associationStatus, 'unknown');
  assert.equal(byEvent.get('workspace').associationStatus, 'workspace');
  assert.deepEqual(await readFile(runFile(root)), before);
  for (const secret of ['隐私背景哨兵', '秘密路径', '联系方式哨兵']) assert.equal(JSON.stringify(overview).includes(secret), false);
  const snapshot = await readSnapshot(root, null, () => t1);
  assert.equal(Object.hasOwn(snapshot.workspaceOverview, 'decisions'), false);
  assert.equal(Object.hasOwn(snapshot.workspaceOverview, 'highlights'), false);
  assert.ok(snapshot.runs.every(run => !Object.hasOwn(run, 'results') && !Object.hasOwn(run, 'highlights')));
});

test('多个可靠对象全部去重保留，同名不同原岗不合并，部分来源缺失不改变事项', async t => {
  const root = await fixture(t);
  await progress(root, { type: 'result', result: result() });
  await progress(root, { type: 'result', result: result('result-b', otherId) });
  let { item } = await register(root, { context: candidateContext, source: { runId: 'source', resultId: 'result-a' } });
  ({ item } = await applyDecisionCommand(root, 'evidence', { id: item.id, expectedRevision: 1, requestId: 'second-candidate', evidence: '同时涉及另一原岗位的同名记录', source: { runId: 'source', resultId: 'result-b' } }, () => t1));
  await progress(root, { type: 'highlight', highlight: { eventKey: 'multi', text: '已核实两个原岗位', decisionId: item.id, context: candidateContext, subjectKey: otherId } }, t1);
  const complete = await readWorkspaceOverview(root, null, () => t1);
  assert.deepEqual(complete.decisions[0].subjects, [subject(), subject(otherId)]);
  assert.equal(complete.decisions[0].associationStatus, 'resolved');
  assert.deepEqual(complete.highlights[0].subjects, [subject(), subject(otherId)]);
  const before = await readFile(decisionFile(root, item.id));
  const run = JSON.parse(await readFile(runFile(root), 'utf8'));
  run.results = run.results.filter(result => result.id !== 'result-b');
  await writeFile(runFile(root), JSON.stringify(run));
  const missing = await readWorkspaceOverview(root, null, () => t2);
  assert.equal(missing.status, 'error');
  assert.deepEqual(missing.decisions[0].subjects, [subject()]);
  assert.equal(missing.decisions[0].associationStatus, 'partial');
  assert.match(missing.decisions[0].associationMessages.join(' '), /result-b/);
  assert.equal(missing.decisions[0].state, 'open');
  const cached = await readWorkspaceOverview(root, complete, () => t2);
  assert.deepEqual(cached.decisions[0].subjects, [subject(), subject(otherId)]);
  assert.equal(cached.decisions[0].associationStatus, 'partial');
  assert.deepEqual(await readFile(decisionFile(root, item.id)), before);
});

test('损坏结果不用于推断，缺失轮次和关联事项分别保留说明，已知数据不因缺失丢失', async t => {
  const root = await fixture(t);
  await progress(root, { type: 'result', result: result() });
  const { item } = await register(root, { source: { runId: 'source', resultId: 'result-a' } });
  const run = JSON.parse(await readFile(runFile(root), 'utf8'));
  run.results[0].candidateId = '["合成甲", "原岗位甲"]';
  await writeFile(runFile(root), JSON.stringify(run));
  const invalid = await readWorkspaceOverview(root, null, () => t1);
  assert.equal(invalid.decisions[0].associationStatus, 'unknown');
  assert.deepEqual(invalid.decisions[0].subjects, []);
  assert.ok(invalid.decisions[0].associationMessages.some(message => message.includes('source')));
  run.results[0].candidateId = candidateId;
  await writeFile(runFile(root), JSON.stringify(run));
  await recordProgress({ workspace: root, id: 'event-run', workflow: 'daily', action: { type: 'start' } }, () => t1);
  await applyDecisionCommand(root, 'evidence', { id: item.id, expectedRevision: 1, requestId: 'highlight-source', evidence: '另一轮记录同事项进展', source: { runId: 'event-run' } }, () => t1);
  await progress(root, { type: 'highlight', highlight: { eventKey: 'linked', text: '已核实进展', decisionId: item.id } }, t1, 'event-run');
  const known = await readWorkspaceOverview(root, null, () => t1);
  await rm(runFile(root));
  const missing = await readWorkspaceOverview(root, known, () => t2);
  assert.deepEqual(missing.decisions[0].subjects, [subject()]);
  assert.deepEqual(missing.highlights[0].subjects, [subject()]);
  assert.equal(missing.highlights[0].associationStatus, 'partial');
  assert.ok(missing.highlights[0].associationMessages.length);
  assert.equal(missing.decisions[0].state, 'open');
  await rm(decisionFile(root, item.id));
  const noDecision = await readWorkspaceOverview(root, null, () => t2);
  assert.equal(noDecision.highlights[0].associationStatus, 'unknown');
  assert.match(noDecision.highlights[0].associationMessages.join(' '), /关联事项/);
});

test('新历史导入保存规范 context，旧导入可沿来源恢复且不重写原run或升级历史状态', async t => {
  const root = await fixture(t);
  await progress(root, { type: 'result', result: result() }, old);
  await progress(root, { type: 'cancel', reason: '合成历史结束' }, old);
  const original = await readFile(runFile(root));
  const imported = await importLegacyDecisions(root, 'source', () => t0);
  const id = imported.imported[0].id;
  let item = await readDecision(root, id);
  assert.equal(item.createdAt, old);
  assert.deepEqual(item.context, candidateContext);
  assert.deepEqual(item.history[0].context, candidateContext);
  assert.equal(item.state, 'history_review');
  assert.equal((await importLegacyDecisions(root, 'source', () => t1)).skipped.length, 1);
  assert.equal((await readDecision(root, id)).revision, 1);
  delete item.context; delete item.history[0].context;
  await writeFile(decisionFile(root, id), JSON.stringify(item));
  const legacy = await readWorkspaceOverview(root, null, () => t1);
  assert.deepEqual(legacy.decisions[0].subjects, [subject()]);
  assert.equal(legacy.decisions[0].associationStatus, 'resolved');
  assert.equal(legacy.decisions[0].state, 'history_review');
  assert.equal((await importLegacyDecisions(root, 'source', () => t2)).skipped.length, 1);
  assert.equal((await readDecision(root, id)).context, undefined);
  assert.deepEqual(await readFile(runFile(root)), original);
});

test('排序只提升有效open的真实逾期、提醒到期或阻塞，同级createdAt/id稳定且历史导入不提级', async t => {
  const root = await fixture(t);
  const created = new Map();
  const add = async (key, time, extra = {}) => {
    const { item } = await register(root, { identity: { ...identity, subjectKey: key }, ...extra }, time);
    created.set(key, item); return item;
  };
  await add('ordinary-old', old);
  await add('urgent-blocked', t1, { blocking: true });
  await add('urgent-deadline', t0, { deadline: t1 });
  let reminded = await add('urgent-reminder', t2);
  await applyDecisionCommand(root, 'snooze', { id: reminded.id, expectedRevision: 1, requestId: 'snooze-reminder', until: t3, reason: '到时确认' }, () => t2);
  await add('ordinary-future', t0, { deadline: '2027-01-01T00:00:00.000Z' });
  await add('ordinary-tie', t0);
  const historical = await applyDecisionCommand(root, 'import', registration({ identity: { ...identity, subjectKey: 'history-old' }, createdAt: old }), () => t3);
  created.set('history-old', historical.item);
  const secondHistory = await applyDecisionCommand(root, 'import', registration({ identity: { ...identity, subjectKey: 'history-new' }, createdAt: t0 }), () => t3);
  created.set('history-new', secondHistory.item);
  const asleep = await add('asleep', old, { blocking: true, deadline: t0 });
  await applyDecisionCommand(root, 'snooze', { id: asleep.id, expectedRevision: 1, requestId: 'snooze-indefinitely', until: null, reason: '暂不处理' }, () => t1);
  const cancelled = await add('cancelled', t0, { blocking: true, deadline: t0 });
  await applyDecisionCommand(root, 'cancel', { id: cancelled.id, expectedRevision: 1, requestId: 'cancel', reason: '不再适用' }, () => t1);
  const decided = await add('decided', t1, { blocking: true, deadline: t0 });
  await applyDecisionCommand(root, 'decide', { id: decided.id, expectedRevision: 1, requestId: 'decide', decision: { text: '按已确认范围处理', scope: identity.scope }, actions: [] }, () => t2);
  const originalFiles = await Promise.all([...created.values()].map(item => readFile(decisionFile(root, item.id))));
  const overview = await readWorkspaceOverview(root, null, () => t3);
  const keyById = new Map([...created].map(([key, item]) => [item.id, key]));
  const tied = ['ordinary-future', 'ordinary-tie'].sort((a, b) => created.get(a).id.localeCompare(created.get(b).id));
  assert.deepEqual(overview.decisions.map(item => keyById.get(item.id)), ['urgent-deadline', 'urgent-blocked', 'urgent-reminder', 'ordinary-old', ...tied, 'history-old', 'history-new', 'asleep', 'cancelled', 'decided']);
  assert.equal(overview.counts.open, 6);
  assert.equal(overview.counts.history, 2);
  assert.equal(overview.decisions.find(item => item.id === reminded.id).state, 'snoozed');
  assert.equal(overview.decisions.find(item => item.id === reminded.id).effectiveState, 'open');
  assert.deepEqual(await Promise.all([...created.values()].map(item => readFile(decisionFile(root, item.id)))), originalFiles);
  const again = await readWorkspaceOverview(root, overview, () => t3);
  assert.deepEqual(again.decisions.map(item => item.id), overview.decisions.map(item => item.id));
});

test('在招严格排除未知、空和其他状态；我的关注可跨全部状态', () => {
  const statuses = ['在招', '暂停', '已关闭', '已下架', '待核', '历史待核', '探索线', null, '', ' 在招 ', undefined];
  const roles = statuses.map((status, index) => ({ name: `合成岗${index}`, status, configured: index < 10, priority: null }));
  const candidates = roles.map((role, index) => ({ id: String(index), role: role.name, stage: 'screen' }));
  const snapshot = { roles, candidates };
  assert.deepEqual(selectRoles(snapshot).roles, [roles[0]]);
  assert.equal(selectRoles(snapshot).total, 1);
  assert.equal(selectRoles(snapshot).label, '在招');
  assert.deepEqual(selectRoles(snapshot, { scope: 'all' }).roles, roles);
  assert.equal(selectRoles(snapshot, { scope: 'all' }).total, roles.length);
  const following = selectRoles(snapshot, { scope: 'following', following: roles.slice(1).map(role => role.name) });
  assert.deepEqual(following.roles, roles.slice(1));
  assert.equal(following.label, '我的关注');
  assert.equal(ROLE_SCOPES.find(scope => scope.id === 'following').label, '我的关注');
  assert.equal(selectRoles({ roles: roles.slice(1), candidates }).total, 0);
  assert.equal(selectRoles({ roles: [], candidates: null }).total, null);
});
