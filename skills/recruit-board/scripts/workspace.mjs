import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, open, realpath, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  KNOWN_ROLE_STATUSES,
  parseRoleStatus,
  readCandidates,
  readConfig,
  readRoles,
  readRoleTable,
  ROLE_ID_PATTERN,
  selectRoles
} from '../model.mjs';
import { insideWorkspace, MAX_FILE_BYTES, resolveWorkspace } from './reader.mjs';
import { validatePlatformListings } from './listings.mjs';

const CANONICAL_COLUMNS = Object.freeze([
  'role_id', '岗位', '优先级', '状态', '对外 JD', '对内档案', '最近变更'
]);

const DEFAULT_CHANGELOG_CONTENT = '# 招聘工作区变更日志\n\n> 记录岗位配置、标准调整与工作区结构演进。\n';

function appError(code, message, status = 400) {
  return Object.assign(new Error(message), { code, status });
}

function sanitizeMessage(message, root) {
  let out = String(message ?? '未知错误');
  if (root) {
    const posixRoot = root.split(path.sep).join('/');
    for (const candidate of new Set([root, posixRoot])) {
      if (candidate) out = out.split(candidate).join('<workspace>');
    }
  }
  return out;
}

function decodeTextWithMeta(bytes, label = '文件') {
  let encoding = 'utf8';
  let bom = Buffer.alloc(0);
  let body = bytes;
  if (bytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]))) {
    bom = bytes.subarray(0, 3);
    body = bytes.subarray(3);
  } else if (bytes.subarray(0, 2).equals(Buffer.from([0xff, 0xfe]))) {
    encoding = 'utf16le';
    bom = bytes.subarray(0, 2);
    body = bytes.subarray(2);
  } else if (bytes.subarray(0, 2).equals(Buffer.from([0xfe, 0xff]))) {
    encoding = 'utf16be';
    bom = bytes.subarray(0, 2);
    body = bytes.subarray(2);
  }
  const codec = encoding === 'utf8' ? 'utf-8' : encoding === 'utf16le' ? 'utf-16le' : 'utf-16be';
  try {
    const text = new TextDecoder(codec, { fatal: true, ignoreBOM: true }).decode(body);
    return {
      text,
      encode(next) {
        const output = Buffer.from(next, encoding === 'utf8' ? 'utf8' : 'utf16le');
        if (encoding === 'utf16be') output.swap16();
        return Buffer.concat([bom, output]);
      }
    };
  } catch {
    throw appError('TEXT_ENCODING_INVALID', `${label}编码无法安全保留，请使用有效 UTF-8 或 UTF-16 文本`, 422);
  }
}

async function inspectRelativePath(root, relativePath) {
  const normalized = String(relativePath ?? '').trim();
  if (!normalized || path.isAbsolute(normalized) || /^[a-zA-Z]:/.test(normalized)) {
    return { status: 'unsafe', code: 'PATH_TRAVERSAL', message: `路径不能是空值或绝对路径：${relativePath}` };
  }
  const resolved = path.resolve(root, normalized);
  if (!insideWorkspace(root, resolved)) {
    return { status: 'unsafe', code: 'PATH_TRAVERSAL', message: `路径越出工作区边界：${relativePath}` };
  }
  const rel = path.relative(root, resolved);
  const parts = rel ? rel.split(path.sep).filter(Boolean) : [];
  let cursor = root;
  for (const part of parts) {
    cursor = path.join(cursor, part);
    let info;
    try {
      info = await lstat(cursor);
    } catch (error) {
      if (error.code === 'ENOENT') return { status: 'missing', target: resolved };
      return { status: 'error', code: 'PATH_UNREADABLE', message: `无法访问路径：${relativePath}` };
    }
    if (info.isSymbolicLink()) {
      return { status: 'unsafe', code: 'SYMLINK_ESCAPE', message: `禁止通过符号链接访问路径：${relativePath}` };
    }
  }
  const realTarget = await realpath(resolved);
  if (!insideWorkspace(root, realTarget)) {
    return { status: 'unsafe', code: 'SYMLINK_ESCAPE', message: `真实路径越出工作区边界：${relativePath}` };
  }
  const info = await lstat(realTarget);
  return { status: 'ok', target: realTarget, info };
}

