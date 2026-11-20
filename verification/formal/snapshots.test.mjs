import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
const sourceRoot = path.resolve(process.env.FORMAL_SOURCE_ROOT || repoRoot);
const fromSource = relative => import(pathToFileURL(path.join(sourceRoot, relative)).href);
const [{ LEDGER_COLUMNS, readCandidates }, { readSnapshot }] = await Promise.all([
  fromSource('skills/recruit-board/model.mjs'),
  fromSource('skills/recruit-board/scripts/reader.mjs'),
]);
const oldTime = '2026-11-01T00:00:00.000Z';
const newTime = '2026-11-02T00:00:00.000Z';
const context = '# 虚构验证工作区\n## 在招岗位与优先级\n| 岗位 | 优先级 | 状态 |\n|---|---|---|\n| 虚构甲岗 | P0 | 在招 |\n| 虚构乙岗 | P1 | 暂停 |\n';
const row = (name, role, status) => ['1', name, role, '虚构背景', 'A', status, '虚构来源', '', ''].join(',');
const csv = rows => `${LEDGER_COLUMNS.join(',')}\n${rows.join('\n')}\n`;
const oldLedger = csv([row('虚构同名', '虚构历史岗', '已回复'), row('虚构同名', '虚构甲岗', '虚构待核状态')]);
const newLedger = csv([row('虚构新乙', '虚构历史岗', '已排除')]);
const oldConfig = { schemaVersion: 1, statusStages: { 已回复: 'decision' }, roleAliases: { 虚构历史岗: '虚构甲岗' } };
const newConfig = { schemaVersion: 1, statusStages: { 已排除: 'interview' }, roleAliases: { 虚构历史岗: '虚构乙岗' } };

async function withWorkspace(operation) {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'recruit-formal-snapshots-'));
  try {
    for (const folder of ['02-sourcing', '_shared']) await mkdir(path.join(workspace, folder));
    await writeFile(path.join(workspace, 'CONTEXT.md'), context);
    return await operation(workspace);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}

async function installSources(workspace, ledger, config, time) {
  const sources = [
    ['CONTEXT.md', time === oldTime ? context : context.replace('| P0 | 在招 |', '| P2 | 已关闭 |')],
    ['02-sourcing/dedup-ledger.csv', ledger],
    ['_shared/recruit-board.config.json', JSON.stringify(config)],
  ];
  for (const [file, text] of sources) {
    await writeFile(path.join(workspace, file), text);
    await utimes(path.join(workspace, file), new Date(time), new Date(time));
  }
}

const payload = snapshot => ({
  candidates: snapshot.candidates,
  roles: snapshot.roles,
  stages: snapshot.stages,
  unknownStatuses: snapshot.unknownStatuses,
  ledgerUpdatedAt: snapshot.ledgerUpdatedAt,
  contextRevision: snapshot.contextRevision,
  ledgerStamp: snapshot.sources.ledger.updatedAt,
  contextStamp: snapshot.sources.context.updatedAt,
  configStamp: snapshot.sources.config.updatedAt,
});

test('首次坏或缺台账显示人数未知，有效空台账才是零人', async () => {
  await withWorkspace(async workspace => {
    for (const kind of ['missing', 'invalid']) {
      const file = path.join(workspace, '02-sourcing/dedup-ledger.csv');
      if (kind === 'missing') await rm(file, { force: true });
      else await writeFile(file, '损坏的虚构台账');
      const snapshot = await readSnapshot(workspace, null, () => oldTime);
      assert.equal(snapshot.candidates, null, 'SNAPSHOTS_UNREADABLE_LEDGER_IS_UNKNOWN');
      assert.ok(snapshot.stages.every(stage => stage.count === null), 'SNAPSHOTS_UNREADABLE_LEDGER_IS_UNKNOWN');
      assert.equal(snapshot.status, 'error', 'SNAPSHOTS_UNREADABLE_LEDGER_IS_UNKNOWN');
    }
    await writeFile(path.join(workspace, '02-sourcing/dedup-ledger.csv'), csv([]));
    const empty = await readSnapshot(workspace, null, () => newTime);
    assert.deepEqual(empty.candidates, [], 'SNAPSHOTS_VALID_EMPTY_IS_ZERO');
    assert.ok(empty.stages.every(stage => stage.count === 0), 'SNAPSHOTS_VALID_EMPTY_IS_ZERO');
  });
});

