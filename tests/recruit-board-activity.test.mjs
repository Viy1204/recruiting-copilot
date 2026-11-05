import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { LEDGER_COLUMNS, createRun, transitionRun } from '../skills/recruit-board/model.mjs';
import { readWorkspaceOverview } from '../skills/recruit-board/scripts/overview.mjs';

const now = '2026-11-05T12:00:00.000Z';
const id = (name, role) => JSON.stringify([name, role]);
const tableHeader = '\n## 进展记录\n\n| 事件ID | 发生时间 | 类型 | 事实 | 依据 | 预约时段 | 面试官 | 来源任务 |\n|---|---|---|---|---|---|---|---|\n';
const archive = (name, role, { rows = '', status = '已约', slot = '2026-11-06 10:30–11:30' } = {}) => `# 面试档案 — ${name}\n\n## 基本信息\n- 姓名：${name}\n- 应聘岗位：${role}\n\n## 面试安排\n| 轮次 | 时间 | 形式 | 面试官 | 状态 |\n|---|---|---|---|---|\n| 一面 | ${slot} | 现场 | 合成面试官 | ${status} |\n${tableHeader}${rows}`;
const eventRow = (key, when) => `| ${key} | ${when} | 面试已约 | 已核实事件 ${key} | 档案记录 | 2026-11-06 10:30–11:30 | 合成面试官 | — |\n`;

async function fixture(t, { rows, archives = {}, files = null, runs = [] } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'board-activity-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const name of ['02-sourcing', '03-interview', '_shared', 'runtime/recruit-board/decisions', 'runtime/recruit-board/runs']) await mkdir(path.join(root, name), { recursive: true });
  await writeFile(path.join(root, 'CONTEXT.md'), '## 在招岗位与优先级\n| 岗位 | 优先级 | 状态 |\n|---|---|---|\n| A岗 | P0 | 在招 |\n| B岗 | P1 | 在招 |\n');
  await writeFile(path.join(root, '02-sourcing/dedup-ledger.csv'), `${LEDGER_COLUMNS.join(',')}\n${rows}`);
  for (const [name, text] of Object.entries(archives)) await writeFile(path.join(root, '03-interview', name), text);
  if (files) await writeFile(path.join(root, '_shared/recruit-board.files.json'), JSON.stringify({ schemaVersion: 1, candidates: files }));
  for (const run of runs) await writeFile(path.join(root, 'runtime/recruit-board/runs', `${run.id}.json`), JSON.stringify(run));
  await writeFile(path.join(root, 'runtime/recruit-board/decisions/.initialized'), '');
  return root;
}

function runWithResults(runId, createdAt, results) {
  let run = createRun({ id: runId, workflow: 'daily', now: createdAt });
  for (const [index, result] of results.entries()) {
    run = transitionRun(run, { type: 'result', result: { id: `result-${index + 1}`, stepId: 'screen', candidateId: result.candidateId, action: '初筛', outcome: '已处理', attention: 'none', nextAction: null } }, result.at);
  }
  return run;
}

const mapping = (entries) => Object.fromEntries(entries.map(([candidateId, file]) => [candidateId, { confirmed: true, files: [{ path: `03-interview/${file}`, category: 'archive' }] }]));

