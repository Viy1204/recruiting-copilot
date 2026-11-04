import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir, hostname } from 'node:os';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { applyDecisionCommand, decisionsCLI, readDecision } from '../skills/recruit-board/scripts/decisions.mjs';
import { readWorkspaceOverview } from '../skills/recruit-board/scripts/overview.mjs';
import { recordProgress } from '../skills/recruit-board/scripts/progress.mjs';
import { importLegacyDecisions } from '../skills/recruit-board/scripts/import-history.mjs';

const t0 = '2026-11-01T01:00:00.000Z', t1 = '2026-11-02T01:00:00.000Z', t2 = '2026-11-03T01:00:00.000Z';
const identity = { subjectKey: 'candidate:123', questionKey: 'location-exception', scope: '仅此候选' };
async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'board-decisions-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await recordProgress({ workspace: root, id: 'first', workflow: 'daily', action: { type: 'start' } }, () => t0);
  return root;
}
const register = (root, extra = {}, time = t0) => applyDecisionCommand(root, 'register', { identity, title: '是否接受异地', source: { runId: 'first' }, expectedRevision: 0, requestId: 'register-1', ...extra }, () => time);
const mutate = (root, item, operation, extra = {}, time = t1) => applyDecisionCommand(root, operation, { id: item.id, expectedRevision: item.revision, requestId: `${operation}-${item.revision}`, ...extra }, () => time);
const answer = { text: '允许此候选远程', scope: identity.scope, authority: '用户明确批准', expiresAt: '2026-11-09T01:00:00.000Z' };
const actions = [{ id: 'sync', label: '同步台账', kind: 'sync' }, { id: 'contact', label: '联系候选', kind: 'external' }];
const decisionFile = (root, id) => path.join(root, 'runtime/recruit-board/decisions', `${id}.json`);

test('显式身份跨五轮去重，原始时间不变；同名、相近问题、不同范围独立', async t => {
  const root = await fixture(t);
  let { item } = await register(root);
  const id = item.id;
  for (let index = 2; index <= 5; index++) {
    const runId = `round-${index}`;
    await recordProgress({ workspace: root, id: runId, workflow: 'daily', action: { type: 'start' } }, () => t0);
    ({ item } = await register(root, { source: { runId }, expectedRevision: item.revision, requestId: `register-${index}` }, t1));
    assert.equal(item.id, id);
  }
  assert.equal(item.sources.length, 5); assert.equal(item.createdAt, t0); assert.equal(item.updatedAt, t1);
  assert.equal(item.history.length, 5);
  for (const delta of [{ subjectKey: 'candidate:124' }, { questionKey: 'location-exception-2' }, { scope: '岗位规则' }]) {
    const other = await register(root, { identity: { ...identity, ...delta } });
    assert.notEqual(other.item.id, id);
  }
  const overview = await readWorkspaceOverview(root, null, () => t1);
  assert.equal(overview.decisions.length, 4); assert.equal(overview.counts.open, 4);
});

test('原run完成后仍可决定、落实多动作，原文件逐字不变', async t => {
  const root = await fixture(t);
  let { item } = await register(root);
  let run;
  for (const step of ['unread', 'priorities', 'sourcing', 'screen', 'greet', 'ledger', 'report', 'card', 'keywords']) {
    run = await recordProgress({ workspace: root, id: 'first', action: { type: 'skip', step, reason: '合成跳过' } }, () => t0);
  }
  await recordProgress({ workspace: root, id: run.id, action: { type: 'complete' } }, () => t0);
  const file = path.join(root, 'runtime/recruit-board/runs/first.json'), original = await readFile(file);
  ({ item } = await mutate(root, item, 'decide', { decision: answer, actions }));
  let overview = await readWorkspaceOverview(root, null, () => t1);
  assert.equal(overview.counts.open, 0); assert.equal(overview.counts.followUp, 1);
  ({ item } = await mutate(root, item, 'action', { actionId: 'sync', status: 'done', evidence: '已核对台账' }));
  assert.equal(item.followUp.status, 'pending'); assert.equal(item.followUp.counts.done, 1);
  await assert.rejects(mutate(root, item, 'close', { reason: '完成' }), error => error.code === 'DECISION_STATE_INVALID');
  ({ item } = await mutate(root, item, 'action', { actionId: 'contact', status: 'failed', reason: '平台不可用' }));
  assert.equal(item.followUp.status, 'failed');
  await assert.rejects(mutate(root, item, 'action', { actionId: 'contact', status: 'running' }), /核实/);
  ({ item } = await mutate(root, item, 'action', { actionId: 'contact', status: 'running', verification: '已核实尚未发出' }));
  ({ item } = await mutate(root, item, 'action', { actionId: 'contact', status: 'uncertain', reason: '请求超时' }));
  await assert.rejects(mutate(root, item, 'action', { actionId: 'contact', status: 'done', evidence: '实际已发送' }), /核实/);
  await assert.rejects(mutate(root, item, 'revise', { decision: answer, reason: '改口', actions: [] }), /核实/);
  ({ item } = await mutate(root, item, 'action', { actionId: 'contact', status: 'done', evidence: '平台回执确认', verification: '查到唯一消息' }));
  ({ item } = await mutate(root, item, 'close', { reason: '两项均已核实完成' }));
  assert.equal(item.state, 'closed');
  overview = await readWorkspaceOverview(root, null, () => t1);
  assert.equal(overview.counts.followUp, 0);
  assert.deepEqual(await readFile(file), original);
});

