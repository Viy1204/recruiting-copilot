import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readFile, realpath, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { readRoleTable } from '../model.mjs';
import {
  applyListingRemove,
  applyListingUpsert,
  emptyListingsConfig,
  LISTING_POLICIES,
  resolveListingTarget,
  validateListingsConfig,
  validatePlatform,
  validateRoleId
} from '../listings-domain.mjs';
import { insideWorkspace, MAX_FILE_BYTES, readSource, resolveWorkspace } from './reader.mjs';

export const LISTINGS_RELATIVE = '_shared/listings.json';
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const failure = (code, message, status = 400) => Object.assign(new Error(message), { code, status });
const isValidRevision = value => value === null || (typeof value === 'string' && /^[a-f0-9]{64}$/.test(value));

async function ensureDir(root, segments, create = false) {
  let current = root;
  for (const segment of segments) {
    current = path.join(current, segment);
    let info;
    try { info = await lstat(current); }
    catch (error) {
      if (error.code !== 'ENOENT') throw failure('LISTINGS_UNREADABLE', '无法访问工作区目录', 422);
      if (!create) return null;
      await mkdir(current, { recursive: true });
      info = await lstat(current);
    }
    if (!info.isDirectory() || info.isSymbolicLink() || !insideWorkspace(root, await realpath(current))) {
      throw failure('LISTINGS_UNSAFE', '目标目录必须位于工作区内且不能为符号链接', 403);
    }
  }
  return current;
}

/**
 * Shares `runtime/recruit-board/roles/context.lock` with roles.mjs / workspace.mjs
 * so role table updates and external listing bindings are strictly mutually exclusive.
 */
async function withContextLock(root, operation) {
  const directory = await ensureDir(root, ['runtime', 'recruit-board', 'roles'], true);
  const lockFile = path.join(directory, 'context.lock');
  let lock;
  try { lock = await open(lockFile, 'wx'); }
  catch (error) {
    if (error.code === 'EEXIST') throw failure('ROLE_LOCKED', '岗位配置或职位路由表正在修改中，请确认后重试', 409);
    throw error;
  }
  try { return await operation(directory); }
  finally {
    await lock.close();
    await rm(lockFile);
  }
}

async function readSafeListingsFile(root) {
  const file = path.join(root, LISTINGS_RELATIVE);
  let info;
  try { info = await lstat(file); }
  catch (error) {
    if (error.code === 'ENOENT') {
      return { file, status: 'missing', bytes: null, text: null, revision: null, info: null, value: emptyListingsConfig() };
    }
    throw failure('LISTINGS_UNREADABLE', `无法读取 ${LISTINGS_RELATIVE}`, 422);
  }
  if (!info.isFile() || info.isSymbolicLink() || !insideWorkspace(root, await realpath(file))) {
    throw failure('LISTINGS_UNSAFE', `${LISTINGS_RELATIVE} 必须是工作区内的普通文件且不能为符号链接`, 403);
  }
  if (info.size > MAX_FILE_BYTES) throw failure('LISTINGS_TOO_LARGE', `${LISTINGS_RELATIVE} 超过读取上限`, 422);
  const bytes = await readFile(file);
  if (bytes.length > MAX_FILE_BYTES) throw failure('LISTINGS_TOO_LARGE', `${LISTINGS_RELATIVE} 超过读取上限`, 422);
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { throw failure('LISTINGS_ENCODING', `${LISTINGS_RELATIVE} 不是有效的 UTF-8 文本`, 422); }
  let parsed;
  try { parsed = JSON.parse(text.replace(/^\uFEFF/, '')); }
  catch { throw Object.assign(failure('LISTINGS_INVALID', `${LISTINGS_RELATIVE} 不是有效的 JSON`, 422), { revision: digest(bytes) }); }
  const value = validateListingsConfig(parsed);
  return { file, status: 'ok', bytes, text, revision: digest(bytes), info, value };
}

async function readContextRoleTable(root) {
  const source = await readSource(root, 'CONTEXT.md');
  if (source.status !== 'ok') {
    throw failure('CONTEXT_UNREADABLE', '无法读取 CONTEXT.md，无法核对 role_id', 422);
  }
  let table;
  try { table = readRoleTable(source.text); }
  catch (error) { throw failure('ROLES_UNCONFIGURED', error.message, 422); }
  const hasRoleIdCol = table.headers.includes('role_id');
  const roleIdSet = new Set(table.rows.map(row => row.roleId).filter(Boolean));
  return { table, rows: table.rows, hasRoleIdCol, roleIdSet, revision: source.revision };
}

