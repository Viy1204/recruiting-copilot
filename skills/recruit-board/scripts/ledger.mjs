import { open } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import {
  CANONICAL_LEDGER_STATUSES,
  LEDGER_COLUMNS,
  parseCSV,
  readConfig,
  readRoles,
  readRoleTable,
  stageForStatus,
  TERMINAL_STAGE_IDS
} from '../model.mjs';
import { MAX_FILE_BYTES, resolveWorkspace } from './reader.mjs';
import {
  decodeTextWithMeta,
  decodeUTF8Strict,
  ensureSafeDirectory as ensureWorkspaceDirectory,
  readSafeWorkspaceFile,
  withWorkspaceLock,
  WORKSPACE_LOCK_FILES,
  writeAtomicFile
} from './workspace-io.mjs';

const CONTACTED_STAGES = new Set(['talking', 'decision', 'interview', 'offer', ...TERMINAL_STAGE_IDS]);

const ledgerError = (code, message, status = 400, exitCode = 1) =>
  Object.assign(new Error(message), { code, status, exitCode });

const normalizeName = value => value.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();

function escapeCsvCell(value) {
  const str = String(value ?? '');
  if (/[",\r\n]/.test(str)) return `"${str.replace(/"/g, '""')}"`;
  return str;
}

export function serializeCSV(header, rows, { bom = true, eol = '\r\n' } = {}) {
  const lines = [header, ...rows].map(row => row.map(escapeCsvCell).join(','));
  return `${bom ? '\uFEFF' : ''}${lines.join(eol)}${eol}`;
}

function detectCsvFormat(bytes, text) {
  const bom = bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
  const firstNewline = text.indexOf('\n');
  const eol = firstNewline > 0 && text[firstNewline - 1] === '\r'
    ? '\r\n'
    : firstNewline >= 0
      ? '\n'
      : '\r\n';
  return { bom, eol };
}

const decodeText = (bytes, label = '文件') =>
  decodeTextWithMeta(bytes, { label, code: 'LEDGER_ENCODING_INVALID', status: 422 }).text;

const decodeUTF8 = (bytes, label = '台账文件') =>
  decodeUTF8Strict(bytes, { label, code: 'LEDGER_CSV_INVALID', status: 422 });

async function resolveSafeWorkspace(workspace) {
  if (typeof workspace !== 'string' || !workspace.trim()) {
    throw ledgerError('LEDGER_INPUT_INVALID', '必须显式指定 --workspace', 400);
  }
  try {
    return await resolveWorkspace(workspace);
  } catch {
    throw ledgerError('LEDGER_WORKSPACE_INVALID', '工作区必须是存在的目录', 400);
  }
}

const ensureSafeDirectory = (root, parts, create = false) =>
  ensureWorkspaceDirectory(root, parts, { create, code: 'WORKSPACE_PATH_UNSAFE', status: 422 });

async function readSafeFile(root, dirParts, filename) {
  const relativePath = [...dirParts, filename].join('/');
  const res = await readSafeWorkspaceFile(root, relativePath, { label: filename });
  if (res.status === 'missing') return null;
  if (res.status === 'ok') return { file: res.file, info: res.info, bytes: res.bytes };
  if (res.code === 'FILE_TOO_LARGE') {
    throw ledgerError('LEDGER_FILE_TOO_LARGE', '文件超过读取大小上限', 422);
  }
  throw ledgerError('WORKSPACE_PATH_UNSAFE', res.message ?? '目标文件必须是工作区内的普通文件且不得为符号链接', 422);
}

async function loadRoleIndex(root, { requireContext = true } = {}) {
  const contextEntry = await readSafeFile(root, [], 'CONTEXT.md');
  if (!contextEntry && requireContext) {
    throw ledgerError('CONTEXT_MISSING', '未找到 CONTEXT.md，无法解析在招岗位配置', 404);
  }
  let table = null;
  let roles = [];
  if (contextEntry) {
    const contextText = decodeText(contextEntry.bytes, 'CONTEXT.md');
    try {
      table = readRoleTable(contextText);
      roles = readRoles(contextText);
    } catch (error) {
      throw ledgerError('CONTEXT_INVALID', error.message, 422);
    }
  }

  const configEntry = await readSafeFile(root, ['_shared'], 'recruit-board.config.json');
  let config = { schemaVersion: 1, statusStages: {}, roleAliases: {} };
  if (configEntry) {
    const configText = decodeText(configEntry.bytes, '兼容配置');
    try {
      if (contextEntry) {
        config = readConfig(configText, roles);
      } else {
        const raw = JSON.parse(configText.replace(/^\uFEFF/, ''));
        config = readConfig(JSON.stringify({ ...raw, roleAliases: {} }), []);
      }
    } catch (error) {
      throw ledgerError(error.code ?? 'CONFIG_INVALID', error.message, 422);
    }
  }

  const rolesByName = new Map();
  const rolesById = new Map();
  for (const row of table?.rows ?? []) {
    const entry = {
      roleId: row.roleId ?? null,
      canonicalRole: row.name,
      status: row.status,
      priority: row.priority
    };
    rolesByName.set(row.name, entry);
    if (row.roleId && !rolesById.has(row.roleId)) {
      rolesById.set(row.roleId, entry);
    }
  }

  return { table, roles, config, rolesByName, rolesById };
}

function resolveRole(query, roleIndex) {
  const trimmed = typeof query === 'string' ? query.trim() : '';
  if (!trimmed) {
    throw ledgerError('LEDGER_ROLE_UNKNOWN', '岗位参数不能为空', 400);
  }
  if (roleIndex.rolesById.has(trimmed)) {
    return roleIndex.rolesById.get(trimmed);
  }
  if (roleIndex.rolesByName.has(trimmed)) {
    return roleIndex.rolesByName.get(trimmed);
  }
  if (Object.hasOwn(roleIndex.config.roleAliases, trimmed)) {
    const targetName = roleIndex.config.roleAliases[trimmed];
    if (roleIndex.rolesByName.has(targetName)) {
      return roleIndex.rolesByName.get(targetName);
    }
  }
  throw ledgerError(
    'LEDGER_ROLE_UNKNOWN',
    `未找到岗位「${trimmed}」，请使用 CONTEXT.md 中的 role_id、标准岗位名或已配置别名`,
    400
  );
}

function resolveRawRole(rawRole, roleIndex) {
  const trimmed = rawRole.trim();
  if (roleIndex.rolesByName.has(trimmed)) {
    return { canonicalRole: trimmed, roleId: roleIndex.rolesByName.get(trimmed).roleId };
  }
  if (Object.hasOwn(roleIndex.config.roleAliases, trimmed)) {
    const targetName = roleIndex.config.roleAliases[trimmed];
    return {
      canonicalRole: targetName,
      roleId: roleIndex.rolesByName.get(targetName)?.roleId ?? null
    };
  }
  if (roleIndex.rolesById.has(trimmed)) {
    const entry = roleIndex.rolesById.get(trimmed);
    return { canonicalRole: entry.canonicalRole, roleId: entry.roleId };
  }
  return { canonicalRole: trimmed, roleId: null };
}

const LEGACY_TERMINAL_PREFIX = /^(?:已排除|初筛不合适|已拒|已放弃|已归档|已结束|已入职|非本项目)(?:$|[-—–·\s（(])/;

function isTerminalStatus(status, stage) {
  return TERMINAL_STAGE_IDS.includes(stage) || (stage === 'unclassified' && LEGACY_TERMINAL_PREFIX.test(status));
}

function formatMatchRow(cells, rowNum, roleIndex) {
  const rawRole = cells[2].trim();
  const resolved = resolveRawRole(rawRole, roleIndex);
  const status = cells[5].trim();
  const stage = stageForStatus(status, roleIndex.config.statusStages);
  return {
    rowNum,
    seq: cells[0].trim(),
    name: cells[1].trim(),
    rawRole,
    roleId: resolved.roleId,
    canonicalRole: resolved.canonicalRole,
    bg: cells[3].trim(),
    rating: cells[4].trim(),
    status,
    stage,
    terminal: isTerminalStatus(status, stage),
    round: cells[6].trim(),
    resume: cells[7].trim(),
    note: cells[8].trim()
  };
}

async function readLedgerRows(root) {
  const entry = await readSafeFile(root, ['02-sourcing'], 'dedup-ledger.csv');
  if (!entry) {
    return { exists: false, file: null, originalBytes: null, bom: true, eol: '\r\n', rows: [] };
  }
  const text = decodeUTF8(entry.bytes, '台账文件');
  const { bom, eol } = detectCsvFormat(entry.bytes, text);
  let rows;
  try {
    rows = parseCSV(text);
  } catch (error) {
    throw ledgerError('LEDGER_CSV_INVALID', error.message, 422);
  }
  return {
    exists: true,
    file: entry.file,
    mode: entry.info.mode & 0o777,
    originalBytes: entry.bytes,
    bom,
    eol,
    rows
  };
}

export async function listStatuses(workspace) {
  const root = await resolveSafeWorkspace(workspace);
  const { config } = await loadRoleIndex(root, { requireContext: false });
  const statusStages = config.statusStages;
  return {
    statuses: CANONICAL_LEDGER_STATUSES.map(status => {
      const stage = stageForStatus(status, statusStages);
      return {
        status,
        stage,
        terminal: TERMINAL_STAGE_IDS.includes(stage)
      };
    })
  };
}

export async function lookupCandidates({ workspace, name, role } = {}) {
  const root = await resolveSafeWorkspace(workspace);
  const nameQuery = typeof name === 'string' && name.trim() ? name.trim() : null;
  const roleQuery = typeof role === 'string' && role.trim() ? role.trim() : null;
  if (!nameQuery && !roleQuery) {
    throw ledgerError('LEDGER_INPUT_INVALID', 'lookup 必须至少提供 --name 或 --role', 400);
  }

  const roleIndex = await loadRoleIndex(root, { requireContext: true });
  const targetRole = roleQuery ? resolveRole(roleQuery, roleIndex) : null;
  const normalizedQuery = nameQuery ? normalizeName(nameQuery) : null;
  const { rows } = await readLedgerRows(root);

  const matches = [];
  for (let i = 0; i < rows.length; i++) {
    const item = formatMatchRow(rows[i], i + 2, roleIndex);
    if (normalizedQuery && !normalizeName(item.name).includes(normalizedQuery)) continue;
    if (targetRole && item.canonicalRole !== targetRole.canonicalRole) continue;
    matches.push(item);
  }

  return {
    query: {
      name: nameQuery,
      roleId: targetRole?.roleId ?? null,
      canonicalRole: targetRole?.canonicalRole ?? null
    },
    count: matches.length,
    hasTerminalOrContacted: matches.some(item => item.terminal || CONTACTED_STAGES.has(item.stage)),
    matches
  };
}

export async function upsertCandidate({
  workspace,
  role,
  name,
  status,
  bg,
  rating,
  round,
  resume,
  note,
  replaceNote = false,
  forceUpdate = false,
  dryRun = false
} = {}) {
  const root = await resolveSafeWorkspace(workspace);
  const candidateName = typeof name === 'string' ? name.trim() : '';
  if (!candidateName) {
    throw ledgerError('LEDGER_INPUT_INVALID', '必须提供非空候选人姓名 (--name)', 400);
  }

  const trimmedStatus = typeof status === 'string' ? status.trim() : '';
  if (!CANONICAL_LEDGER_STATUSES.includes(trimmedStatus)) {
    throw ledgerError(
      'LEDGER_STATUS_INVALID',
      `无效状态「${trimmedStatus}」，请使用标准状态（${CANONICAL_LEDGER_STATUSES.join('、')}），细节请写入 --note`,
      400
    );
  }

  const roleIndex = await loadRoleIndex(root, { requireContext: true });
  const targetRole = resolveRole(role, roleIndex);

  const optionalString = value => (value === undefined || value === null ? undefined : String(value).trim());
  const nextBg = optionalString(bg);
  const nextRating = optionalString(rating);
  const nextRound = optionalString(round);
  const nextResume = optionalString(resume);
  const nextNote = optionalString(note);

  const execute = async () => {
    const ledger = await readLedgerRows(root);
    const sameRoleMatches = [];
    const otherRoleMatches = [];

    for (let i = 0; i < ledger.rows.length; i++) {
      const cells = ledger.rows[i];
      const formatted = formatMatchRow(cells, i + 2, roleIndex);
      if (formatted.name !== candidateName) continue;
      if (formatted.canonicalRole === targetRole.canonicalRole) {
        sameRoleMatches.push({ index: i, cells, formatted });
      } else {
        otherRoleMatches.push(formatted);
      }
    }

    if (sameRoleMatches.length > 1) {
      throw ledgerError(
        'LEDGER_DUPLICATE_EXISTS',
        `台账中已存在 ${sameRoleMatches.length} 条「${candidateName} / ${targetRole.canonicalRole}」重复记录，请先人工核对合并`,
        409,
        2
      );
    }

    let action;
    let nextRow;
    let targetRowNum;
    let previousStatus = null;
    let nextRows;

    if (sameRoleMatches.length === 1) {
      action = 'update';
      const match = sameRoleMatches[0];
      const prev = match.cells;
      previousStatus = match.formatted.status;
      if (match.formatted.terminal && !forceUpdate) {
        throw ledgerError(
          'LEDGER_TERMINAL_BLOCKED',
          `候选人「${candidateName}」当前处于终态「${previousStatus}」（阶段：${match.formatted.stage}），已阻止覆盖；如确需修改请传 --force-update`,
          409,
          3
        );
      }

      let mergedNote = prev[8];
      if (nextNote !== undefined) {
        if (replaceNote || !prev[8].trim()) mergedNote = nextNote;
        else if (nextNote) mergedNote = `${prev[8]}；${nextNote}`;
      }

      nextRow = [
        prev[0],
        prev[1].trim(),
        prev[2],
        nextBg !== undefined ? nextBg : prev[3],
        nextRating !== undefined ? nextRating : prev[4],
        trimmedStatus,
        nextRound !== undefined ? nextRound : prev[6],
        nextResume !== undefined ? nextResume : prev[7],
        mergedNote
      ];
      targetRowNum = match.formatted.rowNum;
      nextRows = ledger.rows.map((row, index) => (index === match.index ? nextRow : row));
    } else {
      action = 'insert';
      if (!nextBg) {
        throw ledgerError('LEDGER_INPUT_INVALID', '新增候选人必须提供 --bg（现职/背景）', 400);
      }
      let maxSeq = 0;
      for (const row of ledger.rows) {
        const parsedSeq = Number.parseInt(row[0].trim(), 10);
        if (Number.isSafeInteger(parsedSeq) && parsedSeq > maxSeq) maxSeq = parsedSeq;
      }
      const seq = String(maxSeq + 1);
      nextRow = [
        seq,
        candidateName,
        targetRole.canonicalRole,
        nextBg,
        nextRating ?? '',
        trimmedStatus,
        nextRound ?? '',
        nextResume ?? '',
        nextNote ?? ''
      ];
      targetRowNum = ledger.rows.length + 2;
      nextRows = [...ledger.rows, nextRow];
    }

    const nextText = serializeCSV(LEDGER_COLUMNS, nextRows, { bom: ledger.bom, eol: ledger.eol });
    const nextBytes = Buffer.from(nextText, 'utf8');
    if (nextBytes.length > MAX_FILE_BYTES) {
      throw ledgerError('LEDGER_FILE_TOO_LARGE', '写入后的台账超过文件大小上限', 422);
    }

    let verifiedRows;
    try {
      verifiedRows = parseCSV(nextText);
    } catch (error) {
      throw ledgerError('LEDGER_CSV_VERIFY_FAILED', `写入前 CSV 校验失败：${error.message}`, 500);
    }
    const exactMatch = verifiedRows.length === nextRows.length &&
      verifiedRows.every((row, i) => row.length === 9 && row.every((cell, j) => cell === nextRows[i][j]));
    if (!exactMatch) {
      throw ledgerError('LEDGER_CSV_VERIFY_FAILED', '写入前 CSV 校验发现内容不一致，已中止写入', 500);
    }

    const stage = stageForStatus(trimmedStatus, roleIndex.config.statusStages);
    const result = {
      ok: true,
      dryRun: Boolean(dryRun),
      action,
      candidateId: JSON.stringify([nextRow[1].trim(), nextRow[2].trim()]),
      rowNum: targetRowNum,
      seq: nextRow[0].trim(),
      name: nextRow[1].trim(),
      rawRole: nextRow[2].trim(),
      roleId: targetRole.roleId,
      canonicalRole: targetRole.canonicalRole,
      previousStatus,
      status: trimmedStatus,
      stage,
      terminal: TERMINAL_STAGE_IDS.includes(stage),
      row: {
        seq: nextRow[0],
        name: nextRow[1],
        rawRole: nextRow[2],
        bg: nextRow[3],
        rating: nextRow[4],
        status: nextRow[5],
        round: nextRow[6],
        resume: nextRow[7],
        note: nextRow[8]
      },
      otherRoleMatches,
      backup: null,
      totalRows: nextRows.length
    };

    if (dryRun) return result;

    const sourcingDir = await ensureSafeDirectory(root, ['02-sourcing'], true);
    const backupsDir = await ensureSafeDirectory(root, ['runtime', 'recruit-board', 'backups'], true);

    if (ledger.originalBytes !== null) {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const backupFile = path.join(backupsDir, `dedup-ledger-${stamp}-${randomUUID()}.csv`);
      const backupHandle = await open(backupFile, 'wx');
      try {
        await backupHandle.writeFile(ledger.originalBytes);
        await backupHandle.sync();
      } finally {
        await backupHandle.close();
      }
      result.backup = path.relative(root, backupFile).split(path.sep).join('/');
    }

    const targetFile = path.join(sourcingDir, 'dedup-ledger.csv');
    await writeAtomicFile(targetFile, nextBytes, {
      mode: ledger.mode ?? 0o600,
      tempPrefix: '.dedup-ledger'
    });

    return result;
  };

  if (dryRun) return execute();
  return withWorkspaceLock(root, WORKSPACE_LOCK_FILES.ledger, execute, {
    lockedCode: 'LEDGER_LOCKED',
    lockedMessage: '台账正在写入或存在未释放的锁，请稍后重试',
    unsafeCode: 'WORKSPACE_PATH_UNSAFE',
    unsafeStatus: 422,
    exitCode: 1
  });
}

const VALUE_FLAGS = {
  statuses: ['workspace'],
  lookup: ['workspace', 'name', 'role', 'role-id'],
  upsert: ['workspace', 'role', 'role-id', 'name', 'status', 'bg', 'rating', 'round', 'resume', 'note']
};

const BOOL_FLAGS = {
  statuses: [],
  lookup: [],
  upsert: ['replace-note', 'force-update', 'dry-run']
};

function parseFlags(command, args) {
  const valueKeys = VALUE_FLAGS[command];
  const boolKeys = BOOL_FLAGS[command];
  if (!valueKeys) {
    throw ledgerError(
      'LEDGER_INPUT_INVALID',
      '用法：ledger.mjs statuses|lookup|upsert --workspace <目录> [参数]',
      400
    );
  }
  const flags = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg.startsWith('--')) {
      throw ledgerError('LEDGER_INPUT_INVALID', `无效参数：${arg}`, 400);
    }
    const key = arg.slice(2);
    if (boolKeys.includes(key)) {
      if (Object.hasOwn(flags, key)) {
        throw ledgerError('LEDGER_INPUT_INVALID', `重复参数：${arg}`, 400);
      }
      flags[key] = true;
      continue;
    }
    if (!valueKeys.includes(key)) {
      throw ledgerError('LEDGER_INPUT_INVALID', `未知参数：${arg}`, 400);
    }
    if (Object.hasOwn(flags, key)) {
      throw ledgerError('LEDGER_INPUT_INVALID', `重复参数：${arg}`, 400);
    }
    const value = args[i + 1];
    if (value === undefined || value.startsWith('--')) {
      throw ledgerError('LEDGER_INPUT_INVALID', `参数 ${arg} 缺少取值`, 400);
    }
    flags[key] = value;
    i++;
  }
  if (!flags.workspace) {
    throw ledgerError('LEDGER_INPUT_INVALID', '必须显式指定 --workspace', 400);
  }
  if (flags.role !== undefined && flags['role-id'] !== undefined) {
    throw ledgerError('LEDGER_INPUT_INVALID', '不能同时指定 --role 和 --role-id', 400);
  }
  return flags;
}

export async function ledgerCLI(argv) {
  const [command, ...args] = argv;
  const flags = parseFlags(command, args);
  const role = flags.role ?? flags['role-id'];

  if (command === 'statuses') {
    return listStatuses(flags.workspace);
  }
  if (command === 'lookup') {
    return lookupCandidates({ workspace: flags.workspace, name: flags.name, role });
  }
  if (command === 'upsert') {
    if (!role) throw ledgerError('LEDGER_INPUT_INVALID', 'upsert 必须指定 --role 或 --role-id', 400);
    if (!flags.name) throw ledgerError('LEDGER_INPUT_INVALID', 'upsert 必须指定 --name', 400);
    if (!flags.status) throw ledgerError('LEDGER_INPUT_INVALID', 'upsert 必须指定 --status', 400);
    return upsertCandidate({
      workspace: flags.workspace,
      role,
      name: flags.name,
      status: flags.status,
      bg: flags.bg,
      rating: flags.rating,
      round: flags.round,
      resume: flags.resume,
      note: flags.note,
      replaceNote: Boolean(flags['replace-note']),
      forceUpdate: Boolean(flags['force-update']),
      dryRun: Boolean(flags['dry-run'])
    });
  }
  throw ledgerError('LEDGER_INPUT_INVALID', `未知子命令：${command ?? ''}`, 400);
}

function sanitizeErrorMessage(message, argv) {
  let clean = String(message ?? '');
  const wsIndex = argv.indexOf('--workspace');
  if (wsIndex >= 0 && argv[wsIndex + 1]) {
    const rawWs = argv[wsIndex + 1];
    const resolvedWs = path.resolve(rawWs);
    for (const candidate of new Set([resolvedWs, rawWs, resolvedWs.replaceAll('\\', '/')])) {
      if (candidate) clean = clean.split(candidate).join('<workspace>');
    }
  }
  clean = clean.replace(/[A-Za-z]:\\[^\s'"]+/g, '<path>');
  return clean;
}

function formatLedgerError(error, argv) {
  const code = typeof error?.code === 'string' && /^[A-Z_]+$/.test(error.code)
    ? error.code
    : 'LEDGER_FAILED';
  const knownDomain = Boolean(error?.status) || /^(LEDGER|CONTEXT|CONFIG|ROLE|WORKSPACE)_/.test(code);
  const message = knownDomain
    ? sanitizeErrorMessage(error.message, argv)
    : '台账操作失败，请检查工作区文件和参数';
  return { error: { code, message } };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const argv = process.argv.slice(2);
  try {
    const output = await ledgerCLI(argv);
    process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${JSON.stringify(formatLedgerError(error, argv))}\n`);
    process.exitCode = error?.exitCode ?? 1;
  }
}