async function readSafeFile(root, relativePath, label = relativePath) {
  const inspected = await inspectRelativePath(root, relativePath);
  if (inspected.status === 'missing') return { status: 'missing' };
  if (inspected.status !== 'ok') return inspected;
  if (!inspected.info.isFile()) {
    return { status: 'error', code: 'NOT_A_FILE', message: `${label}必须是普通文件` };
  }
  if (inspected.info.size > MAX_FILE_BYTES) {
    return { status: 'error', code: 'FILE_TOO_LARGE', message: `${label}超过大小上限` };
  }
  const handle = await open(inspected.target, 'r');
  let raw;
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.size > MAX_FILE_BYTES) {
      return { status: 'error', code: 'FILE_TOO_LARGE', message: `${label}超过大小上限` };
    }
    raw = await handle.readFile();
  } finally {
    await handle.close();
  }
  if (raw.length > MAX_FILE_BYTES) {
    return { status: 'error', code: 'FILE_TOO_LARGE', message: `${label}超过大小上限` };
  }
  const decoded = decodeTextWithMeta(raw, label);
  return { status: 'ok', file: inspected.target, info: inspected.info, bytes: raw, ...decoded };
}

/**
 * Generates a deterministic role_id matching ROLE_ID_PATTERN and avoiding collisions with usedIds.
 * @param {string} name
 * @param {Iterable<string>} [usedIds]
 * @returns {string}
 */
export function generateRoleId(name, usedIds = new Set()) {
  const used = usedIds instanceof Set ? usedIds : new Set(usedIds ?? []);
  const trimmed = String(name ?? '').trim();
  const hash = createHash('sha256').update(trimmed || 'ROLE', 'utf8').digest('hex').toUpperCase();
  const tokens = (trimmed.match(/[A-Za-z0-9]+/g) ?? []).map(token => token.toUpperCase());

  const candidates = [];
  if (tokens.length > 0) {
    const stem = tokens.join('-').slice(0, 24).replace(/-+$/, '');
    if (ROLE_ID_PATTERN.test(stem)) {
      candidates.push(stem);
    }
    const prefix = stem.slice(0, 19).replace(/-+$/, '') || 'ROLE';
    candidates.push(`${prefix}-${hash.slice(0, 4)}`);
    candidates.push(`${prefix.slice(0, 17).replace(/-+$/, '') || 'ROLE'}-${hash.slice(0, 6)}`);
  } else {
    candidates.push(`ROLE-${hash.slice(0, 6)}`);
    candidates.push(`ROLE-${hash.slice(0, 8)}`);
  }

  for (const candidate of candidates) {
    if (ROLE_ID_PATTERN.test(candidate) && !used.has(candidate)) {
      return candidate;
    }
  }

  const base = (tokens.length > 0 ? tokens.join('-').slice(0, 14).replace(/-+$/, '') : '') || 'ROLE';
  for (let i = 1; i < 10000; i++) {
    const candidate = `${base}-${hash.slice(0, 4)}-${i}`.slice(0, 24).replace(/-+$/, '');
    if (ROLE_ID_PATTERN.test(candidate) && !used.has(candidate)) {
      return candidate;
    }
  }
  throw appError('ROLE_ID_EXHAUSTED', `无法为岗位生成唯一 role_id：${trimmed}`, 500);
}

/**
 * Validates workspace structure, pointers, sizes, config, ledger, and board parity.
 * @param {string} workspace
 * @param {{ maxContextBytes?: number, maxInternalBytes?: number }} [options]
 */
