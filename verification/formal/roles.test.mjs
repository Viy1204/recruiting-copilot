import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
const sourceRoot = path.resolve(process.env.FORMAL_SOURCE_ROOT || repoRoot);
const fromSource = relative => import(pathToFileURL(path.join(sourceRoot, relative)).href);
const [{ LEDGER_COLUMNS }, { readSnapshot }, { readRoleInfo, setRoleAlias, setRoleStatus }] = await Promise.all([
  fromSource('skills/recruit-board/model.mjs'),
  fromSource('skills/recruit-board/scripts/reader.mjs'),
  fromSource('skills/recruit-board/scripts/roles.mjs'),
]);
const context = '# 虚构岗位配置\r\n正文保留哨兵\r\n## 在招岗位与优先级\r\n| 岗位 | 优先级 | 状态 |\r\n|---|---|---|\r\n| 虚构甲岗 | P0 | 在招 |\r\n| 虚构乙岗 | P1 | 暂停 |\r\n';
const row = role => ['1', '虚构同名', role, '虚构背景', 'A', '已回复', '虚构来源', '', ''].join(',');
const ledger = `${LEDGER_COLUMNS.join(',')}\n${['虚构历史岗', '虚构甲岗'].map(row).join('\n')}\n`;
const configPath = '_shared/recruit-board.config.json';

async function withWorkspace(operation) {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'recruit-formal-roles-'));
  try {
    for (const folder of ['02-sourcing', '_shared']) await mkdir(path.join(workspace, folder));
    await writeFile(path.join(workspace, 'CONTEXT.md'), context);
    await writeFile(path.join(workspace, '02-sourcing/dedup-ledger.csv'), ledger);
    await writeFile(path.join(workspace, configPath), `${JSON.stringify({ schemaVersion: 1, statusStages: {}, roleAliases: { 虚构历史岗: '虚构甲岗' }, description: '虚构配置说明' }, null, 2)}\n`);
    return await operation(workspace);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}

const identity = snapshot => snapshot.candidates.map(candidate => [candidate.id, candidate.rawRole]);

test('同一配置旧版本的别名保存不能覆盖新映射，原人岗身份和岗位表不变', async () => {
  await withWorkspace(async workspace => {
    const initial = await readRoleInfo(workspace);
    const before = await readSnapshot(workspace);
    const saved = await setRoleAlias({ workspace, role: '虚构历史岗', target: '虚构乙岗', revision: initial.configRevision });
    assert.equal(saved.changed, true);
    const newer = await readFile(path.join(workspace, configPath));
    await assert.rejects(
      setRoleAlias({ workspace, role: '虚构历史岗', target: null, revision: initial.configRevision }),
      error => error.code === 'CONFIG_CONFLICT' && error.status === 409,
      'ROLES_STALE_ALIAS_REJECTED',
    );
    assert.deepEqual(await readFile(path.join(workspace, configPath)), newer, 'ROLES_NEW_ALIAS_PRESERVED');
    const after = await readSnapshot(workspace);
    assert.deepEqual(identity(after), identity(before), 'ROLES_RAW_CANDIDATE_IDENTITIES_PRESERVED');
    assert.equal(after.candidates.length, 2, 'ROLES_RAW_CANDIDATE_IDENTITIES_PRESERVED');
    assert.equal(after.candidates.find(candidate => candidate.rawRole === '虚构历史岗').role, '虚构乙岗');
    assert.equal(await readFile(path.join(workspace, 'CONTEXT.md'), 'utf8'), context, 'ROLES_ALIAS_LEAVES_CONTEXT_UNCHANGED');
    assert.equal(await readFile(path.join(workspace, '02-sourcing/dedup-ledger.csv'), 'utf8'), ledger, 'ROLES_RAW_CANDIDATE_IDENTITIES_PRESERVED');
    const externallyEdited = JSON.parse(newer);
    externallyEdited.description = '虚构的配置说明更新';
    const externalBytes = `${JSON.stringify(externallyEdited, null, 2)}\n`;
    await writeFile(path.join(workspace, configPath), externalBytes);
    await assert.rejects(
      setRoleAlias({ workspace, role: '虚构历史岗', target: '虚构甲岗', revision: saved.configRevision }),
      error => error.code === 'CONFIG_CONFLICT' && error.status === 409,
      'ROLES_METADATA_REVISION_REJECTED',
    );
    assert.equal(await readFile(path.join(workspace, configPath), 'utf8'), externalBytes, 'ROLES_METADATA_REVISION_REJECTED');
  });
});

