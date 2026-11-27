import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readFile, realpath, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { readConfig, readRoles, SCHEMA_VERSION } from '../model.mjs';
import {
  applyListingRemove,
  applyListingUpsert,
  applyRoleRemove,
  applyRoleUpsert,
  buildAliasMap,
  diffWithContextRoles,
  emptyRoleRegistry,
  generateRoleId,
  resolveRoleTarget,
  ROLE_STATUSES,
  validateRoleRegistry
} from '../role-registry-domain.mjs';
import { insideWorkspace, MAX_FILE_BYTES, readSource, resolveWorkspace } from './reader.mjs';
import { withItemLock } from './storage.mjs';

const REGISTRY_RELATIVE = '_shared/roles.json';
const CONFIG_RELATIVE = '_shared/recruit-board.config.json';
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const failure = (code, message, status = 400) => Object.assign(new Error(message), { code, status });
const isValidRevision = value => value === null || (typeof value === 'string' && /^[a-f0-9]{64}$/.test(value));

async function ensureDirectory(root, segments, create = false) {
  let current = root;
  for (const segment of segments) {
    current = path.join(current, segment);
    let info;
    try { info = await lstat(current); }
    catch (error) {
      if (error.code !== 'ENOENT') throw failure('ROLE_REGISTRY_UNREADABLE', '无法访问工作区目录', 422);
      if (!create) return null;
      await mkdir(current, { recursive: true });
      info = await lstat(current);
    }
    if (!info.isDirectory() || info.isSymbolicLink() || !insideWorkspace(root, await realpath(current))) {
      throw failure('ROLE_REGISTRY_UNSAFE', '目标目录必须位于工作区内且不能为符号链接', 403);
    }
  }
  return current;
}

async function readSafeFile(root, relative, missingCode = null) {
  const file = path.join(root, relative);
  let info;
  try { info = await lstat(file); }
  catch (error) {
    if (error.code === 'ENOENT') {
      if (missingCode) throw failure(missingCode, `未找到文件：${relative}`, 404);
      return { file, status: 'missing', bytes: null, text: null, revision: null, info: null };
    }
    throw failure('ROLE_REGISTRY_UNREADABLE', `无法读取文件：${relative}`, 422);
  }
  if (!info.isFile() || info.isSymbolicLink() || !insideWorkspace(root, await realpath(file))) {
    throw failure('ROLE_REGISTRY_UNSAFE', `文件必须位于工作区内且不能为符号链接：${relative}`, 403);
  }
  if (info.size > MAX_FILE_BYTES) throw failure('ROLE_REGISTRY_TOO_LARGE', `文件超过读取上限：${relative}`, 422);
  const bytes = await readFile(file);
  if (bytes.length > MAX_FILE_BYTES) throw failure('ROLE_REGISTRY_TOO_LARGE', `文件超过读取上限：${relative}`, 422);
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { throw failure('ROLE_REGISTRY_ENCODING', `文件不是有效的 UTF-8 文本：${relative}`, 422); }
  return { file, status: 'ok', bytes, text, revision: digest(bytes), info };
}

async function loadRegistry(root) {
  const loaded = await readSafeFile(root, REGISTRY_RELATIVE);
  if (loaded.status === 'missing') {
    return { ...loaded, value: emptyRoleRegistry() };
  }
  let parsed;
  try { parsed = JSON.parse(loaded.text.replace(/^\uFEFF/, '')); }
  catch { throw Object.assign(failure('ROLE_REGISTRY_INVALID', '岗位注册表不是有效的 JSON', 422), { revision: loaded.revision }); }
  try {
    return { ...loaded, value: validateRoleRegistry(parsed) };
  } catch (error) {
    throw Object.assign(failure(error.code ?? 'ROLE_REGISTRY_INVALID', error.message, 422), { revision: loaded.revision });
  }
}

