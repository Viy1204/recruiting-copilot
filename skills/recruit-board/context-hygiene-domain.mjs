import { createHash } from 'node:crypto';

export const DEFAULT_MAX_BYTES = 16 * 1024;
export const DEFAULT_MAX_LINES = 200;
export const DEFAULT_MAX_DECISIONS = 15;
export const DEFAULT_KEEP_RECENT = 10;

const COLD_ARCHIVE_POINTER = '> 历史决策已归档至 `runtime/decisions-log/`（冷审计日志，日常开工默认不读，仅追溯时查阅）。';
const DECISION_SCOPES = Object.freeze(['workspace', 'role', 'channel', 'policy', 'other']);
const COLD_DECISION_FIELDS = Object.freeze(['id', 'date', 'scope', 'summary', 'previousValue', 'newValue', 'reason', 'authority', 'targetFile']);

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const inputError = (code, message, status = 400) => Object.assign(new Error(message), { code, status });
const finding = (code, level, message, extra = {}) => ({ code, level, message, ...extra });

function singleLineText(value, label, max = 300) {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\x00-\x1f\x7f\u0085\p{Zl}\p{Zp}]/u.test(value)) {
    throw inputError('CONTEXT_HYGIENE_INPUT_INVALID', `${label} 必须为 1–${max} 字符的单行文本`);
  }
  return value.trim();
}

function optionalSingleLineText(value, label, max = 300) {
  if (value === undefined || value === null || value === '') return null;
  return singleLineText(value, label, max);
}

export function detectLineEnding(text) {
  return text.includes('\r\n') ? '\r\n' : '\n';
}