test('同一配置旧版本的状态保存不能覆盖新状态，提交点前后的其他字节保留', async () => {
  await withWorkspace(async workspace => {
    const initial = await readRoleInfo(workspace);
    const beforeConfig = await readFile(path.join(workspace, configPath));
    const saved = await setRoleStatus({ workspace, role: '虚构甲岗', status: '暂停', revision: initial.contextRevision });
    const newer = await readFile(path.join(workspace, 'CONTEXT.md'));
    assert.equal(newer.toString(), context.replace('| P0 | 在招 |', '| P0 | 暂停 |'), 'ROLES_ONLY_STATUS_CELL_CHANGED');
    assert.equal(await readFile(path.join(workspace, saved.backup), 'utf8'), context, 'ROLES_STATUS_BACKUP_PRESERVED');
    await assert.rejects(
      setRoleStatus({ workspace, role: '虚构甲岗', status: '已关闭', revision: initial.contextRevision }),
      error => error.code === 'CONTEXT_CONFLICT' && error.status === 409,
      'ROLES_STALE_STATUS_REJECTED',
    );
    assert.deepEqual(await readFile(path.join(workspace, 'CONTEXT.md')), newer, 'ROLES_NEW_STATUS_PRESERVED');
    assert.deepEqual(await readFile(path.join(workspace, configPath)), beforeConfig, 'ROLES_STATUS_LEAVES_ALIASES_UNCHANGED');
    assert.equal(await readFile(path.join(workspace, '02-sourcing/dedup-ledger.csv'), 'utf8'), ledger, 'ROLES_RAW_CANDIDATE_IDENTITIES_PRESERVED');
    const unchanged = await setRoleStatus({ workspace, role: '虚构甲岗', status: '暂停', revision: saved.contextRevision });
    assert.equal(unchanged.changed, false);
    assert.equal(unchanged.backup, null);
    assert.deepEqual(saved.allowedStatuses, ['在招', '已下架', '已关闭', '暂停', '待核']);
  });
});

test('同一文件版本的两个岗位请求争用共用锁，最多一个提交', async () => {
  for (const kind of ['alias', 'status']) {
    await withWorkspace(async workspace => {
      const initial = await readRoleInfo(workspace);
      const results = await Promise.allSettled(kind === 'alias' ? [
        setRoleAlias({ workspace, role: '虚构历史岗', target: '虚构乙岗', revision: initial.configRevision }),
        setRoleAlias({ workspace, role: '虚构历史岗', target: null, revision: initial.configRevision }),
      ] : [
        setRoleStatus({ workspace, role: '虚构甲岗', status: '暂停', revision: initial.contextRevision }),
        setRoleStatus({ workspace, role: '虚构甲岗', status: '已关闭', revision: initial.contextRevision }),
      ]);
      assert.equal(results.filter(result => result.status === 'fulfilled').length, 1, `ROLES_ONE_SAME_VERSION_WINNER ${kind}`);
      assert.equal(results.filter(result => result.status === 'rejected' && result.reason.status === 409).length, 1, `ROLES_ONE_SAME_VERSION_WINNER ${kind}`);
      const current = await readRoleInfo(workspace);
      const firstWon = results[0].status === 'fulfilled';
      if (kind === 'alias') assert.deepEqual(current.roleAliases, firstWon ? { 虚构历史岗: '虚构乙岗' } : {}, 'ROLES_WINNER_VALUE_PRESERVED');
      else assert.equal(current.roles.find(role => role.name === '虚构甲岗').status, firstWon ? '暂停' : '已关闭', 'ROLES_WINNER_VALUE_PRESERVED');
    });
  }
});