async function writeAtomicWithBackup(root, targetFile, previous, nextText, backupPrefix, lockDir) {
  const bytes = Buffer.from(nextText, 'utf8');
  if (bytes.length > MAX_FILE_BYTES) throw failure('ROLE_REGISTRY_TOO_LARGE', '保存内容超过读取上限', 422);
  await ensureDirectory(root, ['_shared'], true);
  let backup = null;
  if (previous.bytes !== null) {
    backup = path.join(lockDir, `${backupPrefix}-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID()}.json`);
    const saved = await open(backup, 'wx');
    try { await saved.writeFile(previous.bytes); await saved.sync(); }
    finally { await saved.close(); }
  }
  const temporary = path.join(path.dirname(targetFile), `.${path.basename(targetFile)}-${randomUUID()}.tmp`);
  try {
    const output = await open(temporary, 'wx', previous.info ? previous.info.mode & 0o777 : 0o600);
    try { await output.writeFile(bytes); await output.sync(); }
    finally { await output.close(); }
    await rename(temporary, targetFile);
  } finally {
    await rm(temporary, { force: true });
  }
  return {
    revision: digest(bytes),
    backup: backup ? path.relative(root, backup).split(path.sep).join('/') : null
  };
}

async function withRegistryMutation(workspace, expectedRevision, mutator) {
  if (!isValidRevision(expectedRevision)) {
    throw failure('ROLE_REGISTRY_INPUT_INVALID', 'expectedRevision 必须为 64 位 SHA-256 十六进制字符串或 null');
  }
  const root = await resolveWorkspace(workspace);
  const lockDir = await ensureDirectory(root, ['runtime', 'recruit-board', 'roles'], true);
  return withItemLock(lockDir, 'role-registry', async () => {
    const current = await loadRegistry(root);
    if (current.revision !== expectedRevision) {
      throw failure('REGISTRY_CONFLICT', '岗位注册表已被修改，请重新读取最新 revision 后保存', 409);
    }
    const outcome = await mutator(current.value, { root, current });
    if (!outcome.changed) {
      return {
        changed: false,
        revision: current.revision,
        backup: null,
        registry: outcome.registry,
        ...outcome.extra
      };
    }
    const nextText = `${JSON.stringify(outcome.registry, null, 2)}\n`;
    const latest = await readSafeFile(root, REGISTRY_RELATIVE);
    if (latest.revision !== expectedRevision) {
      throw failure('REGISTRY_CONFLICT', '保存前检测到岗位注册表变化，请重新读取后保存', 409);
    }
    const saved = await writeAtomicWithBackup(root, current.file, current, nextText, 'roles', lockDir);
    return {
      changed: true,
      revision: saved.revision,
      backup: saved.backup,
      registry: outcome.registry,
      ...outcome.extra
    };
  });
}

export async function readRoleRegistry(workspace, { owner = null, status = null, platform = null } = {}) {
  const root = await resolveWorkspace(workspace);
  const loaded = await loadRegistry(root);
  let roles = loaded.value.roles;
  if (owner) roles = roles.filter(role => role.owner === owner);
  if (status) roles = roles.filter(role => role.status === status);
  const roleIdSet = new Set(roles.map(role => role.id));
  let listings = loaded.value.listings;
  if (platform) listings = listings.filter(item => item.platform === platform);
  if (owner || status) {
    listings = listings.filter(item => item.roleIds.some(id => roleIdSet.has(id)));
  }
  return {
    status: loaded.status,
    revision: loaded.revision,
    path: REGISTRY_RELATIVE,
    roles,
    listings,
    summary: {
      totalRoles: loaded.value.roles.length,
      totalListings: loaded.value.listings.length,
      ignoredListings: loaded.value.listings.filter(item => item.policy === 'ignore').length
    }
  };
}

