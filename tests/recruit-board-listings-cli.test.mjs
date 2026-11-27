import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, open, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import {
  applyListingRemove,
  applyListingUpsert,
  emptyListingsConfig,
  resolveListingTarget,
  validateListingsConfig
} from '../skills/recruit-board/listings-domain.mjs';
import {
  listPlatformListings,
  listingsCLI,
  listingsError,
  removePlatformListing,
  resolvePlatformListing,
  upsertPlatformListing,
  validatePlatformListings
} from '../skills/recruit-board/scripts/listings.mjs';
import { validateWorkspace } from '../skills/recruit-board/scripts/workspace.mjs';

const execFileAsync = promisify(execFile);
const repoRoot = fileURLToPath(new URL('../', import.meta.url));
const listingsScript = path.join(repoRoot, 'skills/recruit-board/scripts/listings.mjs');
const digest = bytes => createHash('sha256').update(bytes).digest('hex');

const contextV09 = [
  '# CONTEXT.md —— 虚构招聘工作区',
  '',
  '## 四、在招岗位与优先级',
  '| role_id | 岗位 | 优先级 | 状态 | 对外 JD | 对内档案 | 最近变更 |',
  '|---|---|---|---|---|---|---|',
  '| STAR-ENG | 星图程序岗 | 急岗 | 在招 | `01-jd/星图程序岗.md` | `01-jd/_internal/星图程序岗.md` | — |',
  '| STAR-QA | 星图测试岗 | 常规 | 在招 | `01-jd/星图测试岗.md` | `01-jd/_internal/星图测试岗.md` | — |',
  '| CRAFT-PE | 云帆工艺岗 | 停 | 暂停 | `01-jd/云帆工艺岗.md` | `01-jd/_internal/云帆工艺岗.md` | — |',
  ''
].join('\n');

async function createWorkspace(t, { context = contextV09, listings = null } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'recruit-listings-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, '01-jd/_internal'), { recursive: true });
  await mkdir(path.join(root, 'docs'), { recursive: true });
  await writeFile(path.join(root, 'CONTEXT.md'), context);
  await writeFile(path.join(root, 'docs/CHANGELOG.md'), '# CHANGELOG\n');
  for (const name of ['星图程序岗', '星图测试岗', '云帆工艺岗']) {
    await writeFile(path.join(root, `01-jd/${name}.md`), `# ${name}\n`);
    await writeFile(path.join(root, `01-jd/_internal/${name}.md`), `# ${name} 对内档案\n`);
  }
  if (listings !== null) {
    await mkdir(path.join(root, '_shared'), { recursive: true });
    const raw = typeof listings === 'string' ? listings : `${JSON.stringify(listings, null, 2)}\n`;
    await writeFile(path.join(root, '_shared/listings.json'), raw);
  }
  return root;
}

