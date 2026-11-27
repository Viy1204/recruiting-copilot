import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { LEDGER_COLUMNS } from '../skills/recruit-board/model.mjs';
import { readSnapshot } from '../skills/recruit-board/scripts/reader.mjs';
import {
  applyListingUpsert,
  applyRoleRemove,
  applyRoleUpsert,
  diffWithContextRoles,
  emptyRoleRegistry,
  resolveRoleTarget,
  validateRoleRegistry
} from '../skills/recruit-board/role-registry-domain.mjs';
import {
  initRoleRegistry,
  readRoleRegistry,
  removeListing,
  removeRole,
  resolveRoleRegistry,
  roleRegistryCLI,
  roleRegistryError,
  syncRegistryAliases,
  upsertListing,
  upsertRole,
  validateRoleRegistryWorkspace
} from '../skills/recruit-board/scripts/role-registry.mjs';

const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const contextDoc = [
  '# 虚构招聘工作区',
  '',
  '## 四、在招岗位与优先级',
  '| 岗位 | 优先级 | 状态 | 对外 JD | 对内笔记 |',
  '|---|---|---|---|---|',
  '| 星图程序岗 | P0 | 在招 | `01-jd/星图程序岗.md` | `01-jd/_internal/星图程序岗.md` |',
  '| 云帆测试岗 | P1 | 暂停 | `01-jd/云帆测试岗.md` | `01-jd/_internal/云帆测试岗.md` |',
  ''
].join('\n');

const ledgerHeader = `${LEDGER_COLUMNS.join(',')}\n`;
const ledgerRow = (index, name, role, status = '已回复') => [String(index), name, role, '虚构背景', 'A', status, '虚构轮次', '', ''].join(',');

async function createWorkspace(t, { context = contextDoc, config = null, ledger = null } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'recruit-role-registry-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  if (context !== null) await writeFile(path.join(root, 'CONTEXT.md'), context);
  if (config !== null) {
    await mkdir(path.join(root, '_shared'), { recursive: true });
    await writeFile(path.join(root, '_shared/recruit-board.config.json'), `${JSON.stringify(config, null, 2)}\n`);
  }
  if (ledger !== null) {
    await mkdir(path.join(root, '02-sourcing'), { recursive: true });
    await writeFile(path.join(root, '02-sourcing/dedup-ledger.csv'), ledger);
  }
  return root;
}