export async function initRoleRegistry({ workspace, merge = false } = {}) {
  const root = await resolveWorkspace(workspace);
  const lockDir = await ensureDirectory(root, ['runtime', 'recruit-board', 'roles'], true);
  return withItemLock(lockDir, 'role-registry', async () => {
    const existing = await loadRegistry(root);
    if (existing.status === 'ok' && !merge) {
      throw failure('REGISTRY_EXISTS', '岗位注册表 _shared/roles.json 已存在；如需增量导入新岗位请传 --merge', 409);
    }
    const contextSource = await readSource(root, 'CONTEXT.md');
    if (contextSource.status !== 'ok') {
      throw failure('CONTEXT_UNREADABLE', '无法读取 CONTEXT.md，无法初始化岗位注册表', 422);
    }
    let contextRoles;
    try { contextRoles = readRoles(contextSource.text); }
    catch (error) { throw failure('ROLES_UNCONFIGURED', error.message, 422); }

    const aliasByTarget = new Map();
    const configSource = await readSource(root, CONFIG_RELATIVE);
    if (configSource.status === 'ok') {
      try {
        const parsedConfig = readConfig(configSource.text, contextRoles);
        for (const [alias, target] of Object.entries(parsedConfig.roleAliases)) {
          if (!aliasByTarget.has(target)) aliasByTarget.set(target, []);
          aliasByTarget.get(target).push(alias);
        }
      } catch {
        // Ignore invalid legacy config during bootstrap; validate command surfaces config issues explicitly.
      }
    }

    const base = existing.status === 'ok' ? existing.value : emptyRoleRegistry();
    const existingByName = new Map(base.roles.map(role => [role.name, role]));
    const usedIds = new Set(base.roles.map(role => role.id));
    const nextRoles = [...base.roles];
    const added = [];

    for (const ctxRole of contextRoles) {
      if (existingByName.has(ctxRole.name)) continue;
      const id = generateRoleId(ctxRole.name, usedIds);
      usedIds.add(id);
      const role = { id, name: ctxRole.name };
      if (ctxRole.priority) role.priority = ctxRole.priority;
      if (ctxRole.status && ROLE_STATUSES.includes(ctxRole.status)) role.status = ctxRole.status;
      const importedAliases = (aliasByTarget.get(ctxRole.name) ?? []).filter(alias => alias !== id && alias !== ctxRole.name);
      if (importedAliases.length) role.aliases = importedAliases;
      nextRoles.push(role);
      added.push(role);
    }

    const nextRegistry = validateRoleRegistry({ ...base, roles: nextRoles });
    if (existing.status === 'ok' && added.length === 0) {
      return { changed: false, revision: existing.revision, backup: null, added: [], registry: existing.value };
    }
    const saved = await writeAtomicWithBackup(root, existing.file, existing, `${JSON.stringify(nextRegistry, null, 2)}\n`, 'roles', lockDir);
    return { changed: true, revision: saved.revision, backup: saved.backup, added, registry: nextRegistry };
  });
}

export async function resolveRoleRegistry(workspace, query) {
  const root = await resolveWorkspace(workspace);
  const loaded = await loadRegistry(root);
  if (loaded.status === 'missing') {
    throw failure('ROLE_REGISTRY_MISSING', '岗位注册表 _shared/roles.json 尚未初始化', 404);
  }
  return {
    revision: loaded.revision,
    ...resolveRoleTarget(loaded.value, query)
  };
}

export async function upsertRole({ workspace, role, expectedRevision }) {
  return withRegistryMutation(workspace, expectedRevision, registry => {
    const outcome = applyRoleUpsert(registry, role);
    return { changed: outcome.changed, registry: outcome.registry, extra: { role: outcome.role } };
  });
}

export async function removeRole({ workspace, roleId, expectedRevision }) {
  return withRegistryMutation(workspace, expectedRevision, registry => {
    const outcome = applyRoleRemove(registry, roleId);
    return { changed: outcome.changed, registry: outcome.registry, extra: { removed: outcome.removed } };
  });
}

export async function upsertListing({ workspace, listing, expectedRevision }) {
  return withRegistryMutation(workspace, expectedRevision, registry => {
    const outcome = applyListingUpsert(registry, listing);
    return { changed: outcome.changed, registry: outcome.registry, extra: { listing: outcome.listing } };
  });
}

export async function removeListing({ workspace, platform, externalJobId, expectedRevision }) {
  return withRegistryMutation(workspace, expectedRevision, registry => {
    const outcome = applyListingRemove(registry, platform, externalJobId);
    return { changed: outcome.changed, registry: outcome.registry, extra: { removed: outcome.removed } };
  });
}