test('domain 校验严格遵守 v0.9.0 ROLE_ID_PATTERN 与 1:1 / 1:N / N:1 / 1:0 ignore 契约', () => {
  const valid = validateListingsConfig({
    schemaVersion: 1,
    listings: [
      { platform: 'boss', externalJobId: 'boss-merge-1', title: '星图研发合并帖', roleIds: ['STAR-ENG', 'STAR-QA'], policy: 'active' },
      { platform: 'liepin', externalJobId: 'lp-eng-1', title: '星图程序岗', roleIds: ['STAR-ENG'], policy: 'inbound_only' },
      { platform: 'zhaopin', externalJobId: 'zp-campus', title: '校招应届帖', roleIds: [], policy: 'ignore', note: '跳过' }
    ]
  }, new Set(['STAR-ENG', 'STAR-QA']));
  assert.equal(valid.listings.length, 3);

  const invalidCases = [
    { schemaVersion: 2, listings: [] },
    { schemaVersion: 1, listings: [], roles: [] }, // 拒绝复制 roles[] 双事实源
    { schemaVersion: 1, listings: [{ platform: 'BOSS', externalJobId: '1', roleIds: ['STAR-ENG'], policy: 'active' }] },
    { schemaVersion: 1, listings: [{ platform: 'boss', externalJobId: '1', roleIds: ['lowercase-id'], policy: 'active' }] },
    { schemaVersion: 1, listings: [{ platform: 'boss', externalJobId: '1', roleIds: ['STAR-ENG', 'STAR-ENG'], policy: 'active' }] },
    { schemaVersion: 1, listings: [{ platform: 'boss', externalJobId: '1', roleIds: [], policy: 'active' }] },
    { schemaVersion: 1, listings: [{ platform: 'boss', externalJobId: '1', roleIds: ['STAR-ENG'], policy: 'ignore' }] },
    {
      schemaVersion: 1,
      listings: [
        { platform: 'boss', externalJobId: 'dup-1', roleIds: ['STAR-ENG'], policy: 'active' },
        { platform: 'boss', externalJobId: 'dup-1', roleIds: ['STAR-QA'], policy: 'paused' }
      ]
    }
  ];
  for (const payload of invalidCases) {
    assert.throws(() => validateListingsConfig(payload), error => error.code === 'LISTINGS_INVALID');
  }

  // 引用不存在的 role_id 报 LISTING_DANGLING_ROLE_ID
  assert.throws(
    () => validateListingsConfig({ schemaVersion: 1, listings: [{ platform: 'boss', externalJobId: '1', roleIds: ['GHOST-01'], policy: 'active' }] }, new Set(['STAR-ENG'])),
    error => error.code === 'LISTING_DANGLING_ROLE_ID' && error.status === 422
  );

  // 域转换：upsert & remove & resolve
  let cfg = emptyListingsConfig();
  cfg = applyListingUpsert(cfg, { platform: 'boss', externalJobId: 'b1', roleIds: ['STAR-ENG', 'STAR-QA'], policy: 'active' }, new Set(['STAR-ENG', 'STAR-QA'])).config;
  cfg = applyListingUpsert(cfg, { platform: 'liepin', externalJobId: 'l1', roleIds: ['STAR-ENG'], policy: 'inbound_only' }, new Set(['STAR-ENG', 'STAR-QA'])).config;
  const byListing = resolveListingTarget(cfg, { platform: 'boss', externalJobId: 'b1' }, [{ roleId: 'STAR-ENG', name: '星图程序岗', priority: '急岗', status: '在招', internalPath: '01-jd/_internal/星图程序岗.md' }]);
  assert.equal(byListing.matched, true);
  assert.deepEqual(byListing.roleIds, ['STAR-ENG', 'STAR-QA']);
  assert.equal(byListing.roles[0].name, '星图程序岗');

  const byRole = resolveListingTarget(cfg, { roleId: 'STAR-ENG' });
  assert.equal(byRole.matched, true);
  assert.equal(byRole.listings.length, 2);

  const removed = applyListingRemove(cfg, 'boss', 'b1');
  assert.equal(removed.config.listings.length, 1);
});

test('upsert/remove 共享 context.lock 互斥锁、乐观并发、自动备份与符号链接拦截', async t => {
  const root = await createWorkspace(t);

  // 首次写入（expectedRevision: null）
  const first = await upsertPlatformListing({
    workspace: root,
    expectedRevision: null,
    listing: { platform: 'boss', externalJobId: 'boss-1001', title: '星图合并帖', roleIds: ['STAR-ENG', 'STAR-QA'], policy: 'active' }
  });
  assert.equal(first.changed, true);
  assert.equal(first.backup, null);
  const bytes1 = await readFile(path.join(root, '_shared/listings.json'));
  assert.equal(first.revision, digest(bytes1));

  // 相同内容重复写入幂等且不写备份
  const noop = await upsertPlatformListing({
    workspace: root,
    expectedRevision: first.revision,
    listing: { platform: 'boss', externalJobId: 'boss-1001', title: '星图合并帖', roleIds: ['STAR-ENG', 'STAR-QA'], policy: 'active' }
  });
  assert.equal(noop.changed, false);
  assert.equal(noop.backup, null);

  // 新增 ignore 职位，自动留备份
  const second = await upsertPlatformListing({
    workspace: root,
    expectedRevision: first.revision,
    listing: { platform: 'liepin', externalJobId: 'lp-campus', title: '校招旧帖', roleIds: [], policy: 'ignore', note: '跳过' }
  });
  assert.equal(second.changed, true);
  assert.deepEqual(await readFile(path.join(root, second.backup)), bytes1);

  // 过期 revision 返回 409 LISTINGS_CONFLICT
  await assert.rejects(
    upsertPlatformListing({
      workspace: root,
      expectedRevision: first.revision,
      listing: { platform: 'zhaopin', externalJobId: 'zp-1', roleIds: ['STAR-ENG'], policy: 'active' }
    }),
    error => error.code === 'LISTINGS_CONFLICT' && error.status === 409
  );

  // 引用不存在的 role_id 拒绝写入
  await assert.rejects(
    upsertPlatformListing({
      workspace: root,
      expectedRevision: second.revision,
      listing: { platform: 'zhaopin', externalJobId: 'zp-bad', roleIds: ['NO-SUCH'], policy: 'active' }
    }),
    error => error.code === 'LISTING_DANGLING_ROLE_ID' && error.status === 422
  );

  // 与 roles.mjs 共用 runtime/recruit-board/roles/context.lock 互斥
  const lockPath = path.join(root, 'runtime/recruit-board/roles/context.lock');
  const lockHandle = await open(lockPath, 'wx');
  try {
    await assert.rejects(
      removePlatformListing({ workspace: root, platform: 'liepin', externalJobId: 'lp-campus', expectedRevision: second.revision }),
      error => error.code === 'ROLE_LOCKED' && error.status === 409
    );
  } finally {
    await lockHandle.close();
    await rm(lockPath);
  }

  // 释放锁后可正常删除
  const removed = await removePlatformListing({
    workspace: root,
    platform: 'liepin',
    externalJobId: 'lp-campus',
    expectedRevision: second.revision
  });
  assert.equal(removed.removed.externalJobId, 'lp-campus');
  assert.equal(removed.listings.length, 1);

  // 符号链接越权拦截
  const outside = await mkdtemp(path.join(tmpdir(), 'recruit-outside-listings-'));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await writeFile(path.join(outside, 'escape.json'), '{"schemaVersion":1,"listings":[]}\n');
  await rm(path.join(root, '_shared/listings.json'));
  await symlink(path.join(outside, 'escape.json'), path.join(root, '_shared/listings.json'));
  await assert.rejects(listPlatformListings(root), error => error.code === 'LISTINGS_UNSAFE' && error.status === 403);
});