test('版本冲突显式拒绝；同请求跨进程重放不重写，不重复历史且回放不倒退新状态', async t => {
  const root = await fixture(t);
  let { item } = await register(root);
  const payload = { id: item.id, expectedRevision: 1, requestId: 'answer-fixed', decision: answer, actions: [] };
  ({ item } = await applyDecisionCommand(root, 'decide', payload, () => t1));
  const oldHistory = structuredClone(item.history);
  ({ item } = await mutate(root, item, 'revise', { decision: { ...answer, text: '改为现场办公' }, reason: '明确修订', actions: [] }, t2));
  assert.deepEqual(item.history.slice(0, 2), oldHistory);
  const before = await readFile(decisionFile(root, item.id));
  await assert.rejects(applyDecisionCommand(root, 'decide', { ...payload, requestId: 'stale' }, () => t2), error => error.code === 'DECISION_REVISION_CONFLICT');
  const cli = fileURLToPath(new URL('../skills/recruit-board/scripts/decisions.mjs', import.meta.url));
  const { stdout } = await promisify(execFile)(process.execPath, [cli, 'decide', '--workspace', root, '--input', JSON.stringify(payload)]);
  const replay = JSON.parse(stdout);
  assert.equal(replay.replayed, true); assert.equal(replay.appliedRevision, 2); assert.equal(replay.item.revision, 3);
  assert.equal(replay.item.decision.text, '改为现场办公');
  assert.deepEqual(await readFile(decisionFile(root, item.id)), before);
  await assert.rejects(applyDecisionCommand(root, 'decide', { ...payload, decision: { ...answer, text: '别的内容' } }, () => t2), error => error.code === 'DECISION_REQUEST_CONFLICT');
});

test('并发同版本仅一位写入者成功，其他事项互不锁住', async t => {
  const root = await fixture(t), { item } = await register(root);
  const writes = await Promise.allSettled([
    mutate(root, item, 'snooze', { until: null, reason: '稍后' }),
    mutate(root, item, 'decide', { decision: answer })
  ]);
  assert.equal(writes.filter(value => value.status === 'fulfilled').length, 1);
  assert.ok(['DECISION_LOCKED', 'DECISION_REVISION_CONFLICT'].includes(writes.find(value => value.status === 'rejected').reason.code));
  const independent = await Promise.all([register(root, { identity: { ...identity, subjectKey: 'candidate:a' } }), register(root, { identity: { ...identity, subjectKey: 'candidate:b' } })]);
  assert.equal(independent.length, 2);
});

test('已退出写入进程留下的完整锁可恢复，活进程或未知锁不被按时间删除', async t => {
  const root = await fixture(t), { item } = await register(root);
  const child = spawn(process.execPath, ['-e', 'process.exit(0)']);
  await new Promise((resolve, reject) => { child.on('error', reject); child.on('exit', resolve); });
  const lock = decisionFile(root, item.id).replace(/\.json$/, '.lock');
  await writeFile(lock, JSON.stringify({ pid: child.pid, host: hostname(), token: '00000000-0000-0000-0000-000000000000' }));
  const recovered = await mutate(root, item, 'snooze', { until: null, reason: '恢复后暂缓' });
  assert.equal(recovered.item.state, 'snoozed');
  await writeFile(lock, JSON.stringify({ pid: process.pid, host: hostname(), token: '00000000-0000-0000-0000-000000000000' }));
  await assert.rejects(mutate(root, recovered.item, 'reopen', { reason: '重新确认' }), error => error.code === 'DECISION_LOCKED');
  assert.ok((await readFile(lock, 'utf8')).includes(String(process.pid)));
  await rm(lock);
});