export async function validateRoleRegistryWorkspace(workspace) {
  const root = await resolveWorkspace(workspace);
  const loaded = await loadRegistry(root);
  if (loaded.status === 'missing') {
    return { status: 'missing', valid: false, revision: null, contextStatus: 'skipped', diff: null, missingAliases: [] };
  }
  const contextSource = await readSource(root, 'CONTEXT.md');
  let contextStatus = contextSource.status;
  let contextRoles = null;
  let diff = null;
  if (contextSource.status === 'ok') {
    try {
      contextRoles = readRoles(contextSource.text);
      diff = diffWithContextRoles(loaded.value, contextRoles);
    } catch {
      contextStatus = 'error';
    }
  }
  const expectedAliases = buildAliasMap(loaded.value, contextRoles ? new Set(contextRoles.map(role => role.name)) : null);
  const configSource = await readSource(root, CONFIG_RELATIVE);
  let currentAliases = {};
  let configStatus = configSource.status;
  if (configSource.status === 'ok' && contextRoles) {
    try { currentAliases = readConfig(configSource.text, contextRoles).roleAliases; }
    catch { configStatus = 'error'; }
  }
  const missingAliases = Object.entries(expectedAliases)
    .filter(([alias, target]) => currentAliases[alias] !== target)
    .map(([alias, target]) => ({ alias, target, current: currentAliases[alias] ?? null }));

  return {
    status: 'ok',
    valid: true,
    revision: loaded.revision,
    contextStatus,
    configStatus,
    diff,
    missingAliases
  };
}

export async function syncRegistryAliases({ workspace, expectedConfigRevision = undefined } = {}) {
  const root = await resolveWorkspace(workspace);
  const lockDir = await ensureDirectory(root, ['runtime', 'recruit-board', 'roles'], true);
  return withItemLock(lockDir, 'role-registry-sync', async () => {
    const loaded = await loadRegistry(root);
    if (loaded.status === 'missing') {
      throw failure('ROLE_REGISTRY_MISSING', '岗位注册表 _shared/roles.json 尚未初始化', 404);
    }
    const contextSource = await readSource(root, 'CONTEXT.md');
    if (contextSource.status !== 'ok') {
      throw failure('CONTEXT_UNREADABLE', '无法读取 CONTEXT.md，无法核对可同步的正式岗位目标', 422);
    }
    let contextRoles;
    try { contextRoles = readRoles(contextSource.text); }
    catch (error) { throw failure('ROLES_UNCONFIGURED', error.message, 422); }

    const configuredNames = new Set(contextRoles.map(role => role.name));
    const derived = buildAliasMap(loaded.value, configuredNames);
    const existingConfig = await readSafeFile(root, CONFIG_RELATIVE);
    if (expectedConfigRevision !== undefined) {
      if (!isValidRevision(expectedConfigRevision)) {
        throw failure('ROLE_REGISTRY_INPUT_INVALID', 'expectedConfigRevision 必须为 64 位 SHA-256 十六进制字符串或 null');
      }
      if (existingConfig.revision !== expectedConfigRevision) {
        throw failure('CONFIG_CONFLICT', '看板配置文件已被修改，请重新读取后同步', 409);
      }
    }

    let baseConfig = { schemaVersion: SCHEMA_VERSION, statusStages: {}, roleAliases: {} };
    if (existingConfig.status === 'ok') {
      try {
        baseConfig = JSON.parse(existingConfig.text.replace(/^\uFEFF/, ''));
        readConfig(existingConfig.text, contextRoles);
      } catch {
        throw failure('ROLE_CONFIG_INVALID', '现有 _shared/recruit-board.config.json 无效，请先修复后再同步', 422);
      }
    }

    const mergedAliases = { ...(baseConfig.roleAliases ?? {}) };
    const synced = [];
    for (const [alias, target] of Object.entries(derived)) {
      if (configuredNames.has(alias)) continue;
      if (mergedAliases[alias] !== target) {
        mergedAliases[alias] = target;
        synced.push({ alias, target });
      }
    }
    if (synced.length === 0) {
      return {
        changed: false,
        configRevision: existingConfig.revision,
        backup: null,
        synced: [],
        roleAliases: mergedAliases
      };
    }
    const nextConfig = { ...baseConfig, schemaVersion: SCHEMA_VERSION, statusStages: baseConfig.statusStages ?? {}, roleAliases: mergedAliases };
    const nextText = `${JSON.stringify(nextConfig, null, 2)}\n`;
    readConfig(nextText, contextRoles);

    const latestConfig = await readSafeFile(root, CONFIG_RELATIVE);
    if (latestConfig.revision !== existingConfig.revision) {
      throw failure('CONFIG_CONFLICT', '保存前检测到看板配置文件变化，请重新读取后同步', 409);
    }
    const saved = await writeAtomicWithBackup(root, existingConfig.file, existingConfig, nextText, 'recruit-board.config', lockDir);
    return {
      changed: true,
      configRevision: saved.revision,
      backup: saved.backup,
      synced,
      roleAliases: mergedAliases
    };
  });
}