test('活动索引取最新已核实档案事件，覆盖全部历史，未来与任意备注日期不冒充最新', async t => {
  const old = id('旧人', 'A岗'), fresh = id('新人', 'B岗'), blank = id('无时间', 'A岗'), future = id('未来', 'B岗'), backfill = id('补录', 'A岗'), noted = id('备注', 'B岗');
  const root = await fixture(t, {
    rows: `1,旧人,A岗,,A,已约谈,合成来源,,\n2,新人,B岗,,B,待初筛,合成来源,,\n3,无时间,A岗,,C,待初筛,合成来源,,\n4,未来,B岗,,A,待初筛,合成来源,,\n5,补录,A岗,,B,待初筛,合成来源,,\n6,备注,B岗,,A,待初筛,合成来源,,\n`,
    archives: {
      'old.md': archive('旧人', 'A岗', { rows: eventRow('old-1', '2026-09-01') + eventRow('old-2', '2026-11-05T02:00:00.000Z') }),
      'blank.md': archive('无时间', 'A岗'),
      'future.md': archive('未来', 'B岗', { rows: eventRow('future-old', '2026-10-01') + eventRow('future-new', '2026-11-06') }),
      'backfill.md': archive('补录', 'A岗', { rows: eventRow('backfill-1', '2026-10-01') }),
      'noted.md': archive('备注', 'B岗', { status: '已约（备注：2026-11-05 已核实岗位要求）' })
    },
    files: mapping([[old, 'old.md'], [blank, 'blank.md'], [future, 'future.md'], [backfill, 'backfill.md'], [noted, 'noted.md']]),
    runs: [runWithResults('recent', '2026-10-20T08:00:00.000Z', [{ candidateId: fresh, at: '2026-11-04T09:00:00.000Z' }])]
  });
  const overview = await readWorkspaceOverview(root, null, () => now);
  const activity = new Map(overview.candidateActivity.map(item => [item.candidateId, item]));
  assert.equal(activity.get(old).at, '2026-11-05T02:00:00.000Z');
  assert.equal(activity.get(old).precision, 'instant');
  assert.equal(activity.get(old).sourceKind, 'archive');
  assert.equal(activity.get(fresh).at, '2026-11-04T09:00:00.000Z');
  assert.equal(activity.get(fresh).sourceKind, 'result');
  assert.equal(activity.get(future).at, '2026-10-01T00:00:00.000Z');
  assert.equal(activity.get(backfill).at, '2026-10-01T00:00:00.000Z');
  assert.equal(activity.get(backfill).precision, 'day');
  assert.equal(activity.has(blank), false);
  assert.equal(activity.has(noted), false);
  assert.deepEqual(overview.candidateActivity.map(item => item.candidateId).slice(0, 2), [old, fresh]);
});

test('旧排期明确已发日期可按日参与排序，只有未来预约及计划、预计、取消、改期不能推测', async t => {
  const cases = [
    ['明确已发', '已约（邀约已于 2026-11-05 发出）'],
    ['只有未来预约', '已约'],
    ['计划邀约', '计划（邀约将于 2026-11-05 发出）'],
    ['预计邀约', '预计（邀约于 2026-11-05 发出）'],
    ['取消邀约', '取消（邀约已于 2026-11-05 发出）'],
    ['改期邀约', '改期（邀约已于 2026-11-05 发出）']
  ];
  const invited = id('明确已发', 'A岗'), earlier = id('较早有效', 'B岗');
  const root = await fixture(t, {
    rows: cases.map(([name], index) => `${index + 1},${name},A岗,,B,待初筛,合成来源,,\n`).join('') + '7,较早有效,B岗,,A,已约谈,合成来源,,\n',
    archives: {
      ...Object.fromEntries(cases.map(([name, status], index) => [`case-${index}.md`, archive(name, 'A岗', { status })])),
      'earlier.md': archive('较早有效', 'B岗', { rows: eventRow('earlier-event', '2026-11-04T07:00:00.000Z') })
    },
    files: mapping([...cases.map(([name], index) => [id(name, 'A岗'), `case-${index}.md`]), [earlier, 'earlier.md']])
  });
  const overview = await readWorkspaceOverview(root, null, () => now);
  assert.equal(overview.status, 'ok');
  assert.deepEqual(overview.candidateActivity, [
    { candidateId: invited, at: '2026-11-05T00:00:00.000Z', precision: 'day', sourceKind: 'archive' },
    { candidateId: earlier, at: '2026-11-04T07:00:00.000Z', precision: 'instant', sourceKind: 'archive' }
  ]);
  const restored = overview.highlights.find(item => item.context?.candidateId === invited);
  assert.equal(restored.recovered, true);
  assert.equal(restored.timePrecision, 'day');
  assert.equal(restored.occurredAt, '2026-11-05T00:00:00.000Z');
});