test('配置或其依据失效时整套保留最后可信视图，重复读取不混算，恢复后使用新源', async () => {
  await withWorkspace(async workspace => {
    await installSources(workspace, oldLedger, oldConfig, oldTime);
    const trusted = await readSnapshot(workspace, null, () => oldTime);
    assert.equal(trusted.sources.config.status, 'ok');
    assert.equal(trusted.candidates.length, 2);
    assert.equal(trusted.unknownStatuses.length, 1);
    const original = payload(trusted);
    for (const fault of ['config-invalid', 'config-missing', 'config-unreadable', 'target-invalid', 'context-invalid', 'context-missing', 'ledger-invalid', 'ledger-missing']) {
      await installSources(workspace, newLedger, newConfig, newTime);
      const configFile = path.join(workspace, '_shared/recruit-board.config.json');
      if (fault === 'config-invalid') await writeFile(configFile, '{');
      if (fault === 'config-missing') await rm(configFile);
      if (fault === 'config-unreadable') {
        await rm(configFile);
        await mkdir(configFile);
      }
      if (fault === 'target-invalid') await writeFile(configFile, JSON.stringify({ ...newConfig, roleAliases: { 虚构历史岗: '虚构不存在岗' } }));
      if (fault === 'context-invalid') await writeFile(path.join(workspace, 'CONTEXT.md'), '# 没有岗位表的虚构文档\n');
      if (fault === 'context-missing') await rm(path.join(workspace, 'CONTEXT.md'));
      if (fault === 'ledger-invalid') await writeFile(path.join(workspace, '02-sourcing/dedup-ledger.csv'), '坏表头');
      if (fault === 'ledger-missing') await rm(path.join(workspace, '02-sourcing/dedup-ledger.csv'));
      const stale = await readSnapshot(workspace, trusted, () => newTime);
      assert.deepEqual(payload(stale), original, `SNAPSHOTS_TRUSTED_VIEW_PRESERVED ${fault}`);
      assert.equal(stale.status, 'stale', `SNAPSHOTS_TRUSTED_VIEW_PRESERVED ${fault}`);
      for (const source of ['ledger', 'context', 'config']) assert.equal(stale.sources[source].status, 'stale', `SNAPSHOTS_TRUSTED_VIEW_PRESERVED ${fault} ${source}`);
      const repeated = await readSnapshot(workspace, stale, () => newTime);
      assert.deepEqual(payload(repeated), original, `SNAPSHOTS_TRUSTED_VIEW_PRESERVED repeated ${fault}`);
      if (fault === 'config-unreadable') await rm(configFile, { recursive: true });
      await installSources(workspace, newLedger, newConfig, newTime);
      const recovered = await readSnapshot(workspace, repeated, () => newTime);
      assert.equal(recovered.sources.config.status, 'ok', 'SNAPSHOTS_RECOVERY_USES_NEW_SOURCES');
      assert.equal(recovered.sources.ledger.status, 'ok', 'SNAPSHOTS_RECOVERY_USES_NEW_SOURCES');
      assert.deepEqual(recovered.candidates.map(candidate => [candidate.name, candidate.role, candidate.stage]), [['虚构新乙', '虚构乙岗', 'interview']], 'SNAPSHOTS_RECOVERY_USES_NEW_SOURCES');
      assert.notEqual(recovered.contextRevision, trusted.contextRevision, 'SNAPSHOTS_RECOVERY_USES_NEW_SOURCES');
    }
  });
});

test('阶段是台账读取投影，岗位别名不改变原人岗身份或合并同名人选', () => {
  const parsed = readCandidates(oldLedger, oldConfig);
  assert.deepEqual(parsed.candidates.map(candidate => [candidate.id, candidate.rawRole, candidate.role]), [
    [JSON.stringify(['虚构同名', '虚构历史岗']), '虚构历史岗', '虚构甲岗'],
    [JSON.stringify(['虚构同名', '虚构甲岗']), '虚构甲岗', '虚构甲岗'],
  ], 'SNAPSHOTS_RAW_IDENTITIES_PRESERVED');
  assert.deepEqual(parsed.candidates.map(candidate => candidate.stage), ['decision', 'unclassified'], 'SNAPSHOTS_STAGES_ARE_PROJECTION');
});