async function readInputJSON(flags) {
  if (flags.input !== undefined && flags['input-file'] !== undefined) {
    throw failure('ROLE_REGISTRY_INPUT_INVALID', '--input 与 --input-file 只能提供一个');
  }
  if (flags.input !== undefined) {
    try { return JSON.parse(flags.input); }
    catch { throw failure('ROLE_REGISTRY_INPUT_INVALID', '--input 不是有效的 JSON'); }
  }
  if (flags['input-file'] !== undefined) {
    const root = await resolveWorkspace(flags.workspace);
    const resolved = path.resolve(flags['input-file']);
    const real = await realpath(resolved).catch(() => {
      throw failure('ROLE_REGISTRY_INPUT_INVALID', '无法读取 --input-file');
    });
    if (!insideWorkspace(root, real)) {
      throw failure('ROLE_REGISTRY_UNSAFE', '--input-file 必须位于工作区内', 403);
    }
    const bytes = await readFile(real);
    if (bytes.length > MAX_FILE_BYTES) throw failure('ROLE_REGISTRY_TOO_LARGE', '--input-file 超过读取上限', 422);
    try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
    catch { throw failure('ROLE_REGISTRY_INPUT_INVALID', '--input-file 不是有效的 UTF-8 JSON'); }
  }
  throw failure('ROLE_REGISTRY_INPUT_INVALID', '必须提供 --input 或 --input-file 参数');
}

const commandSpecs = {
  init: { required: ['workspace'], optional: ['merge'], booleanFlags: ['merge'] },
  list: { required: ['workspace'], optional: ['owner', 'status', 'platform'], booleanFlags: [] },
  resolve: { required: ['workspace'], optional: ['platform', 'external-job-id', 'role-id', 'name', 'ats-req-id'], booleanFlags: [] },
  'upsert-role': { required: ['workspace'], optional: ['input', 'input-file'], booleanFlags: [] },
  'remove-role': { required: ['workspace'], optional: ['input', 'input-file'], booleanFlags: [] },
  'upsert-listing': { required: ['workspace'], optional: ['input', 'input-file'], booleanFlags: [] },
  'remove-listing': { required: ['workspace'], optional: ['input', 'input-file'], booleanFlags: [] },
  validate: { required: ['workspace'], optional: [], booleanFlags: [] },
  'sync-aliases': { required: ['workspace'], optional: ['expected-config-revision'], booleanFlags: [] }
};