test('domain 校验拒绝重复 ID/名称、别名冲突、悬空 roleIds、非法策略与路径穿越', () => {
  const valid = validateRoleRegistry({
    schemaVersion: 1,
    roles: [
      { id: 'role-star-eng', name: '星图程序岗', priority: 'P0', status: '在招', owner: 'lin', atsRequisitionId: 'J10001', aliases: ['星图旧岗'], jdPath: '01-jd/星图程序岗.md' },
      { id: 'role-star-qa', name: '云帆测试岗', priority: 'P1', status: '在招', owner: 'chen', atsRequisitionId: 'J10001' }
    ],
    listings: [
      { platform: 'boss', externalJobId: 'boss-1001', title: '研发合并帖', roleIds: ['role-star-eng', 'role-star-qa'], policy: 'active' },
      { platform: 'liepin', externalJobId: 'lp-ignore-1', title: '校招旧帖', roleIds: [], policy: 'ignore', note: '跳过' }
    ]
  });
  assert.equal(valid.roles.length, 2);
  assert.equal(valid.listings.length, 2);

  const invalidCases = [
    { schemaVersion: 2, roles: [], listings: [] },
    { schemaVersion: 1, roles: [], listings: [], extraField: true },
    { schemaVersion: 1, roles: [{ id: 'bad id!', name: '星图程序岗' }], listings: [] },
    { schemaVersion: 1, roles: [{ id: 'role-a', name: '甲岗' }, { id: 'role-a', name: '乙岗' }], listings: [] },
    { schemaVersion: 1, roles: [{ id: 'role-a', name: '甲岗' }, { id: 'role-b', name: '甲岗' }], listings: [] },
    { schemaVersion: 1, roles: [{ id: 'role-a', name: '甲岗', aliases: ['乙岗'] }, { id: 'role-b', name: '乙岗' }], listings: [] },
    { schemaVersion: 1, roles: [{ id: 'role-a', name: '甲岗', aliases: ['role-b'] }, { id: 'role-b', name: '乙岗' }], listings: [] },
    { schemaVersion: 1, roles: [{ id: 'role-a', name: '甲岗', aliases: ['同别名'] }, { id: 'role-b', name: '乙岗', aliases: ['同别名'] }], listings: [] },
    { schemaVersion: 1, roles: [{ id: 'role-a', name: '甲岗', jdPath: '../secret.md' }], listings: [] },
    { schemaVersion: 1, roles: [{ id: 'role-a', name: '甲岗' }], listings: [{ platform: 'BOSS', externalJobId: '1', roleIds: ['role-a'], policy: 'active' }] },
    { schemaVersion: 1, roles: [{ id: 'role-a', name: '甲岗' }], listings: [{ platform: 'boss', externalJobId: '1', roleIds: ['role-missing'], policy: 'active' }] },
    { schemaVersion: 1, roles: [{ id: 'role-a', name: '甲岗' }], listings: [{ platform: 'boss', externalJobId: '1', roleIds: [], policy: 'active' }] },
    { schemaVersion: 1, roles: [{ id: 'role-a', name: '甲岗' }], listings: [{ platform: 'boss', externalJobId: '1', roleIds: ['role-a'], policy: 'ignore' }] },
    {
      schemaVersion: 1,
      roles: [{ id: 'role-a', name: '甲岗' }],
      listings: [
        { platform: 'boss', externalJobId: 'dup-1', roleIds: ['role-a'], policy: 'active' },
        { platform: 'boss', externalJobId: 'dup-1', roleIds: ['role-a'], policy: 'paused' }
      ]
    }
  ];
  for (const payload of invalidCases) {
    assert.throws(() => validateRoleRegistry(payload), error => error.code === 'ROLE_REGISTRY_INVALID');
  }
});