async function writeAtomicWithBackup(root, lockDir, previous, nextText) {
  const bytes = Buffer.from(nextText, 'utf8');
  if (bytes.length > MAX_FILE_BYTES) throw failure('LISTINGS_TOO_LARGE', '保存内容超过读取上限', 422);
  await ensureDir(root, ['_shared'], true);
  let backup = null;
  if (previous.bytes !== null) {
    backup = path.join(lockDir, `listings-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID()}.json`);
    const saved = await open(backup, 'wx');
    try { await saved.writeFile(previous.bytes); await saved.sync(); }
    finally { await saved.close(); }
  }
  const temporary = path.join(path.dirname(previous.file), `.listings-${randomUUID()}.tmp`);
  try {
    const output = await open(temporary, 'wx', previous.info ? previous.info.mode & 0o777 : 0o600);
    try { await output.writeFile(bytes); await output.sync(); }
    finally { await output.close(); }
    await rename(temporary, previous.file);
  } finally {
    await rm(temporary, { force: true });
  }
  return {
    revision: digest(bytes),
    backup: backup ? path.relative(root, backup).split(path.sep).join('/') : null
  };
}

export async function listPlatformListings(workspace, { platform = null, roleId = null, policy = null } = {}) {
  const root = await resolveWorkspace(workspace);
  if (platform !== null) validatePlatform(platform);
  if (roleId !== null) validateRoleId(roleId);
  if (policy !== null && !LISTING_POLICIES.includes(policy)) {
    throw failure('LISTINGS_INVALID', `无效策略筛选：${policy}`);
  }
  const loaded = await readSafeListingsFile(root);
  let listings = loaded.value.listings;
  if (platform !== null) listings = listings.filter(item => item.platform === platform);
  if (roleId !== null) listings = listings.filter(item => item.roleIds.includes(roleId));
  if (policy !== null) listings = listings.filter(item => item.policy === policy);
  return {
    status: loaded.status,
    revision: loaded.revision,
    path: LISTINGS_RELATIVE,
    listings,
    summary: {
      total: loaded.value.listings.length,
      active: loaded.value.listings.filter(item => item.policy === 'active').length,
      inboundOnly: loaded.value.listings.filter(item => item.policy === 'inbound_only').length,
      paused: loaded.value.listings.filter(item => item.policy === 'paused').length,
      ignored: loaded.value.listings.filter(item => item.policy === 'ignore').length
    }
  };
}

export async function resolvePlatformListing(workspace, query) {
  const root = await resolveWorkspace(workspace);
  const loaded = await readSafeListingsFile(root);
  let rows = [];
  const context = await readSource(root, 'CONTEXT.md');
  if (context.status === 'ok') {
    try { rows = readRoleTable(context.text).rows; } catch { rows = []; }
  }
  return {
    status: loaded.status,
    revision: loaded.revision,
    ...resolveListingTarget(loaded.value, query, rows)
  };
}

export async function upsertPlatformListing({ workspace, listing, expectedRevision }) {
  if (!isValidRevision(expectedRevision)) {
    throw failure('LISTINGS_INPUT_INVALID', 'expectedRevision 必须为 64 位 SHA-256 十六进制字符串或 null');
  }
  const root = await resolveWorkspace(workspace);
  return withContextLock(root, async lockDir => {
    const context = await readContextRoleTable(root);
    if (!context.hasRoleIdCol) {
      throw failure('LISTINGS_REQUIRE_ROLE_ID', 'CONTEXT.md 岗位表尚未升级到含 role_id 的 7 列结构，请先运行 workspace.mjs migrate', 422);
    }
    const current = await readSafeListingsFile(root);
    if (current.revision !== expectedRevision) {
      throw failure('LISTINGS_CONFLICT', '外部职位路由表已被修改，请重新读取最新 revision 后保存', 409);
    }
    const outcome = applyListingUpsert(current.value, listing, context.roleIdSet);
    if (!outcome.changed) {
      return { changed: false, revision: current.revision, backup: null, listing: outcome.listing, listings: outcome.config.listings };
    }
    const nextText = `${JSON.stringify(outcome.config, null, 2)}\n`;
    const latestContext = await readContextRoleTable(root);
    if (latestContext.revision !== context.revision) {
      throw failure('CONTEXT_CONFLICT', '保存前检测到 CONTEXT.md 变化，请重新读取后保存', 409);
    }
    const latest = await readSafeListingsFile(root);
    if (latest.revision !== expectedRevision) {
      throw failure('LISTINGS_CONFLICT', '保存前检测到外部职位路由表变化，请重新读取后保存', 409);
    }
    const saved = await writeAtomicWithBackup(root, lockDir, current, nextText);
    return { changed: true, revision: saved.revision, backup: saved.backup, listing: outcome.listing, listings: outcome.config.listings };
  });
}