export async function roleRegistryCLI(argv) {
  const [command, ...args] = argv;
  const spec = Object.hasOwn(commandSpecs, command) ? commandSpecs[command] : null;
  if (!spec) {
    throw failure('ROLE_REGISTRY_INPUT_INVALID', '用法：role-registry.mjs init/list/resolve/upsert-role/remove-role/upsert-listing/remove-listing/validate/sync-aliases --workspace <目录> ...');
  }
  const allowed = new Set([...spec.required, ...spec.optional]);
  const booleans = new Set(spec.booleanFlags);
  const flags = {};
  for (let index = 0; index < args.length; index++) {
    const flag = args[index];
    if (!flag.startsWith('--')) throw failure('ROLE_REGISTRY_INPUT_INVALID', `无效参数：${flag}`);
    const key = flag.slice(2);
    if (!allowed.has(key) || Object.hasOwn(flags, key)) {
      throw failure('ROLE_REGISTRY_INPUT_INVALID', `包含无效或重复参数：${flag}`);
    }
    if (booleans.has(key)) {
      flags[key] = true;
      continue;
    }
    const value = args[++index];
    if (value === undefined || value.startsWith('--')) {
      throw failure('ROLE_REGISTRY_INPUT_INVALID', `参数 ${flag} 缺少值`);
    }
    flags[key] = value;
  }
  for (const key of spec.required) {
    if (!Object.hasOwn(flags, key)) throw failure('ROLE_REGISTRY_INPUT_INVALID', `缺少必填参数：--${key}`);
  }

  if (command === 'init') return initRoleRegistry({ workspace: flags.workspace, merge: Boolean(flags.merge) });
  if (command === 'list') return readRoleRegistry(flags.workspace, { owner: flags.owner ?? null, status: flags.status ?? null, platform: flags.platform ?? null });
  if (command === 'resolve') {
    return resolveRoleRegistry(flags.workspace, {
      ...(flags.platform !== undefined ? { platform: flags.platform } : {}),
      ...(flags['external-job-id'] !== undefined ? { externalJobId: flags['external-job-id'] } : {}),
      ...(flags['role-id'] !== undefined ? { roleId: flags['role-id'] } : {}),
      ...(flags.name !== undefined ? { name: flags.name } : {}),
      ...(flags['ats-req-id'] !== undefined ? { atsRequisitionId: flags['ats-req-id'] } : {})
    });
  }
  if (command === 'validate') return validateRoleRegistryWorkspace(flags.workspace);
  if (command === 'sync-aliases') {
    const expected = flags['expected-config-revision'] === undefined
      ? undefined
      : flags['expected-config-revision'] === 'null' ? null : flags['expected-config-revision'];
    return syncRegistryAliases({ workspace: flags.workspace, expectedConfigRevision: expected });
  }

  const payload = await readInputJSON(flags);
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw failure('ROLE_REGISTRY_INPUT_INVALID', '输入 JSON 必须为对象');
  }
  if (command === 'upsert-role') return upsertRole({ workspace: flags.workspace, role: payload.role, expectedRevision: payload.expectedRevision });
  if (command === 'remove-role') return removeRole({ workspace: flags.workspace, roleId: payload.roleId, expectedRevision: payload.expectedRevision });
  if (command === 'upsert-listing') return upsertListing({ workspace: flags.workspace, listing: payload.listing, expectedRevision: payload.expectedRevision });
  if (command === 'remove-listing') return removeListing({ workspace: flags.workspace, platform: payload.platform, externalJobId: payload.externalJobId, expectedRevision: payload.expectedRevision });
  throw failure('ROLE_REGISTRY_INPUT_INVALID', `未知命令：${command}`);
}

export function roleRegistryError(error) {
  return {
    error: {
      code: typeof error.code === 'string' && /^[A-Z_]+$/.test(error.code) ? error.code : 'ROLE_REGISTRY_FAILED',
      message: error.status || error.code?.startsWith('ROLE_') || error.code?.startsWith('REGISTRY_') || error.code?.startsWith('LISTING_') || error.code?.startsWith('CONTEXT_') || error.code?.startsWith('CONFIG_')
        ? error.message
        : '岗位注册表操作失败，请检查工作区文件和权限'
    }
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try { process.stdout.write(`${JSON.stringify(await roleRegistryCLI(process.argv.slice(2)))}\n`); }
  catch (error) { process.stderr.write(`${JSON.stringify(roleRegistryError(error))}\n`); process.exitCode = 1; }
}
