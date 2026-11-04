import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readFile, realpath, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { readCandidates, readConfig, readRoles, SCHEMA_VERSION } from '../model.mjs';
import { insideWorkspace, MAX_FILE_BYTES, readSource, resolveWorkspace } from './reader.mjs';

export const ROLE_STATUSES = Object.freeze(['在招', '已下架', '已关闭', '暂停', '待核']);
export const contextRevision = bytes => createHash('sha256').update(bytes).digest('hex');
const failure = (code, message, status = 400) => Object.assign(new Error(message), { code, status });
const cellText = value => value.trim().replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').replace(/[*`]/g, '').trim();

function decodeContext(bytes) {
  let encoding = 'utf8', bom = Buffer.alloc(0), body = bytes;
  if (bytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]))) { bom = bytes.subarray(0, 3); body = bytes.subarray(3); }
  else if (bytes.subarray(0, 2).equals(Buffer.from([0xff, 0xfe]))) { encoding = 'utf16le'; bom = bytes.subarray(0, 2); body = bytes.subarray(2); }
  else if (bytes.subarray(0, 2).equals(Buffer.from([0xfe, 0xff]))) { encoding = 'utf16be'; bom = bytes.subarray(0, 2); body = bytes.subarray(2); }
  try {
    const text = new TextDecoder({ utf8: 'utf-8', utf16le: 'utf-16le', utf16be: 'utf-16be' }[encoding], { fatal: true, ignoreBOM: true }).decode(body);
    return { text, encode: next => {
      const output = Buffer.from(next, encoding === 'utf8' ? 'utf8' : 'utf16le');
      if (encoding === 'utf16be') output.swap16();
      return Buffer.concat([bom, output]);
    } };
  } catch { throw failure('CONTEXT_ENCODING', '岗位配置编码无法安全保留，请使用有效的 UTF-8 或带 BOM 的 UTF-16 文本'); }
}

export function replaceRoleStatus(text, role, status) {
  if (!ROLE_STATUSES.includes(status)) throw failure('ROLE_STATUS_INVALID', '岗位状态仅支持在招、已下架、已关闭、暂停或待核');
  const configured = readRoles(text);
  if (!configured.some(item => item.name === role)) throw failure('ROLE_NOT_CONFIGURED', '只能调整当前标准岗位表中已配置的岗位', 404);
  let inSection = false, columns = null, offset = 0, headerSeen = false;
  for (const match of text.matchAll(/[^\r\n]*(?:\r\n|\n|\r|$)/g)) {
    const raw = match[0];
    if (!raw) continue;
    const line = raw.replace(/[\r\n]+$/, '');
    const heading = /^(#{1,6})\s+(.+)$/.exec(line);
    if (heading) {
      if (inSection) break;
      inSection = /^(?:[一二三四五六七八九十\d]+[、.．]\s*)?在招岗位与优先级$/.test(heading[2].trim());
    } else if (inSection && line.trim().startsWith('|')) {
      const pipes = [...line.matchAll(/\|/g)].map(item => item.index);
      const hasEnd = line.trimEnd().endsWith('|');
      const ends = hasEnd ? pipes.slice(1) : [...pipes.slice(1), line.length];
      const cells = ends.map((end, index) => ({ start: pipes[index] + 1, end, text: line.slice(pipes[index] + 1, end) }));
      if (!columns) {
        const names = cells.map(cell => cellText(cell.text));
        const found = ['岗位', '优先级', '状态'].map(name => names.indexOf(name));
        if (found.every(index => index >= 0)) { columns = found; headerSeen = true; }
      } else if (headerSeen) {
        if (!cells.every(cell => /^:?-{3,}:?$/.test(cell.text.trim()))) { columns = null; }
        headerSeen = false;
      } else if (cellText(cells[columns[0]]?.text ?? '') === role) {
        const cell = cells[columns[2]];
        const leading = cell.text.match(/^\s*/)[0], trailing = cell.text.slice(leading.length).match(/\s*$/)[0];
        return text.slice(0, offset + cell.start) + leading + status + trailing + text.slice(offset + cell.end);
      }
    } else if (columns && !headerSeen) break;
    offset += raw.length;
  }
  throw failure('ROLE_NOT_CONFIGURED', '未定位到当前标准岗位表的状态单元格', 404);
}

async function contextFile(root) {
  const file = path.join(root, 'CONTEXT.md');
  const info = await lstat(file);
  if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_FILE_BYTES || !insideWorkspace(root, await realpath(file))) throw failure('CONTEXT_UNSAFE', '岗位配置必须是工作区内的普通文本文件');
  const bytes = await readFile(file);
  if (bytes.length > MAX_FILE_BYTES) throw failure('CONTEXT_TOO_LARGE', '岗位配置超过读取上限');
  return { file, info, bytes, ...decodeContext(bytes) };
}

