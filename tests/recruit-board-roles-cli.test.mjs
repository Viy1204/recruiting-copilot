import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { replaceRoleStatus, rolesCLI, setRoleStatus, upsertRole } from '../skills/recruit-board/scripts/roles.mjs';

const execFileAsync = promisify(execFile);
const rolesScript = path.resolve('skills/recruit-board/scripts/roles.mjs');

const sevenColContext = [
  '# 合成工作区',
  '',
  '## 四、在招岗位与优先级',
  '',
  '| role_id | 岗位 | 优先级 | 状态 | 对外 JD | 对内档案 | 最近变更 |',
  '|---|---|---|---|---|---|---|',
  '| `GAME-CLIENT-01` | 客户端主程 | 最高 | 在招 | `01-jd/client.md` | `01-roles/client-internal.md` | — |',
  '| `GAME-ART-01` | 美术总监 | 急岗 | 暂停 | — | — | — |',
  ''
].join('\r\n');

const freshFiveColTemplate = [
  '# CONTEXT.md',
  '',
  '## 四、在招岗位与优先级',
  '',
  '| 岗位 | 优先级 | 状态 | 对外 JD | 对内笔记 |',
  '|---|---|---|---|---|',
  '| （待梳理） | | | `01-jd/<role>.md` | `01-jd/_internal/<role>.md` |',
  ''
].join('\n');

const freshSevenColTemplate = [
  '# CONTEXT.md',
  '',
  '## 四、在招岗位与优先级',
  '',
  '| role_id | 岗位 | 优先级 | 状态 | 对外 JD | 对内档案 | 最近变更 |',
  '|---|---|---|---|---|---|---|',
  '| （待梳理） | （待填写） | 常规 | 待梳理 | — | — | — |',
  ''
].join('\n');