test('更正历史中的撤回误记不参与活动排序，仅有撤回记录的人选没有可靠时间', async t => {
  const recent = id('有效最近', 'A岗'), corrected = id('有撤回误记', 'B岗'), withdrawnOnly = id('仅撤回误记', 'A岗');
  const withdrawn = tableHeader.replace('## 进展记录', '## 更正历史（已撤回的误记）');
  const root = await fixture(t, {
    rows: `1,有效最近,A岗,,A,已约谈,合成来源,,\n2,有撤回误记,B岗,,B,已约谈,合成来源,,\n3,仅撤回误记,A岗,,C,待初筛,合成来源,,\n`,
    archives: {
      'recent.md': archive('有效最近', 'A岗', { rows: eventRow('current-recent', '2026-11-04T07:00:00.000Z') }),
      'corrected.md': archive('有撤回误记', 'B岗', { rows: eventRow('current-old', '2026-10-01') }) + withdrawn + eventRow('withdrawn-newer', '2026-11-05T11:00:00.000Z'),
      'withdrawn-only.md': archive('仅撤回误记', 'A岗') + withdrawn + eventRow('withdrawn-only', '2026-11-05T11:30:00.000Z')
    },
    files: mapping([[recent, 'recent.md'], [corrected, 'corrected.md'], [withdrawnOnly, 'withdrawn-only.md']])
  });
  const overview = await readWorkspaceOverview(root, null, () => now);
  assert.equal(overview.status, 'ok');
  assert.deepEqual(overview.candidateActivity, [
    { candidateId: recent, at: '2026-11-04T07:00:00.000Z', precision: 'instant', sourceKind: 'archive' },
    { candidateId: corrected, at: '2026-10-01T00:00:00.000Z', precision: 'day', sourceKind: 'archive' }
  ]);
  assert.equal(overview.highlights.some(item => item.eventKey.startsWith('withdrawn-')), false);
  assert.equal(overview.diagnostics.some(item => ['PROGRESS_EVENT_INVALID', 'PROGRESS_SOURCE_UNAVAILABLE'].includes(item.code)), false);
  const refreshed = await readWorkspaceOverview(root, overview, () => now);
  assert.equal(refreshed.status, 'ok');
  assert.deepEqual(refreshed.candidateActivity, overview.candidateActivity);
});

test('结果收据按实际处理时间参与排序，不被轮次后续更新时间覆盖，同时间档案优先', async t => {
  const processed = id('结果人', 'A岗'), later = id('后记录', 'B岗'), archived = id('档案人', 'A岗'), tied = id('同时间', 'B岗');
  const root = await fixture(t, {
    rows: `1,结果人,A岗,,A,待初筛,合成来源,,\n2,后记录,B岗,,B,待初筛,合成来源,,\n3,档案人,A岗,,A,待初筛,合成来源,,\n4,同时间,B岗,,B,待初筛,合成来源,,\n`,
    archives: {
      'archived.md': archive('档案人', 'A岗', { rows: eventRow('archive-1', '2026-11-04T01:00:00.000Z') }),
      'tied.md': archive('同时间', 'B岗', { rows: eventRow('tied-1', '2026-11-03T08:00:00.000Z') })
    },
    files: mapping([[archived, 'archived.md'], [tied, 'tied.md']]),
    runs: [
      runWithResults('processed', '2026-11-01T08:00:00.000Z', [{ candidateId: processed, at: '2026-11-03T08:00:00.000Z' }, { candidateId: later, at: '2026-11-05T10:00:00.000Z' }]),
      runWithResults('archived', '2026-11-01T08:00:00.000Z', [{ candidateId: archived, at: '2026-11-02T08:00:00.000Z' }, { candidateId: tied, at: '2026-11-03T08:00:00.000Z' }])
    ]
  });
  const overview = await readWorkspaceOverview(root, null, () => now);
  const activity = new Map(overview.candidateActivity.map(item => [item.candidateId, item]));
  assert.equal(activity.get(processed).at, '2026-11-03T08:00:00.000Z');
  assert.equal(activity.get(processed).sourceKind, 'result');
  assert.equal(activity.get(later).at, '2026-11-05T10:00:00.000Z');
  assert.equal(activity.get(archived).at, '2026-11-04T01:00:00.000Z');
  assert.equal(activity.get(archived).sourceKind, 'archive');
  assert.equal(activity.get(tied).at, '2026-11-03T08:00:00.000Z');
  assert.equal(activity.get(tied).sourceKind, 'archive');
});