export async function removePlatformListing({ workspace, platform, externalJobId, expectedRevision }) {
  if (!isValidRevision(expectedRevision)) {
    throw failure('LISTINGS_INPUT_INVALID', 'expectedRevision 必须为 64 位 SHA-256 十六进制字符串或 null');
  }
  const root = await resolveWorkspace(workspace);
  return withContextLock(root, async lockDir => {
    const current = await readSafeListingsFile(root);
    if (current.status === 'missing') {
      throw failure('LISTING_NOT_FOUND', `未找到平台职位绑定：${platform}:${externalJobId}`, 404);
    }
    if (current.revision !== expectedRevision) {
      throw failure('LISTINGS_CONFLICT', '外部职位路由表已被修改，请重新读取最新 revision 后保存', 409);
    }
    const outcome = applyListingRemove(current.value, platform, externalJobId);
    const nextText = `${JSON.stringify(outcome.config, null, 2)}\n`;
    const latest = await readSafeListingsFile(root);
    if (latest.revision !== expectedRevision) {
      throw failure('LISTINGS_CONFLICT', '保存前检测到外部职位路由表变化，请重新读取后保存', 409);
    }
    const saved = await writeAtomicWithBackup(root, lockDir, current, nextText);
    return { changed: true, revision: saved.revision, backup: saved.backup, removed: outcome.removed, listings: outcome.config.listings };
  });
}

/**
 * Fail-closed validator shared by both `listings.mjs validate` and `workspace.mjs validate`.
 */
export async function validatePlatformListings(workspace) {
  const root = await resolveWorkspace(workspace);
  const errors = [];
  const warnings = [];
  let loaded;
  try {
    loaded = await readSafeListingsFile(root);
  } catch (error) {
    errors.push({ code: error.code ?? 'LISTINGS_INVALID', message: error.message, path: LISTINGS_RELATIVE });
    return { ok: false, status: 'error', revision: error.revision ?? null, errors, warnings, count: 0, ignoredCount: 0 };
  }
  if (loaded.status === 'missing') {
    return { ok: true, status: 'missing', revision: null, errors: [], warnings: [], count: 0, ignoredCount: 0 };
  }

  let context;
  try {
    context = await readContextRoleTable(root);
  } catch (error) {
    errors.push({ code: error.code ?? 'CONTEXT_UNREADABLE', message: error.message, path: 'CONTEXT.md' });
    return { ok: false, status: 'error', revision: loaded.revision, errors, warnings, count: loaded.value.listings.length, ignoredCount: loaded.value.listings.filter(item => item.policy === 'ignore').length };
  }

  if (!context.hasRoleIdCol) {
    errors.push({
      code: 'LISTINGS_REQUIRE_ROLE_ID',
      message: '已配置 _shared/listings.json，但 CONTEXT.md 岗位表缺少 role_id 列，请先运行 workspace.mjs migrate',
      path: LISTINGS_RELATIVE
    });
  } else {
    const rowByRoleId = new Map(context.rows.filter(row => row.roleId).map(row => [row.roleId, row]));
    for (const listing of loaded.value.listings) {
      const key = `${listing.platform}:${listing.externalJobId}`;
      for (const roleId of listing.roleIds) {
        const row = rowByRoleId.get(roleId);
        if (!row) {
          errors.push({
            code: 'LISTING_DANGLING_ROLE_ID',
            message: `平台职位 ${key} 引用了 CONTEXT.md 中不存在的 role_id：${roleId}`,
            path: LISTINGS_RELATIVE,
            platform: listing.platform,
            externalJobId: listing.externalJobId,
            roleId
          });
        } else if ((listing.policy === 'active' || listing.policy === 'inbound_only') && row.status !== '在招') {
          warnings.push({
            code: 'LISTING_ROLE_INACTIVE',
            message: `平台职位 ${key}（策略 ${listing.policy}）指向非在招岗位 ${roleId}（${row.name}，当前状态：${row.status ?? '空'}）`,
            path: LISTINGS_RELATIVE,
            platform: listing.platform,
            externalJobId: listing.externalJobId,
            roleId,
            status: row.status
          });
        }
      }
    }
  }

  return {
    ok: errors.length === 0,
    status: errors.length === 0 ? 'ok' : 'error',
    revision: loaded.revision,
    errors,
    warnings,
    count: loaded.value.listings.length,
    ignoredCount: loaded.value.listings.filter(item => item.policy === 'ignore').length
  };
}