async function configDirectory(root, create = false) {
  const directory = path.join(root, '_shared');
  let info;
  try { info = await lstat(directory); }
  catch (error) {
    if (error.code !== 'ENOENT') throw failure('ROLE_CONFIG_UNREADABLE', '无法读取岗位归并配置目录', 422);
    if (!create) return null;
    await mkdir(directory, { recursive: true });
    info = await lstat(directory);
  }
  if (!info.isDirectory() || info.isSymbolicLink() || !insideWorkspace(root, await realpath(directory))) throw failure('ROLE_CONFIG_UNSAFE', '岗位归并配置目录必须位于工作区内');
  return directory;
}

async function roleConfig(root, configured) {
  const file = path.join(root, '_shared/recruit-board.config.json');
  const value = { schemaVersion: SCHEMA_VERSION, statusStages: {}, roleAliases: {} };
  const missing = { file, bytes: null, info: null, value, parsed: readConfig(JSON.stringify(value), configured), revision: null, status: 'missing', encode: text => Buffer.from(text) };
  if (!await configDirectory(root)) return missing;
  let info;
  try { info = await lstat(file); }
  catch (error) {
    if (error.code === 'ENOENT') return missing;
    throw failure('ROLE_CONFIG_UNREADABLE', '无法读取岗位归并配置', 422);
  }
  if (!info.isFile() || info.isSymbolicLink() || !insideWorkspace(root, await realpath(file))) throw failure('ROLE_CONFIG_UNSAFE', '岗位归并配置必须是工作区内的普通文件');
  if (info.size > MAX_FILE_BYTES) throw failure('ROLE_CONFIG_TOO_LARGE', '岗位归并配置超过读取上限', 422);
  let bytes;
  try { bytes = await readFile(file); }
  catch { throw failure('ROLE_CONFIG_UNREADABLE', '无法读取岗位归并配置', 422); }
  if (bytes.length > MAX_FILE_BYTES) throw failure('ROLE_CONFIG_TOO_LARGE', '岗位归并配置超过读取上限', 422);
  const revision = contextRevision(bytes);
  try {
    const decoded = decodeContext(bytes);
    return { file, info, bytes, ...decoded, value: JSON.parse(decoded.text), parsed: readConfig(decoded.text, configured), revision, status: 'ok' };
  } catch { throw Object.assign(failure('ROLE_CONFIG_INVALID', '岗位归并配置的编码、JSON 或映射无效，请核对后重试', 422), { revision }); }
}

async function describeRoles(root, context, config) {
  const configured = readRoles(context.text);
  const aliases = config.parsed.roleAliases;
  const ledger = await readSource(root, '02-sourcing/dedup-ledger.csv');
  const names = new Set(configured.map(role => role.name));
  const counts = new Map();
  let ledgerStatus = ledger.status;
  if (ledger.status === 'ok') {
    try {
      for (const candidate of readCandidates(ledger.text).candidates) {
        if (!names.has(candidate.rawRole) && !Object.hasOwn(aliases, candidate.rawRole)) counts.set(candidate.rawRole, (counts.get(candidate.rawRole) ?? 0) + 1);
      }
    } catch { ledgerStatus = 'error'; counts.clear(); }
  }
  return {
    contextRevision: contextRevision(context.bytes), roles: configured, allowedStatuses: [...ROLE_STATUSES],
    unconfiguredRoles: [...counts].map(([name, count]) => ({ name, count })), roleAliases: aliases,
    configRevision: config.revision, configStatus: config.status, ledgerStatus
  };
}