test('支持 M:N 平台职位映射、ATS 1 对多画像反查、改名不丢绑定与引用完整性保护', () => {
  let reg = emptyRoleRegistry();
  reg = applyRoleUpsert(reg, { id: 'role-hw-a', name: '硬件方向甲', priority: 'P0', status: '在招', owner: 'lin', atsRequisitionId: 'J10373', aliases: ['旧硬件甲'] }).registry;
  reg = applyRoleUpsert(reg, { id: 'role-hw-b', name: '硬件方向乙', priority: 'P0', status: '在招', owner: 'lin', atsRequisitionId: 'J10373' }).registry;
  // 1 帖 -> N 岗（合并帖）
  reg = applyListingUpsert(reg, { platform: 'boss', externalJobId: 'boss-merge-1', title: '硬件开发合并帖', roleIds: ['role-hw-a', 'role-hw-b'], policy: 'active' }).registry;
  // N 帖 -> 1 岗（跨平台）
  reg = applyListingUpsert(reg, { platform: 'liepin', externalJobId: 'lp-hw-a', title: '硬件甲专帖', roleIds: ['role-hw-a'], policy: 'inbound_only' }).registry;
  // 1 帖 -> 0 岗（显式忽略）
  reg = applyListingUpsert(reg, { platform: 'zhaopin', externalJobId: 'zp-campus', title: '在校应届帖', roleIds: [], policy: 'ignore', note: '跳过' }).registry;

  const merged = resolveRoleTarget(reg, { platform: 'boss', externalJobId: 'boss-merge-1' });
  assert.equal(merged.matched, true);
  assert.equal(merged.matchKind, 'listing');
  assert.equal(merged.policy, 'active');
  assert.deepEqual(merged.roleIds, ['role-hw-a', 'role-hw-b']);

  const ignored = resolveRoleTarget(reg, { platform: 'zhaopin', externalJobId: 'zp-campus' });
  assert.equal(ignored.matched, true);
  assert.equal(ignored.policy, 'ignore');
  assert.deepEqual(ignored.roleIds, []);

  const byReq = resolveRoleTarget(reg, { atsRequisitionId: 'J10373' });
  assert.equal(byReq.matched, true);
  assert.equal(byReq.matchKind, 'atsRequisitionId');
  assert.deepEqual(byReq.roleIds, ['role-hw-a', 'role-hw-b']);
  assert.equal(byReq.listings.length, 2);

  const byAlias = resolveRoleTarget(reg, { name: '旧硬件甲' });
  assert.equal(byAlias.matched, true);
  assert.equal(byAlias.matchKind, 'alias');
  assert.deepEqual(byAlias.roleIds, ['role-hw-a']);
  assert.equal(byAlias.listings.length, 2);

  // 改名后固定 ID 与平台绑定完全不变
  const renamed = applyRoleUpsert(reg, { id: 'role-hw-a', name: '硬件方向甲（升级名）', priority: 'P0', status: '在招', owner: 'lin', atsRequisitionId: 'J10373', aliases: ['旧硬件甲', '硬件方向甲'] }).registry;
  const afterRename = resolveRoleTarget(renamed, { platform: 'liepin', externalJobId: 'lp-hw-a' });
  assert.equal(afterRename.roles[0].id, 'role-hw-a');
  assert.equal(afterRename.roles[0].name, '硬件方向甲（升级名）');

  // 被平台职位引用的岗位不可直接删除
  assert.throws(() => applyRoleRemove(renamed, 'role-hw-a'), error => error.code === 'ROLE_IN_USE' && error.status === 409);

  // diff 检查
  const diff = diffWithContextRoles(renamed, [{ name: '硬件方向甲（升级名）', priority: 'P0', status: '暂停' }, { name: '未注册新岗', priority: 'P2', status: '在招' }]);
  assert.equal(diff.inSync, false);
  assert.deepEqual(diff.onlyInContext, ['未注册新岗']);
  assert.deepEqual(diff.onlyInRegistry, [{ id: 'role-hw-b', name: '硬件方向乙' }]);
  assert.equal(diff.statusMismatch.length, 1);
  assert.equal(diff.statusMismatch[0].context, '暂停');
  assert.equal(diff.statusMismatch[0].registry, '在招');
});

test('init 从 CONTEXT.md 与旧别名初始化注册表，merge 保留既有 ID 与映射且不改动 CONTEXT.md', async t => {
  const root = await createWorkspace(t, {
    config: { schemaVersion: 1, statusStages: {}, roleAliases: { 星图旧称: '星图程序岗' } }
  });
  const initialized = await initRoleRegistry({ workspace: root });
  assert.equal(initialized.changed, true);
  assert.equal(initialized.added.length, 2);
  assert.equal(await readFile(path.join(root, 'CONTEXT.md'), 'utf8'), contextDoc);

  const star = initialized.registry.roles.find(role => role.name === '星图程序岗');
  assert.ok(star.id.startsWith('role-'));
  assert.deepEqual(star.aliases, ['星图旧称']);

  // 重复不带 merge 的 init 拒绝覆盖
  await assert.rejects(initRoleRegistry({ workspace: root }), error => error.code === 'REGISTRY_EXISTS' && error.status === 409);

  // 给既有岗位绑定平台职位，再在 CONTEXT.md 新增一岗后 --merge
  const bound = await upsertListing({
    workspace: root,
    expectedRevision: initialized.revision,
    listing: { platform: 'boss', externalJobId: 'boss-star-1', roleIds: [star.id], policy: 'active' }
  });
  await writeFile(path.join(root, 'CONTEXT.md'), `${contextDoc}| 凌云算法岗 | P0 | 在招 | \`01-jd/凌云算法岗.md\` | \`01-jd/_internal/凌云算法岗.md\` |\n`);
  const merged = await initRoleRegistry({ workspace: root, merge: true });
  assert.equal(merged.changed, true);
  assert.equal(merged.added.length, 1);
  assert.equal(merged.added[0].name, '凌云算法岗');
  assert.equal(merged.registry.roles.find(role => role.name === '星图程序岗').id, star.id);
  assert.equal(merged.registry.listings.length, 1);
  assert.ok(merged.backup);
  assert.notEqual(merged.revision, bound.revision);

  // 无新增岗位时 merge 为幂等空操作
  const noop = await initRoleRegistry({ workspace: root, merge: true });
  assert.equal(noop.changed, false);
  assert.equal(noop.backup, null);
});