async function makeWorkspace(t, content = sevenColContext) {
  const root = await mkdtemp(path.join(tmpdir(), 'recruit-roles-cli-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, 'CONTEXT.md'), content, 'utf8');
  return root;
}

test('setRoleStatus 支持按 role_id 与岗位名更新状态与最近变更，并追加 docs/CHANGELOG.md', async t => {
  const root = await makeWorkspace(t);
  const listed = await rolesCLI(['list', '--workspace', root]);
  assert.equal(listed.rows.length, 2);
  assert.equal(listed.rows[0].roleId, 'GAME-CLIENT-01');
  assert.deepEqual(listed.allowedStatuses, ['在招', '已下架', '已关闭', '暂停', '待核']);
  assert.ok(listed.knownStatuses.includes('待梳理'));

  const first = await setRoleStatus({
    workspace: root,
    role: 'GAME-CLIENT-01',
    status: '暂停',
    revision: listed.contextRevision,
    reason: '阶段性收口',
    now: () => '2026-11-27T08:00:00.000Z'
  });
  assert.equal(first.changed, true);
  assert.equal(first.role, '客户端主程');
  assert.equal(first.roleId, 'GAME-CLIENT-01');
  assert.equal(first.status, '暂停');
  assert.equal(first.changelogUpdated, true);

  const afterFirst = await readFile(path.join(root, 'CONTEXT.md'), 'utf8');
  assert.ok(afterFirst.includes('\r\n'));
  assert.match(afterFirst, /\| `GAME-CLIENT-01` \| 客户端主程 \| 最高 \| 暂停 \| `01-jd\/client\.md` \| `01-roles\/client-internal\.md` \| 2026-11-27 阶段性收口 \|/);

  const second = await setRoleStatus({
    workspace: root,
    role: '美术总监',
    status: '在招',
    revision: first.contextRevision,
    reason: '重新开放HC',
    now: () => '2026-11-28T09:00:00.000Z'
  });
  assert.equal(second.changed, true);
  assert.equal(second.role, '美术总监');
  assert.equal(second.roleId, 'GAME-ART-01');

  const changelog = await readFile(path.join(root, 'docs/CHANGELOG.md'), 'utf8');
  assert.equal(
    changelog,
    '# CHANGELOG — 招聘工作区变更日志\n\n' +
    '- 2026-11-27 | GAME-CLIENT-01（客户端主程）| 状态：在招 -> 暂停 | 阶段性收口\n' +
    '- 2026-11-28 | GAME-ART-01（美术总监）| 状态：暂停 -> 在招 | 重新开放HC\n'
  );
});

test('setRoleStatus 不传 reason 时仅改状态单元格且不创建 docs/CHANGELOG.md', async t => {
  const root = await makeWorkspace(t);
  const listed = await rolesCLI(['list', '--workspace', root]);
  const saved = await setRoleStatus({
    workspace: root,
    role: 'GAME-CLIENT-01',
    status: '待核',
    revision: listed.contextRevision
  });
  assert.equal(saved.changed, true);
  assert.equal(Object.hasOwn(saved, 'changelogUpdated'), false);
  const expected = sevenColContext.replace('| 最高 | 在招 |', '| 最高 | 待核 |');
  assert.equal(await readFile(path.join(root, 'CONTEXT.md'), 'utf8'), expected);
  assert.equal((await readdir(root)).includes('docs'), false);
});

test('setRoleStatus 与 replaceRoleStatus 拒绝带括号自由附注状态及非法 reason 且不改动 CONTEXT.md', async t => {
  const root = await makeWorkspace(t);
  const before = await readFile(path.join(root, 'CONTEXT.md'));
  const listed = await rolesCLI(['list', '--workspace', root]);

  await assert.rejects(
    setRoleStatus({ workspace: root, role: 'GAME-CLIENT-01', status: '在招（恢复）', revision: listed.contextRevision }),
    error => ['ROLE_STATUS_INVALID', 'ROLE_INPUT_INVALID'].includes(error.code)
  );
  await assert.rejects(
    setRoleStatus({ workspace: root, role: 'GAME-CLIENT-01', status: '暂停', revision: listed.contextRevision, reason: '包含|竖线' }),
    error => error.code === 'ROLE_INPUT_INVALID'
  );
  await assert.rejects(
    setRoleStatus({ workspace: root, role: 'GAME-CLIENT-01', status: '暂停', revision: listed.contextRevision, reason: '   ' }),
    error => error.code === 'ROLE_INPUT_INVALID'
  );
  assert.throws(
    () => replaceRoleStatus(sevenColContext, 'GAME-CLIENT-01', '在招（恢复）'),
    error => error.code === 'ROLE_STATUS_INVALID'
  );
  const escaped = replaceRoleStatus(sevenColContext, 'GAME-CLIENT-01', '暂停', { lastChange: '2026-11-27 A|B' });
  assert.match(escaped, /2026-11-27 A｜B/);
  assert.deepEqual(await readFile(path.join(root, 'CONTEXT.md')), before);
});

test('upsertRole 支持模板占位行替换、按 role_id 更新、冲突检测、路径校验与幂等重复调用', async t => {
  const fiveRoot = await makeWorkspace(t, freshFiveColTemplate);
  const insertedFive = await upsertRole({
    workspace: fiveRoot,
    name: '数值策划',
    priority: '急岗',
    status: '待梳理',
    jdPath: '01-jd/design.md',
    internalPath: '01-jd/_internal/design.md'
  });
  assert.equal(insertedFive.changed, true);
  assert.equal(insertedFive.action, 'insert');
  assert.equal(insertedFive.role, '数值策划');
  assert.equal(insertedFive.status, '待梳理');
  const fiveText = await readFile(path.join(fiveRoot, 'CONTEXT.md'), 'utf8');
  assert.equal(fiveText.includes('（待梳理）'), false);
  assert.match(fiveText, /\| 数值策划 \| 急岗 \| 待梳理 \| `01-jd\/design\.md` \| `01-jd\/_internal\/design\.md` \|/);

  const sevenRoot = await makeWorkspace(t, freshSevenColTemplate);
  const insertedSeven = await upsertRole({
    workspace: sevenRoot,
    roleId: 'GAME-SERVER-01',
    name: '服务端主程',
    priority: '最高',
    status: '在招',
    jdPath: '01-jd/server.md',
    internalPath: '01-roles/server-internal.md',
    reason: '新开核心岗位',
    now: () => '2026-11-27T10:00:00.000Z'
  });
  assert.equal(insertedSeven.changed, true);
  assert.equal(insertedSeven.action, 'insert');
  assert.equal(insertedSeven.roleId, 'GAME-SERVER-01');
  assert.equal(insertedSeven.changelogUpdated, true);
  const sevenText = await readFile(path.join(sevenRoot, 'CONTEXT.md'), 'utf8');
  assert.equal(sevenText.includes('（待填写）'), false);
  assert.match(sevenText, /\| `GAME-SERVER-01` \| 服务端主程 \| 最高 \| 在招 \| `01-jd\/server\.md` \| `01-roles\/server-internal\.md` \| 2026-11-27 新开核心岗位 \|/);

  const noop = await upsertRole({
    workspace: sevenRoot,
    roleId: 'GAME-SERVER-01',
    name: '服务端主程',
    priority: '最高',
    status: '在招',
    jdPath: '01-jd/server.md',
    internalPath: '01-roles/server-internal.md',
    reason: '新开核心岗位',
    now: () => '2026-11-27T11:00:00.000Z'
  });
  assert.equal(noop.changed, false);
  assert.equal(noop.action, 'noop');
  assert.equal(noop.backup, null);
  assert.equal(noop.changelogUpdated, false);

  const updated = await upsertRole({
    workspace: sevenRoot,
    roleId: 'GAME-SERVER-01',
    name: '资深服务端主程',
    priority: '急岗',
    status: '暂停',
    reason: '职级调整',
    now: () => '2026-11-28T10:00:00.000Z'
  });
  assert.equal(updated.changed, true);
  assert.equal(updated.action, 'update');
  assert.equal(updated.role, '资深服务端主程');
  assert.equal(updated.priority, '急岗');
  assert.equal(updated.status, '暂停');

  await upsertRole({
    workspace: sevenRoot,
    roleId: 'GAME-QA-01',
    name: 'QA 负责人',
    priority: '常规',
    status: '在招'
  });
  await assert.rejects(
    upsertRole({
      workspace: sevenRoot,
      roleId: 'GAME-SERVER-01',
      name: 'QA 负责人',
      priority: '常规',
      status: '在招'
    }),
    error => error.code === 'ROLE_CONFLICT' && error.status === 409
  );

  const beforeInvalid = await readFile(path.join(sevenRoot, 'CONTEXT.md'));
  for (const bad of [
    { roleId: 'invalid_id', name: '新岗', priority: '常规', status: '在招' },
    { roleId: 'GAME-NEW-01', name: '新岗', priority: '常规', status: '在招（加急）' },
    { roleId: 'GAME-NEW-01', name: '新岗', priority: '常规', status: '在招', jdPath: '../outside.md' },
    { roleId: 'GAME-NEW-01', name: '新岗', priority: '常规', status: '在招', internalPath: '/etc/passwd' },
    { roleId: 'GAME-NEW-01', name: '新岗', priority: '常规', status: '在招', jdPath: 'C:\\outside.md' },
    { name: '缺少ID岗', priority: '常规', status: '在招' }
  ]) {
    await assert.rejects(
      upsertRole({ workspace: sevenRoot, ...bad }),
      error => ['ROLE_INPUT_INVALID', 'ROLE_STATUS_INVALID'].includes(error.code)
    );
  }
  assert.deepEqual(await readFile(path.join(sevenRoot, 'CONTEXT.md')), beforeInvalid);
});

test('roles.mjs CLI 支持 list、set-status（自动读取 revision）与 upsert，错误 JSON 不泄露绝对路径', async t => {
  const root = await makeWorkspace(t);

  const listOut = await execFileAsync(process.execPath, [rolesScript, 'list', '--workspace', root]);
  const listJson = JSON.parse(listOut.stdout);
  assert.equal(listJson.rows.length, 2);
  assert.match(listJson.contextRevision, /^[a-f0-9]{64}$/);

  const setOut = await execFileAsync(process.execPath, [
    rolesScript, 'set-status', '--workspace', root, '--role', 'GAME-CLIENT-01', '--status', '已下架', '--reason', 'CLI下架测试'
  ]);
  const setJson = JSON.parse(setOut.stdout);
  assert.equal(setJson.changed, true);
  assert.equal(setJson.role, '客户端主程');
  assert.equal(setJson.roleId, 'GAME-CLIENT-01');
  assert.equal(setJson.status, '已下架');
  assert.equal(setJson.changelogUpdated, true);
  assert.equal(setOut.stdout.includes(root), false);

  const upsertOut = await execFileAsync(process.execPath, [
    rolesScript, 'upsert', '--workspace', root, '--role-id', 'GAME-TECH-01', '--name', '技术美术', '--priority', '急岗', '--status', '在招', '--jd', '01-jd/ta.md', '--reason', 'CLI新增'
  ]);
  const upsertJson = JSON.parse(upsertOut.stdout);
  assert.equal(upsertJson.changed, true);
  assert.equal(upsertJson.action, 'insert');
  assert.equal(upsertJson.role, '技术美术');
  assert.equal(upsertJson.roleId, 'GAME-TECH-01');
  assert.equal(upsertOut.stdout.includes(root), false);

  await assert.rejects(
    execFileAsync(process.execPath, [
      rolesScript, 'set-status', '--workspace', root, '--role', 'GAME-CLIENT-01', '--status', '在招（恢复）'
    ]),
    error => {
      assert.equal(error.code, 1);
      const parsed = JSON.parse(error.stderr);
      assert.ok(['ROLE_STATUS_INVALID', 'ROLE_INPUT_INVALID'].includes(parsed.error.code));
      assert.equal(error.stderr.includes(root), false);
      return true;
    }
  );

  const missingWorkspace = path.join(root, 'not-exists');
  await assert.rejects(
    execFileAsync(process.execPath, [rolesScript, 'list', '--workspace', missingWorkspace]),
    error => {
      assert.equal(error.code, 1);
      const parsed = JSON.parse(error.stderr);
      assert.equal(typeof parsed.error.code, 'string');
      assert.equal(error.stderr.includes(root), false);
      assert.equal(error.stderr.includes(missingWorkspace), false);
      return true;
    }
  );
});

test('docs 目录符号链接指向外部时拒绝写入 CHANGELOG', async t => {
  const root = await makeWorkspace(t);
  const outside = await mkdtemp(path.join(tmpdir(), 'recruit-roles-outside-'));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await symlink(outside, path.join(root, 'docs'), process.platform === 'win32' ? 'junction' : 'dir');

  const listed = await rolesCLI(['list', '--workspace', root]);
  await assert.rejects(
    setRoleStatus({
      workspace: root,
      role: 'GAME-CLIENT-01',
      status: '暂停',
      revision: listed.contextRevision,
      reason: '外部符号链接测试'
    }),
    error => error.code === 'CHANGELOG_UNSAFE'
  );
  assert.deepEqual(await readdir(outside), []);
});
