import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const sourceRoot = path.resolve(process.env.FORMAL_SOURCE_ROOT || repoRoot);
const { applyDecision } = await import(pathToFileURL(path.join(sourceRoot, 'skills/recruit-board/decisions-domain.mjs')).href);
const { applyDecisionCommand, readDecision } = await import(pathToFileURL(path.join(sourceRoot, 'skills/recruit-board/scripts/decisions.mjs')).href);
const { recordProgress } = await import(pathToFileURL(path.join(sourceRoot, 'skills/recruit-board/scripts/progress.mjs')).href);
const now = '2026-11-04T10:00:00.000Z';
const later = '2026-11-04T11:00:00.000Z';
const source = { runId: 'formal-decision-source' };
const registration = { identity: { subjectKey: '虚构候选甲', questionKey: '虚构地点要求', scope: '仅本次虚构核验' }, title: '虚构事项：核实工作地点', source, expectedRevision: 0, requestId: 'formal-register' };
const evidence = (id, client, expectedRevision) => ({ id, expectedRevision, requestId: `formal-evidence-${client}`, source, evidence: `虚构客户端 ${client} 的核实依据` });

// 两种提交顺序均真实执行；旧读者拒绝后须重读，旧回执不能回滚更新。
test('纯域转换：expectedRevision 阻止旧写，requestId 重放不增加修订或回滚依据', () => {
  for (const [first, second] of [['A', 'B'], ['B', 'A']]) {
    let { item } = applyDecision(null, 'register', registration, now);
    const firstInput = evidence(item.id, first, 1);
    ({ item } = applyDecision(item, 'evidence', firstInput, now));
    const saved = structuredClone(item);
    assert.throws(() => applyDecision(item, 'evidence', evidence(item.id, second, 1), later), error => error.code === 'DECISION_REVISION_CONFLICT', 'DECISIONS_STALE_GUARD');
    assert.deepEqual(item, saved, 'DECISIONS_STALE_INPUT_UNCHANGED');
    ({ item } = applyDecision(item, 'evidence', evidence(item.id, second, item.revision), later));
    assert.equal(item.revision, 3);
    const latest = structuredClone(item);
    let replay;
    assert.doesNotThrow(() => { replay = applyDecision(item, 'evidence', firstInput, later); }, 'DECISIONS_REPLAY_GUARD');
    assert.equal(replay.replayed, true, 'DECISIONS_REPLAY_RECEIPT');
    assert.equal(replay.appliedRevision, 2, 'DECISIONS_REPLAY_ORIGINAL_REVISION');
    assert.deepEqual(replay.item, latest, 'DECISIONS_REPLAY_PRESERVES_CURRENT');
    assert.equal(replay.item.history.at(-1).evidence, `虚构客户端 ${second} 的核实依据`);
    assert.equal(new Set(replay.item.history.map(entry => entry.requestId)).size, replay.item.history.length, 'DECISIONS_NO_DUPLICATE_HISTORY');
    assert.throws(() => applyDecision(item, 'evidence', { ...firstInput, evidence: '复用请求身份却更换内容' }, later), error => error.code === 'DECISION_REQUEST_CONFLICT', 'DECISIONS_REQUEST_CONTENT_GUARD');
    assert.deepEqual(item, latest);
  }
});

test('公开存储入口：拒绝旧版本后文件不变，重放旧请求仍返回最新事项且逐字不重写', async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), 'formal-decisions-contract-'));
  try {
    await recordProgress({ workspace, id: source.runId, workflow: 'daily', action: { type: 'start' } }, () => now);
    let { item } = await applyDecisionCommand(workspace, 'register', registration, () => now);
    const inputA = evidence(item.id, 'A', item.revision);
    ({ item } = await applyDecisionCommand(workspace, 'evidence', inputA, () => now));
    const file = path.join(workspace, 'runtime/recruit-board/decisions', `${item.id}.json`);
    const firstBytes = await readFile(file);
    await assert.rejects(applyDecisionCommand(workspace, 'evidence', evidence(item.id, 'B', 1), () => later), error => error.code === 'DECISION_REVISION_CONFLICT', 'DECISIONS_STALE_STORE_GUARD');
    assert.deepEqual(await readFile(file), firstBytes, 'DECISIONS_STALE_BYTES_UNCHANGED');
    const fresh = await readDecision(workspace, item.id);
    ({ item } = await applyDecisionCommand(workspace, 'evidence', evidence(item.id, 'B', fresh.revision), () => later));
    const latest = await readDecision(workspace, item.id), bytes = await readFile(file);
    let replay;
    await assert.doesNotReject(async () => { replay = await applyDecisionCommand(workspace, 'evidence', inputA, () => later); }, 'DECISIONS_REPLAY_STORE_GUARD');
    assert.equal(replay.replayed, true, 'DECISIONS_REPLAY_STORE_RECEIPT');
    assert.equal(replay.appliedRevision, 2);
    assert.equal(replay.item.revision, 3);
    assert.deepEqual(await readDecision(workspace, item.id), latest, 'DECISIONS_REPLAY_STORE_CURRENT');
    assert.deepEqual(await readFile(file), bytes, 'DECISIONS_REPLAY_BYTES_UNCHANGED');
    await assert.rejects(applyDecisionCommand(workspace, 'evidence', { ...inputA, evidence: '请求内容被替换' }, () => later), error => error.code === 'DECISION_REQUEST_CONFLICT', 'DECISIONS_REQUEST_STORE_CONTENT_GUARD');
    assert.deepEqual(await readFile(file), bytes);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});