export function parseContextSections(text) {
  const normalized = text.replace(/^\uFEFF/, '');
  const lines = normalized.split(/\r?\n/);
  const sections = [];
  let current = null;

  for (let index = 0; index < lines.length; index++) {
    const match = /^(#{1,6})\s+(.+)$/.exec(lines[index]);
    if (match && match[1].length === 2) {
      if (current) {
        current.endLine = index; // exclusive, 0-based
        sections.push(current);
      }
      current = {
        title: match[2].trim(),
        headingLine: index,
        startLine: index + 1,
        endLine: lines.length
      };
    }
  }
  if (current) sections.push(current);

  return sections.map(section => {
    const bodyLines = lines.slice(section.startLine, section.endLine);
    const fullLines = lines.slice(section.headingLine, section.endLine);
    return {
      ...section,
      lineCount: fullLines.length,
      bytes: Buffer.byteLength(fullLines.join('\n'), 'utf8'),
      bodyLines,
      bodyText: bodyLines.join('\n')
    };
  });
}

export function inspectRolesTableIntegrity(text) {
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/);
  let inSection = false;
  let tableStart = -1;
  let headerCount = 0;
  let parsedRows = 0;
  let tableEnded = false;
  let blankSplits = 0;
  let trailingRows = 0;
  const splitLines = [];

  for (let i = 0; i < lines.length; i++) {
    const heading = /^(#{1,6})\s+(.+)$/.exec(lines[i]);
    if (heading) {
      if (inSection) break;
      if (/^(?:[一二三四五六七八九十\d]+[、.．]\s*)?在招岗位与优先级$/.test(heading[2].trim())) {
        inSection = true;
      }
      continue;
    }
    if (!inSection) continue;
    const trimmed = lines[i].trim();
    if (tableStart < 0) {
      if (!trimmed.startsWith('|')) continue;
      const cells = trimmed.replace(/^\|/, '').replace(/\|$/, '').split('|').map(c => c.trim());
      if (['岗位', '优先级', '状态'].every(col => cells.includes(col)) && lines[i + 1]) {
        const sep = lines[i + 1].trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(c => c.trim());
        if (sep.every(cell => /^:?-{3,}:?$/.test(cell))) {
          tableStart = i;
          headerCount = cells.length;
          i++; // skip separator
        }
      }
      continue;
    }
    if (!tableEnded) {
      if (trimmed.startsWith('|')) {
        parsedRows++;
      } else {
        tableEnded = true;
        if (trimmed === '') {
          // Check if another table row with the same column structure follows
          for (let k = i + 1; k < lines.length; k++) {
            const nextHeading = /^(#{1,6})\s+/.exec(lines[k]);
            if (nextHeading) break;
            const nextTrim = lines[k].trim();
            if (!nextTrim) continue;
            if (nextTrim.startsWith('|')) {
              const nextCells = nextTrim.replace(/^\|/, '').replace(/\|$/, '').split('|');
              if (nextCells.length === headerCount) {
                blankSplits++;
                splitLines.push(i + 1); // 1-based line number
              }
            }
            break;
          }
        }
      }
    } else if (trimmed.startsWith('|')) {
      const cells = trimmed.replace(/^\|/, '').replace(/\|$/, '').split('|');
      if (cells.length === headerCount) trailingRows++;
    }
  }

  return {
    found: tableStart >= 0,
    parsedRows,
    blankSplits,
    trailingRows,
    splitLines,
    truncated: blankSplits > 0 || trailingRows > 0
  };
}

const isDecisionSection = title => /^(?:[一二三四五六七八九十\d]+[、.．]\s*)?已对齐决策(?:[（(][^）)]*[）)])?$/.test(title.trim());

export function extractDecisionEntries(sectionBodyLines) {
  const preamble = [];
  const entries = [];
  let current = null;

  for (let i = 0; i < sectionBodyLines.length; i++) {
    const line = sectionBodyLines[i];
    const isBullet = /^-\s+/.test(line);
    if (isBullet) {
      if (current) entries.push(current);
      const body = line.replace(/^-\s+/, '').trim();
      const isPlaceholder = /^（无）$|^\(无\)$/.test(body);
      const dateMatch = /\b(\d{4}-\d{2}-\d{2})\b/.exec(body) || /\bD-(\d{4})(\d{2})(\d{2})-\d+\b/.exec(body);
      let date = null;
      if (dateMatch) {
        date = dateMatch.length === 2 ? dateMatch[1] : `${dateMatch[1]}-${dateMatch[2]}-${dateMatch[3]}`;
      }
      current = {
        lines: [line],
        date,
        isPlaceholder
      };
      continue;
    }
    if (current) {
      // Attach indented continuation lines or blank lines only if followed by indented text
      if (/^\s+\S/.test(line)) {
        current.lines.push(line);
      } else {
        entries.push(current);
        current = null;
        if (!line.includes('runtime/decisions-log/')) preamble.push(line);
      }
    } else {
      if (!line.includes('runtime/decisions-log/')) preamble.push(line);
    }
  }
  if (current) entries.push(current);

  const realEntries = entries.filter(entry => !entry.isPlaceholder).map(entry => {
    const rawText = entry.lines.join('\n').trimEnd();
    const hash = createHash('sha256').update(rawText).digest('hex').slice(0, 12);
    return { ...entry, text: rawText, hash };
  });

  return { preamble, entries: realEntries };
}

export function auditContext(text, {
  maxBytes = DEFAULT_MAX_BYTES,
  maxLines = DEFAULT_MAX_LINES,
  maxDecisions = DEFAULT_MAX_DECISIONS
} = {}) {
  const normalized = text.replace(/^\uFEFF/, '');
  const bytes = Buffer.byteLength(normalized, 'utf8');
  const lines = normalized.split(/\r?\n/);
  const sections = parseContextSections(normalized);
  const rolesTable = inspectRolesTableIntegrity(normalized);
  const decisionSection = sections.find(section => isDecisionSection(section.title)) ?? null;
  const decisionCount = decisionSection ? extractDecisionEntries(decisionSection.bodyLines).entries.length : 0;

  const findings = [];
  if (bytes > maxBytes) {
    findings.push(finding(
      'CONTEXT_SIZE_BUDGET',
      'warning',
      `CONTEXT.md 当前体积 ${bytes} 字节，已超过建议上限 ${maxBytes} 字节；建议将历史决策归档至 runtime/decisions-log/，并将执行战报留在 runtime/reports/`
    ));
  }
  if (lines.length > maxLines) {
    findings.push(finding(
      'CONTEXT_LINE_BUDGET',
      'warning',
      `CONTEXT.md 当前共 ${lines.length} 行，已超过建议上限 ${maxLines} 行`
    ));
  }
  if (decisionCount > maxDecisions) {
    findings.push(finding(
      'DECISIONS_UNARCHIVED',
      'warning',
      `「已对齐决策」当前保留 ${decisionCount} 条（建议上限 ${maxDecisions} 条），可执行 archive-decisions 将旧决策归档到冷日志`
    ));
  }
  if (rolesTable.truncated) {
    findings.push(finding(
      'ROLES_TABLE_TRUNCATED',
      'error',
      `「在招岗位与优先级」表格疑似被空行或中断行截断（已解析 ${rolesTable.parsedRows} 行，其后残留 ${rolesTable.trailingRows} 行表格数据；空行位置：L${rolesTable.splitLines.join(', L')}），看板将漏读后续岗位`,
      { lines: rolesTable.splitLines, parsedRows: rolesTable.parsedRows, trailingRows: rolesTable.trailingRows }
    ));
  }

  // Detect stacked prose override directives across multiple sections
  const overrideSections = sections.filter(section => /(以本节为准|冲突时[，,]?以本节|覆写下文|覆盖本文件)/.test(section.bodyText));
  if (overrideSections.length >= 2) {
    findings.push(finding(
      'OVERRIDE_LAYER_STACK',
      'warning',
      `检测到 ${overrideSections.length} 个小节同时声明「冲突时以本节为准」（${overrideSections.map(s => s.title).join('、')}），建议原地更新生效条款而非叠加覆写层`,
      { sections: overrideSections.map(s => s.title) }
    ));
  }

  // Detect execution battle reports / script backup filenames leaking into hot policy
  const pollutionLines = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/(?:\d{2}:\d{2}\s*(?:BOSS|猎聘|智联|51job)|批量打招呼\s*\*?\*?\d+|批次全部「成功|\.bak-[a-z0-9-]+)/i.test(line)) {
      pollutionLines.push(i + 1);
    }
  }
  if (pollutionLines.length > 0) {
    findings.push(finding(
      'EXECUTION_LOG_POLLUTION',
      'warning',
      `检测到 ${pollutionLines.length} 行疑似单次执行战报或脚本补丁备份记录（如 L${pollutionLines.slice(0, 5).join(', L')}）；执行过程应记入 runtime/reports/，不要写入 CONTEXT.md`,
      { count: pollutionLines.length, sampleLines: pollutionLines.slice(0, 10) }
    ));
  }

  // Detect contradictory dead-rule annotations left inside active rules
  const deadRuleLines = [];
  for (let i = 0; i < lines.length; i++) {
    if (/(?:AI\s*\*?\*?一律不执行|AI\s*\*?\*?不执行|待用户确认后删除)/.test(lines[i])) {
      deadRuleLines.push(i + 1);
    }
  }
  if (deadRuleLines.length > 0) {
    findings.push(finding(
      'DEPRECATED_RULE_RESIDUE',
      'warning',
      `检测到 ${deadRuleLines.length} 处带有「不执行 / 待删除」标注的失效条款残留（L${deadRuleLines.slice(0, 5).join(', L')}），建议直接物理删除以免长上下文误触发`,
      { count: deadRuleLines.length, sampleLines: deadRuleLines.slice(0, 10) }
    ));
  }

  const hasError = findings.some(item => item.level === 'error');
  const hasWarning = findings.some(item => item.level === 'warning');
  const status = hasError ? 'error' : hasWarning ? 'warning' : 'ok';

  return {
    status,
    healthy: !hasError && !hasWarning,
    metrics: {
      bytes,
      lines: lines.length,
      decisionCount,
      rolesTable,
      sections: sections.map(section => ({
        title: section.title,
        lines: section.lineCount,
        bytes: section.bytes,
        share: bytes > 0 ? Number((section.bytes / bytes).toFixed(4)) : 0
      }))
    },
    findings
  };
}

