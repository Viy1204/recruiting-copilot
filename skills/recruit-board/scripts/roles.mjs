import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readFile, realpath, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  KNOWN_ROLE_STATUSES,
  ROLE_ID_PATTERN,
  readCandidates,
  readConfig,
  readRoleTable,
  readRoles,
  SCHEMA_VERSION,
  updateFenceState
} from '../model.mjs';
import { insideWorkspace, MAX_FILE_BYTES, readSource, resolveWorkspace } from './reader.mjs';

export const ROLE_STATUSES = Object.freeze(['在招', '已下架', '已关闭', '暂停', '待核']);
export const contextRevision = bytes => createHash('sha256').update(bytes).digest('hex');
const failure = (code, message, status = 400) => Object.assign(new Error(message), { code, status });
const cellText = value => value.trim().replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').replace(/[*`]/g, '').trim();
const CHANGELOG_HEADER = '# CHANGELOG — 招聘工作区变更日志\n\n';
const PLACEHOLDER_ROLE_RE = /^(?:[（(]?(?:待梳理|待填写|岗位名|role)[）)]?|<role>)$/i;
const CONTROL_CHAR_RE = /[\x00-\x1f\x7f\u0085\p{Zl}\p{Zp}]/u;

function validateSingleLine(value, label, max, { allowPipe = false } = {}) {
  if (typeof value !== 'string' || !value.trim() || value.length > max || CONTROL_CHAR_RE.test(value) || (!allowPipe && value.includes('|'))) {
    throw failure('ROLE_INPUT_INVALID', `${label} 必须为 1–${max} 字符的合法单行文本`);
  }
  return value.trim();
}

function resolveDateStamp(now) {
  const iso = typeof now === 'function' ? now() : (now ?? new Date().toISOString());
  if (typeof iso !== 'string' || !/^\d{4}-\d{2}-\d{2}/.test(iso)) throw failure('ROLE_INPUT_INVALID', '变更日期格式无效');
  return iso.slice(0, 10);
}

function validateRelativeWorkspacePath(root, value, label) {
  if (value === undefined) return undefined;
  if (value === null || value === '—' || value === '-') return null;
  const trimmed = validateSingleLine(value, label, 300);
  if (
    /^[/\\]/.test(trimmed) ||
    /^[a-zA-Z]:/.test(trimmed) ||
    trimmed.includes('://') ||
    trimmed.split(/[/\\]/).includes('..') ||
    path.isAbsolute(trimmed) ||
    path.win32.isAbsolute(trimmed) ||
    path.posix.isAbsolute(trimmed) ||
    !insideWorkspace(root, path.resolve(root, trimmed))
  ) {
    throw failure('ROLE_INPUT_INVALID', `${label} 必须是工作区内的安全相对路径`);
  }
  return trimmed.replaceAll('\\', '/');
}

function findRoleRow(table, roleOrId) {
  return table.rows.find(row => row.name === roleOrId || (row.roleId !== null && row.roleId === roleOrId)) ?? null;
}

function parsePipeCells(line) {
  const pipes = [...line.matchAll(/\|/g)].map(item => item.index);
  const hasEnd = line.trimEnd().endsWith('|');
  const ends = hasEnd ? pipes.slice(1) : [...pipes.slice(1), line.length];
  return ends.map((end, index) => ({ start: pipes[index] + 1, end, text: line.slice(pipes[index] + 1, end) }));
}

const isSeparatorCells = cells => cells.length > 0 && cells.every(cell => /^:?-{3,}:?$/.test(cell.text.trim()));

