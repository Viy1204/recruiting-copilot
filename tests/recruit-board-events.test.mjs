import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { LEDGER_COLUMNS, createRun, transitionRun } from '../skills/recruit-board/model.mjs';
import { readWorkspaceOverview } from '../skills/recruit-board/scripts/overview.mjs';

const now = '2026-11-04T12:00:00.000Z';
const id = JSON.stringify(['合成甲', '合成岗位']);
const archive = '# 面试档案 — 合成甲\n\n## 基本信息\n- 姓名：合成甲\n- 应聘岗位：合成岗位\n- 当前状态：已约一面\n\n## 面试安排\n| 轮次 | 时间 | 形式 | 面试官 | 状态 |\n|---|---|---|---|---|\n| 一面 | 2026-11-06 10:30–11:30 | 现场 | 合成面试官 | 已约 |\n\n## 决策\n- 下一步：面后回收反馈\n';
const table = '\n## 进展记录\n\n| 事件ID | 发生时间 | 类型 | 事实 | 依据 | 预约时段 | 面试官 | 来源任务 |\n|---|---|---|---|---|---|---|---|\n';
const row = (key = 'interview-one', when = '2026-11-04', run = '—') => `| ${key} | ${when} | 面试已约 | 已约一面 | 档案已核实邀约 | 2026-11-06 10:30–11:30 | 合成面试官 | ${run} |\n`;
async function fixture(t, content = archive + table + row()) {
  const root = await mkdtemp(path.join(tmpdir(), 'board-events-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const name of ['02-sourcing', '03-interview', '_shared', 'runtime/recruit-board/decisions', 'runtime/recruit-board/runs']) await mkdir(path.join(root, name), { recursive: true });
  await writeFile(path.join(root, 'CONTEXT.md'), '## 在招岗位与优先级\n| 岗位 | 优先级 | 状态 |\n|---|---|---|\n| 合成岗位 | P0 | 在招 |\n| 另一岗位 | P1 | 在招 |\n');
  await writeFile(path.join(root, '02-sourcing/dedup-ledger.csv'), `${LEDGER_COLUMNS.join(',')}\n1,合成甲,合成岗位,,A,已约谈,合成来源,,\n`);
  await writeFile(path.join(root, '03-interview/合成甲.md'), content);
  await writeFile(path.join(root, 'runtime/recruit-board/decisions/.initialized'), '');
  return root;
}

test('没有任务轮次的当日已约事件直接进入近期进展，日期不伪造时分', async t => {
  const root = await fixture(t);
  await rm(path.join(root, 'runtime/recruit-board/runs'), { recursive: true });
  const before = await readdir(root, { recursive: true });
  const overview = await readWorkspaceOverview(root, null, () => now);
  assert.equal(overview.status, 'ok');
  assert.equal(overview.highlights.length, 1);
  assert.equal(overview.highlights[0].eventKey, 'interview-one');
  assert.equal(overview.highlights[0].context.candidateId, id);
  assert.equal(overview.highlights[0].runId, null);
  assert.equal(overview.highlights[0].timePrecision, 'day');
  assert.equal(overview.highlights[0].sourceDocumentId.length, 64);
  assert.deepEqual(overview.highlights[0].sourceRunIds, []);
  assert.match(overview.highlights[0].details.find(field => field.label === '预约时段').value, /2026-11-06/);
  assert.deepEqual(await readdir(root, { recursive: true }), before);
});

test('读取与文件mtime不使旧事件变新，未来预约不是发生时间，重复刷新幂等', async t => {
  const root = await fixture(t, archive + table + row('old', '2026-10-01'));
  assert.equal((await readWorkspaceOverview(root, null, () => now)).highlights.length, 0);
  await writeFile(path.join(root, '03-interview/合成甲.md'), archive + table + row());
  const one = await readWorkspaceOverview(root, null, () => now);
  const two = await readWorkspaceOverview(root, one, () => '2026-11-05T12:00:00.000Z');
  assert.equal(two.highlights.length, 1);
  assert.equal(two.highlights[0].occurredAt, one.highlights[0].occurredAt);
  assert.equal(two.highlights[0].updatedAt, one.highlights[0].updatedAt);
});

test('同事件档案与旧任务重点只显示一次，来源任务和结构化人选都保留', async t => {
  const root = await fixture(t, archive + table + row('interview-one', '2026-11-04', 'schedule'));
  let run = createRun({ id: 'schedule', workflow: 'interview-schedule', now });
  run = transitionRun(run, { type: 'highlight', highlight: { eventKey: 'interview-one', text: '旧任务已约面', context: { scope: 'candidate', candidateId: id } } }, now);
  await writeFile(path.join(root, 'runtime/recruit-board/runs/schedule.json'), JSON.stringify(run));
  const overview = await readWorkspaceOverview(root, null, () => now);
  assert.equal(overview.highlights.length, 1);
  assert.deepEqual(overview.highlights[0].sourceRunIds, ['schedule']);
  assert.equal(overview.highlights[0].context.candidateId, id);
  assert.ok(overview.highlights[0].sourceDocumentId);
});

test('台账明确引用的非标准文件名面试档案同样进入进展，不被预筛遗漏', async t => {
  const root = await fixture(t);
  await writeFile(path.join(root, '03-interview/合成甲-一面.md'), archive + table + row());
  await rm(path.join(root, '03-interview/合成甲.md'));
  await writeFile(path.join(root, '02-sourcing/dedup-ledger.csv'), `${LEDGER_COLUMNS.join(',')}\n1,合成甲,合成岗位,,A,已约谈,合成来源,03-interview/合成甲-一面.md,\n`);
  const overview = await readWorkspaceOverview(root, null, () => now);
  assert.equal(overview.highlights.length, 1);
  assert.equal(overview.highlights[0].context.candidateId, id);
});

test('旧档案事件被任务重新引用但未更正时，不因导入时间进入近期', async t => {
  const root = await fixture(t, archive + table + row('old-event', '2026-10-01', 'imported'));
  let run = createRun({ id: 'imported', workflow: 'daily', now });
  run = transitionRun(run, { type: 'highlight', highlight: { eventKey: 'old-event', text: '旧安排重新引用', occurredAt: '2026-10-01T00:00:00.000Z', context: { scope: 'candidate', candidateId: id } } }, now);
  await writeFile(path.join(root, 'runtime/recruit-board/runs/imported.json'), JSON.stringify(run));
  assert.equal((await readWorkspaceOverview(root, null, () => now)).highlights.length, 0);
});

test('排期没有带日期事件则报覆盖缺口；损坏、丢档保留已知事件而非清空', async t => {
  const root = await fixture(t, archive);
  const missing = await readWorkspaceOverview(root, null, () => now);
  assert.ok(missing.diagnostics.some(item => item.code === 'PROGRESS_EVENT_MISSING'));
  await writeFile(path.join(root, '03-interview/合成甲.md'), archive + table + row());
  const known = await readWorkspaceOverview(root, null, () => now);
  await rm(path.join(root, '03-interview/合成甲.md'));
  const stale = await readWorkspaceOverview(root, known, () => now);
  assert.equal(stale.status, 'stale');
  assert.equal(stale.highlights[0].eventKey, 'interview-one');
  assert.ok(stale.diagnostics.some(item => item.code === 'PROGRESS_SOURCE_UNAVAILABLE'));
});

test('旧排期状态明确写出邀约发生日期时可恢复进展，不借用预约日或文件日期', async t => {
  const root = await fixture(t, archive.replace('| 已约 |', '| 已约（邀约由用户 2026-11-04 发出） |'));
  const overview = await readWorkspaceOverview(root, null, () => now);
  assert.equal(overview.highlights.length, 1);
  assert.equal(overview.highlights[0].timePrecision, 'day');
  assert.equal(overview.highlights[0].occurredAt.slice(0, 10), '2026-11-04');
  assert.match(overview.highlights[0].text, /邀约/);
  assert.equal(overview.diagnostics.some(item => item.code === 'PROGRESS_EVENT_MISSING'), false);
});

test('未核实同名异岗不读档案事件，显式归属后只进入对应原人岗', async t => {
  const root = await fixture(t);
  await writeFile(path.join(root, '02-sourcing/dedup-ledger.csv'), `${LEDGER_COLUMNS.join(',')}\n1,合成甲,合成岗位,,A,已约谈,合成来源,,\n2,合成甲,另一岗位,,A,已回复,合成来源,,\n`);
  assert.equal((await readWorkspaceOverview(root, null, () => now)).highlights.length, 0);
  await writeFile(path.join(root, '_shared/recruit-board.files.json'), JSON.stringify({ schemaVersion: 1, candidates: { [id]: { confirmed: true, files: [{ path: '03-interview/合成甲.md', category: 'archive' }] } } }));
  const overview = await readWorkspaceOverview(root, null, () => now);
  assert.equal(overview.highlights.length, 1);
  assert.equal(overview.highlights[0].context.candidateId, id);
});

test('不依赖run的写入入口追加档案并幂等、冲突不覆盖；约面任务漏事件不能静默完成', async t => {
  const root = await fixture(t, archive);
  const { recordCandidateEvent } = await import('../skills/recruit-board/scripts/events.mjs');
  const { readCandidateDetail } = await import('../skills/recruit-board/scripts/records.mjs');
  const { recordProgress } = await import('../skills/recruit-board/scripts/progress.mjs');
  const detail = await readCandidateDetail(root, id);
  const input = { workspace: root, candidateId: id, documentId: detail.documents[0].id, event: { eventKey: 'manual-interview', occurredAt: '2026-11-04', type: '面试已约', text: '已约一面', evidence: '已核实用户发出邀约', slot: '2026-11-06 10:30–11:30', interviewer: '合成面试官' } };
  let run = createRun({ id: 'schedule', workflow: 'interview-schedule', now });
  run = { ...run, status: 'running', steps: run.steps.map(step => ({ ...step, status: 'completed' })), results: [{ id: 'calendar', stepId: 'calendar', candidateId: id, action: '约面', outcome: '已安排面试', attention: 'none', nextAction: null, updatedAt: now }], resultsRevision: 1 };
  await writeFile(path.join(root, 'runtime/recruit-board/runs/schedule.json'), JSON.stringify(run));
  await assert.rejects(recordProgress({ workspace: root, id: run.id, action: { type: 'complete' } }, () => now), /进展|事件/);
  const one = await recordCandidateEvent({ ...input, event: { ...input.event, runId: run.id } }, () => now);
  const bytes = await readFile(path.join(root, '03-interview/合成甲.md'));
  assert.equal((await recordCandidateEvent({ ...input, event: { ...input.event, runId: run.id } }, () => now)).changed, false);
  assert.deepEqual(await readFile(path.join(root, '03-interview/合成甲.md')), bytes);
  await assert.rejects(recordCandidateEvent({ ...input, event: { ...input.event, text: '改成别的结论', runId: run.id } }, () => now), /事件.*冲突|已有事件/);
  const summary = await recordProgress({ workspace: root, id: run.id, action: { type: 'summary', summaryState: 'highlights', closingSummary: '面试安排已同步档案与总览' } }, () => now);
  assert.equal(summary.highlights.length, 1);
  assert.equal(summary.highlights[0].eventKey, 'manual-interview');
  const finished = await recordProgress({ workspace: root, id: run.id, action: { type: 'complete' } }, () => now);
  assert.equal(finished.status, 'completed');
  const overview = await readWorkspaceOverview(root, null, () => now);
  assert.equal(overview.highlights.length, 1);
  assert.equal(overview.highlights[0].eventKey, 'manual-interview');
  assert.ok(one.changed);
});