export function planDecisionArchive(text, { keepRecent = DEFAULT_KEEP_RECENT, beforeDate = null } = {}) {
  if (!Number.isSafeInteger(keepRecent) || keepRecent < 0) {
    throw inputError('CONTEXT_HYGIENE_INPUT_INVALID', 'keepRecent 必须为非负整数');
  }
  if (beforeDate !== null && !/^\d{4}-\d{2}-\d{2}$/.test(beforeDate)) {
    throw inputError('CONTEXT_HYGIENE_INPUT_INVALID', 'beforeDate 必须为 YYYY-MM-DD 格式');
  }
  const eol = detectLineEnding(text);
  const hadBom = text.startsWith('\uFEFF');
  const clean = hadBom ? text.slice(1) : text;
  const lines = clean.split(/\r?\n/);
  const sections = parseContextSections(clean);
  const section = sections.find(item => isDecisionSection(item.title));
  if (!section) {
    throw inputError('DECISION_SECTION_MISSING', '未找到「已对齐决策」小节，无法执行决策归档', 422);
  }

  const { preamble, entries } = extractDecisionEntries(section.bodyLines);
  const toArchive = [];
  const toKeep = [];

  if (beforeDate !== null) {
    for (const entry of entries) {
      if (entry.date && entry.date < beforeDate) toArchive.push(entry);
      else toKeep.push(entry);
    }
  } else {
    const splitAt = Math.max(0, entries.length - keepRecent);
    toArchive.push(...entries.slice(0, splitAt));
    toKeep.push(...entries.slice(splitAt));
  }

  if (toArchive.length === 0) {
    return { changed: false, archivedCount: 0, keptCount: entries.length, nextContextText: text, archiveGroups: {} };
  }

  const archiveGroups = {};
  for (const entry of toArchive) {
    const bucket = entry.date ? entry.date.slice(0, 7) : 'undated';
    if (!archiveGroups[bucket]) archiveGroups[bucket] = [];
    archiveGroups[bucket].push(entry);
  }

  const trimmedPreamble = [...preamble];
  while (trimmedPreamble.length && trimmedPreamble[trimmedPreamble.length - 1].trim() === '') {
    trimmedPreamble.pop();
  }
  const rebuiltBody = [
    ...trimmedPreamble,
    ...(trimmedPreamble.length ? [''] : []),
    COLD_ARCHIVE_POINTER,
    '',
    ...(toKeep.length ? toKeep.flatMap(entry => entry.lines) : ['- （无）']),
    ''
  ];

  const nextLines = [
    ...lines.slice(0, section.startLine),
    ...rebuiltBody,
    ...lines.slice(section.endLine)
  ];
  const nextContextText = `${hadBom ? '\uFEFF' : ''}${nextLines.join(eol)}`;

  return {
    changed: true,
    archivedCount: toArchive.length,
    keptCount: toKeep.length,
    nextContextText,
    archiveGroups
  };
}