function parseTableLines(text) {
  const entries = [];
  let offset = 0;
  for (const match of text.matchAll(/[^\r\n]*(?:\r\n|\n|\r|$)/g)) {
    const raw = match[0];
    if (!raw) continue;
    const line = raw.replace(/[\r\n]+$/, '');
    const eol = raw.slice(line.length);
    entries.push({ raw, line, eol, start: offset, end: offset + raw.length });
    offset += raw.length;
  }

  let inSection = false, header = null, separator = null, fence = null;
  let pendingBreak = false;
  const dataRows = [];
  for (let i = 0; i < entries.length; i++) {
    const { raw, line, eol, start, end } = entries[i];
    const nextFence = updateFenceState(line, fence);
    if (fence || nextFence) {
      fence = nextFence;
      if (header && separator) pendingBreak = true;
      continue;
    }
    const heading = /^(#{1,6})\s+(.+)$/.exec(line);
    if (heading) {
      if (inSection) break;
      inSection = /^(?:[一二三四五六七八九十\d]+[、.．]\s*)?在招岗位与优先级$/.test(heading[2].trim());
      continue;
    }
    if (!inSection) continue;
    const trimmed = line.trim();
    if (!trimmed.startsWith('|')) {
      if (header && separator) pendingBreak = true;
      continue;
    }
    const cells = parsePipeCells(line);
    if (!header) {
      const names = cells.map(cell => cellText(cell.text));
      const nameCol = names.indexOf('岗位');
      const priorityCol = names.indexOf('优先级');
      const statusCol = names.indexOf('状态');
      if (nameCol >= 0 && priorityCol >= 0 && statusCol >= 0) {
        const internalArchiveCol = names.indexOf('对内档案');
        header = {
          start,
          end,
          line,
          eol,
          cells,
          names,
          cols: {
            roleId: names.indexOf('role_id'),
            name: nameCol,
            priority: priorityCol,
            status: statusCol,
            jd: names.indexOf('对外 JD'),
            internal: internalArchiveCol >= 0 ? internalArchiveCol : names.indexOf('对内笔记'),
            lastChange: names.indexOf('最近变更')
          }
        };
      }
      continue;
    }
    if (!separator) {
      if (!isSeparatorCells(cells)) {
        header = null;
      } else {
        separator = { start, end, line, eol, cells };
      }
      continue;
    }
    if (pendingBreak) {
      const nextEntry = entries[i + 1];
      if (nextEntry && nextEntry.line.trim().startsWith('|') && isSeparatorCells(parsePipeCells(nextEntry.line))) {
        break;
      }
      if (isSeparatorCells(cells) || cells.length !== header.names.length) {
        continue;
      }
      pendingBreak = false;
    }
    const name = cellText(cells[header.cols.name]?.text ?? '');
    const isPlaceholder = !name || PLACEHOLDER_ROLE_RE.test(name);
    dataRows.push({ start, end, raw, line, eol, cells, name, isPlaceholder });
  }
  if (!header || !separator) throw failure('ROLE_NOT_CONFIGURED', '未定位到当前标准岗位表的状态单元格', 404);
  return { header, separator, dataRows };
}

function applyRowCellEdits(text, rowStart, edits) {
  let updated = text;
  for (const { cell, value } of [...edits].sort((a, b) => b.cell.start - a.cell.start)) {
    const leading = cell.text.match(/^\s*/)[0];
    const trailing = cell.text.slice(leading.length).match(/\s*$/)[0];
    updated = updated.slice(0, rowStart + cell.start) + leading + value + trailing + updated.slice(rowStart + cell.end);
  }
  return updated;
}

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

export function replaceRoleStatus(text, roleOrId, status, { lastChange } = {}) {
  if (!ROLE_STATUSES.includes(status)) throw failure('ROLE_STATUS_INVALID', '岗位状态仅支持在招、已下架、已关闭、暂停或待核');
  const table = readRoleTable(text);
  const target = findRoleRow(table, roleOrId);
  if (!target) throw failure('ROLE_NOT_CONFIGURED', '只能调整当前标准岗位表中已配置的岗位', 404);
  const normalizedLastChange = typeof lastChange === 'string' && lastChange.trim()
    ? lastChange.trim().replace(/[\r\n]+/g, ' ').replaceAll('|', '｜')
    : null;
  const { header, dataRows } = parseTableLines(text);
  const row = dataRows.find(item => !item.isPlaceholder && item.name === target.name);
  if (!row) throw failure('ROLE_NOT_CONFIGURED', '未定位到当前标准岗位表的状态单元格', 404);
  const edits = [{ cell: row.cells[header.cols.status], value: status }];
  if (normalizedLastChange !== null && header.cols.lastChange >= 0 && row.cells[header.cols.lastChange]) {
    edits.push({ cell: row.cells[header.cols.lastChange], value: normalizedLastChange });
  }
  return applyRowCellEdits(text, row.start, edits);
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

async function withContextLock(root, operation) {
  const directory = await controlDirectory(root);
  const lockFile = path.join(directory, 'context.lock');
  let lock;
  try { lock = await open(lockFile, 'wx'); }
  catch (error) {
    if (error.code === 'EEXIST') throw failure('ROLE_LOCKED', '岗位配置正在修改或仍有写入锁，请确认后重试', 409);
    throw error;
  }
  try { return await operation(directory); }
  finally {
    await lock.close();
    await rm(lockFile);
  }
}

async function writeContextWithBackup(root, directory, context, nextText, expectedRevision) {
  const bytes = context.encode(nextText);
  if (bytes.length > MAX_FILE_BYTES) throw failure('CONTEXT_TOO_LARGE', '岗位配置超过读取上限');
  const backup = path.join(directory, `CONTEXT-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID()}.md`);
  const saved = await open(backup, 'wx');
  try { await saved.writeFile(context.bytes); await saved.sync(); }
  finally { await saved.close(); }
  let temporary = path.join(root, `.CONTEXT-${randomUUID()}.tmp`);
  try {
    const output = await open(temporary, 'wx', context.info.mode & 0o777);
    try { await output.writeFile(bytes); await output.sync(); }
    finally { await output.close(); }
    if (expectedRevision !== undefined) {
      const current = await contextFile(root);
      if (contextRevision(current.bytes) !== expectedRevision) throw failure('CONTEXT_CONFLICT', '保存前检测到岗位配置变化，请重新读取后保存', 409);
    }
    await rename(temporary, context.file);
    temporary = null;
    return {
      backup: path.relative(root, backup).split(path.sep).join('/'),
      contextRevision: contextRevision(bytes)
    };
  } finally {
    if (temporary) await rm(temporary, { force: true });
  }
}

async function appendChangelog(root, entry, defaultMode = 0o644) {
  const docsDir = path.join(root, 'docs');
  let dirInfo;
  try { dirInfo = await lstat(docsDir); }
  catch (error) {
    if (error.code !== 'ENOENT') throw failure('CHANGELOG_UNREADABLE', '无法读取变更日志目录', 422);
    await mkdir(docsDir, { recursive: true });
    dirInfo = await lstat(docsDir);
  }
  if (!dirInfo.isDirectory() || dirInfo.isSymbolicLink() || !insideWorkspace(root, await realpath(docsDir))) {
    throw failure('CHANGELOG_UNSAFE', '变更日志目录必须位于工作区内且不能是符号链接', 422);
  }
  const changelogFile = path.join(docsDir, 'CHANGELOG.md');
  let existing = CHANGELOG_HEADER, fileMode = defaultMode || 0o644;
  let fileInfo = null;
  try { fileInfo = await lstat(changelogFile); }
  catch (error) {
    if (error.code !== 'ENOENT') throw failure('CHANGELOG_UNREADABLE', '无法读取变更日志', 422);
  }
  if (fileInfo) {
    if (!fileInfo.isFile() || fileInfo.isSymbolicLink() || !insideWorkspace(root, await realpath(changelogFile))) {
      throw failure('CHANGELOG_UNSAFE', '变更日志必须是工作区内的普通文件', 422);
    }
    if (fileInfo.size > MAX_FILE_BYTES) throw failure('CHANGELOG_TOO_LARGE', '变更日志超过大小上限', 422);
    const raw = await readFile(changelogFile);
    if (raw.length > MAX_FILE_BYTES) throw failure('CHANGELOG_TOO_LARGE', '变更日志超过大小上限', 422);
    existing = decodeContext(raw).text;
    fileMode = fileInfo.mode & 0o777;
  }
  const prefix = existing.length > 0 && !existing.endsWith('\n') ? `${existing}\n` : existing;
  const next = prefix + entry;
  if (Buffer.byteLength(next, 'utf8') > MAX_FILE_BYTES) throw failure('CHANGELOG_TOO_LARGE', '变更日志超过大小上限', 422);
  let temporary = path.join(docsDir, `.CHANGELOG-${randomUUID()}.tmp`);
  try {
    const output = await open(temporary, 'wx', fileMode);
    try { await output.writeFile(next, 'utf8'); await output.sync(); }
    finally { await output.close(); }
    await rename(temporary, changelogFile);
    temporary = null;
  } finally {
    if (temporary) await rm(temporary, { force: true });
  }
}

export async function setRoleStatus({ workspace, role, status, revision, reason, now }) {
  if (typeof role !== 'string' || !role.trim() || role !== role.trim() || role.length > 300 || !ROLE_STATUSES.includes(status) || typeof revision !== 'string' || !/^[a-f0-9]{64}$/.test(revision)) {
    throw failure('ROLE_INPUT_INVALID', '岗位、状态或配置版本无效');
  }
  const hasReason = reason !== undefined && reason !== null;
  const normalizedReason = hasReason ? validateSingleLine(reason, '变更原因', 300) : null;
  const date = hasReason ? resolveDateStamp(now) : null;
  const lastChange = hasReason ? `${date} ${normalizedReason}` : undefined;
  const root = await resolveWorkspace(workspace);
  return withContextLock(root, async directory => {
    const context = await contextFile(root);
    if (contextRevision(context.bytes) !== revision) throw failure('CONTEXT_CONFLICT', '岗位配置已被修改，请重新读取后保存', 409);
    const table = readRoleTable(context.text);
    const target = findRoleRow(table, role);
    if (!target) throw failure('ROLE_NOT_CONFIGURED', '只能调整当前标准岗位表中已配置的岗位', 404);
    const canonicalName = target.name;
    const roleId = target.roleId;
    const prevStatus = target.status;
    const next = replaceRoleStatus(context.text, canonicalName, status, { lastChange });
    if (next === context.text) {
      return {
        changed: false,
        role: canonicalName,
        ...(roleId ? { roleId } : {}),
        status,
        backup: null,
        contextRevision: revision,
        roles: readRoles(next),
        allowedStatuses: [...ROLE_STATUSES],
        ...(hasReason ? { changelogUpdated: false } : {})
      };
    }
    const saved = await writeContextWithBackup(root, directory, context, next, revision);
    if (hasReason) {
      const entry = `- ${date} | ${roleId ?? canonicalName}（${canonicalName}）| 状态：${prevStatus ?? '无'} -> ${status} | ${normalizedReason}\n`;
      await appendChangelog(root, entry, context.info.mode & 0o777);
    }
    return {
      changed: true,
      role: canonicalName,
      ...(roleId ? { roleId } : {}),
      status,
      backup: saved.backup,
      contextRevision: saved.contextRevision,
      roles: readRoles(next),
      allowedStatuses: [...ROLE_STATUSES],
      ...(hasReason ? { changelogUpdated: true } : {})
    };
  });
}

export async function upsertRole({ workspace, roleId, name, priority, status, jdPath, internalPath, reason, now }) {
  const normalizedName = validateSingleLine(name, '岗位名称', 120);
  if (PLACEHOLDER_ROLE_RE.test(normalizedName)) throw failure('ROLE_INPUT_INVALID', '岗位名称不能使用占位符');
  const normalizedPriority = validateSingleLine(priority, '优先级', 40);
  if (!KNOWN_ROLE_STATUSES.includes(status)) {
    throw failure('ROLE_STATUS_INVALID', '岗位状态仅支持在招、已下架、已关闭、暂停、待核或待梳理');
  }
  let normalizedRoleId = null;
  if (roleId !== undefined && roleId !== null) {
    if (typeof roleId !== 'string' || !ROLE_ID_PATTERN.test(roleId)) {
      throw failure('ROLE_INPUT_INVALID', 'roleId 必须为 2–24 位大写字母、数字或连字符，且以字母或数字开头');
    }
    normalizedRoleId = roleId;
  }
  const hasReason = reason !== undefined && reason !== null;
  const normalizedReason = hasReason ? validateSingleLine(reason, '变更原因', 300) : null;
  const date = hasReason ? resolveDateStamp(now) : null;
  const lastChange = hasReason ? `${date} ${normalizedReason}` : null;
  const root = await resolveWorkspace(workspace);
  const normalizedJdPath = validateRelativeWorkspacePath(root, jdPath, '对外 JD 路径');
  const normalizedInternalPath = validateRelativeWorkspacePath(root, internalPath, '对内档案路径');

  return withContextLock(root, async directory => {
    const context = await contextFile(root);
    const revision = contextRevision(context.bytes);
    const table = readRoleTable(context.text);
    const parsedLines = parseTableLines(context.text);
    const { cols } = parsedLines.header;

    const byId = normalizedRoleId ? table.rows.find(row => row.roleId === normalizedRoleId) ?? null : null;
    const byName = table.rows.find(row => row.name === normalizedName) ?? null;
    if (byId && byName && byId !== byName) {
      throw failure('ROLE_CONFLICT', 'role_id 与岗位名称分别指向不同岗位，存在冲突', 409);
    }
    const matched = byId ?? byName;

    let next, action, effectiveRoleId, prevStatus = null;
    if (!matched) {
      if (cols.roleId >= 0 && !normalizedRoleId) {
        throw failure('ROLE_INPUT_INVALID', '当前标准岗位表包含 role_id 列，新增岗位必须提供 roleId');
      }
      const rowCells = parsedLines.header.names.map((_, index) => {
        if (index === cols.roleId) return normalizedRoleId ? `\`${normalizedRoleId}\`` : '—';
        if (index === cols.name) return normalizedName;
        if (index === cols.priority) return normalizedPriority;
        if (index === cols.status) return status;
        if (index === cols.jd) return normalizedJdPath ? `\`${normalizedJdPath}\`` : '—';
        if (index === cols.internal) return normalizedInternalPath ? `\`${normalizedInternalPath}\`` : '—';
        if (index === cols.lastChange) return lastChange ?? '—';
        return '—';
      });
      const formattedRow = `| ${rowCells.join(' | ')} |`;
      const tableEol = parsedLines.dataRows[0]?.eol || parsedLines.separator.eol || parsedLines.header.eol || (context.text.includes('\r\n') ? '\r\n' : '\n');
      if (parsedLines.dataRows.length > 0 && parsedLines.dataRows.every(row => row.isPlaceholder)) {
        const first = parsedLines.dataRows[0], last = parsedLines.dataRows.at(-1);
        next = context.text.slice(0, first.start) + formattedRow + last.eol + context.text.slice(last.end);
      } else {
        const anchor = parsedLines.dataRows.length > 0 ? parsedLines.dataRows.at(-1) : parsedLines.separator;
        next = anchor.eol
          ? context.text.slice(0, anchor.end) + formattedRow + anchor.eol + context.text.slice(anchor.end)
          : context.text.slice(0, anchor.end) + tableEol + formattedRow + context.text.slice(anchor.end);
      }
      action = 'insert';
      effectiveRoleId = cols.roleId >= 0 ? normalizedRoleId : null;
    } else {
      const rowLine = parsedLines.dataRows.find(row => !row.isPlaceholder && row.name === matched.name);
      if (!rowLine) throw failure('ROLE_NOT_CONFIGURED', '未定位到当前标准岗位表的对应行', 404);
      const edits = [];
      if (matched.name !== normalizedName) edits.push({ cell: rowLine.cells[cols.name], value: normalizedName });
      if (matched.priority !== normalizedPriority) edits.push({ cell: rowLine.cells[cols.priority], value: normalizedPriority });
      if (rowLine.cells[cols.status].text.trim() !== status) edits.push({ cell: rowLine.cells[cols.status], value: status });
      if (cols.roleId >= 0 && normalizedRoleId !== null && matched.roleId !== normalizedRoleId) {
        edits.push({ cell: rowLine.cells[cols.roleId], value: `\`${normalizedRoleId}\`` });
      }
      if (cols.jd >= 0 && normalizedJdPath !== undefined && matched.jdPath !== normalizedJdPath) {
        edits.push({ cell: rowLine.cells[cols.jd], value: normalizedJdPath ? `\`${normalizedJdPath}\`` : '—' });
      }
      if (cols.internal >= 0 && normalizedInternalPath !== undefined && matched.internalPath !== normalizedInternalPath) {
        edits.push({ cell: rowLine.cells[cols.internal], value: normalizedInternalPath ? `\`${normalizedInternalPath}\`` : '—' });
      }
      if (cols.lastChange >= 0 && lastChange !== null && matched.lastChange !== lastChange) {
        edits.push({ cell: rowLine.cells[cols.lastChange], value: lastChange });
      }
      next = edits.length ? applyRowCellEdits(context.text, rowLine.start, edits) : context.text;
      effectiveRoleId = cols.roleId >= 0 ? (normalizedRoleId ?? matched.roleId ?? null) : null;
      prevStatus = matched.status;
      action = next === context.text ? 'noop' : 'update';
    }

    const nextRoles = readRoles(next);
    if (next === context.text) {
      return {
        changed: false,
        action: 'noop',
        role: normalizedName,
        roleId: effectiveRoleId,
        status,
        priority: normalizedPriority,
        contextRevision: revision,
        backup: null,
        roles: nextRoles,
        ...(hasReason ? { changelogUpdated: false } : {})
      };
    }

    const saved = await writeContextWithBackup(root, directory, context, next, revision);
    if (hasReason) {
      const changeSummary = action === 'insert'
        ? `新增：状态 ${status}，优先级 ${normalizedPriority}`
        : `状态：${prevStatus ?? '无'} -> ${status}，优先级：${normalizedPriority}`;
      const entry = `- ${date} | ${effectiveRoleId ?? normalizedName}（${normalizedName}）| ${changeSummary} | ${normalizedReason}\n`;
      await appendChangelog(root, entry, context.info.mode & 0o777);
    }
    return {
      changed: true,
      action,
      role: normalizedName,
      roleId: effectiveRoleId,
      status,
      priority: normalizedPriority,
      contextRevision: saved.contextRevision,
      backup: saved.backup,
      roles: nextRoles,
      ...(hasReason ? { changelogUpdated: true } : {})
    };
  });
}

const CLI_COMMANDS = {
  list: { required: ['workspace'], optional: [] },
  'set-status': { required: ['workspace', 'role', 'status'], optional: ['reason', 'revision'] },
  upsert: { required: ['workspace', 'name', 'priority', 'status'], optional: ['role-id', 'jd', 'internal', 'reason'] }
};

export async function rolesCLI(argv) {
  const [command, ...args] = argv;
  const spec = Object.hasOwn(CLI_COMMANDS, command) ? CLI_COMMANDS[command] : null;
  if (!spec) {
    throw failure('ROLE_INPUT_INVALID', '用法：roles.mjs list|set-status|upsert --workspace <目录> ...');
  }
  const allowed = new Set([...spec.required, ...spec.optional]);
  if (args.length % 2 !== 0) throw failure('ROLE_INPUT_INVALID', '命令包含无效、重复或缺失参数');
  const flags = {};
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index], value = args[index + 1];
    if (typeof flag !== 'string' || !flag.startsWith('--')) throw failure('ROLE_INPUT_INVALID', '命令包含无效、重复或缺失参数');
    const key = flag.slice(2);
    if (!allowed.has(key) || Object.hasOwn(flags, key) || typeof value !== 'string' || !value || value.startsWith('--')) {
      throw failure('ROLE_INPUT_INVALID', '命令包含无效、重复或缺失参数');
    }
    flags[key] = value;
  }
  if (spec.required.some(key => !Object.hasOwn(flags, key))) {
    throw failure('ROLE_INPUT_INVALID', `命令必须提供 ${spec.required.map(key => `--${key}`).join(' ')} 参数`);
  }
  if (command === 'list') {
    const root = await resolveWorkspace(flags.workspace);
    const context = await contextFile(root);
    const table = readRoleTable(context.text);
    return {
      contextRevision: contextRevision(context.bytes),
      headers: table.headers,
      rows: table.rows,
      allowedStatuses: [...ROLE_STATUSES],
      knownStatuses: [...KNOWN_ROLE_STATUSES]
    };
  }
  if (command === 'set-status') {
    let revision = flags.revision;
    if (revision === undefined) {
      const root = await resolveWorkspace(flags.workspace);
      const context = await contextFile(root);
      revision = contextRevision(context.bytes);
    }
    return setRoleStatus({
      workspace: flags.workspace,
      role: flags.role,
      status: flags.status,
      revision,
      ...(Object.hasOwn(flags, 'reason') ? { reason: flags.reason } : {})
    });
  }
  return upsertRole({
    workspace: flags.workspace,
    name: flags.name,
    priority: flags.priority,
    status: flags.status,
    ...(Object.hasOwn(flags, 'role-id') ? { roleId: flags['role-id'] } : {}),
    ...(Object.hasOwn(flags, 'jd') ? { jdPath: flags.jd } : {}),
    ...(Object.hasOwn(flags, 'internal') ? { internalPath: flags.internal } : {}),
    ...(Object.hasOwn(flags, 'reason') ? { reason: flags.reason } : {})
  });
}

function roleError(error) {
  const safeCode = typeof error?.code === 'string' && /^[A-Z_]+$/.test(error.code) ? error.code : 'ROLE_OPERATION_FAILED';
  const safeMessage = (error?.status || error?.code?.startsWith('ROLE_') || error?.code?.startsWith('CONTEXT_') || error?.code?.startsWith('CHANGELOG_') || error?.message === '必须显式指定 --workspace' || error?.message === '工作区必须是存在的目录') && error?.errno === undefined && error?.syscall === undefined
    ? error.message
    : '岗位配置读取或写入失败，请检查工作区目录、CONTEXT.md 与文件权限';
  return { error: { code: safeCode, message: safeMessage } };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try { process.stdout.write(`${JSON.stringify(await rolesCLI(process.argv.slice(2)))}\n`); }
  catch (error) { process.stderr.write(`${JSON.stringify(roleError(error))}\n`); process.exitCode = 1; }
}
