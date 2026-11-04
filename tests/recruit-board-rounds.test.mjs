import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import http from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { createRun, MAX_RUN_HIGHLIGHTS, transitionRun, validateRun } from '../skills/recruit-board/model.mjs';
import { progressCLI, recordProgress } from '../skills/recruit-board/scripts/progress.mjs';
import { applyDecisionCommand } from '../skills/recruit-board/scripts/decisions.mjs';
import { readWorkspaceOverview } from '../skills/recruit-board/scripts/overview.mjs';
import { readSnapshot } from '../skills/recruit-board/scripts/reader.mjs';
import { readRunHighlights } from '../skills/recruit-board/scripts/results.mjs';
import { actionsCLI } from '../skills/recruit-board/scripts/actions.mjs';
import { createBoardServer } from '../skills/recruit-board/scripts/server.mjs';
import { probeBoard } from '../skills/recruit-board/scripts/connect.mjs';

const old = '2026-10-20T01:00:00.000Z', first = '2026-11-01T01:00:00.000Z', later = '2026-11-02T01:00:00.000Z';
async function workspace(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'board-rounds-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
const start = (workspace, id, trigger = 'manual', time = first) => recordProgress({ workspace, id, trigger, workflow: 'daily', action: { type: 'start' } }, () => time);
const progress = (workspace, id, action, time = first) => recordProgress({ workspace, id, action }, () => time);
const request = (port, url, options = {}) => new Promise((resolve, reject) => {
  const req = http.request({ host: '127.0.0.1', port, path: url, ...options }, response => {
    let body = ''; response.setEncoding('utf8').on('data', chunk => { body += chunk; });
    response.on('end', () => resolve({ status: response.statusCode, body, headers: response.headers }));
  });
  req.on('error', reject); req.end();
});

test('旧run缺字段仍能读，未记录与显式no_change分开，trigger只接受明确枚举', async t => {
  const root = await workspace(t);
  const run = await start(root, 'legacy');
  for (const field of ['trigger', 'summaryState', 'closingSummary', 'highlights', 'highlightsRevision']) delete run[field];
  await writeFile(path.join(root, 'runtime/recruit-board/runs/legacy.json'), JSON.stringify(run));
  const legacy = await readRunHighlights(root, 'legacy');
  assert.equal(legacy.trigger, 'unknown'); assert.equal(legacy.summaryState, 'unrecorded'); assert.equal(legacy.highlights, null);
  const created = await progressCLI(['start', '--workspace', root, '--workflow', 'daily', '--run', 'scheduled', '--trigger', 'scheduled']);
  assert.equal(created.trigger, 'scheduled'); assert.equal(created.summaryState, 'unrecorded');
  const summary = await progressCLI(['summary', '--workspace', root, '--run', 'scheduled', '--state', 'no_change', '--text', '已核查，无重要变化']);
  assert.equal(summary.summaryState, 'no_change'); assert.equal(summary.highlights.length, 0);
  await assert.rejects(progressCLI(['start', '--workspace', root, '--workflow', 'daily', '--trigger', 'background']), /来源/);
  assert.equal((await actionsCLI(['run-highlights', '--workspace', root, '--run', 'legacy'])).summaryState, 'unrecorded');
});

test('近期重点独立于最新无变化轮次，同事件取最新事实，超过窗口仍可读原轮正文', async t => {
  const root = await workspace(t);
  await start(root, 'ancient', 'manual', old);
  await progress(root, 'ancient', { type: 'highlight', highlight: { eventKey: 'old-event', text: '旧进展' } }, old);
  await start(root, 'important');
  await progress(root, 'important', { type: 'highlight', highlight: { eventKey: 'candidate:123:interview', text: '安排面试', evidence: '已核对日程' } });
  await progress(root, 'important', { type: 'summary', summaryState: 'highlights', closingSummary: '已安排一位合成人选面试' });
  await start(root, 'correction', 'manual', later);
  await progress(root, 'correction', { type: 'highlight', highlight: { eventKey: 'candidate:123:interview', text: '面试改期', evidence: '已核实新时间', correction: '候选时间冲突' } }, later);
  await start(root, 'latest-check', 'scheduled', later);
  await progress(root, 'latest-check', { type: 'summary', summaryState: 'no_change', closingSummary: '巡检无重要变化' }, later);
  const overview = await readWorkspaceOverview(root, null, () => later);
  assert.equal(overview.highlights.length, 1); assert.equal(overview.highlights[0].text, '面试改期');
  assert.equal(overview.highlights[0].runId, 'correction');
  assert.deepEqual(overview.highlights[0].sourceRunIds.sort(), ['correction', 'important']);
  const original = await readRunHighlights(root, 'important');
  assert.equal(original.highlights[0].text, '安排面试'); assert.equal(original.summaryState, 'highlights');
  assert.equal((await readRunHighlights(root, 'ancient')).highlights[0].text, '旧进展');
  const snapshot = await readSnapshot(root, null, () => later);
  assert.equal(snapshot.runs.find(run => run.id === 'latest-check').trigger, 'scheduled');
  assert.equal(snapshot.workspaceOverview.counts.open, 0);
  assert.equal(JSON.stringify(snapshot).includes('已核对日程'), false);
  assert.ok(snapshot.runs.every(run => !Object.hasOwn(run, 'highlights')));
  assert.equal(Object.hasOwn(snapshot.workspaceOverview, 'decisions'), false);
});

test('重点重试不刷新排序和版本，更正需理由且保留前结论；no_change拒绝矛盾与终态写入', async t => {
  const root = await workspace(t);
  await start(root, 'retries');
  const highlight = { eventKey: 'event-1', text: '实际结果', evidence: '回执' };
  const one = await progress(root, 'retries', { type: 'highlight', highlight });
  const file = path.join(root, 'runtime/recruit-board/runs/retries.json'), original = await readFile(file);
  assert.deepEqual(await progress(root, 'retries', { type: 'highlight', highlight }, later), one);
  assert.deepEqual(await readFile(file), original);
  await assert.rejects(progress(root, 'retries', { type: 'highlight', highlight: { ...highlight, text: '更正结果' } }, later), /更正/);
  const corrected = await progress(root, 'retries', { type: 'highlight', expectedRevision: 1, requestId: 'correct-result', highlight: { ...highlight, text: '更正结果', correction: '核查回执后修正' } }, later);
  assert.equal(corrected.highlights[0].previousText, '实际结果'); assert.equal(corrected.highlights[0].correction, '核查回执后修正');
  assert.equal(corrected.highlightsRevision, 2);
  await assert.rejects(progress(root, 'retries', { type: 'summary', summaryState: 'no_change', closingSummary: '无变化' }, later), /已有重点/);
  await progress(root, 'retries', { type: 'cancel', reason: '合成结束' }, later);
  const final = await readFile(file);
  await assert.rejects(progress(root, 'retries', { type: 'highlight', highlight }, later), /已经结束/);
  await assert.rejects(progress(root, 'retries', { type: 'summary', summaryState: 'highlights', closingSummary: '结束后改写' }, later), /已经结束/);
  assert.deepEqual(await readFile(file), final);
});

test('重点多次更正保留逐版正文和依据，旧请求跨进程重放不回滚、改载荷和过期版本拒绝', async t => {
  const root = await workspace(t);
  await progressCLI(['start', '--workspace', root, '--run', 'correction-history', '--workflow', 'daily']);
  const base = ['highlight', '--workspace', root, '--run', 'correction-history', '--event', 'event-a'];
  await progressCLI([...base, '--text', 'A结论', '--evidence', 'A依据']);
  const requestB = [...base, '--text', 'B结论', '--evidence', 'B依据', '--correction', '复核为B', '--expected-revision', '1', '--request', 'correct-b'];
  await progressCLI(requestB);
  await progressCLI([...base, '--text', 'C结论', '--evidence', 'C依据', '--correction', '复核为C', '--expected-revision', '2', '--request', 'correct-c']);
  const file = path.join(root, 'runtime/recruit-board/runs/correction-history.json');
  const before = await readFile(file);
  const cli = fileURLToPath(new URL('../skills/recruit-board/scripts/progress.mjs', import.meta.url));
  const { stdout } = await promisify(execFile)(process.execPath, [cli, ...requestB]);
  const replay = JSON.parse(stdout);
  assert.equal(replay.highlights[0].text, 'C结论'); assert.equal(replay.highlights[0].revision, 3);
  assert.deepEqual(await readFile(file), before);
  const detail = await actionsCLI(['run-highlights', '--workspace', root, '--run', 'correction-history']);
  assert.equal(detail.highlights[0].revision, 3);
  assert.deepEqual(detail.highlights[0].history.map(entry => [entry.revision, entry.text, entry.evidence, entry.correction]), [[1, 'A结论', 'A依据', null], [2, 'B结论', 'B依据', '复核为B'], [3, 'C结论', 'C依据', '复核为C']]);
  assert.deepEqual(detail.highlights[0].history.map(entry => entry.requestId), [null, 'correct-b', 'correct-c']);
  const changed = [...requestB]; changed[changed.indexOf('--text') + 1] = '篡改请求';
  await assert.rejects(progressCLI(changed), error => error.code === 'HIGHLIGHT_REQUEST_CONFLICT');
  const stale = [...requestB]; stale[stale.indexOf('--request') + 1] = 'stale-request';
  await assert.rejects(progressCLI(stale), error => error.code === 'HIGHLIGHT_REVISION_CONFLICT');
  await assert.rejects(progressCLI([...base, '--text', 'D结论', '--correction', '缺版本和请求']), /expected-revision/);
  await assert.rejects(progressCLI([...base, '--text', 'D结论', '--correction', '仅版本', '--expected-revision', '3']), /request/);
  await assert.rejects(progressCLI([...base, '--text', 'D结论', '--correction', '非法版本', '--expected-revision', '3x', '--request', 'bad']), /revision/);
  assert.deepEqual(await readFile(file), before);
  const unchanged = await progressCLI([...base, '--text', 'C结论', '--evidence', 'C依据', '--correction', '复核为C']);
  assert.equal(unchanged.highlightsRevision, replay.highlightsRevision);
  await progressCLI(['cancel', '--workspace', root, '--run', 'correction-history', '--reason', '合成结束']);
  const ended = await readFile(file);
  assert.equal((await progressCLI(requestB)).status, 'cancelled');
  assert.deepEqual(await readFile(file), ended);
});

test('重点数量和文本有界，正文必须可验证，空结果不推断无变化', () => {
  let run = createRun({ id: 'bounded', workflow: 'daily', now: first });
  assert.equal(run.summaryState, 'unrecorded');
  for (let index = 0; index < MAX_RUN_HIGHLIGHTS; index++) run = transitionRun(run, { type: 'highlight', highlight: { eventKey: `event-${index}`, text: '核实后的结果' } }, first);
  assert.throws(() => transitionRun(run, { type: 'highlight', highlight: { eventKey: 'overflow', text: '结果' } }, first), /最多/);
  assert.throws(() => transitionRun(run, { type: 'highlight', highlight: { eventKey: 'x', text: 'x'.repeat(301) } }, first), /300/);
  assert.throws(() => validateRun({ ...run, trigger: 'guess' }), /来源/);
  assert.throws(() => validateRun({ ...run, summaryState: 'no_change', closingSummary: '无变化' }), /不能含重点/);
  assert.throws(() => validateRun({ ...run, highlights: [{ ...run.highlights[0], updatedAt: later, history: [{ ...run.highlights[0].history[0], updatedAt: later }] }] }), /时间/);
  assert.throws(() => transitionRun(run, { type: 'highlight', highlight: { eventKey: 'future', text: '未来事项', occurredAt: later } }, first), /发生时间/);
});

test('HTTP新读取入口遵守工作区和同源边界，health兼容，错误保留可信事项与重点', async t => {
  const root = await workspace(t);
  await start(root, 'api');
  const { item } = await applyDecisionCommand(root, 'register', { requestId: 'first', expectedRevision: 0, identity: { subjectKey: 'role:1', questionKey: 'remote', scope: '岗位地点' }, title: '确认地点', source: { runId: 'api' } }, () => first);
  await progressCLI(['highlight', '--workspace', root, '--run', 'api', '--event', 'remote-question', '--text', '需确认岗位地点', '--decision', item.id]);
  const server = await createBoardServer({ workspace: root });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const port = server.address().port;
  const health = JSON.parse((await request(port, '/api/health')).body);
  assert.ok(health.capabilities.includes('workspace-overview')); assert.ok(health.capabilities.includes('run-highlights'));
  assert.equal((await probeBoard({ workspace: root, url: `http://127.0.0.1:${port}` })).status, 'ready');
  const initial = JSON.parse((await request(port, '/api/workspace/overview')).body);
  assert.equal(initial.counts.open, 1); assert.equal(initial.decisions[0].id, item.id);
  const history = JSON.parse((await request(port, '/api/runs/highlights?run=api')).body);
  assert.equal(history.highlights[0].decisionId, item.id);
  for (const endpoint of ['/api/workspace/overview', '/api/runs/highlights?run=api']) {
    assert.equal((await request(port, endpoint, { headers: { Origin: 'https://evil.example' } })).status, 403);
    assert.equal((await request(port, endpoint, { headers: { 'X-Workspace-Key': 'a'.repeat(64) } })).status, 409);
    assert.equal((await request(port, endpoint, { method: 'POST' })).status, 405);
  }
  assert.equal((await request(port, '/api/workspace/overview?file=CONTEXT.md')).status, 400);
  assert.equal((await request(port, '/api/runs/highlights?run=../bad')).status, 400);
  assert.equal((await request(port, '/api/runs/highlights?run=api&run=api')).status, 400);
  const before = await readdir(root, { recursive: true });
  assert.equal((await actionsCLI(['workspace-overview', '--workspace', root])).counts.open, 1);
  assert.deepEqual(await readdir(root, { recursive: true }), before);
  await rm(path.join(root, 'runtime/recruit-board/runs/api.json'));
  const unavailable = JSON.parse((await request(port, '/api/workspace/overview')).body);
  assert.equal(unavailable.counts.open, 1);
  assert.equal(unavailable.status, 'stale');
  assert.equal(unavailable.highlights[0].eventKey, 'remote-question');
  assert.ok(unavailable.diagnostics.some(entry => entry.code === 'DECISION_SOURCE_UNAVAILABLE'));
  await writeFile(path.join(root, 'runtime/recruit-board/decisions', `${item.id}.json`), '{');
  const stale = JSON.parse((await request(port, '/api/workspace/overview')).body);
  assert.equal(stale.status, 'stale'); assert.equal(stale.counts.open, 1); assert.equal(stale.decisions[0].id, item.id);
});

test('轮次目录缺失不能伪报空重点，缺来源不取消已知事项', async t => {
  const root = await workspace(t);
  await start(root, 'source');
  await applyDecisionCommand(root, 'register', { requestId: 'r', expectedRevision: 0, identity: { subjectKey: 'role:1', questionKey: 'remote', scope: '岗位地点' }, title: '地点', source: { runId: 'source' } }, () => first);
  await rm(path.join(root, 'runtime/recruit-board/runs'), { recursive: true });
  const overview = await readWorkspaceOverview(root, null, () => later);
  assert.equal(overview.status, 'error'); assert.equal(overview.highlights, null); assert.equal(overview.counts.open, 1);
  assert.equal(overview.decisions[0].state, 'open');
  await writeFile(path.join(root, 'runtime/recruit-board/decisions', `${overview.decisions[0].id}.json`), '{');
  const stale = await readWorkspaceOverview(root, overview, () => later);
  assert.equal(stale.status, 'stale'); assert.equal(stale.counts.open, 1);
});