test('乐观并发冲突、自动备份、删除解绑顺序及符号链接越权保护', async t => {
  const root = await createWorkspace(t);
  const first = await upsertRole({
    workspace: root,
    expectedRevision: null,
    role: { id: 'role-alpha', name: '星图程序岗', priority: 'P0', status: '在招', owner: 'lin' }
  });
  assert.equal(first.changed, true);
  assert.equal(first.backup, null);
  const bytes1 = await readFile(path.join(root, '_shared/roles.json'));
  assert.equal(first.revision, digest(bytes1));

  // 重复保存相同内容不写备份
  const unchanged = await upsertRole({
    workspace: root,
    expectedRevision: first.revision,
    role: { id: 'role-alpha', name: '星图程序岗', priority: 'P0', status: '在招', owner: 'lin' }
  });
  assert.equal(unchanged.changed, false);
  assert.equal(unchanged.backup, null);

  // 绑定平台职位
  const second = await upsertListing({
    workspace: root,
    expectedRevision: first.revision,
    listing: { platform: 'liepin', externalJobId: 'lp-100', roleIds: ['role-alpha'], policy: 'active' }
  });
  assert.equal(second.changed, true);
  assert.deepEqual(await readFile(path.join(root, second.backup)), bytes1);

  // 使用过期 revision 写入必须返回 409 REGISTRY_CONFLICT
  await assert.rejects(
    upsertRole({ workspace: root, expectedRevision: first.revision, role: { id: 'role-beta', name: '云帆测试岗' } }),
    error => error.code === 'REGISTRY_CONFLICT' && error.status === 409
  );

  // 解绑后可删除岗位
  await assert.rejects(
    removeRole({ workspace: root, roleId: 'role-alpha', expectedRevision: second.revision }),
    error => error.code === 'ROLE_IN_USE' && error.status === 409
  );
  const unbound = await removeListing({ workspace: root, platform: 'liepin', externalJobId: 'lp-100', expectedRevision: second.revision });
  const removed = await removeRole({ workspace: root, roleId: 'role-alpha', expectedRevision: unbound.revision });
  assert.equal(removed.removed.id, 'role-alpha');
  assert.equal(removed.registry.roles.length, 0);

  // 符号链接指向工作区外文件必须拦截
  const outside = await mkdtemp(path.join(tmpdir(), 'recruit-outside-'));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await writeFile(path.join(outside, 'escape.json'), '{"schemaVersion":1,"roles":[],"listings":[]}\n');
  await rm(path.join(root, '_shared/roles.json'));
  await symlink(path.join(outside, 'escape.json'), path.join(root, '_shared/roles.json'));
  await assert.rejects(readRoleRegistry(root), error => error.code === 'ROLE_REGISTRY_UNSAFE' && error.status === 403);
});