test('暂缓到期读取恢复提醒但不授权、不写文件；新证据不自动反转决定，重开保留历史', async t => {
  const root = await fixture(t);
  let { item } = await register(root);
  ({ item } = await mutate(root, item, 'snooze', { until: t2, reason: '周二再看' }));
  const before = await readFile(decisionFile(root, item.id));
  const early = await readWorkspaceOverview(root, null, () => t1), due = await readWorkspaceOverview(root, null, () => t2);
  assert.equal(early.counts.snoozed, 1); assert.equal(due.counts.open, 1); assert.notEqual(early.revision, due.revision);
  assert.equal(due.decisions[0].state, 'snoozed'); assert.equal(due.decisions[0].decision, null);
  assert.deepEqual(await readFile(decisionFile(root, item.id)), before);
  ({ item } = await mutate(root, item, 'decide', { decision: answer, actions: [] }, t2));
  ({ item } = await mutate(root, item, 'evidence', { source: { runId: 'first' }, evidence: '候选条件有变化' }, t2));
  assert.equal(item.state, 'decided'); assert.equal(item.decision.text, answer.text);
  ({ item } = await mutate(root, item, 'reopen', { reason: '新证据需要用户重看', evidence: '候选条件有变化' }, t2));
  assert.equal(item.state, 'open'); assert.equal(item.history[2].decision.text, answer.text);
});

test('修订开启新动作代际，撤回批准不遗留待联系；已完成旧同步不冒充新标准已同步', async t => {
  const root = await fixture(t);
  let { item } = await register(root);
  ({ item } = await mutate(root, item, 'decide', { decision: answer, actions }));
  ({ item } = await mutate(root, item, 'action', { actionId: 'sync', status: 'done', evidence: '旧标准已同步' }));
  ({ item } = await mutate(root, item, 'revise', { decision: { ...answer, text: '不再联系，更新标准' }, reason: '用户改口', actions: [actions[0]] }));
  assert.equal(item.actions.length, 1); assert.equal(item.actions[0].status, 'pending'); assert.equal(item.actions[0].evidence, null);
  assert.equal(item.actions[0].decisionRevision, item.revision);
  assert.equal(item.history.at(-2).actions[0].status, 'done');
  ({ item } = await mutate(root, item, 'revise', { decision: { ...answer, text: '全部取消' }, reason: '再次明确改口', actions: [] }));
  assert.deepEqual(item.actions, []); assert.equal(item.followUp.status, 'none');
});

test('显式导入旧收据只进历史待核对、重复不新增；关联新事项不重复导入', async t => {
  const root = await fixture(t);
  const result = { id: 'old-1', stepId: 'screen', candidateId: JSON.stringify(['合成甲', '合成岗']), action: '初筛', outcome: '经历需核实', attention: 'decision', nextAction: '是否允许例外' };
  await recordProgress({ workspace: root, id: 'first', action: { type: 'result', result } }, () => t0);
  const original = await readFile(path.join(root, 'runtime/recruit-board/runs/first.json'));
  const imported = await importLegacyDecisions(root, 'first', () => t1);
  assert.equal(imported.imported.length, 1);
  const id = imported.imported[0].id;
  let item = await readDecision(root, id);
  assert.equal(item.state, 'history_review'); assert.equal(item.createdAt, t0);
  assert.equal((await importLegacyDecisions(root, 'first', () => t2)).skipped.length, 1);
  assert.equal((await readDecision(root, id)).revision, 1);
  ({ item } = await mutate(root, item, 'resolve-history', { resolution: 'closed', reason: '核实已拒绝', decision: { text: '拒绝此例外', scope: item.identity.scope } }, t2));
  assert.equal(item.state, 'closed');
  assert.deepEqual(await readFile(path.join(root, 'runtime/recruit-board/runs/first.json')), original);
  const fresh = await register(root);
  await recordProgress({ workspace: root, id: 'first', action: { type: 'result', result: { ...result, id: 'linked', decisionId: fresh.item.id } } }, () => t1);
  await assert.rejects(recordProgress({ workspace: root, id: 'first', action: { type: 'result', result: { ...result, id: 'linked' } } }, () => t1), /不可移除或改绑/);
  const importedAgain = await importLegacyDecisions(root, 'first', () => t2);
  assert.equal(importedAgain.imported.length, 0); assert.equal(importedAgain.skipped.length, 2);
  await rm(decisionFile(root, fresh.item.id));
  assert.equal((await importLegacyDecisions(root, 'first', () => t2)).diagnostics[0].code, 'DECISION_LINK_INVALID');
});