export async function readRoleInfo(workspace) {
  const root = await resolveWorkspace(workspace);
  const context = await contextFile(root);
  let config;
  try { config = await roleConfig(root, readRoles(context.text)); }
  catch (error) { config = { status: 'error', revision: error.revision ?? null, parsed: { roleAliases: {} } }; }
  return describeRoles(root, context, config);
}

async function controlDirectory(root) {
  let directory = root;
  for (const name of ['runtime', 'recruit-board', 'roles']) {
    directory = path.join(directory, name);
    await mkdir(directory, { recursive: true });
    directory = await realpath(directory);
    if (!insideWorkspace(root, directory)) throw failure('ROLE_DIRECTORY_UNSAFE', '岗位备份目录不能指向工作区外');
  }
  return directory;
}

export async function setRoleAlias({ workspace, role, target, revision }) {
  const validName = value => typeof value === 'string' && value.length > 0 && value.length <= 300 && value === value.trim() && !/[\u0000-\u001f\u007f]/.test(value);
  if (!validName(role) || (target !== null && !validName(target)) || (revision !== null && (typeof revision !== 'string' || !/^[a-f0-9]{64}$/.test(revision)))) throw failure('ROLE_ALIAS_INPUT_INVALID', '原岗位、目标岗位或配置版本无效');
  const root = await resolveWorkspace(workspace);
  const directory = await controlDirectory(root);
  const lockFile = path.join(directory, 'context.lock');
  let lock;
  try { lock = await open(lockFile, 'wx'); }
  catch (error) {
    if (error.code === 'EEXIST') throw failure('ROLE_LOCKED', '岗位配置正在修改或仍有写入锁，请确认后重试', 409);
    throw error;
  }
  let temporary;
  try {
    const context = await contextFile(root);
    const configured = readRoles(context.text);
    const config = await roleConfig(root, configured);
    if (config.revision !== revision) throw failure('CONFIG_CONFLICT', '岗位归并配置已被修改，请重新读取后保存', 409);
    const info = await describeRoles(root, context, config);
    if (configured.some(item => item.name === role)) throw failure('ROLE_ALIAS_CONFIGURED', '正式岗位不能被别名覆盖，请在岗位状态管理中调整');
    if (target !== null && (!configured.some(item => item.name === target) || Object.hasOwn(config.parsed.roleAliases, target))) throw failure('ROLE_ALIAS_TARGET_INVALID', '归并目标必须是正式岗位，且不能形成链或循环');
    const exists = Object.hasOwn(config.parsed.roleAliases, role);
    if (!exists) {
      if (info.ledgerStatus !== 'ok') throw failure('ROLE_LEDGER_UNREADABLE', '台账未成功读取，无法核对原岗位名称', 422);
      if (!info.unconfiguredRoles.some(item => item.name === role)) throw failure('ROLE_ALIAS_NOT_FOUND', '未找到待归并的台账原岗位名称', 404);
    }
    if ((!exists && target === null) || (exists && config.parsed.roleAliases[role] === target)) return { ...info, changed: false, role, target, backup: null };
    const entries = Object.entries(config.value.roleAliases).filter(([raw]) => raw.trim() !== role);
    if (target !== null) entries.push([role, target]);
    const value = { ...config.value, roleAliases: Object.fromEntries(entries) };
    const next = JSON.stringify(value, null, 2) + '\n';
    let parsed;
    try { parsed = readConfig(next, configured); }
    catch { throw failure('ROLE_ALIAS_TARGET_INVALID', '岗位归并结果无效，目标须为正式岗位且不得形成链或循环'); }
    const bytes = config.encode(next);
    if (bytes.length > MAX_FILE_BYTES) throw failure('ROLE_CONFIG_TOO_LARGE', '岗位归并配置超过读取上限', 422);
    await configDirectory(root, true);
    let backup = null;
    if (config.bytes !== null) {
      backup = path.join(directory, `recruit-board.config-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID()}.json`);
      const saved = await open(backup, 'wx');
      try { await saved.writeFile(config.bytes); await saved.sync(); }
      finally { await saved.close(); }
    }
    temporary = path.join(root, '_shared', `.recruit-board.config-${randomUUID()}.tmp`);
    const output = await open(temporary, 'wx', config.info ? config.info.mode & 0o777 : 0o600);
    try { await output.writeFile(bytes); await output.sync(); }
    finally { await output.close(); }
    const currentContext = await contextFile(root);
    if (contextRevision(currentContext.bytes) !== info.contextRevision) throw failure('CONTEXT_CONFLICT', '保存前检测到正式岗位配置变化，请重新读取后保存', 409);
    const current = await roleConfig(root, configured);
    if (current.revision !== revision) throw failure('CONFIG_CONFLICT', '保存前检测到岗位归并配置变化，请重新读取后保存', 409);
    await rename(temporary, config.file);
    const nextInfo = await describeRoles(root, context, { revision: contextRevision(bytes), status: 'ok', parsed });
    return { ...nextInfo, changed: true, role, target, backup: backup ? path.relative(root, backup).split(path.sep).join('/') : null };
  } finally {
    if (temporary) await rm(temporary, { force: true });
    await lock.close();
    await rm(lockFile);
  }
}