test('sync-aliases 将固定 ID 与别名桥接到 recruit-board.config.json，既有看板直接归组且保留原人岗键', async t => {
  const ledger = ledgerHeader + [
    ledgerRow(1, '样例甲', 'role-star-eng'),
    ledgerRow(2, '样例乙', '星图历史名'),
    ledgerRow(3, '样例丙', '星图程序岗')
  ].join('\n') + '\n';
  const root = await createWorkspace(t, {
    ledger,
    config: {
      schemaVersion: 1,
      statusStages: { '已沟通-待回复': 'talking' },
      roleAliases: {},
      description: '保留原配置说明'
    }
  });
  await upsertRole({
    workspace: root,
    expectedRevision: null,
    role: { id: 'role-star-eng', name: '星图程序岗', priority: 'P0', status: '在招', owner: 'lin', aliases: ['星图历史名'] }
  });

  const beforeValidate = await validateRoleRegistryWorkspace(root);
  assert.equal(beforeValidate.valid, true);
  assert.equal(beforeValidate.missingAliases.length, 2);

  const synced = await syncRegistryAliases({ workspace: root });
  assert.equal(synced.changed, true);
  assert.equal(synced.roleAliases['role-star-eng'], '星图程序岗');
  assert.equal(synced.roleAliases['星图历史名'], '星图程序岗');
  const savedConfig = JSON.parse(await readFile(path.join(root, '_shared/recruit-board.config.json'), 'utf8'));
  assert.equal(savedConfig.description, '保留原配置说明');
  assert.deepEqual(savedConfig.statusStages, { '已沟通-待回复': 'talking' });

  // 再次同步为幂等无变更
  const syncedAgain = await syncRegistryAliases({ workspace: root, expectedConfigRevision: synced.configRevision });
  assert.equal(syncedAgain.changed, false);

  // 既有 readSnapshot 直接将固定 ID 与历史别名归入「星图程序岗」，且保留各自原人岗 ID
  const snapshot = await readSnapshot(root);
  assert.equal(snapshot.status, 'ok');
  assert.equal(snapshot.candidates.length, 3);
  assert.ok(snapshot.candidates.every(candidate => candidate.role === '星图程序岗'));
  assert.equal(snapshot.candidates.find(candidate => candidate.name === '样例甲').rawRole, 'role-star-eng');
  assert.equal(snapshot.candidates.find(candidate => candidate.name === '样例乙').rawRole, '星图历史名');
});

test('CLI 命令端到端可用并输出结构化 JSON 错误', async t => {
  const root = await createWorkspace(t);
  const initOut = await roleRegistryCLI(['init', '--workspace', root]);
  assert.equal(initOut.changed, true);
  const starId = initOut.registry.roles.find(role => role.name === '星图程序岗').id;

  const listed = await roleRegistryCLI(['list', '--workspace', root, '--status', '在招']);
  assert.equal(listed.roles.length, 1);
  assert.equal(listed.roles[0].id, starId);

  const payloadFile = path.join(root, '_shared/tmp-listing.json');
  await writeFile(payloadFile, JSON.stringify({
    expectedRevision: listed.revision,
    listing: { platform: 'boss', externalJobId: 'cli-boss-99', title: '星图 CLI 帖', roleIds: [starId], policy: 'active' }
  }));
  const bound = await roleRegistryCLI(['upsert-listing', '--workspace', root, '--input-file', payloadFile]);
  assert.equal(bound.changed, true);

  const resolved = await roleRegistryCLI(['resolve', '--workspace', root, '--platform', 'boss', '--external-job-id', 'cli-boss-99']);
  assert.equal(resolved.matched, true);
  assert.deepEqual(resolved.roleIds, [starId]);

  const validated = await roleRegistryCLI(['validate', '--workspace', root]);
  assert.equal(validated.valid, true);
  assert.equal(validated.diff.inSync, true);

  await assert.rejects(roleRegistryCLI(['unknown-cmd', '--workspace', root]), error => {
    const formatted = roleRegistryError(error);
    assert.equal(formatted.error.code, 'ROLE_REGISTRY_INPUT_INVALID');
    return true;
  });

  // 也测试 resolveRoleRegistry 缺失注册表时明确报 404
  const emptyRoot = await createWorkspace(t);
  await assert.rejects(resolveRoleRegistry(emptyRoot, { roleId: 'role-none' }), error => error.code === 'ROLE_REGISTRY_MISSING' && error.status === 404);
});
