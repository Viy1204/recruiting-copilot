import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const sourceRoot = path.resolve(process.env.FORMAL_SOURCE_ROOT || repoRoot);
const { createRun, transitionRun, validateRun, WORKFLOWS } = await import(pathToFileURL(path.join(sourceRoot, 'skills/recruit-board/model.mjs')).href);
const { recordProgress } = await import(pathToFileURL(path.join(sourceRoot, 'skills/recruit-board/scripts/progress.mjs')).href);
const now = '2026-11-04T10:00:00.000Z';
const later = '2026-11-04T11:00:00.000Z';
const settled = run => run.steps.every(step => ['completed', 'skipped'].includes(step.status));
const receipt = stepId => ({ id: 'formal-receipt', stepId, candidateId: JSON.stringify(['虚构候选甲', '虚构岗位']), action: '记录虚构核验', outcome: '仅供契约验证', attention: 'none', nextAction: null });

// 与 Runs.tla 的两项步骤投影相同，但状态转换实际调用产品公开入口。
test('两项代表步骤的所有可达顺序：禁止假完成，结束后禁止新进度写入', () => {
  let initial = createRun({ id: 'formal-runs-domain', workflow: 'init', now });
  const ids = [initial.steps[0].id, initial.steps.at(-1).id];
  for (const step of initial.steps.filter(step => !ids.includes(step.id))) initial = transitionRun(initial, { type: 'skip', step: step.id, reason: '虚构流程中不执行此项' }, now);
  const queue = [initial], seen = new Set();
  for (let index = 0; index < queue.length; index++) {
    const run = queue[index];
    const key = JSON.stringify([run.status, ...ids.map(id => run.steps.find(step => step.id === id).status)]);
    if (seen.has(key)) continue;
    seen.add(key);
    const actions = [
      ...ids.flatMap(step => [
        { type: 'step', step }, { type: 'complete', step },
        { type: 'skip', step, reason: '虚构跳过依据' }, { type: 'fail', step, reason: '虚构读取失败' },
      ]),
      { type: 'complete' }, { type: 'wait', reason: '等待虚构确认' },
      { type: 'fail', reason: '虚构任务失败' }, { type: 'cancel', reason: '取消虚构任务' },
    ];
    const before = structuredClone(run);
    if (['completed', 'failed', 'cancelled'].includes(run.status)) {
      actions.push(
        { type: 'result', result: receipt(ids[0]) },
        { type: 'highlight', highlight: { eventKey: 'formal-new-event', text: '新的虚构进展' } },
        { type: 'summary', summaryState: 'no_change', closingSummary: '虚构摘要' },
      );
      for (const action of actions) assert.throws(() => transitionRun(run, action, later), Error, `RUNS_TERMINAL_GUARD ${run.status}/${action.type}`);
    } else {
      for (const action of actions) {
        const target = run.steps.find(step => step.id === action.step);
        const unfinished = target && ['pending', 'running'].includes(target.status);
        let allowed = true;
        if (action.type === 'step') allowed = unfinished && !run.steps.some(step => step.id !== target.id && step.status === 'running');
        else if (action.type === 'complete') allowed = action.step ? target.status === 'running' : settled(run);
        else if (action.step) allowed = unfinished;
        if (!allowed) {
          assert.throws(() => transitionRun(run, action, later), Error, `RUNS_UNSETTLED_GUARD ${action.type}/${action.step ?? 'run'}`);
          continue;
        }
        const next = transitionRun(run, action, later);
        assert.ok(next.status !== 'completed' || settled(next), 'RUNS_NO_FALSE_COMPLETION');
        queue.push(next);
      }
    }
    assert.deepEqual(run, before, 'RUNS_INPUT_NOT_MUTATED');
  }
  assert.ok(seen.size > 20, 'RUNS_REACHABLE_ORDERS_EXERCISED');
});

