import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const sourceRoot = path.resolve(process.env.FORMAL_SOURCE_ROOT || repoRoot);
const { LEDGER_COLUMNS } = await import(pathToFileURL(path.join(sourceRoot, 'skills/recruit-board/model.mjs')).href);
const { recordProgress } = await import(pathToFileURL(path.join(sourceRoot, 'skills/recruit-board/scripts/progress.mjs')).href);
const { recordCandidateEvent, readArchiveEvents, parseArchiveEvents } = await import(pathToFileURL(path.join(sourceRoot, 'skills/recruit-board/scripts/events.mjs')).href);
const { readCandidateDetail } = await import(pathToFileURL(path.join(sourceRoot, 'skills/recruit-board/scripts/records.mjs')).href);
const now = '2026-11-04T12:00:00.000Z';
const role = '虚构核验岗位';
const candidateId = name => JSON.stringify([name, role]);
const archivePath = name => `03-interview/${name}.md`;
const archive = name => `# 面试档案 — ${name}\n\n## 基本信息\n- 姓名：${name}\n- 应聘岗位：${role}\n- 当前状态：虚构预约已核实\n`;

async function prepare(workspace, names) {
  for (const directory of ['02-sourcing', '03-interview', '_shared']) await mkdir(path.join(workspace, directory), { recursive: true });
  await writeFile(path.join(workspace, 'CONTEXT.md'), `## 在招岗位与优先级\n| 岗位 | 优先级 | 状态 |\n|---|---|---|\n| ${role} | P0 | 在招 |\n`);
  await writeFile(path.join(workspace, '02-sourcing/dedup-ledger.csv'), `${LEDGER_COLUMNS.join(',')}\n${names.map((name, i) => `${i + 1},${name},${role},,A,已约谈,虚构来源,${archivePath(name)},`).join('\n')}\n`);
  for (const name of names) await writeFile(path.join(workspace, archivePath(name)), archive(name));
  const id = 'formal-calendar-run';
  let run = await recordProgress({ workspace, id, workflow: 'interview-schedule', action: { type: 'start' } }, () => now);
  for (const [i, name] of names.entries()) {
    run = await recordProgress({ workspace, id, action: { type: 'result', result: { id: `calendar-${i}`, stepId: 'calendar', candidateId: candidateId(name), action: '虚构日程回执', outcome: '仅供本地契约验证', attention: 'none', nextAction: null } } }, () => now);
  }
  for (const step of run.steps.slice().reverse()) run = await recordProgress({ workspace, id, action: { type: 'skip', step: step.id, reason: '虚构流程已核对，无需真实平台操作' } }, () => now);
  return id;
}

async function append(workspace, name, eventKey, runId) {
  const detail = await readCandidateDetail(workspace, candidateId(name));
  const document = detail.documents.find(item => item.category === 'archive' && item.status === 'ok');
  assert.ok(document, 'EVENTS_FIXTURE_ARCHIVE_IS_LINKED');
  const input = { workspace, candidateId: candidateId(name), documentId: document.id, event: { eventKey, occurredAt: '2026-11-04', type: '面试已约', text: '虚构一面已安排', evidence: '虚构日历回执已人工核实', slot: '2026-11-06 10:00–11:00', interviewer: '虚构面试官', ...(runId ? { runId } : {}) } };
  return { input, result: await recordCandidateEvent(input, () => now) };
}

async function assertBlocked(workspace, id, marker) {
  const file = path.join(workspace, 'runtime/recruit-board/runs', `${id}.json`);
  const bytes = await readFile(file);
  for (const action of [{ type: 'complete' }, { type: 'summary', summaryState: 'no_change', closingSummary: '虚构无变化摘要' }]) {
    await assert.rejects(recordProgress({ workspace, id, action }, () => now), /进展事件/, marker);
    assert.deepEqual(await readFile(file), bytes, 'EVENTS_BLOCKED_RUN_BYTES_UNCHANGED');
  }
}