test('历史导入折叠合法多行和制表符，原收据完整保留且重复导入不新增', async t => {
  const root = await fixture(t);
  const result = { id: 'multiline', stepId: 'screen', candidateId: JSON.stringify(['合成甲', '合成岗']), action: '初筛', outcome: '技术经历匹配\n地点\t仍需核实', attention: 'decision', nextAction: '是否接受异地\r\n\t并确认例外范围' };
  await recordProgress({ workspace: root, id: 'first', action: { type: 'result', result } }, () => t0);
  await recordProgress({ workspace: root, id: 'first', action: { type: 'cancel', reason: '合成历史轮次' } }, () => t0);
  const file = path.join(root, 'runtime/recruit-board/runs/first.json'), original = await readFile(file);
  const imported = await importLegacyDecisions(root, 'first', () => t1);
  assert.equal(imported.status, 'ok'); assert.equal(imported.imported.length, 1);
  const item = await readDecision(root, imported.imported[0].id);
  assert.equal(item.state, 'history_review');
  assert.equal(item.title, '是否接受异地 并确认例外范围');
  assert.equal(item.history[0].evidence, '技术经历匹配 地点 仍需核实');
  assert.deepEqual(item.sources[0], { runId: 'first', resultId: 'multiline', recordedAt: t1 });
  const repeated = await importLegacyDecisions(root, 'first', () => t2);
  assert.equal(repeated.imported.length, 0); assert.equal(repeated.skipped.length, 1);
  assert.equal((await readDecision(root, item.id)).revision, 1);
  assert.deepEqual(await readFile(file), original);
});

test('未接入、已接入零项、损坏和删除有不同读数；缓存保留最后可信状态', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'board-empty-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  let overview = await readWorkspaceOverview(root, null, () => t0);
  assert.equal(overview.status, 'missing'); assert.equal(overview.counts.open, null);
  assert.deepEqual(await readdir(root), []);
  await recordProgress({ workspace: root, id: 'first', workflow: 'daily', action: { type: 'start' } }, () => t0);
  overview = await readWorkspaceOverview(root, null, () => t0);
  assert.equal(overview.status, 'ok'); assert.equal(overview.counts.open, 0);
  const { item } = await register(root);
  const good = await readWorkspaceOverview(root, null, () => t1);
  const file = decisionFile(root, item.id), bytes = await readFile(file);
  await writeFile(file, '{');
  const bad = await readWorkspaceOverview(root, null, () => t1);
  assert.equal(bad.status, 'error'); assert.equal(bad.counts.open, null); assert.equal(bad.decisions, null);
  const stale = await readWorkspaceOverview(root, good, () => t1);
  assert.equal(stale.status, 'stale'); assert.equal(stale.counts.open, 1);
  await writeFile(file, bytes);
  assert.equal((await readWorkspaceOverview(root, stale, () => t1)).status, 'ok');
  await rm(file);
  assert.equal((await readWorkspaceOverview(root, null, () => t1)).counts.open, null);
  await assert.rejects(register(root), error => error.code === 'DECISION_MISSING');
});

test('来源、版本、身份、输入文件与路径边界验证，拒绝后不改原记录', async t => {
  const root = await fixture(t);
  const outside = await mkdtemp(path.join(tmpdir(), 'board-outside-'));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await assert.rejects(register(root, { source: { runId: 'missing' } }), error => error.code === 'RUN_NOT_FOUND');
  await assert.rejects(register(root, { source: { runId: 'first', resultId: 'missing' } }), /来源结果/);
  const { item } = await register(root);
  const original = await readFile(decisionFile(root, item.id));
  await assert.rejects(mutate(root, item, 'decide', { decision: { ...answer, scope: '全岗' } }), /范围/);
  await assert.rejects(mutate(root, item, 'invalidate', { reason: '文件不见了' }), /依据/);
  await assert.rejects(decisionsCLI(['show', '--workspace', root, '--id', '../other']), /ID/);
  const input = path.join(root, 'input.json');
  await writeFile(input, JSON.stringify({ id: item.id, expectedRevision: item.revision, requestId: 'file-snooze', until: null, reason: '先放着' }));
  assert.equal((await decisionsCLI(['snooze', '--workspace', root, '--input-file', input])).item.state, 'snoozed');
  const out = path.join(outside, 'input.json'); await writeFile(out, '{}');
  await assert.rejects(decisionsCLI(['register', '--workspace', root, '--input-file', out]), /工作区/);
  await assert.rejects(decisionsCLI(['register', '--workspace', root, '--input', '{}', '--input-file', input]), /只能/);
  assert.notDeepEqual(await readFile(decisionFile(root, item.id)), original);
  const dataDirectory = path.join(root, 'runtime/recruit-board/decisions');
  await rename(dataDirectory, `${dataDirectory}-saved`);
  await symlink(outside, dataDirectory, process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal((await readWorkspaceOverview(root)).status, 'error');
  await assert.rejects(register(root), /工作区/);
  assert.deepEqual(await readdir(outside), ['input.json']);
});