test('所有真实工作流均允许任意步骤顺序、等待续办及不先写 summary 的正常完成', () => {
  for (const workflow of Object.keys(WORKFLOWS)) {
    let run = createRun({ id: `formal-${workflow}`, workflow, now });
    assert.equal(run.status, 'running');
    assert.ok(run.steps.every(step => step.status === 'pending'));
    assert.throws(() => validateRun({ ...run, status: 'completed' }), Error, 'RUNS_VALIDATE_COMPLETION_GUARD');
    assert.throws(() => transitionRun(run, { type: 'complete' }, later), Error, 'RUNS_UNFINISHED_COMPLETION_GUARD');
    for (const step of run.steps.slice(1).reverse()) run = transitionRun(run, { type: 'skip', step: step.id, reason: '虚构流程已核对无需执行' }, later);
    run = transitionRun(run, { type: 'step', step: run.steps[0].id }, later);
    run = transitionRun(run, { type: 'wait', reason: '等待虚构确认' }, later);
    assert.equal(run.status, 'waiting');
    assert.throws(() => transitionRun(run, { type: 'complete' }, later), Error, 'RUNS_RUNNING_STEP_COMPLETION_GUARD');
    run = transitionRun(run, { type: 'complete', step: run.steps[0].id }, later);
    run = transitionRun(run, { type: 'complete' }, later);
    assert.equal(run.status, 'completed');
    assert.equal(run.summaryState, 'unrecorded');
    assert.ok(settled(run));
  }
});

test('recordProgress 拒绝未收尾任务与三类终态的新收据，失败写入不改变文件', async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), 'formal-runs-contract-'));
  try {
    for (const terminal of ['completed', 'failed', 'cancelled']) {
      const id = `formal-${terminal}`;
      let run = await recordProgress({ workspace, id, workflow: 'init', action: { type: 'start' } }, () => now);
      const file = path.join(workspace, 'runtime/recruit-board/runs', `${id}.json`);
      const pending = await readFile(file);
      await assert.rejects(recordProgress({ workspace, id, action: { type: 'complete' } }, () => later), Error, 'RUNS_INCOMPLETE_STORE_GUARD');
      assert.deepEqual(await readFile(file), pending);
      if (terminal === 'completed') {
        for (const step of run.steps.slice().reverse()) run = await recordProgress({ workspace, id, action: { type: 'skip', step: step.id, reason: '虚构步骤已核对无需执行' } }, () => later);
      }
      const action = terminal === 'completed' ? { type: 'complete' } : { type: terminal === 'failed' ? 'fail' : 'cancel', reason: '虚构终态依据' };
      run = await recordProgress({ workspace, id, action }, () => later);
      assert.equal(run.status, terminal);
      const frozen = await readFile(file);
      await assert.rejects(recordProgress({ workspace, id, action: { type: 'result', result: receipt(run.steps[0].id) } }, () => later), Error, 'RUNS_TERMINAL_STORE_GUARD');
      assert.deepEqual(await readFile(file), frozen, 'RUNS_TERMINAL_BYTES_UNCHANGED');
    }
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test('终态可返回历史重点请求的回执，回放不改变任何持久化内容', async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), 'formal-runs-replay-'));
  try {
    const id = 'formal-terminal-replay';
    let run = await recordProgress({ workspace, id, workflow: 'init', action: { type: 'start' } }, () => now);
    const highlight = { type: 'highlight', requestId: 'formal-fixed-request', expectedRevision: 0, highlight: { eventKey: 'formal-fixed-event', text: '已核实的虚构进展' } };
    await recordProgress({ workspace, id, action: highlight }, () => now);
    for (const step of run.steps) await recordProgress({ workspace, id, action: { type: 'skip', step: step.id, reason: '虚构流程跳过依据' } }, () => now);
    run = await recordProgress({ workspace, id, action: { type: 'complete' } }, () => now);
    const file = path.join(workspace, 'runtime/recruit-board/runs', `${id}.json`);
    const bytes = await readFile(file);
    const replay = await recordProgress({ workspace, id, action: highlight }, () => later);
    assert.deepEqual(replay, run, 'RUNS_TERMINAL_REPLAY_IS_READ_ONLY');
    assert.deepEqual(await readFile(file), bytes, 'RUNS_TERMINAL_REPLAY_BYTES_UNCHANGED');
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});