export async function setRoleStatus({ workspace, role, status, revision }) {
  if (typeof role !== 'string' || !role.trim() || role !== role.trim() || role.length > 300 || !ROLE_STATUSES.includes(status) || typeof revision !== 'string' || !/^[a-f0-9]{64}$/.test(revision)) throw failure('ROLE_INPUT_INVALID', '岗位、状态或配置版本无效');
  const root = await resolveWorkspace(workspace);
  const directory = await controlDirectory(root);
  const lockFile = path.join(directory, 'context.lock');
  let lock;
  try { lock = await open(lockFile, 'wx'); }
  catch (error) {
    if (error.code === 'EEXIST') throw failure('ROLE_LOCKED', '岗位配置正在修改或仍有写入锁，请确认后重试', 409);
    throw error;
  }
  let temporary;
  try {
    const context = await contextFile(root);
    if (contextRevision(context.bytes) !== revision) throw failure('CONTEXT_CONFLICT', '岗位配置已被修改，请重新读取后保存', 409);
    const next = replaceRoleStatus(context.text, role, status);
    if (next === context.text) return { changed: false, role, status, backup: null, contextRevision: revision, roles: readRoles(next), allowedStatuses: [...ROLE_STATUSES] };
    const backup = path.join(directory, `CONTEXT-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID()}.md`);
    const saved = await open(backup, 'wx');
    try { await saved.writeFile(context.bytes); await saved.sync(); }
    finally { await saved.close(); }
    temporary = path.join(root, `.CONTEXT-${randomUUID()}.tmp`);
    const output = await open(temporary, 'wx', context.info.mode & 0o777);
    const bytes = context.encode(next);
    try { await output.writeFile(bytes); await output.sync(); }
    finally { await output.close(); }
    const current = await contextFile(root);
    if (contextRevision(current.bytes) !== revision) throw failure('CONTEXT_CONFLICT', '保存前检测到岗位配置变化，请重新读取后保存', 409);
    await rename(temporary, context.file);
    return { changed: true, role, status, backup: path.relative(root, backup).split(path.sep).join('/'), contextRevision: contextRevision(bytes), roles: readRoles(next), allowedStatuses: [...ROLE_STATUSES] };
  } finally {
    if (temporary) await rm(temporary, { force: true });
    await lock.close();
    await rm(lockFile);
  }
}