export function normalizeColdDecisionInput(input, nowIso = new Date().toISOString()) {
  if (!isObject(input)) throw inputError('CONTEXT_HYGIENE_INPUT_INVALID', '决策记录必须为对象');
  const unknown = Object.keys(input).filter(key => !COLD_DECISION_FIELDS.includes(key));
  if (unknown.length) throw inputError('CONTEXT_HYGIENE_INPUT_INVALID', `决策记录包含未知字段：${unknown.join('、')}`);

  const date = input.date === undefined ? nowIso.slice(0, 10) : singleLineText(input.date, '日期', 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw inputError('CONTEXT_HYGIENE_INPUT_INVALID', '日期必须为 YYYY-MM-DD 格式');
  const scope = singleLineText(input.scope, '适用范围', 32);
  if (!DECISION_SCOPES.includes(scope)) {
    throw inputError('CONTEXT_HYGIENE_INPUT_INVALID', `适用范围仅支持 ${DECISION_SCOPES.join('、')}`);
  }
  const summary = singleLineText(input.summary, '决策摘要', 300);
  const reason = singleLineText(input.reason, '决策依据', 500);
  const previousValue = optionalSingleLineText(input.previousValue, '原口径', 300);
  const newValue = optionalSingleLineText(input.newValue, '新口径', 300);
  const authority = optionalSingleLineText(input.authority, '拍板人', 80);
  const targetFile = optionalSingleLineText(input.targetFile, '生效文件', 300);
  if (targetFile && (targetFile.startsWith('/') || targetFile.includes('..') || targetFile.includes('\\'))) {
    throw inputError('CONTEXT_HYGIENE_INPUT_INVALID', '生效文件必须为工作区相对路径');
  }
  const rawId = optionalSingleLineText(input.id, '决策 ID', 64);
  if (rawId && !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(rawId)) {
    throw inputError('CONTEXT_HYGIENE_INPUT_INVALID', '决策 ID 仅允许 1–64 位字母、数字、点、下划线或连字符');
  }
  const hash = createHash('sha256')
    .update(JSON.stringify({ date, scope, summary, previousValue, newValue, reason, authority, targetFile }))
    .digest('hex')
    .slice(0, 10);
  const id = rawId ?? `D-${date.replaceAll('-', '')}-${hash}`;
  return { id, date, scope, summary, previousValue, newValue, reason, authority, targetFile, month: date.slice(0, 7) };
}

export function formatColdDecisionMarkdown(entry) {
  const lines = [`- **[${entry.id}]** \`${entry.date}\` · \`${entry.scope}\` · ${entry.summary}`];
  if (entry.previousValue !== null || entry.newValue !== null) {
    lines.push(`  - 变更：${entry.previousValue ?? '（无）'} → ${entry.newValue ?? '（无）'}`);
  }
  lines.push(`  - 依据：${entry.reason}`);
  if (entry.authority) lines.push(`  - 拍板人：${entry.authority}`);
  if (entry.targetFile) lines.push(`  - 生效位置：\`${entry.targetFile}\``);
  return `${lines.join('\n')}\n`;
}