test('calendar 收据对应的每个人都须有来源本轮的有效档案事件，别人的事件与别轮来源不能代替', async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), 'formal-events-contract-'));
  try {
    const names = ['虚构候选甲', '虚构候选乙'];
    const id = await prepare(workspace, names);
    await assertBlocked(workspace, id, 'EVENTS_CALENDAR_GUARD');
    await append(workspace, names[0], 'formal-event-a', id);
    await assertBlocked(workspace, id, 'EVENTS_EVERY_CANDIDATE_GUARD');
    await append(workspace, names[1], 'formal-event-unlinked');
    await assertBlocked(workspace, id, 'EVENTS_UNLINKED_EVENT_GUARD');
    await append(workspace, names[1], 'formal-event-other-run', 'formal-another-run');
    await recordProgress({ workspace, id, action: { type: 'wait', reason: '虚构确认完成前再次核实' } }, () => now);
    await assertBlocked(workspace, id, 'EVENTS_OTHER_RUN_GUARD');
    await append(workspace, names[1], 'formal-event-b', id);
    const finished = await recordProgress({ workspace, id, action: { type: 'complete' } }, () => now);
    assert.equal(finished.status, 'completed');
    assert.equal(finished.summaryState, 'highlights');
    assert.deepEqual(new Set(finished.highlights.map(item => item.eventKey)), new Set(['formal-event-a', 'formal-event-b']), 'EVENTS_ONLY_LINKED_RUN_HIGHLIGHTS');
    for (const name of names) assert.ok(finished.highlights.some(item => item.context.candidateId === candidateId(name)), 'EVENTS_COMPLETED_CANDIDATES_OBSERVED');
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test('已存在有效事件时，关联档案的坏记录或不可读诊断仍阻止收尾；恢复后可以完成', async () => {
  for (const damage of ['invalid', 'unavailable']) {
    const workspace = await mkdtemp(path.join(tmpdir(), 'formal-events-diagnostics-'));
    try {
      const name = '虚构候选甲', id = await prepare(workspace, [name]);
      await append(workspace, name, 'formal-valid-event', id);
      const file = path.join(workspace, archivePath(name)), good = await readFile(file);
      if (damage === 'invalid') await writeFile(file, Buffer.concat([good, Buffer.from('\n| formal-bad-event | invalid-date | 面试已约 | 虚构事实 | 虚构依据 | — | — | — |\n')]));
      else await rm(file);
      const observed = await readArchiveEvents(workspace);
      assert.ok(observed.diagnostics.some(item => item.candidateId === candidateId(name) && ['PROGRESS_EVENT_INVALID', 'PROGRESS_SOURCE_UNAVAILABLE'].includes(item.code)), 'EVENTS_DIAGNOSTIC_OBSERVED');
      await assertBlocked(workspace, id, 'EVENTS_DIAGNOSTIC_GUARD');
      await writeFile(file, good);
      const summary = await recordProgress({ workspace, id, action: { type: 'summary', summaryState: 'highlights', closingSummary: '虚构事件已回读核实' } }, () => now);
      assert.equal(summary.highlights.length, 1);
      assert.equal((await recordProgress({ workspace, id, action: { type: 'complete' } }, () => now)).status, 'completed');
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  }
});

test('稳定事件身份的重放不重复写档案，摘要与 complete 导入同一重点不重复', async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), 'formal-events-replay-'));
  try {
    const name = '虚构候选甲', id = await prepare(workspace, [name]);
    const { input, result } = await append(workspace, name, 'formal-stable-event', id);
    assert.equal(result.changed, true);
    const file = path.join(workspace, archivePath(name)), bytes = await readFile(file);
    assert.equal((await recordCandidateEvent(input, () => now)).changed, false, 'EVENTS_STABLE_ID_REPLAY');
    assert.deepEqual(await readFile(file), bytes, 'EVENTS_REPLAY_ARCHIVE_BYTES_UNCHANGED');
    await assert.rejects(recordCandidateEvent({ ...input, event: { ...input.event, text: '同一身份但不同结论' } }, () => now), error => error.code === 'PROGRESS_EVENT_CONFLICT', 'EVENTS_STABLE_ID_CONFLICT');
    assert.deepEqual(await readFile(file), bytes);
    assert.equal(parseArchiveEvents(bytes.toString('utf8')).events.length, 1);
    const summary = await recordProgress({ workspace, id, action: { type: 'summary', summaryState: 'highlights', closingSummary: '虚构面试事件已同步档案' } }, () => now);
    const finished = await recordProgress({ workspace, id, action: { type: 'complete' } }, () => now);
    assert.equal(finished.highlights.length, 1, 'EVENTS_IMPORT_IS_IDEMPOTENT');
    assert.equal(finished.highlights[0].eventKey, 'formal-stable-event');
    assert.equal(finished.highlightsRevision, summary.highlightsRevision);
    assert.deepEqual(await readFile(file), bytes);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});