async function readInputJSON(flags) {
  if (flags.input !== undefined && flags['input-file'] !== undefined) {
    throw failure('LISTINGS_INPUT_INVALID', '--input 与 --input-file 只能提供一个');
  }
  if (flags.input !== undefined) {
    try { return JSON.parse(flags.input); }
    catch { throw failure('LISTINGS_INPUT_INVALID', '--input 不是有效的 JSON'); }
  }
  if (flags['input-file'] !== undefined) {
    const root = await resolveWorkspace(flags.workspace);
    const real = await realpath(path.resolve(flags['input-file'])).catch(() => {
      throw failure('LISTINGS_INPUT_INVALID', '无法读取 --input-file');
    });
    if (!insideWorkspace(root, real)) throw failure('LISTINGS_UNSAFE', '--input-file 必须位于工作区内', 403);
    const bytes = await readFile(real);
    if (bytes.length > MAX_FILE_BYTES) throw failure('LISTINGS_TOO_LARGE', '--input-file 超过读取上限', 422);
    try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
    catch { throw failure('LISTINGS_INPUT_INVALID', '--input-file 不是有效的 UTF-8 JSON'); }
  }
  throw failure('LISTINGS_INPUT_INVALID', '必须提供 --input 或 --input-file 参数');
}

const commandSpecs = {
  list: { required: ['workspace'], optional: ['platform', 'role-id', 'policy'] },
  resolve: { required: ['workspace'], optional: ['platform', 'external-job-id', 'role-id'] },
  upsert: { required: ['workspace'], optional: ['input', 'input-file'] },
  remove: { required: ['workspace'], optional: ['input', 'input-file'] },
  validate: { required: ['workspace'], optional: [] }
};

export async function listingsCLI(argv) {
  const [command, ...args] = argv;
  const spec = Object.hasOwn(commandSpecs, command) ? commandSpecs[command] : null;
  if (!spec) {
    throw failure('LISTINGS_INPUT_INVALID', '用法：listings.mjs list/resolve/upsert/remove/validate --workspace <目录> ...');
  }
  const allowed = new Set([...spec.required, ...spec.optional]);
  const flags = {};
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index], value = args[index + 1];
    if (!flag?.startsWith('--')) throw failure('LISTINGS_INPUT_INVALID', `无效参数：${flag ?? ''}`);
    const key = flag.slice(2);
    if (!allowed.has(key) || Object.hasOwn(flags, key) || value === undefined || value.startsWith('--')) {
      throw failure('LISTINGS_INPUT_INVALID', `参数无效、重复或缺少值：${flag}`);
    }
    flags[key] = value;
  }
  for (const key of spec.required) {
    if (!Object.hasOwn(flags, key)) throw failure('LISTINGS_INPUT_INVALID', `缺少必填参数：--${key}`);
  }

  if (command === 'list') {
    return listPlatformListings(flags.workspace, {
      platform: flags.platform ?? null,
      roleId: flags['role-id'] ?? null,
      policy: flags.policy ?? null
    });
  }
  if (command === 'resolve') {
    return resolvePlatformListing(flags.workspace, {
      ...(flags.platform !== undefined ? { platform: flags.platform } : {}),
      ...(flags['external-job-id'] !== undefined ? { externalJobId: flags['external-job-id'] } : {}),
      ...(flags['role-id'] !== undefined ? { roleId: flags['role-id'] } : {})
    });
  }
  if (command === 'validate') {
    return validatePlatformListings(flags.workspace);
  }
  const payload = await readInputJSON(flags);
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw failure('LISTINGS_INPUT_INVALID', '输入 JSON 必须为对象');
  }
  if (command === 'upsert') {
    return upsertPlatformListing({ workspace: flags.workspace, listing: payload.listing, expectedRevision: payload.expectedRevision });
  }
  return removePlatformListing({ workspace: flags.workspace, platform: payload.platform, externalJobId: payload.externalJobId, expectedRevision: payload.expectedRevision });
}

export function listingsError(error) {
  return {
    error: {
      code: typeof error.code === 'string' && /^[A-Z_]+$/.test(error.code) ? error.code : 'LISTINGS_FAILED',
      message: error.status || error.code?.startsWith('LISTING') || error.code?.startsWith('ROLE_') || error.code?.startsWith('CONTEXT_')
        ? error.message
        : '外部职位路由表操作失败，请检查工作区文件和权限'
    }
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const result = await listingsCLI(process.argv.slice(2));
    process.stdout.write(`${JSON.stringify(result)}\n`);
    if (process.argv[2] === 'validate' && result && result.ok === false) {
      process.exitCode = 1;
    }
  } catch (error) {
    process.stderr.write(`${JSON.stringify(listingsError(error))}\n`);
    process.exitCode = 1;
  }
}