export async function validateWorkspace(workspace, { maxContextBytes = 16 * 1024, maxInternalBytes = 20 * 1024 } = {}) {
  const root = await resolveWorkspace(workspace);
  const errors = [];
  const warnings = [];
  const pushError = (code, message, extra = {}) => errors.push({ code, message, ...extra });
  const pushWarning = (code, message, extra = {}) => warnings.push({ code, message, ...extra });

  const stats = {
    contextLines: 0,
    contextBytes: 0,
    totalRoles: 0,
    activeRoles: 0,
    activeCandidates: 0,
    activeInternalSizes: {}
  };

  const contextRes = await readSafeFile(root, 'CONTEXT.md', 'CONTEXT.md');
  if (contextRes.status === 'missing') {
    pushError('CONTEXT_MISSING', '缺少 CONTEXT.md', { path: 'CONTEXT.md' });
    return { ok: false, errors, warnings, stats };
  }
  if (contextRes.status !== 'ok') {
    pushError(contextRes.code ?? 'CONTEXT_UNSAFE', contextRes.message ?? 'CONTEXT.md 无法读取', { path: 'CONTEXT.md' });
    return { ok: false, errors, warnings, stats };
  }

  stats.contextBytes = contextRes.bytes.length;
  stats.contextLines = contextRes.text.split(/\r?\n/).length;
  if (stats.contextBytes > maxContextBytes) {
    pushWarning('CONTEXT_OVERSIZED', `CONTEXT.md 体积（${stats.contextBytes} 字节）超过阈值 ${maxContextBytes} 字节`, { path: 'CONTEXT.md' });
  }

  let roleTable;
  let roles;
  try {
    roleTable = readRoleTable(contextRes.text);
    roles = readRoles(contextRes.text);
  } catch (error) {
    pushError('CONTEXT_INVALID', error.message, { path: 'CONTEXT.md' });
    return { ok: false, errors, warnings, stats };
  }

  stats.totalRoles = roleTable.rows.length;
  stats.activeRoles = roleTable.rows.filter(row => row.status === '在招').length;

  let config = { schemaVersion: 1, statusStages: {}, roleAliases: {} };
  const configRes = await readSafeFile(root, '_shared/recruit-board.config.json', '_shared/recruit-board.config.json');
  if (configRes.status === 'ok') {
    try {
      config = readConfig(configRes.text, roles);
    } catch (error) {
      pushError(error.code ?? 'CONFIG_INVALID', error.message, { path: '_shared/recruit-board.config.json' });
    }
  } else if (configRes.status !== 'missing') {
    pushError(configRes.code ?? 'CONFIG_UNSAFE', configRes.message ?? '兼容配置无法读取', { path: '_shared/recruit-board.config.json' });
  }

  let candidates = [];
  const ledgerRes = await readSafeFile(root, '02-sourcing/dedup-ledger.csv', '02-sourcing/dedup-ledger.csv');
  if (ledgerRes.status === 'ok') {
    try {
      const parsedLedger = readCandidates(ledgerRes.text, config);
      candidates = parsedLedger.candidates;
      if (parsedLedger.unknownStatuses.length > 0) {
        const unmappedTotal = parsedLedger.unknownStatuses.reduce((sum, item) => sum + item.count, 0);
        const sample = parsedLedger.unknownStatuses.slice(0, 5).map(item => `${item.status || '空状态'}（${item.count}）`).join('、');
        pushWarning(
          'UNMAPPED_LEDGER_STATUS',
          `台账有 ${unmappedTotal} 条记录（${parsedLedger.unknownStatuses.length} 种状态）未映射到看板阶段：${sample}；建议补齐 _shared/recruit-board.config.json 的 statusStages`,
          { path: '02-sourcing/dedup-ledger.csv', count: unmappedTotal, distinct: parsedLedger.unknownStatuses.length }
        );
      }
    } catch (error) {
      pushError('LEDGER_INVALID', error.message, { path: '02-sourcing/dedup-ledger.csv' });
    }
  } else if (ledgerRes.status !== 'missing') {
    pushError(ledgerRes.code ?? 'LEDGER_UNSAFE', ledgerRes.message ?? '候选人台账无法读取', { path: '02-sourcing/dedup-ledger.csv' });
  }

  const hasRoleIdCol = roleTable.headers.includes('role_id');
  if (!hasRoleIdCol) {
    pushWarning('LEGACY_ROLE_TABLE', '岗位配置表缺少 role_id 列，建议运行 workspace.mjs migrate 升级', { path: 'CONTEXT.md' });
  }
  if (roleTable.rows.some(row => row.annotated)) {
    pushWarning('ROLE_STATUS_ANNOTATED', '岗位状态含括号附注，建议运行 workspace.mjs migrate 规范化', { path: 'CONTEXT.md' });
  }

  const seenRoleIds = new Set();
  for (const row of roleTable.rows) {
    if (hasRoleIdCol) {
      if (!row.roleId || !ROLE_ID_PATTERN.test(row.roleId)) {
        pushError('INVALID_ROLE_ID', `岗位「${row.name}」的 role_id 无效或缺失：${row.roleId ?? '空'}`, { role: row.name });
      } else if (seenRoleIds.has(row.roleId)) {
        pushError('DUPLICATE_ROLE_ID', `岗位 role_id 重复：${row.roleId}`, { role: row.name });
      } else {
        seenRoleIds.add(row.roleId);
      }
    }

    if (!row.status) {
      if (row.priority) {
        pushError('ROLE_STATUS_EMPTY', `岗位「${row.name}」设置了优先级但状态为空`, { role: row.name });
      } else {
        pushWarning('ROLE_STATUS_EMPTY', `岗位「${row.name}」状态为空`, { role: row.name });
      }
    } else if (!KNOWN_ROLE_STATUSES.includes(row.status)) {
      pushWarning('UNKNOWN_ROLE_STATUS', `岗位「${row.name}」包含历史/自定义状态：${row.status}`, { role: row.name });
    }

    for (const [fieldLabel, relPath] of [['对外 JD', row.jdPath], ['对内档案', row.internalPath]]) {
      if (!relPath) continue;
      const check = await inspectRelativePath(root, relPath);
      const validTarget = check.status === 'ok' && (
        fieldLabel === '对外 JD'
          ? (check.info.isFile() || check.info.isDirectory())
          : check.info.isFile()
      );
      if (check.status === 'unsafe') {
        pushError(check.code, `${row.name} 的${fieldLabel}路径不安全：${relPath}`, { role: row.name, path: relPath });
      } else if (check.status === 'missing' || (check.status === 'ok' && !validTarget)) {
        pushError('DANGLING_POINTER', `${row.name} 的${fieldLabel}指向不存在的${fieldLabel === '对外 JD' ? '路径' : '文件'}：${relPath}`, { role: row.name, path: relPath });
      } else if (check.status !== 'ok') {
        pushError(check.code ?? 'POINTER_ERROR', `${row.name} 的${fieldLabel}无法读取：${relPath}`, { role: row.name, path: relPath });
      } else if (fieldLabel === '对内档案' && row.status === '在招') {
        stats.activeInternalSizes[row.name] = check.info.size;
        if (check.info.size > maxInternalBytes) {
          pushWarning('INTERNAL_OVERSIZED', `在招岗位「${row.name}」对内档案体积（${check.info.size} 字节）超过阈值 ${maxInternalBytes} 字节`, { role: row.name, path: relPath });
        }
      }
    }

    if (row.status === '在招' && !row.internalPath) {
      pushWarning('ACTIVE_INTERNAL_MISSING', `在招岗位「${row.name}」尚未配置对内档案`, { role: row.name });
    }
  }

  const listingsCheck = await validatePlatformListings(root);
  if (listingsCheck.status !== 'missing') {
    for (const err of listingsCheck.errors) errors.push(err);
    for (const warn of listingsCheck.warnings) warnings.push(warn);
    stats.listingsCount = listingsCheck.count;
    stats.ignoredListingsCount = listingsCheck.ignoredCount;
  }

  const changelogCheck = await inspectRelativePath(root, 'docs/CHANGELOG.md');
  if (changelogCheck.status === 'missing') {
    pushWarning('CHANGELOG_MISSING', '缺少 docs/CHANGELOG.md，可运行 workspace.mjs migrate 初始化', { path: 'docs/CHANGELOG.md', level: 'info' });
  } else if (changelogCheck.status === 'unsafe') {
    pushError(changelogCheck.code, 'docs/CHANGELOG.md 路径不安全', { path: 'docs/CHANGELOG.md' });
  }

  const agentsRes = await readSafeFile(root, 'AGENTS.md', 'AGENTS.md');
  if (agentsRes.status === 'ok') {
    const hasDeprecatedTools = /tools\/(?:validate-context|ledger-upsert)\.mjs/.test(agentsRes.text);
    const hasNewCli = /skills\/recruit-board\/scripts\/(?:roles|ledger|role-context|workspace)\.mjs/.test(agentsRes.text);
    if (hasDeprecatedTools || !hasNewCli) {
      pushWarning(
        'LEGACY_AGENTS_MD',
        'AGENTS.md 仍指向旧脚本或尚未接入新版确定性 CLI（roles/ledger/role-context/workspace.mjs），建议同步并清理与 CONTEXT.md 重复的硬规则',
        { path: 'AGENTS.md' }
      );
    }
  }

  const boardSelection = selectRoles({ roles, candidates }, { scope: 'active' });
  stats.activeCandidates = boardSelection.total ?? 0;
  if (boardSelection.roles.length !== stats.activeRoles) {
    pushError('BOARD_PARITY_MISMATCH', `看板在招岗位数（${boardSelection.roles.length}）与岗位表在招行数（${stats.activeRoles}）不一致`);
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    stats
  };
}