test('validate fail-closed 并与 workspace.mjs validate 联动（悬空 role_id 返回 ok:false 且 CLI exit 1；指向非在招岗给出告警）', async t => {
  // 1. 正常 + 指向暂停岗的活跃帖 -> ok:true + LISTING_ROLE_INACTIVE warning
  const warnRoot = await createWorkspace(t, {
    listings: {
      schemaVersion: 1,
      listings: [
        { platform: 'boss', externalJobId: 'b-active', roleIds: ['STAR-ENG'], policy: 'active' },
        { platform: 'boss', externalJobId: 'b-paused-role', roleIds: ['CRAFT-PE'], policy: 'active' },
        { platform: 'liepin', externalJobId: 'lp-ignore', roleIds: [], policy: 'ignore' }
      ]
    }
  });
  const wsWarn = await validateWorkspace(warnRoot);
  assert.equal(wsWarn.ok, true);
  assert.equal(wsWarn.stats.listingsCount, 3);
  assert.equal(wsWarn.stats.ignoredListingsCount, 1);
  assert.ok(wsWarn.warnings.some(item => item.code === 'LISTING_ROLE_INACTIVE' && item.roleId === 'CRAFT-PE'));

  // 2. 悬空 role_id -> ok:false 且 listings.mjs validate 子进程退出码 1
  const badRoot = await createWorkspace(t, {
    listings: {
      schemaVersion: 1,
      listings: [
        { platform: 'boss', externalJobId: 'b-dangling', roleIds: ['DELETED-01'], policy: 'active' }
      ]
    }
  });
  const directCheck = await validatePlatformListings(badRoot);
  assert.equal(directCheck.ok, false);
  assert.equal(directCheck.errors[0].code, 'LISTING_DANGLING_ROLE_ID');

  const wsBad = await validateWorkspace(badRoot);
  assert.equal(wsBad.ok, false);
  assert.ok(wsBad.errors.some(item => item.code === 'LISTING_DANGLING_ROLE_ID'));

  await assert.rejects(
    execFileAsync(process.execPath, [listingsScript, 'validate', '--workspace', badRoot]),
    error => {
      assert.equal(error.code, 1);
      const parsed = JSON.parse(error.stdout);
      assert.equal(parsed.ok, false);
      assert.equal(parsed.errors[0].code, 'LISTING_DANGLING_ROLE_ID');
      return true;
    }
  );
});

test('CLI list/resolve/upsert/validate 端到端可用且错误格式统一', async t => {
  const root = await createWorkspace(t);
  const upserted = await listingsCLI([
    'upsert',
    '--workspace', root,
    '--input', JSON.stringify({
      expectedRevision: null,
      listing: { platform: 'boss', externalJobId: 'boss-9001', title: '合并岗', roleIds: ['STAR-ENG', 'STAR-QA'], policy: 'active' }
    })
  ]);
  assert.equal(upserted.changed, true);

  const listed = await listingsCLI(['list', '--workspace', root, '--platform', 'boss']);
  assert.equal(listed.listings.length, 1);

  const resolved = await resolvePlatformListing(root, { platform: 'boss', externalJobId: 'boss-9001' });
  assert.equal(resolved.matched, true);
  assert.deepEqual(resolved.roleIds, ['STAR-ENG', 'STAR-QA']);
  assert.equal(resolved.roles[0].name, '星图程序岗');
  assert.equal(resolved.roles[1].name, '星图测试岗');

  const validated = await listingsCLI(['validate', '--workspace', root]);
  assert.equal(validated.ok, true);

  await assert.rejects(listingsCLI(['bad-cmd', '--workspace', root]), error => {
    const formatted = listingsError(error);
    assert.equal(formatted.error.code, 'LISTINGS_INPUT_INVALID');
    return true;
  });
});
