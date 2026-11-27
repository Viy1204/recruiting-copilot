import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { readConfig, readRoles, readRoleTable } from '../model.mjs';
import { resolveWorkspace } from './reader.mjs';
import {
  inspectRelativePath,
  readSafeWorkspaceFile,
  sanitizeWorkspaceMessage
} from './workspace-io.mjs';

const GLOBAL_SECTION_PATTERNS = [
  /公司与业务背景/,
  /产品/,
  /团队现状/,
  /招聘底层方法论/,
  /初筛硬规则/,
  /术语表/,
  /工作方式约定/,
  /商业化/
];

const EXCLUDED_SECTION_PATTERNS = [
  /招聘岗位状态/,
  /本次招聘岗位/,
  /在招岗位与优先级/,
  /面捕/,
  /已对齐/,
  /待定决策/,
  /产出/,
  /寻源工作流/
];

const SECTION_PREFIX = /^[一二三四五六七八九十百千\d]+[、.．:：\s]*/;

function appError(code, message, status = 400) {
  return Object.assign(new Error(message), { code, status });
}

async function readSafeWorkspaceText(root, relativePath, { required = false, label = relativePath } = {}) {
  const res = await readSafeWorkspaceFile(root, relativePath, { label, decode: true });
  if (res.status === 'missing') {
    if (required) throw appError('FILE_NOT_FOUND', `缺少必需文件：${relativePath}`, 404);
    return { status: 'missing', text: null, bytes: 0 };
  }
  if (res.status === 'unsafe') {
    throw appError('UNSAFE_WORKSPACE_PATH', res.message, 403);
  }
  if (res.status !== 'ok') {
    if (res.code === 'NOT_A_FILE') throw appError('UNSAFE_WORKSPACE_PATH', `${label}必须是工作区内的普通文件`, 403);
    throw appError(res.code ?? 'FILE_READ_ERROR', res.message ?? `无法读取 ${label}`, 422);
  }
  return { status: 'ok', text: res.text, bytes: res.bytes.length };
}

/**
 * Extracts only global workspace rules from CONTEXT.md, excluding per-role status and decision chronicles.
 * @param {string} contextText
 * @returns {string}
 */
