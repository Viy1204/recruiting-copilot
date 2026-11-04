import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, open, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { LEDGER_COLUMNS, readConfig } from '../skills/recruit-board/model.mjs';
import * as roles from '../skills/recruit-board/scripts/roles.mjs';
import { MAX_FILE_BYTES, readSnapshot } from '../skills/recruit-board/scripts/reader.mjs';

const context = '# 虚构工作区\n\n## 在招岗位与优先级\n| 岗位 | 优先级 | 状态 |\n|---|---|---|\n| 星图程序岗 | P0 | 在招 |\n| 云帆动画岗 | P1 | 暂停 |\n';
const header = `${LEDGER_COLUMNS.join(',')}\n`;
const row = (name, role) => ['1', name, role, '', 'A', '已回复', '虚构来源', '', ''].join(',');
const ledger = header + [row('样例甲', '星图旧岗'), row('样例甲', '星图旧岗'), row('样例乙', '星图旧岗'), row('样例甲', '星图程序岗'), row('样例丙', '程序/动画复合岗')].join('\n') + '\n';
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const configuration = (aliases = {}) => ({ schemaVersion: 1, statusStages: {}, roleAliases: aliases });
const configPath = root => path.join(root, '_shared/recruit-board.config.json');

async function fixture(t, config = null) {
  const root = await mkdtemp(path.join(tmpdir(), 'recruit-role-aliases-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, '02-sourcing'));
  await writeFile(path.join(root, 'CONTEXT.md'), context);
  await writeFile(path.join(root, '02-sourcing/dedup-ledger.csv'), ledger);
  if (config !== null) {
    await mkdir(path.join(root, '_shared'));
    await writeFile(configPath(root), JSON.stringify(config, null, 2) + '\n');
  }
  return root;
}

const save = (root, info, role = '星图旧岗', target = '星图程序岗') => roles.setRoleAlias({ workspace: root, role, target, revision: info.configRevision });

test('岗位管理列出台账中未配置的原岗名，保持正式岗位接口且只按原人岗键计数', async t => {
  const root = await fixture(t);
  const info = await roles.readRoleInfo(root);
  assert.deepEqual(info.roles.map(role => role.name), ['星图程序岗', '云帆动画岗']);
  assert.deepEqual(info.allowedStatuses, [...roles.ROLE_STATUSES]);
  assert.equal(info.contextRevision, digest(Buffer.from(context)));
  assert.deepEqual(info.unconfiguredRoles, [{ name: '星图旧岗', count: 2 }, { name: '程序/动画复合岗', count: 1 }]);
  assert.deepEqual(info.roleAliases, {});
  assert.equal(info.configRevision, null);
  assert.equal(info.configStatus, 'missing');
  assert.equal(info.ledgerStatus, 'ok');
  assert.equal((await readdir(root)).includes('_shared'), false);
  assert.equal((await readdir(root)).includes('runtime'), false);
});

test('缺失配置可以新增别名，按现有 schema 建立默认配置且保留台账原键和正式标准', async t => {
  const root = await fixture(t);
  const before = await readSnapshot(root);
  const info = await roles.readRoleInfo(root);
  const saved = await save(root, info);
  const bytes = await readFile(configPath(root));
  assert.deepEqual(JSON.parse(bytes), configuration({ 星图旧岗: '星图程序岗' }));
  assert.deepEqual(readConfig(bytes.toString(), info.roles).roleAliases, saved.roleAliases);
  assert.equal(saved.changed, true);
  assert.equal(saved.role, '星图旧岗');
  assert.equal(saved.target, '星图程序岗');
  assert.equal(saved.backup, null);
  assert.equal(saved.configRevision, digest(bytes));
  assert.equal(saved.configStatus, 'ok');
  assert.equal(saved.contextRevision, info.contextRevision);
  assert.deepEqual(saved.unconfiguredRoles, [{ name: '程序/动画复合岗', count: 1 }]);
  assert.equal(await readFile(path.join(root, 'CONTEXT.md'), 'utf8'), context);
  assert.equal(await readFile(path.join(root, '02-sourcing/dedup-ledger.csv'), 'utf8'), ledger);
  const after = await readSnapshot(root);
  assert.deepEqual(after.candidates.map(item => [item.id, item.rawRole]), before.candidates.map(item => [item.id, item.rawRole]));
  assert.equal(after.candidates.length, before.candidates.length);
  assert.equal(after.candidates.find(item => item.rawRole === '星图旧岗').role, '星图程序岗');
  assert.equal(after.roles.find(item => item.name === '星图程序岗').status, '在招');
  assert.equal(after.roles.find(item => item.name === '程序/动画复合岗').configured, false);
});

test('更正和移除已有映射保留其他配置，备份原字节，重复保存不写新备份', async t => {
  const original = {
    ...configuration({ ' 星图旧岗 ': ' 星图程序岗 ', 备用旧称: '星图程序岗' }),
    statusStages: { ' 已沟通-待答复 ': 'talking' },
    description: '虚构配置说明', verifiedAt: '2026-11-04', source: { channel: '虚构来源', notes: ['保留原始约定'] }
  };
  const root = await fixture(t, original);
  const before = await readFile(configPath(root));
  const info = await roles.readRoleInfo(root);
  assert.equal(info.configRevision, digest(before));
  assert.deepEqual(info.roleAliases, { 星图旧岗: '星图程序岗', 备用旧称: '星图程序岗' });
  assert.deepEqual(info.unconfiguredRoles, [{ name: '程序/动画复合岗', count: 1 }]);
  const saved = await save(root, info, '星图旧岗', '云帆动画岗');
  assert.equal(saved.changed, true);
  assert.deepEqual(await readFile(path.join(root, saved.backup)), before);
  assert.ok(!path.isAbsolute(saved.backup));
  const expected = { ...original, roleAliases: { 备用旧称: '星图程序岗', 星图旧岗: '云帆动画岗' } };
  assert.deepEqual(JSON.parse(await readFile(configPath(root), 'utf8')), expected);
  const directory = path.join(root, 'runtime/recruit-board/roles');
  const files = await readdir(directory);
  const unchanged = await save(root, saved, '星图旧岗', '云帆动画岗');
  assert.equal(unchanged.changed, false);
  assert.equal(unchanged.backup, null);
  assert.equal(unchanged.configRevision, saved.configRevision);
  assert.deepEqual(await readdir(directory), files);
  const previous = await readFile(configPath(root));
  const removed = await save(root, saved, '星图旧岗', null);
  assert.equal(removed.target, null);
  assert.deepEqual(removed.roleAliases, { 备用旧称: '星图程序岗' });
  assert.deepEqual(await readFile(path.join(root, removed.backup)), previous);
  assert.deepEqual(removed.unconfiguredRoles, [{ name: '星图旧岗', count: 2 }, { name: '程序/动画复合岗', count: 1 }]);
  assert.equal(await readFile(path.join(root, 'CONTEXT.md'), 'utf8'), context);
  assert.equal(await readFile(path.join(root, '02-sourcing/dedup-ledger.csv'), 'utf8'), ledger);
  const removedAgain = await save(root, removed, '星图旧岗', null);
  assert.equal(removedAgain.changed, false);
  assert.equal(removedAgain.backup, null);
  assert.equal(removedAgain.configRevision, removed.configRevision);
});

test('台账缺失或损坏不破坏原岗位状态接口，仍可更正或移除已配置但当前无台账的映射', async t => {
  const root = await fixture(t, configuration({ 备用旧称: '星图程序岗' }));
  for (const missing of [true, false]) {
    const ledgerFile = path.join(root, '02-sourcing/dedup-ledger.csv');
    if (missing) await rm(ledgerFile);
    else await writeFile(ledgerFile, 'bad ledger');
    const info = await roles.readRoleInfo(root);
    assert.equal(info.roles.length, 2);
    assert.equal(info.ledgerStatus, missing ? 'missing' : 'error');
    assert.deepEqual(info.unconfiguredRoles, []);
    assert.deepEqual(info.roleAliases, { 备用旧称: '星图程序岗' });
    await assert.rejects(save(root, info), error => error.code === 'ROLE_LEDGER_UNREADABLE');
    const saved = await save(root, info, '备用旧称', '云帆动画岗');
    assert.equal(saved.roleAliases.备用旧称, '云帆动画岗');
    const restored = await save(root, saved, '备用旧称', '星图程序岗');
    assert.equal(restored.roleAliases.备用旧称, '星图程序岗');
  }
  const removed = await save(root, await roles.readRoleInfo(root), '备用旧称', null);
  assert.deepEqual(removed.roleAliases, {});
});

test('拒正式岗位覆盖、无效目标、别名链循环和未见过的来源名称，输入校验不改原文件', async t => {
  const root = await fixture(t, configuration({ 星图旧岗: '星图程序岗' }));
  const info = await roles.readRoleInfo(root);
  const before = await readFile(configPath(root));
  for (const [role, target] of [['星图程序岗', '云帆动画岗'], ['云帆动画岗', null]]) {
    await assert.rejects(save(root, info, role, target), error => error.code === 'ROLE_ALIAS_CONFIGURED');
  }
  for (const [role, target] of [['星图旧岗', '不存在岗位'], ['星图旧岗', '星图旧岗'], ['程序/动画复合岗', '星图旧岗']]) {
    await assert.rejects(save(root, info, role, target), error => error.code === 'ROLE_ALIAS_TARGET_INVALID');
  }
  await assert.rejects(save(root, info, '未见来源', '星图程序岗'), error => error.code === 'ROLE_ALIAS_NOT_FOUND' && error.status === 404);
  for (const input of [
    { role: '' }, { role: ' 星图旧岗' }, { role: 'x'.repeat(301) }, { role: '换\n行' },
    { target: undefined }, { target: '' }, { target: ' 星图程序岗' }, { target: 1 },
    { revision: undefined }, { revision: 'bad' }, { revision: 0 }
  ]) {
    await assert.rejects(roles.setRoleAlias({ workspace: root, role: '星图旧岗', target: '星图程序岗', revision: info.configRevision, ...input }), error => error.code === 'ROLE_ALIAS_INPUT_INVALID' && error.status === 400);
  }
  assert.deepEqual(await readFile(configPath(root)), before);
});

test('配置缺失、创建、删除、元数据变化及并发写入均受 configRevision 和共用写锁保护', async t => {
  const root = await fixture(t);
  const initial = await roles.readRoleInfo(root);
  const saved = await save(root, initial);
  await assert.rejects(save(root, initial, '程序/动画复合岗'), error => error.code === 'CONFIG_CONFLICT' && error.status === 409);
  const changed = JSON.parse(await readFile(configPath(root), 'utf8'));
  changed.description = '并发外部修改';
  await writeFile(configPath(root), JSON.stringify(changed));
  const external = await readFile(configPath(root));
  await assert.rejects(save(root, saved, '星图旧岗', null), error => error.code === 'CONFIG_CONFLICT');
  assert.deepEqual(await readFile(configPath(root)), external);
  let info = await roles.readRoleInfo(root);
  await rm(configPath(root));
  await assert.rejects(save(root, info), error => error.code === 'CONFIG_CONFLICT');
  info = await roles.readRoleInfo(root);
  const directory = path.join(root, 'runtime/recruit-board/roles');
  const lock = await open(path.join(directory, 'context.lock'), 'wx');
  try {
    await assert.rejects(save(root, info), error => error.code === 'ROLE_LOCKED' && error.status === 409);
  } finally {
    await lock.close();
    await rm(path.join(directory, 'context.lock'));
  }
  const attempts = await Promise.allSettled([save(root, info), save(root, info, '程序/动画复合岗', '云帆动画岗')]);
  assert.equal(attempts.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(attempts.filter(result => result.status === 'rejected').length, 1);
  assert.ok(['ROLE_LOCKED', 'CONFIG_CONFLICT'].includes(attempts.find(result => result.status === 'rejected').reason.code));
  assert.ok((await readdir(path.join(root, '_shared'))).every(file => !file.endsWith('.tmp')));
  assert.ok(!(await readdir(directory)).includes('context.lock'));
});

test('损坏配置和已有链循环不被默认值覆盖，读取保留旧岗位能力且拒绝写入', async t => {
  const root = await fixture(t, configuration());
  for (const value of [
    '{', JSON.stringify({ schemaVersion: 2 }),
    JSON.stringify(configuration({ 星图旧岗: '中间旧称', 中间旧称: '星图程序岗' })),
    JSON.stringify(configuration({ 星图旧岗: '程序/动画复合岗', '程序/动画复合岗': '星图旧岗' }))
  ]) {
    await writeFile(configPath(root), value);
    const info = await roles.readRoleInfo(root);
    assert.equal(info.roles.length, 2);
    assert.equal(info.configStatus, 'error');
    assert.deepEqual(info.roleAliases, {});
    await assert.rejects(save(root, info), error => error.code === 'ROLE_CONFIG_INVALID' && error.status === 422);
    assert.equal(await readFile(configPath(root), 'utf8'), value);
  }
});

test('配置编码和 BOM 可保留，超限配置拒绝且不覆盖已有字节', async t => {
  const root = await fixture(t, configuration());
  const original = JSON.stringify(configuration());
  for (const encoding of ['utf8bom', 'utf16le', 'utf16be']) {
    const body = Buffer.from(original, encoding === 'utf8bom' ? 'utf8' : 'utf16le');
    if (encoding === 'utf16be') body.swap16();
    const bom = Buffer.from(encoding === 'utf8bom' ? [0xef, 0xbb, 0xbf] : encoding === 'utf16le' ? [0xff, 0xfe] : [0xfe, 0xff]);
    const before = Buffer.concat([bom, body]);
    await writeFile(configPath(root), before);
    const saved = await save(root, await roles.readRoleInfo(root));
    const output = await readFile(configPath(root));
    assert.deepEqual(output.subarray(0, bom.length), bom);
    assert.deepEqual(await readFile(path.join(root, saved.backup)), before);
    assert.equal((await roles.readRoleInfo(root)).roleAliases.星图旧岗, '星图程序岗');
  }
  const oversized = Buffer.alloc(MAX_FILE_BYTES + 1, 32);
  await writeFile(configPath(root), oversized);
  const info = await roles.readRoleInfo(root);
  assert.equal(info.configStatus, 'error');
  await assert.rejects(save(root, info), error => error.code === 'ROLE_CONFIG_TOO_LARGE');
  assert.deepEqual(await readFile(configPath(root)), oversized);
});

test('特殊对象键按精确原岗名映射，不修改对象原型', async t => {
  const root = await fixture(t, configuration());
  await writeFile(path.join(root, '02-sourcing/dedup-ledger.csv'), header + [row('样例甲', '__proto__'), row('样例乙', 'constructor'), row('样例丙', 'toString')].join('\n'));
  let info = await roles.readRoleInfo(root);
  for (const role of ['__proto__', 'constructor', 'toString']) {
    info = await save(root, info, role);
    assert.ok(Object.hasOwn(info.roleAliases, role));
    assert.equal(info.roleAliases[role], '星图程序岗');
  }
  assert.equal(Object.getPrototypeOf(info.roleAliases), Object.prototype);
  assert.equal(Object.hasOwn(Object.prototype, '星图旧岗'), false);
});

test('跨工作区配置、台账或备份目录符号链接不会读取或写入外部内容', async t => {
  const outside = await mkdtemp(path.join(tmpdir(), 'recruit-role-outside-'));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await writeFile(path.join(outside, 'recruit-board.config.json'), JSON.stringify(configuration()));
  await writeFile(path.join(outside, 'dedup-ledger.csv'), ledger);
  const externalConfig = await readFile(path.join(outside, 'recruit-board.config.json'));
  const externalFiles = await readdir(outside);
  for (const link of ['_shared', 'runtime', '02-sourcing']) {
    const root = await fixture(t);
    if (link === '02-sourcing') await rm(path.join(root, link), { recursive: true });
    await symlink(outside, path.join(root, link), process.platform === 'win32' ? 'junction' : 'dir');
    const info = await roles.readRoleInfo(root);
    if (link === '_shared') assert.equal(info.configStatus, 'error');
    if (link === '02-sourcing') {
      assert.equal(info.ledgerStatus, 'error');
      assert.deepEqual(info.unconfiguredRoles, []);
    }
    await assert.rejects(save(root, info), error => /UNSAFE|UNREADABLE/.test(error.code));
    assert.deepEqual(await readFile(path.join(outside, 'recruit-board.config.json')), externalConfig);
    assert.deepEqual(await readdir(outside), externalFiles);
  }
  const root = await fixture(t, configuration());
  await rm(configPath(root));
  try {
    await symlink(path.join(outside, 'recruit-board.config.json'), configPath(root), 'file');
  } catch (error) {
    if (process.platform !== 'win32' || error.code !== 'EPERM') throw error;
    t.diagnostic('当前 Windows 账户无文件 symlink 权限；目录 junction 的跨区保护已验证');
    return;
  }
  const info = await roles.readRoleInfo(root);
  assert.equal(info.configStatus, 'error');
  await assert.rejects(save(root, info), error => error.code === 'ROLE_CONFIG_UNSAFE');
  assert.deepEqual(await readFile(path.join(outside, 'recruit-board.config.json')), externalConfig);
});
