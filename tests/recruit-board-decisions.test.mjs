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
import { createBoardServer } from '../skills/recruit-board/scripts/server.mjs';
import { actionsCLI } from '../skills/recruit-board/scripts/actions.mjs';

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

async function startDecisionBoard(t, root, now = () => t1) {
  const server = await createBoardServer({ workspace: root, now });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const health = await (await fetch(`${baseUrl}/api/health`)).json();
  const { csrfToken } = await (await fetch(`${baseUrl}/api/session`)).json();
  const postDecision = async (body, headers = {}, rawBody = null) => {
    const response = await fetch(`${baseUrl}/api/decisions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-CSRF-Token': csrfToken,
        'X-Workspace-Key': health.workspaceKey,
        Origin: baseUrl,
        ...headers
      },
      body: rawBody ?? JSON.stringify(body)
    });
    return { status: response.status, body: await response.json() };
  };
  return { baseUrl, health, csrfToken, postDecision };
}

test('HTTP /api/health 声明 web-decisions，POST /api/decisions 支持 decide 暂存、刷新总览缓存并与 actions CLI 互通', async t => {
  const root = await fixture(t);
  const { item } = await register(root);
  const { baseUrl, health, postDecision } = await startDecisionBoard(t, root, () => t1);
  assert.ok(health.capabilities.includes('web-decisions'));
  const beforeOverview = await (await fetch(`${baseUrl}/api/workspace/overview`)).json();
  assert.equal(beforeOverview.counts.open, 1);
  assert.equal(beforeOverview.counts.followUp, 0);

  const decided = await postDecision({
    operation: 'decide',
    input: { id: item.id, expectedRevision: 1, requestId: 'http-decide-1', decision: answer, actions }
  });
  assert.equal(decided.status, 200);
  assert.equal(decided.body.replayed, false);
  assert.equal(decided.body.appliedRevision, 2);
  assert.equal(decided.body.item.state, 'decided');
  assert.equal(decided.body.item.followUp.status, 'pending');
  assert.ok(decided.body.item.actions.every(action => action.status === 'pending'));
  assert.equal(typeof decided.body.message, 'string');

  const afterOverview = await (await fetch(`${baseUrl}/api/workspace/overview`)).json();
  assert.equal(afterOverview.counts.open, 0);
  assert.equal(afterOverview.counts.followUp, 1);
  assert.equal(afterOverview.decisions[0].state, 'decided');
  assert.equal(afterOverview.decisions[0].followUp.status, 'pending');

  const cliDirect = await actionsCLI(['workspace-overview', '--workspace', root]);
  assert.equal(cliDirect.counts.followUp, 1);
  assert.equal(cliDirect.decisions[0].id, item.id);
  assert.equal(cliDirect.decisions[0].state, 'decided');
  assert.equal(cliDirect.decisions[0].followUp.status, 'pending');

  const actionsCli = fileURLToPath(new URL('../skills/recruit-board/scripts/actions.mjs', import.meta.url));
  const { stdout } = await promisify(execFile)(process.execPath, [actionsCli, 'workspace-overview', '--workspace', root]);
  const cliProcess = JSON.parse(stdout);
  assert.equal(cliProcess.decisions[0].revision, 2);
  assert.equal(cliProcess.decisions[0].followUp.status, 'pending');
});

test('HTTP POST /api/decisions 支持 snooze、reopen、revise、cancel 与 resolve-history', async t => {
  const root = await fixture(t);
  const { item } = await register(root);
  const result = { id: 'hist-1', stepId: 'screen', candidateId: JSON.stringify(['合成乙', '合成岗']), action: '初筛', outcome: '需核对', attention: 'decision', nextAction: '是否保留历史例外' };
  await recordProgress({ workspace: root, id: 'first', action: { type: 'result', result } }, () => t0);
  const imported = await importLegacyDecisions(root, 'first', () => t0);
  const historyItem = await readDecision(root, imported.imported[0].id);

  const { baseUrl, postDecision } = await startDecisionBoard(t, root, () => t1);

  const snoozed = await postDecision({
    operation: 'snooze',
    input: { id: item.id, expectedRevision: 1, requestId: 'http-snooze-1', until: t2, reason: '暂缓到周二' }
  });
  assert.equal(snoozed.status, 200);
  assert.equal(snoozed.body.item.state, 'snoozed');
  const overview = await (await fetch(`${baseUrl}/api/workspace/overview`)).json();
  assert.equal(overview.counts.snoozed, 1);
  assert.equal(overview.counts.open, 0);
  assert.equal(overview.counts.history, 1);

  const reopened = await postDecision({
    operation: 'reopen',
    input: { id: item.id, expectedRevision: 2, requestId: 'http-reopen-1', reason: '提前重新评估' }
  });
  assert.equal(reopened.status, 200);
  assert.equal(reopened.body.item.state, 'open');

  const decided = await postDecision({
    operation: 'decide',
    input: { id: item.id, expectedRevision: 3, requestId: 'http-decide-2', decision: answer, actions }
  });
  assert.equal(decided.status, 200);

  const revised = await postDecision({
    operation: 'revise',
    input: { id: item.id, expectedRevision: 4, requestId: 'http-revise-1', decision: { ...answer, text: '改为现场办公' }, reason: '明确修订', actions: [actions[0]] }
  });
  assert.equal(revised.status, 200);
  assert.equal(revised.body.item.revision, 5);
  assert.equal(revised.body.item.decision.text, '改为现场办公');
  assert.equal(revised.body.item.followUp.status, 'pending');
  assert.equal(revised.body.item.actions.length, 1);

  const cancelled = await postDecision({
    operation: 'cancel',
    input: { id: item.id, expectedRevision: 5, requestId: 'http-cancel-1', reason: '岗位暂停' }
  });
  assert.equal(cancelled.status, 200);
  assert.equal(cancelled.body.item.state, 'cancelled');
  assert.equal(cancelled.body.item.followUp.status, 'cancelled');

  const resolved = await postDecision({
    operation: 'resolve-history',
    input: {
      id: historyItem.id,
      expectedRevision: 1,
      requestId: 'http-resolve-1',
      resolution: 'decided',
      reason: '核实后批准推进',
      decision: { text: '历史例外有效', scope: historyItem.identity.scope },
      actions: []
    }
  });
  assert.equal(resolved.status, 200);
  assert.equal(resolved.body.item.state, 'decided');
  assert.equal(resolved.body.item.decision.text, '历史例外有效');
});

test('HTTP POST /api/decisions 保证 requestId 幂等重放、载荷冲突 409、过期版本 409 不改磁盘与 scope 校验', async t => {
  const root = await fixture(t);
  const { item } = await register(root);
  const second = await register(root, { identity: { ...identity, subjectKey: 'candidate:999' }, requestId: 'register-second' });
  const { postDecision } = await startDecisionBoard(t, root, () => t1);

  const firstPayload = {
    operation: 'decide',
    input: { id: item.id, expectedRevision: 1, requestId: 'replay-req-1', decision: answer, actions: [] }
  };
  const first = await postDecision(firstPayload);
  assert.equal(first.status, 200);
  assert.equal(first.body.appliedRevision, 2);
  const diskAtRev2 = await readFile(decisionFile(root, item.id));

  const replay = await postDecision(firstPayload);
  assert.equal(replay.status, 200);
  assert.equal(replay.body.replayed, true);
  assert.equal(replay.body.appliedRevision, 2);
  assert.equal(replay.body.item.revision, 2);
  assert.deepEqual(await readFile(decisionFile(root, item.id)), diskAtRev2);

  const conflictPayload = await postDecision({
    operation: 'decide',
    input: { id: item.id, expectedRevision: 1, requestId: 'replay-req-1', decision: { ...answer, text: '篡改决定内容' }, actions: [] }
  });
  assert.equal(conflictPayload.status, 409);
  assert.equal(conflictPayload.body.error.code, 'DECISION_REQUEST_CONFLICT');
  assert.deepEqual(await readFile(decisionFile(root, item.id)), diskAtRev2);

  const revised = await postDecision({
    operation: 'revise',
    input: { id: item.id, expectedRevision: 2, requestId: 'revise-req-2', decision: { ...answer, text: '二轮修订' }, reason: '更新标准', actions: [] }
  });
  assert.equal(revised.status, 200);
  assert.equal(revised.body.item.revision, 3);
  const diskAtRev3 = await readFile(decisionFile(root, item.id));

  const stale = await postDecision({
    operation: 'revise',
    input: { id: item.id, expectedRevision: 1, requestId: 'stale-req-3', decision: { ...answer, text: '过期覆盖' }, reason: '旧版本', actions: [] }
  });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.error.code, 'DECISION_REVISION_CONFLICT');
  assert.deepEqual(await readFile(decisionFile(root, item.id)), diskAtRev3);

  const secondDisk = await readFile(decisionFile(root, second.item.id));
  const wrongScope = await postDecision({
    operation: 'decide',
    input: { id: second.item.id, expectedRevision: 1, requestId: 'scope-mismatch-1', decision: { ...answer, scope: '全岗通用' }, actions: [] }
  });
  assert.equal(wrongScope.status, 400);
  assert.equal(wrongScope.body.error.code, 'DECISION_INPUT_INVALID');
  assert.deepEqual(await readFile(decisionFile(root, second.item.id)), secondDisk);
});

test('HTTP POST /api/decisions 拒绝受限操作、非法输入、缺失 CSRF、跨站 Origin 与错误工作区键', async t => {
  const root = await fixture(t);
  const { item } = await register(root);
  const { baseUrl, health, csrfToken, postDecision } = await startDecisionBoard(t, root, () => t1);
  const validBody = { operation: 'snooze', input: { id: item.id, expectedRevision: 1, requestId: 'guard-check', until: null, reason: '测试守卫' } };

  for (const op of ['action', 'register', 'import', 'close', 'evidence', 'invalidate', 'unknown']) {
    const res = await postDecision({ operation: op, input: { id: item.id, expectedRevision: 1, requestId: `blocked-${op}` } });
    assert.equal(res.status, 400, op);
    assert.equal(res.body.error.code, 'DECISION_OP_FORBIDDEN', op);
  }

  for (const headers of [
    { 'X-CSRF-Token': '' },
    { 'X-CSRF-Token': csrfToken.replace(/^./, csrfToken[0] === 'a' ? 'b' : 'a') }
  ]) {
    const res = await postDecision(validBody, headers);
    assert.equal(res.status, 403);
    assert.equal(res.body.error.code, 'CSRF_REJECTED');
  }
  const noCsrf = await fetch(`${baseUrl}/api/decisions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Workspace-Key': health.workspaceKey, Origin: baseUrl },
    body: JSON.stringify(validBody)
  });
  assert.equal(noCsrf.status, 403);
  assert.equal((await noCsrf.json()).error.code, 'CSRF_REJECTED');

  const crossOrigin = await fetch(`${baseUrl}/api/decisions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken, 'X-Workspace-Key': health.workspaceKey, Origin: 'https://evil.example' },
    body: JSON.stringify(validBody)
  });
  assert.equal(crossOrigin.status, 403);

  const wrongKey = health.workspaceKey === 'a'.repeat(64) ? 'b'.repeat(64) : 'a'.repeat(64);
  const mismatch = await postDecision(validBody, { 'X-Workspace-Key': wrongKey });
  assert.equal(mismatch.status, 409);
  assert.equal(mismatch.body.error.code, 'WORKSPACE_MISMATCH');

  const nonJson = await postDecision(null, { 'Content-Type': 'text/plain' }, 'plain');
  assert.equal(nonJson.status, 415);
  assert.equal(nonJson.body.error.code, 'JSON_REQUIRED');

  const invalidJson = await postDecision(null, {}, '{');
  assert.equal(invalidJson.status, 400);
  assert.equal(invalidJson.body.error.code, 'JSON_INVALID');

  for (const badBody of [{}, { operation: 'snooze' }, { operation: 'snooze', input: {}, extra: 1 }, []]) {
    const res = await postDecision(badBody);
    assert.equal(res.status, 400);
    assert.equal(res.body.error.code, 'DECISION_INPUT_INVALID');
  }

  const oversized = await postDecision(null, {}, JSON.stringify({ operation: 'snooze', input: { pad: 'x'.repeat(33000) } }));
  assert.equal(oversized.status, 413);
  assert.equal(oversized.body.error.code, 'REQUEST_TOO_LARGE');

  const methodNotAllowed = await fetch(`${baseUrl}/api/decisions`, { method: 'DELETE' });
  assert.equal(methodNotAllowed.status, 405);
});