function markdownCell(value) {
  return value.trim().replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').replace(/[*`]/g, '').trim();
}

function splitTableLine(line) {
  return line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|');
}

function isPlaceholderRoleName(name) {
  return !name || /^(?:[（(]?(?:待梳理|待填写|岗位名|role)[）)]?|<role>)$/i.test(name);
}

function upgradeRoleTableInContext(text) {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = [];
  let offset = 0;
  for (const match of text.matchAll(/[^\r\n]*(?:\r\n|\n|\r|$)/g)) {
    const raw = match[0];
    if (!raw) continue;
    const lineEndMatch = /(\r\n|\n|\r)$/.exec(raw);
    const lineEol = lineEndMatch ? lineEndMatch[1] : '';
    const line = raw.slice(0, raw.length - lineEol.length);
    lines.push({ raw, line, lineEol, start: offset, end: offset + raw.length });
    offset += raw.length;
  }

  let inSection = false;
  let headerIdx = -1;
  let dataEndIdx = -1;
  let headers = null;

  for (let i = 0; i < lines.length; i++) {
    const heading = /^(#{1,6})\s+(.+)$/.exec(lines[i].line);
    if (heading) {
      if (inSection) break;
      if (/^(?:[一二三四五六七八九十\d]+[、.．]\s*)?在招岗位与优先级$/.test(heading[2].trim())) {
        inSection = true;
      }
      continue;
    }
    if (!inSection || !lines[i].line.trim().startsWith('|')) continue;
    const candidateHeaders = splitTableLine(lines[i].line).map(markdownCell);
    if (!['岗位', '优先级', '状态'].every(col => candidateHeaders.includes(col))) continue;
    if (!lines[i + 1] || !splitTableLine(lines[i + 1].line).map(markdownCell).every(cell => /^:?-{3,}:?$/.test(cell))) continue;
    headerIdx = i;
    headers = candidateHeaders;
    let j = i + 2;
    while (j < lines.length && lines[j].line.trim().startsWith('|')) j++;
    dataEndIdx = j;
    break;
  }

  if (headerIdx < 0) {
    throw appError('ROLE_TABLE_NOT_FOUND', '未找到“在招岗位与优先级”的岗位配置表', 422);
  }

  const normalizedHeaders = headers.map(h => (h === '对内笔记' ? '对内档案' : h));
  const extraHeaders = normalizedHeaders.filter(h => !CANONICAL_COLUMNS.includes(h));
  const targetHeaders = [...CANONICAL_COLUMNS, ...extraHeaders];
  const headersMatch = normalizedHeaders.length === targetHeaders.length
    && normalizedHeaders.every((h, idx) => h === targetHeaders[idx]);

  const dataLines = lines.slice(headerIdx + 2, dataEndIdx);
  const usedIds = new Set();
  const parsedRows = dataLines.map(entry => {
    const rawCells = splitTableLine(entry.line);
    if (rawCells.length !== headers.length) {
      throw appError('ROLE_TABLE_MALFORMED', '岗位配置表列数不一致', 422);
    }
    const cellMap = new Map();
    for (let c = 0; c < normalizedHeaders.length; c++) {
      cellMap.set(normalizedHeaders[c], rawCells[c].trim());
    }
    const name = markdownCell(cellMap.get('岗位') ?? '');
    const placeholder = isPlaceholderRoleName(name);
    const existingId = markdownCell(cellMap.get('role_id') ?? '');
    if (!placeholder && existingId && existingId !== '—' && existingId !== '-') {
      usedIds.add(existingId);
    }
    return { cellMap, name, placeholder, existingId };
  });

  const addedRoleIds = [];
  const normalizedStatuses = [];
  let rowChanged = false;

  const builtDataLines = parsedRows.map(({ cellMap, name, placeholder, existingId }) => {
    const nextMap = new Map(cellMap);
    if (!placeholder) {
      let roleId = existingId && existingId !== '—' && existingId !== '-' ? existingId : '';
      if (!roleId) {
        roleId = generateRoleId(name, usedIds);
        usedIds.add(roleId);
        addedRoleIds.push({ role: name, roleId });
        rowChanged = true;
      }
      nextMap.set('role_id', roleId);

      const rawStatusCell = nextMap.get('状态') ?? '';
      const parsedStatus = parseRoleStatus(markdownCell(rawStatusCell));
      if (parsedStatus.annotated) {
        nextMap.set('状态', parsedStatus.status);
        const prevChange = (nextMap.get('最近变更') ?? '').trim();
        const nextChange = !prevChange || prevChange === '—' || prevChange === '-'
          ? parsedStatus.note
          : prevChange.includes(parsedStatus.note)
            ? prevChange
            : `${prevChange}；${parsedStatus.note}`;
        nextMap.set('最近变更', nextChange);
        normalizedStatuses.push({
          role: name,
          from: parsedStatus.rawStatus,
          to: parsedStatus.status,
          note: parsedStatus.note
        });
        rowChanged = true;
      }
    } else if (!nextMap.has('role_id')) {
      nextMap.set('role_id', '');
    }

    const orderedCells = targetHeaders.map(col => (nextMap.get(col) ?? '').trim());
    return `| ${orderedCells.join(' | ')} |`;
  });

  const contextChanged = !headersMatch || rowChanged;
  if (!contextChanged) {
    return { nextText: text, contextChanged: false, addedRoleIds: [], normalizedStatuses: [] };
  }

  const lastTableLine = lines[dataEndIdx - 1];
  const tableStartOffset = lines[headerIdx].start;
  const tableEndOffset = lastTableLine.end;

  const rebuiltLines = [
    `| ${targetHeaders.join(' | ')} |`,
    `|${targetHeaders.map(() => '---').join('|')}|`,
    ...builtDataLines
  ];
  const rebuiltTable = rebuiltLines.join(eol) + lastTableLine.lineEol;
  const nextText = text.slice(0, tableStartOffset) + rebuiltTable + text.slice(tableEndOffset);

  return { nextText, contextChanged: true, addedRoleIds, normalizedStatuses };
}

async function ensureSafeDirectory(root, relativeParts) {
  let cursor = root;
  for (const part of relativeParts) {
    cursor = path.join(cursor, part);
    let exists = true;
    try {
      const info = await lstat(cursor);
      if (info.isSymbolicLink() || !info.isDirectory()) {
        throw appError('UNSAFE_WORKSPACE_PATH', `目录路径不安全：${relativeParts.join('/')}`, 403);
      }
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      exists = false;
    }
    if (!exists) await mkdir(cursor);
    const real = await realpath(cursor);
    if (!insideWorkspace(root, real)) {
      throw appError('UNSAFE_WORKSPACE_PATH', `目录越出工作区边界：${relativeParts.join('/')}`, 403);
    }
  }
  return cursor;
}

/**
 * Idempotently upgrades a workspace's CONTEXT.md role table and initializes changelog/logs directories.
 * @param {string} workspace
 * @param {{ dryRun?: boolean, now?: string | (() => string) }} [options]
 */
export async function migrateWorkspace(workspace, { dryRun = false, now } = {}) {
  const root = await resolveWorkspace(workspace);
  const stamp = (typeof now === 'function' ? now() : (now ?? new Date().toISOString())).replace(/[:.]/g, '-');

  const runMigration = async () => {
    const contextRes = await readSafeFile(root, 'CONTEXT.md', 'CONTEXT.md');
    if (contextRes.status === 'missing') {
      throw appError('CONTEXT_MISSING', '缺少 CONTEXT.md，无法执行迁移', 404);
    }
    if (contextRes.status !== 'ok') {
      throw appError(contextRes.code ?? 'CONTEXT_UNSAFE', contextRes.message ?? 'CONTEXT.md 无法读取', 422);
    }

    const upgraded = upgradeRoleTableInContext(contextRes.text);
    const changelogCheck = await inspectRelativePath(root, 'docs/CHANGELOG.md');
    if (changelogCheck.status === 'unsafe') {
      throw appError(changelogCheck.code, changelogCheck.message, 403);
    }
    const logsCheck = await inspectRelativePath(root, '01-jd/_internal/logs');
    if (logsCheck.status === 'unsafe') {
      throw appError(logsCheck.code, logsCheck.message, 403);
    }

    const createChangelog = changelogCheck.status === 'missing';
    const createLogsDir = logsCheck.status === 'missing';
    const changed = upgraded.contextChanged || createChangelog || createLogsDir;

    const actions = [];
    if (upgraded.contextChanged) actions.push('upgrade_role_table');
    if (createChangelog) actions.push('create_changelog');
    if (createLogsDir) actions.push('create_logs_dir');

    if (dryRun || !changed) {
      return {
        dryRun: Boolean(dryRun),
        changed,
        contextChanged: upgraded.contextChanged,
        actions,
        addedRoleIds: upgraded.addedRoleIds,
        normalizedStatuses: upgraded.normalizedStatuses,
        createChangelog,
        createLogsDir,
        ...(dryRun ? {} : { backup: null })
      };
    }

    let backupRel = null;
    if (upgraded.contextChanged) {
      const nextRoles = readRoles(upgraded.nextText);
      readRoleTable(upgraded.nextText);
      const configRes = await readSafeFile(root, '_shared/recruit-board.config.json', '_shared/recruit-board.config.json');
      if (configRes.status === 'ok') {
        readConfig(configRes.text, nextRoles);
      } else if (configRes.status !== 'missing') {
        throw appError(configRes.code ?? 'CONFIG_INVALID', configRes.message ?? '兼容配置校验失败', 422);
      }

      const nextBytes = contextRes.encode(upgraded.nextText);
      const rolesDir = await ensureSafeDirectory(root, ['runtime', 'recruit-board', 'roles']);
      const backupFile = path.join(rolesDir, `CONTEXT-migrate-${stamp}-${randomUUID()}.md`);
      const saved = await open(backupFile, 'wx');
      try {
        await saved.writeFile(contextRes.bytes);
        await saved.sync();
      } finally {
        await saved.close();
      }
      backupRel = path.relative(root, backupFile).split(path.sep).join('/');

      const temporary = path.join(root, `.CONTEXT-migrate-${randomUUID()}.tmp`);
      try {
        const output = await open(temporary, 'wx', contextRes.info.mode & 0o777);
        try {
          await output.writeFile(nextBytes);
          await output.sync();
        } finally {
          await output.close();
        }
        await rename(temporary, contextRes.file);
      } finally {
        await rm(temporary, { force: true });
      }
    }

    if (createChangelog) {
      const docsDir = await ensureSafeDirectory(root, ['docs']);
      const changelogPath = path.join(docsDir, 'CHANGELOG.md');
      try {
        const handle = await open(changelogPath, 'wx');
        try {
          await handle.writeFile(DEFAULT_CHANGELOG_CONTENT, 'utf8');
          await handle.sync();
        } finally {
          await handle.close();
        }
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
      }
    }

    if (createLogsDir) {
      await ensureSafeDirectory(root, ['01-jd', '_internal', 'logs']);
    }

    return {
      dryRun: false,
      changed: true,
      contextChanged: upgraded.contextChanged,
      actions,
      addedRoleIds: upgraded.addedRoleIds,
      normalizedStatuses: upgraded.normalizedStatuses,
      createChangelog,
      createLogsDir,
      backup: backupRel
    };
  };

  if (dryRun) {
    return runMigration();
  }

  const rolesDir = await ensureSafeDirectory(root, ['runtime', 'recruit-board', 'roles']);
  const lockFile = path.join(rolesDir, 'context.lock');
  let lock;
  try {
    lock = await open(lockFile, 'wx');
  } catch (error) {
    if (error.code === 'EEXIST') {
      throw appError('ROLE_LOCKED', '岗位配置正在迁移或仍有写入锁，请确认后重试', 409);
    }
    throw error;
  }

  try {
    return await runMigration();
  } finally {
    await lock.close();
    await rm(lockFile, { force: true });
  }
}

function parseFlags(args, allowed, booleanFlags = []) {
  const flags = {};
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (!flag?.startsWith('--')) {
      throw appError('INVALID_ARGS', `无效参数：${flag ?? ''}`, 400);
    }
    const key = flag.slice(2);
    if (!allowed.includes(key) || flags[key] !== undefined) {
      throw appError('INVALID_ARGS', `无效或重复参数：${flag}`, 400);
    }
    if (booleanFlags.includes(key)) {
      flags[key] = true;
      continue;
    }
    const value = args[i + 1];
    if (!value || value.startsWith('--')) {
      throw appError('INVALID_ARGS', `参数缺少取值：${flag}`, 400);
    }
    flags[key] = value;
    i++;
  }
  return flags;
}