export function extractGlobalContext(contextText) {
  if (typeof contextText !== 'string') return '';
  const clean = contextText.replace(/^\uFEFF/, '');
  const eol = clean.includes('\r\n') ? '\r\n' : '\n';
  const lines = clean.split(/\r?\n/);

  const sections = [];
  let current = null;
  let inFence = false;

  for (const line of lines) {
    if (/^\s*(?:```|~~~)/.test(line)) {
      inFence = !inFence;
    }
    const h2 = !inFence && /^##\s+(.+)$/.exec(line);
    if (h2) {
      if (current) sections.push(current);
      current = { heading: h2[1].trim(), lines: [line] };
      continue;
    }
    if (current) current.lines.push(line);
  }
  if (current) sections.push(current);

  const kept = [];
  for (const section of sections) {
    const stripped = section.heading.replace(SECTION_PREFIX, '').trim();
    const isExcluded = EXCLUDED_SECTION_PATTERNS.some(re => re.test(stripped) || re.test(section.heading));
    if (isExcluded) continue;
    const isGlobal = GLOBAL_SECTION_PATTERNS.some(re => re.test(stripped) || re.test(section.heading));
    if (!isGlobal) continue;
    while (section.lines.length > 1 && section.lines[section.lines.length - 1].trim() === '') {
      section.lines.pop();
    }
    kept.push(section.lines.join(eol));
  }

  return kept.join(`${eol}${eol}`);
}

function splitMarkdownCells(line) {
  return line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(cell => cell.trim());
}

function isSeparatorLine(line) {
  if (!line || !line.trim().startsWith('|')) return false;
  const cells = splitMarkdownCells(line);
  return cells.length > 0 && cells.every(cell => /^:?-{3,}:?$/.test(cell));
}

function extractRoundNumber(rowLine) {
  const cells = splitMarkdownCells(rowLine);
  for (const cell of cells.slice(0, 2)) {
    const m = /\bR(\d+)\b/i.exec(cell) || /^R(\d+)$/i.exec(cell);
    if (m) return Number(m[1]);
  }
  const fallback = /\bR(\d+)\b/i.exec(rowLine);
  return fallback ? Number(fallback[1]) : null;
}

function extractIsoDate(rowLine) {
  const cells = splitMarkdownCells(rowLine);
  for (const cell of cells.slice(0, 2)) {
    const m = /(\d{4}-\d{2}-\d{2})/.exec(cell);
    if (m) return m[1];
  }
  const fallback = /(\d{4}-\d{2}-\d{2})/.exec(rowLine);
  return fallback ? fallback[1] : null;
}

function isNewestFirst(firstRow, lastRow) {
  const rFirst = extractRoundNumber(firstRow);
  const rLast = extractRoundNumber(lastRow);
  if (rFirst !== null && rLast !== null && rFirst !== rLast) {
    return rFirst > rLast;
  }
  const dFirst = extractIsoDate(firstRow);
  const dLast = extractIsoDate(lastRow);
  if (dFirst !== null && dLast !== null && dFirst !== dLast) {
    return dFirst > dLast;
  }
  return false;
}

/**
 * Slices a legacy _internal document's keyword iteration table down to the latest N rounds.
 * @param {string} text
 * @param {{ maxRounds?: number }} [options]
 * @returns {{ text: string, omittedRounds: number, totalRounds: number }}
 */
export function sliceInternalDoc(text, { maxRounds = 2 } = {}) {
  if (typeof text !== 'string') throw appError('INVALID_INTERNAL_DOC', '对内档案内容必须是文本');
  if (!Number.isInteger(maxRounds) || maxRounds < 0) {
    throw appError('INVALID_MAX_ROUNDS', 'maxRounds 必须是非负整数');
  }
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);

  let sectionLevel = 0;
  let sectionStart = -1;
  let sectionEnd = lines.length;
  let inFence = false;

  for (let i = 0; i < lines.length; i++) {
    if (/^\s*(?:```|~~~)/.test(lines[i])) inFence = !inFence;
    if (inFence) continue;
    const heading = /^(#{1,6})\s+(.+)$/.exec(lines[i]);
    if (!heading) continue;
    const level = heading[1].length;
    if (sectionStart < 0) {
      if ((level === 2 || level === 3) && /(?:关键词迭代表|搜索词迭代表)/.test(heading[2])) {
        sectionStart = i;
        sectionLevel = level;
      }
    } else if (level <= sectionLevel) {
      sectionEnd = i;
      break;
    }
  }

  if (sectionStart < 0) {
    return { text, omittedRounds: 0, totalRounds: 0 };
  }

  let tableHeaderIdx = -1;
  let tableEndIdx = -1;
  for (let i = sectionStart + 1; i < sectionEnd; i++) {
    if (lines[i].trim().startsWith('|') && i + 1 < sectionEnd && isSeparatorLine(lines[i + 1])) {
      tableHeaderIdx = i;
      let j = i + 2;
      while (j < sectionEnd && lines[j].trim().startsWith('|')) j++;
      tableEndIdx = j;
      break;
    }
  }

  if (tableHeaderIdx < 0) {
    return { text, omittedRounds: 0, totalRounds: 0 };
  }

  const dataRows = lines.slice(tableHeaderIdx + 2, tableEndIdx);
  const totalRounds = dataRows.length;
  if (totalRounds <= maxRounds) {
    return { text, omittedRounds: 0, totalRounds };
  }

  const newestFirst = isNewestFirst(dataRows[0], dataRows[dataRows.length - 1]);
  const keptRows = maxRounds === 0
    ? []
    : newestFirst
      ? dataRows.slice(0, maxRounds)
      : dataRows.slice(totalRounds - maxRounds);
  const omittedRounds = totalRounds - keptRows.length;
  const notice = `> 已自动省略 ${omittedRounds} 轮历史关键词记录（仅保留最近 ${maxRounds} 轮）。`;

  const updatedLines = [
    ...lines.slice(0, tableHeaderIdx),
    notice,
    '',
    lines[tableHeaderIdx],
    lines[tableHeaderIdx + 1],
    ...keptRows,
    ...lines.slice(tableEndIdx)
  ];

  return { text: updatedLines.join(eol), omittedRounds, totalRounds };
}

function resolveSourcingLogRelativePath(row) {
  const sourcePath = row.internalPath || row.jdPath;
  if (!sourcePath) return null;
  const base = path.posix.basename(sourcePath.replace(/\\/g, '/'));
  const ext = path.posix.extname(base);
  const stem = ext ? base.slice(0, -ext.length) : base;
  if (!stem) return null;
  return `01-jd/_internal/logs/${stem}-sourcing-log.md`;
}

function renderRoleContextMarkdown({ role, globalContextText, internal, sourcingLog }) {
  const lines = [
    `# 岗位上下文切片：${role.name}${role.roleId ? ` (${role.roleId})` : ''}`,
    '',
    '## 目标岗位元数据',
    '',
    `- **role_id**：${role.roleId ?? '（未分配）'}`,
    `- **岗位名称**：${role.name}`,
    `- **优先级**：${role.priority ?? '（未设）'}`,
    `- **状态**：${role.status ?? '（未设）'}${role.statusNote ? `（${role.statusNote}）` : ''}`,
    `- **对外 JD**：${role.jdPath ?? '（未配置）'}`,
    `- **对内档案**：${role.internalPath ?? '（未配置）'}`,
    `- **最近变更**：${role.lastChange ?? '（无）'}`,
    `- **冷启动寻源日志**：${sourcingLog.path ? `${sourcingLog.path}（${sourcingLog.exists ? '已存在' : '未创建'}）` : '（未推断）'}`
  ];

  if (globalContextText) {
    lines.push('', '---', '', globalContextText);
  }

  lines.push('', '---', '', '## 目标岗位对内档案');
  if (internal.status === 'ok') {
    lines.push('', internal.text.trimEnd());
  } else {
    lines.push('', `> 对内档案当前缺失（路径：${internal.path ?? '未配置'}），请先通过 \`/recruit-grill\` 补齐或核对 \`CONTEXT.md\`。`);
  }

  return `${lines.join('\n')}\n`;
}

/**
 * Bundles global rules from CONTEXT.md, target role metadata, and sliced _internal doc for a single role.
 * @param {{ workspace: string, role: string, maxRounds?: number }} options
 */
export async function buildRoleContext({ workspace, role, maxRounds = 2 }) {
  if (typeof role !== 'string' || !role.trim()) {
    throw appError('ROLE_INPUT_INVALID', '必须指定目标岗位（--role）', 400);
  }
  const root = await resolveWorkspace(workspace);
  const contextRes = await readSafeWorkspaceText(root, 'CONTEXT.md', { required: true, label: 'CONTEXT.md' });
  const roleTable = readRoleTable(contextRes.text);
  const roles = readRoles(contextRes.text);

  let config = { schemaVersion: 1, statusStages: {}, roleAliases: {} };
  const configRes = await readSafeWorkspaceText(root, '_shared/recruit-board.config.json', {
    required: false,
    label: '_shared/recruit-board.config.json'
  });
  if (configRes.status === 'ok') {
    config = readConfig(configRes.text, roles);
  }

  const query = role.trim();
  const aliasedName = Object.hasOwn(config.roleAliases, query) ? config.roleAliases[query] : null;
  const targetRow = roleTable.rows.find(row => row.roleId === query)
    ?? roleTable.rows.find(row => row.name === query)
    ?? (aliasedName ? roleTable.rows.find(row => row.name === aliasedName) : null);

  if (!targetRow) {
    throw appError('ROLE_CONTEXT_NOT_FOUND', `未找到岗位：${query}`, 404);
  }

  const roleMeta = {
    roleId: targetRow.roleId,
    name: targetRow.name,
    priority: targetRow.priority,
    status: targetRow.status,
    rawStatus: targetRow.rawStatus,
    statusNote: targetRow.statusNote,
    jdPath: targetRow.jdPath,
    internalPath: targetRow.internalPath,
    lastChange: targetRow.lastChange
  };

  let internal = {
    status: 'missing',
    path: targetRow.internalPath,
    text: '',
    omittedRounds: 0,
    totalRounds: 0
  };
  if (targetRow.internalPath) {
    const internalRes = await readSafeWorkspaceText(root, targetRow.internalPath, {
      required: false,
      label: targetRow.internalPath
    });
    if (internalRes.status === 'ok') {
      const sliced = sliceInternalDoc(internalRes.text, { maxRounds });
      internal = {
        status: 'ok',
        path: targetRow.internalPath,
        text: sliced.text,
        omittedRounds: sliced.omittedRounds,
        totalRounds: sliced.totalRounds
      };
    }
  }

  const sourcingLogPath = resolveSourcingLogRelativePath(targetRow);
  let sourcingLogExists = false;
  if (sourcingLogPath) {
    const logCheck = await inspectRelativePath(root, sourcingLogPath);
    if (logCheck.status === 'unsafe') {
      throw appError('UNSAFE_WORKSPACE_PATH', logCheck.message, 403);
    }
    sourcingLogExists = logCheck.status === 'ok' && logCheck.info.isFile() && !logCheck.info.isSymbolicLink();
  }
  const sourcingLog = { path: sourcingLogPath, exists: sourcingLogExists };

  const globalContextText = extractGlobalContext(contextRes.text);
  const markdown = renderRoleContextMarkdown({
    role: roleMeta,
    globalContextText,
    internal,
    sourcingLog
  });

  return {
    role: roleMeta,
    globalContext: { text: globalContextText },
    internal,
    sourcingLog,
    stats: {
      contextBytes: contextRes.bytes,
      bundleBytes: Buffer.byteLength(markdown, 'utf8'),
      omittedRounds: internal.omittedRounds
    },
    markdown
  };
}

/**
 * CLI entrypoint for role-context.mjs.
 * @param {string[]} argv
 */
export async function roleContextCLI(argv) {
  const allowed = ['workspace', 'role', 'max-rounds', 'format'];
  const flags = {};
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i];
    const key = flag?.replace(/^--/, '');
    if (!flag?.startsWith('--') || !allowed.includes(key) || flags[key] !== undefined || !argv[i + 1] || argv[i + 1].startsWith('--')) {
      throw appError('INVALID_ARGS', `无效或重复参数：${flag ?? ''}`, 400);
    }
    flags[key] = argv[i + 1];
  }
  if (!flags.workspace) throw appError('MISSING_WORKSPACE', '必须显式指定 --workspace', 400);
  if (!flags.role) throw appError('MISSING_ROLE', '必须显式指定 --role', 400);

  let maxRounds = 2;
  if (flags['max-rounds'] !== undefined) {
    if (!/^\d+$/.test(flags['max-rounds'])) {
      throw appError('INVALID_MAX_ROUNDS', '--max-rounds 必须是非负整数', 400);
    }
    maxRounds = Number(flags['max-rounds']);
  }

  const format = flags.format ?? 'markdown';
  if (format !== 'markdown' && format !== 'json') {
    throw appError('INVALID_FORMAT', '--format 必须为 markdown 或 json', 400);
  }

  const result = await buildRoleContext({
    workspace: flags.workspace,
    role: flags.role,
    maxRounds
  });

  if (format === 'markdown') return result.markdown;
  const { markdown: _markdown, ...jsonResult } = result;
  return jsonResult;
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
    const output = await roleContextCLI(argv);
    if (typeof output === 'string') {
      process.stdout.write(output.endsWith('\n') ? output : `${output}\n`);
    } else {
      process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
    }
  } catch (error) {
    const code = error.code ?? 'ROLE_CONTEXT_ERROR';
    const message = sanitizeWorkspaceMessage(error.message, resolvedRoot);
    process.stderr.write(`${JSON.stringify({ error: { code, message } })}\n`);
    process.exitCode = 1;
  }
}