test('仅有处理收据的轮次丢失时保留可信时间并提示，来源恢复更新后解除', async t => {
  const candidateId = id('结果人', 'A岗');
  const root = await fixture(t, {
    rows: '1,结果人,A岗,,A,待初筛,合成来源,,\n',
    runs: [runWithResults('results-only', '2026-11-01T08:00:00.000Z', [{ candidateId, at: '2026-11-04T09:00:00.000Z' }])]
  });
  const known = await readWorkspaceOverview(root, null, () => now);
  assert.equal(known.status, 'ok');
  assert.deepEqual(known.highlights, []);
  const source = path.join(root, 'runtime/recruit-board/runs/results-only.json');
  await rm(source);
  const stale = await readWorkspaceOverview(root, known, () => now);
  assert.equal(stale.status, 'stale');
  assert.deepEqual(stale.candidateActivity, known.candidateActivity);
  assert.equal(stale.updatedAt, known.updatedAt);
  assert.ok(stale.diagnostics.some(item => item.level === 'error' && item.source === 'runs'));
  await writeFile(source, JSON.stringify(runWithResults('results-only', '2026-11-01T08:00:00.000Z', [{ candidateId, at: '2026-11-05T09:00:00.000Z' }])));
  const recovered = await readWorkspaceOverview(root, stale, () => now);
  assert.equal(recovered.status, 'ok');
  assert.equal(recovered.candidateActivity[0].at, '2026-11-05T09:00:00.000Z');
  assert.deepEqual(recovered.diagnostics, []);
});

test('同名异岗各取自己的事件时间，来源失效时保留最后可信索引', async t => {
  const active = id('同名', 'A岗'), other = id('同名', 'B岗');
  const root = await fixture(t, {
    rows: `1,同名,A岗,,A,待初筛,合成来源,,\n2,同名,B岗,,B,待初筛,合成来源,,\n`,
    archives: {
      'active.md': archive('同名', 'A岗', { rows: eventRow('active-1', '2026-10-01') }),
      'other.md': archive('同名', 'B岗', { rows: eventRow('other-1', '2026-11-04T07:00:00.000Z') })
    },
    files: mapping([[active, 'active.md'], [other, 'other.md']])
  });
  const known = await readWorkspaceOverview(root, null, () => now);
  const activity = new Map(known.candidateActivity.map(item => [item.candidateId, item]));
  assert.equal(activity.get(active).at, '2026-10-01T00:00:00.000Z');
  assert.equal(activity.get(other).at, '2026-11-04T07:00:00.000Z');
  assert.notEqual(activity.get(active).at, activity.get(other).at);
  await rm(path.join(root, '03-interview'), { recursive: true });
  await rm(path.join(root, 'runtime/recruit-board/runs'), { recursive: true });
  const stale = await readWorkspaceOverview(root, known, () => now);
  assert.equal(stale.status, 'stale');
  assert.ok(stale.diagnostics.some(item => item.code === 'PROGRESS_SOURCE_UNAVAILABLE'));
  assert.deepEqual(stale.candidateActivity.map(item => [item.candidateId, item.at]), known.candidateActivity.map(item => [item.candidateId, item.at]));
  const unknown = await readWorkspaceOverview(root, null, () => now);
  assert.equal(unknown.candidateActivity, null);
});