/**
 * CLI entrypoint for workspace.mjs (supports `validate` and `migrate`).
 * @param {string[]} argv
 */
export async function workspaceCLI(argv) {
  const [command, ...rest] = argv;
  if (command === 'validate') {
    const flags = parseFlags(rest, ['workspace', 'max-context-kb', 'max-internal-kb']);
    if (!flags.workspace) throw appError('MISSING_WORKSPACE', '必须显式指定 --workspace', 400);
    const parseKb = (raw, fallback, name) => {
      if (raw === undefined) return fallback;
      if (!/^\d+$/.test(raw) || Number(raw) <= 0) {
        throw appError('INVALID_THRESHOLD', `--${name} 必须是正整数`, 400);
      }
      return Number(raw) * 1024;
    };
    return validateWorkspace(flags.workspace, {
      maxContextBytes: parseKb(flags['max-context-kb'], 16 * 1024, 'max-context-kb'),
      maxInternalBytes: parseKb(flags['max-internal-kb'], 20 * 1024, 'max-internal-kb')
    });
  }

  if (command === 'migrate') {
    const flags = parseFlags(rest, ['workspace', 'dry-run'], ['dry-run']);
    if (!flags.workspace) throw appError('MISSING_WORKSPACE', '必须显式指定 --workspace', 400);
    return migrateWorkspace(flags.workspace, { dryRun: Boolean(flags['dry-run']) });
  }

  throw appError('UNKNOWN_COMMAND', '用法：workspace.mjs <validate|migrate> --workspace <dir>', 400);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const argv = process.argv.slice(2);
  const wsIdx = argv.indexOf('--workspace');
  const rawWs = wsIdx >= 0 ? argv[wsIdx + 1] : null;
  let resolvedRoot = null;
  if (rawWs) {
    try { resolvedRoot = await resolveWorkspace(rawWs); } catch { resolvedRoot = path.resolve(rawWs); }
  }
  try {
    const result = await workspaceCLI(argv);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if (argv[0] === 'validate' && result?.ok === false) {
      process.exitCode = 1;
    }
  } catch (error) {
    const code = error.code ?? 'WORKSPACE_ERROR';
    const message = sanitizeMessage(error.message, resolvedRoot);
    process.stderr.write(`${JSON.stringify({ error: { code, message } })}\n`);
    process.exitCode = 1;
  }
}
