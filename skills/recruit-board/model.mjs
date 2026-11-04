export const SCHEMA_VERSION = 1;
export const MAX_RUN_RESULTS = 2000;
export const MAX_RUN_HIGHLIGHTS = 50;
export const RUN_TRIGGERS = Object.freeze(['manual', 'scheduled', 'unknown']);
export const SUMMARY_STATES = Object.freeze(['unrecorded', 'highlights', 'no_change']);
export const ROLE_SCOPES = Object.freeze([
  { id: 'active', label: '在招' }, { id: 'following', label: '我的关注' }, { id: 'all', label: '全部' }
].map(scope => Object.freeze(scope)));
export const LEDGER_COLUMNS = Object.freeze([
  '序号', '姓名', '应聘岗位', '现职/背景', '评级', '状态', '来源轮次', '简历路径', '备注'
]);
export const STAGES = Object.freeze([
  { id: 'screen', label: '待初筛', statuses: ['未初筛', '待初筛'] },
  { id: 'contact', label: '待沟通', statuses: ['初筛通过'] },
  { id: 'talking', label: '沟通中', statuses: ['已打招呼', '已回复'] },
  { id: 'decision', label: '待决策', statuses: ['待确认', '观望'] },
  { id: 'interview', label: '面试', statuses: ['已约谈', '面试中'] },
  { id: 'offer', label: 'Offer', statuses: ['offer', '已发offer', '已接受offer'] },
  { id: 'joined', label: '入职', statuses: ['入职', '已入职'] },
  { id: 'ended', label: '已结束', statuses: ['初筛不合适', '已拒', '已排除'] },
  { id: 'unclassified', label: '未归类', statuses: [] }
].map(stage => Object.freeze({ ...stage, statuses: Object.freeze(stage.statuses) })));

export const WORKFLOWS = Object.freeze(Object.fromEntries([
  ['init', '初始化工作区', [['dependencies', '检查依赖'], ['workspace', '建立工作区'], ['register', '注册技能入口'], ['roles', '逐岗梳理'], ['handoff', '交付与待办']]],
  ['grill', '梳理岗位', [['context', '读取已有标准'], ['interview', '逐项梳理需求'], ['jd', '编写 JD 与对内笔记'], ['context-update', '更新标准与岗位表'], ['keywords', '建立搜索词']]],
  ['daily', '每日招聘', [['unread', '查未处理'], ['priorities', '确定寻源岗位'], ['sourcing', '双通道寻源'], ['screen', '按标准初筛'], ['greet', '联系候选人'], ['ledger', '更新台账'], ['report', '生成日报'], ['card', '推送日报卡片'], ['keywords', '回填搜索词']]],
  ['resume-review', '简历收取与评估', [['context', '读取现行标准'], ['mail', '收取邮箱简历'], ['parse', '解析简历与初评'], ['evaluate', '逐份评估'], ['records', '落面试档案'], ['ledger', '更新台账'], ['summary', '交付汇总']]],
  ['interview-schedule', '面试预约', [['details', '核对候选人与要素'], ['interviewers', '解析面试官'], ['availability', '查询忙闲'], ['calendar', '确认并建立日程'], ['invitation', '交付邀约话术'], ['records', '同步档案与台账']]],
  ['mapping', '市场人才盘点', [['scope', '确定范围与锚点'], ['sources', '广度取数'], ['deep-dive', '代表性深挖'], ['analysis', '统计分析'], ['conclusions', '形成观察与结论'], ['report', '交付报告']]]
].map(([id, label, steps]) => [id, Object.freeze({
  id, label, steps: Object.freeze(steps.map(([id, label]) => Object.freeze({ id, label })))
})])));

/** @typedef {import('./types/index.d.ts').Diagnostic} Diagnostic */
/** @typedef {import('./types/index.d.ts').Candidate} Candidate */
/** @typedef {import('./types/index.d.ts').Role} Role */
/** @typedef {import('./types/index.d.ts').Run} Run */
/** @typedef {import('./types/index.d.ts').BoardSnapshot} BoardSnapshot */

const stageByStatus = new Map(STAGES.flatMap(stage => stage.statuses.map(status => [status.toLowerCase(), stage.id])));
const normalizeStatus = value => value.trim().toLowerCase();
export const stageForStatus = (value, statusStages = {}) => {
  const status = normalizeStatus(value);
  return (Object.hasOwn(statusStages, status) ? statusStages[status] : stageByStatus.get(status)) ?? 'unclassified';
};
const diagnostic = (code, source, message, level = 'warning') => ({ code, source, level, message });

export function parseCSV(text) {
  if (typeof text !== 'string') throw new Error('CSV 内容必须是文本');
  text = text.replace(/^\uFEFF/, '');
  const rows = [];
  let row = [], field = '', quoted = false, closed = false, rowPresent = false, line = 1;
  const fieldEnd = () => { row.push(field); field = ''; closed = false; };
  const rowEnd = () => { fieldEnd(); if (rowPresent || row.length > 1 || row.some(cell => cell !== '')) rows.push(row); row = []; rowPresent = false; };
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (char !== '\r' && char !== '\n') rowPresent = true;
    if (quoted) {
      if (char === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else { quoted = false; closed = true; }
      } else { field += char; if (char === '\n') line++; }
    } else if (char === ',') fieldEnd();
    else if (char === '\n' || char === '\r') {
      rowEnd();
      if (char === '\r' && text[i + 1] === '\n') i++;
      line++;
    } else if (char === '"' && field === '' && !closed) quoted = true;
    else {
      if (closed || char === '"') throw new Error(`CSV 第 ${line} 行引号格式错误`);
      field += char;
    }
  }
  if (quoted) throw new Error(`CSV 第 ${line} 行引号未闭合`);
  if (row.length || field !== '' || closed) rowEnd();
  if (!rows.length) throw new Error('CSV 缺少九列表头');
  if (rows[0].length !== 9 || rows[0].some((cell, i) => cell.trim() !== LEDGER_COLUMNS[i])) {
    throw new Error('CSV 表头必须按约定排列九列');
  }
  return rows.slice(1).map((cells, i) => {
    if (cells.length !== 9) throw new Error(`CSV 第 ${i + 2} 条记录不是九列`);
    if (!cells[1].trim() || !cells[2].trim()) throw new Error(`CSV 第 ${i + 2} 条记录缺少姓名或应聘岗位`);
    return cells;
  });
}

export function readCandidates(text, { statusStages = {}, roleAliases = {} } = {}) {
  const grouped = new Map();
  for (const cells of parseCSV(text)) {
    const name = cells[1].trim(), rawRole = cells[2].trim();
    const id = JSON.stringify([name, rawRole]);
    const group = grouped.get(id) ?? { id, name, rawRole, rows: [] };
    group.rows.push({ rating: cells[4].trim(), rawStatus: cells[5].trim() });
    grouped.set(id, group);
  }
  const diagnostics = [], candidates = [], unknown = new Map(), canonicalKeys = new Map();
  let duplicates = 0, conflicts = 0, collisions = 0;
  for (const group of grouped.values()) {
    const statuses = [...new Set(group.rows.map(row => row.rawStatus))];
    const normalized = new Set(statuses.map(normalizeStatus));
    const ratings = [...new Set(group.rows.map(row => row.rating))];
    const conflict = normalized.size > 1 || ratings.length > 1;
    const rawStatus = normalized.size > 1 ? null : statuses[0];
    const stage = conflict ? 'unclassified' : stageForStatus(rawStatus, statusStages);
    const role = Object.hasOwn(roleAliases, group.rawRole) ? roleAliases[group.rawRole] : group.rawRole;
    const key = JSON.stringify([group.name, role]);
    canonicalKeys.set(key, (canonicalKeys.get(key) ?? 0) + 1);
    if (group.rows.length > 1) duplicates++;
    if (conflict) conflicts++;
    if (!conflict && stage === 'unclassified' && !Object.hasOwn(statusStages, normalizeStatus(rawStatus))) unknown.set(rawStatus, (unknown.get(rawStatus) ?? 0) + 1);
    candidates.push({
      id: group.id, name: group.name, role, rawRole: group.rawRole, rating: ratings.length === 1 ? ratings[0] : null,
      rawStatus, stage, conflict, statuses
    });
  }
  for (const count of canonicalKeys.values()) if (count > 1) collisions += count;
  const unknownStatuses = [...unknown].map(([status, count]) => ({ status, count }));
  if (duplicates) diagnostics.push(diagnostic('DUPLICATE_KEY', 'ledger', `${duplicates} 个姓名＋原岗位有重复记录，已按原人岗键计一次`, 'info'));
  if (conflicts) diagnostics.push(diagnostic('DUPLICATE_CONFLICT', 'ledger', `${conflicts} 个重复键的状态或评级冲突；保留原状态并归未归类`));
  if (unknownStatuses.length) diagnostics.push(diagnostic('UNKNOWN_STATUS', 'ledger', `${unknownStatuses.reduce((sum, item) => sum + item.count, 0)} 条记录的状态未在精确映射中，已归未归类：${unknownStatuses.map(item => `${item.status || '空状态'}（${item.count}）`).join('；')}`));
  if (collisions) diagnostics.push(diagnostic('ROLE_ALIAS_COLLISION', 'ledger', `岗位归组后 ${collisions} 条同名跨岗位记录未合并，仍按姓名＋原岗位计数`, 'info'));
  return { candidates, diagnostics, unknownStatuses };
}

function markdownCell(value) {
  return value.trim().replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').replace(/[*`]/g, '').trim();
}

export function readRoles(text) {
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/);
  let inSection = false;
  for (let i = 0; i < lines.length; i++) {
    const heading = /^(#{1,6})\s+(.+)$/.exec(lines[i]);
    if (heading) {
      if (inSection) break;
      if (/^(?:[一二三四五六七八九十\d]+[、.．]\s*)?在招岗位与优先级$/.test(heading[2].trim())) {
        inSection = true;
      }
      continue;
    }
    if (!inSection || !lines[i].trim().startsWith('|')) continue;
    const cells = line => line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(markdownCell);
    const header = cells(lines[i]);
    const columns = ['岗位', '优先级', '状态'].map(name => header.indexOf(name));
    if (columns.some(index => index < 0)) continue;
    if (!lines[i + 1] || !cells(lines[i + 1]).every(cell => /^:?-{3,}:?$/.test(cell))) continue;
    const roles = [];
    for (let j = i + 2; j < lines.length && lines[j].trim().startsWith('|'); j++) {
      const values = cells(lines[j]);
      if (values.length !== header.length) throw new Error('岗位配置表列数不一致');
      const name = values[columns[0]];
      if (!name || /^(?:[（(]?(?:待梳理|待填写|岗位名|role)[）)]?|<role>)$/i.test(name)) continue;
      if (roles.some(role => role.name === name)) throw new Error('岗位配置表包含重复岗位');
      roles.push({ name, priority: values[columns[1]] || null, status: values[columns[2]] || null, configured: true });
    }
    return roles;
  }
  throw new Error('未读取岗位配置：未找到“在招岗位与优先级”的岗位／优先级／状态表');
}

export function readConfig(text, roles = []) {
  let value;
  try { value = JSON.parse(text.replace(/^﻿/, '')); }
  catch { throw new Error('兼容配置不是有效 JSON'); }
  const object = item => item !== null && typeof item === 'object' && !Array.isArray(item);
  if (!object(value) || value.schemaVersion !== 1 || Object.keys(value).some(key => !['schemaVersion', 'statusStages', 'roleAliases', 'description', 'verifiedAt', 'source'].includes(key))) throw new Error('兼容配置版本或字段无效');
  if (!object(value.statusStages) || !object(value.roleAliases)) throw new Error('兼容配置的 statusStages 和 roleAliases 必须为对象');
  const statuses = new Map(), aliases = new Map();
  for (const [raw, stage] of Object.entries(value.statusStages)) {
    const key = normalizeStatus(raw);
    if (!key || statuses.has(key) || !STAGES.some(item => item.id === stage)) throw new Error('兼容配置包含空状态、规范化重复状态或无效阶段');
    statuses.set(key, stage);
  }
  for (const [raw, target] of Object.entries(value.roleAliases)) {
    const key = raw.trim();
    if (!key || aliases.has(key) || typeof target !== 'string' || !target.trim()) throw Object.assign(new Error('岗位别名配置包含空值或规范化重复键'), { code: 'CONFIG_INVALID_ALIAS' });
    aliases.set(key, target.trim());
  }
  for (const target of aliases.values()) {
    if (aliases.has(target) || !roles.some(role => role.configured && role.name === target)) throw Object.assign(new Error('岗位别名目标必须是本次成功读取的岗位表名称，且不得形成链或循环'), { code: 'CONFIG_INVALID_ALIAS' });
  }
  return { schemaVersion: 1, statusStages: Object.fromEntries(statuses), roleAliases: Object.fromEntries(aliases) };
}

export function assertRunId(id) {
  if (typeof id !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(id)) throw new Error('runId 仅允许 1–64 位字母、数字、下划线和连字符');
  return id;
}

function shortText(value, label, required = false) {
  if (value == null && !required) return null;
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > 300 || /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(value)) throw new Error(`${label} 必须为 1–300 字符的文本`);
  return value.trim();
}

function timestamp(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) throw new Error('进度时间必须为 ISO UTC 时间');
  return value;
}

export function candidateSubject(candidateId) {
  let identity;
  try { identity = JSON.parse(candidateId); }
  catch { return null; }
  if (typeof candidateId !== 'string' || !Array.isArray(identity) || identity.length !== 2 || identity.some(item => typeof item !== 'string' || !item.trim() || item !== item.trim()) || JSON.stringify(identity) !== candidateId) return null;
  return { candidateId, name: identity[0], rawRole: identity[1], role: identity[1] };
}

function singleLineText(value, label, max) {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\x00-\x1f\x7f\u0085\p{Zl}\p{Zp}]/u.test(value)) throw new Error(`${label} 必须为 1–${max} 字符的单行文本`);
  return value.trim();
}

export function validateContext(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !['scope', 'candidateId', 'role'].includes(key)) || !['candidate', 'role', 'workspace'].includes(value.scope)) throw new Error('context 的范围或字段无效');
  if (value.scope === 'workspace') {
    if (Object.hasOwn(value, 'candidateId') || Object.hasOwn(value, 'role')) throw new Error('工作区 context 不能包含 candidateId 或 role');
    return { scope: 'workspace' };
  }
  const role = Object.hasOwn(value, 'role') ? singleLineText(value.role, 'context 岗位', 300) : undefined;
  if (value.scope === 'role') {
    if (role === undefined || Object.hasOwn(value, 'candidateId')) throw new Error('岗位 context 必须包含 role 且不能包含 candidateId');
    return { scope: 'role', role };
  }
  if (!candidateSubject(value.candidateId)) throw new Error('context candidateId 必须是规范的姓名＋原岗位 JSON');
  return { scope: 'candidate', candidateId: value.candidateId, ...(role === undefined ? {} : { role }) };
}

function highlightDetails(value) {
  if (!Array.isArray(value) || value.length > 8) throw new Error('重点 details 必须为最多 8 项的数组');
  return value.map(item => {
    if (!item || typeof item !== 'object' || Array.isArray(item) || Object.keys(item).some(key => !['label', 'value'].includes(key))) throw new Error('重点 details 仅接受 label 和 value');
    return { label: singleLineText(item.label, '细节标签', 80), value: singleLineText(item.value, '细节内容', 300) };
  });
}

function runResult(value, definition, updatedAt) {
  const fields = ['id', 'stepId', 'candidateId', 'action', 'outcome', 'attention', 'nextAction'];
  if (updatedAt === undefined) fields.push('updatedAt');
  if (!value || typeof value !== 'object' || Array.isArray(value) || fields.some(key => !Object.hasOwn(value, key)) || Object.keys(value).some(key => ![...fields, 'decisionId'].includes(key))) throw new Error('结果记录包含无效字段');
  if (value.decisionId !== undefined && (typeof value.decisionId !== 'string' || !/^decision-[a-f0-9]{48}$/.test(value.decisionId))) throw new Error('关联事项 ID 无效');
  if (typeof value.id !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(value.id)) throw new Error('结果 ID 仅允许 1–64 位字母、数字、下划线和连字符');
  if (!definition.steps.some(step => step.id === value.stepId)) throw new Error('结果步骤必须属于本轮工作流');
  if (!candidateSubject(value.candidateId)) throw new Error('结果候选标识必须是规范的姓名＋原岗位 JSON');
  const action = shortText(value.action, '结果动作', true);
  if (value.action.length > 80) throw new Error('结果动作必须为 1–80 字符的文本');
  const outcome = shortText(value.outcome, '结果结论', true);
  if (!['none', 'notice', 'decision'].includes(value.attention)) throw new Error('结果 attention 必须为 none、notice 或 decision');
  if (value.nextAction !== null && typeof value.nextAction !== 'string') throw new Error('结果下一步必须为文本或 null');
  const nextAction = shortText(value.nextAction, '结果下一步', value.attention === 'decision');
  return { id: value.id, stepId: value.stepId, candidateId: value.candidateId, action, outcome, attention: value.attention, nextAction, updatedAt: timestamp(updatedAt ?? value.updatedAt), ...(value.decisionId ? { decisionId: value.decisionId } : {}) };
}

const highlightContentFields = ['text', 'evidence', 'decisionId', 'subjectKey', 'correction', 'context', 'details'];
const sameHighlightContent = (a, b, fields = highlightContentFields) => fields.every(key => JSON.stringify(a[key]) === JSON.stringify(b[key]));
const highlightConflict = (code, message) => Object.assign(new Error(message), { code, status: 409 });

function highlightRequestId(value) {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(value)) throw new Error('重点 request 必须为 1–128 位字母、数字、下划线或连字符');
  return value;
}

function runHighlight(value, now) {
  const allowed = ['eventKey', ...highlightContentFields, 'occurredAt', ...(now === undefined ? ['updatedAt', 'previousText', 'revision', 'history'] : [])];
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !allowed.includes(key))) throw new Error('重点记录包含无效字段');
  const eventKey = shortText(value.eventKey, '稳定事件键', true);
  if (eventKey !== value.eventKey || eventKey.length > 200) throw new Error('稳定事件键必须为 1–200 字符且不含首尾空白');
  if (value.decisionId != null && (typeof value.decisionId !== 'string' || !/^decision-[a-f0-9]{48}$/.test(value.decisionId))) throw new Error('关联事项 ID 无效');
  const occurredAt = timestamp(value.occurredAt ?? now), updatedAt = timestamp(now ?? value.updatedAt);
  if (occurredAt > updatedAt) throw new Error('重点发生时间不能晚于记录时间');
  const highlight = {
    eventKey, text: shortText(value.text, '重点结论', true), evidence: shortText(value.evidence, '重点依据'), decisionId: value.decisionId ?? null,
    subjectKey: shortText(value.subjectKey, '重点对象'), occurredAt, updatedAt,
    correction: shortText(value.correction, '更正说明'), previousText: shortText(value.previousText, '更正前结论'),
    ...(value.context === undefined ? {} : { context: validateContext(value.context) }),
    ...(value.details === undefined ? {} : { details: highlightDetails(value.details) })
  };
  if (now !== undefined) return highlight;
  const revision = value.revision === undefined ? 1 : value.revision;
  if (!Number.isSafeInteger(revision) || revision < 1) throw new Error('重点事件版本必须为正安全整数');
  let history = null;
  if (value.history !== undefined && value.history !== null) {
    if (!Array.isArray(value.history) || value.history.length !== revision) throw new Error('重点修订历史与事件版本不一致');
    const requests = new Set();
    let previousAt = null;
    history = value.history.map((entry, index) => {
      const fields = ['revision', 'requestId', 'expectedRevision', 'requestedOccurredAt', 'text', 'evidence', 'decisionId', 'subjectKey', 'occurredAt', 'updatedAt', 'correction'];
      if (!entry || typeof entry !== 'object' || Array.isArray(entry) || fields.some(key => !Object.hasOwn(entry, key)) || Object.keys(entry).some(key => ![...fields, 'context', 'details'].includes(key)) || entry.revision !== index + 1) throw new Error('重点修订记录无效');
      const recorded = runHighlight({ eventKey, ...Object.fromEntries([...highlightContentFields, 'occurredAt'].map(key => [key, entry[key]])) }, timestamp(entry.updatedAt));
      if (recorded.occurredAt !== occurredAt || recorded.decisionId !== highlight.decisionId || recorded.subjectKey !== highlight.subjectKey || recorded.updatedAt > updatedAt || (previousAt !== null && recorded.updatedAt < previousAt)) throw new Error('重点修订的身份或时间不一致');
      if (index > 0 && !recorded.correction) throw new Error('重点更正历史缺少理由');
      if (entry.requestId === null) {
        if (index !== 0 || entry.expectedRevision !== null || entry.requestedOccurredAt !== null) throw new Error('重点修订缺少请求回执');
      } else {
        highlightRequestId(entry.requestId);
        if (requests.has(entry.requestId) || entry.expectedRevision !== index) throw new Error('重点修订请求重复或版本无效');
        if (entry.requestedOccurredAt !== null && timestamp(entry.requestedOccurredAt) !== occurredAt) throw new Error('重点发生时间不可更换');
        requests.add(entry.requestId);
      }
      previousAt = recorded.updatedAt;
      const { eventKey: ignoredKey, previousText, ...content } = recorded;
      return { revision: entry.revision, requestId: entry.requestId, expectedRevision: entry.expectedRevision, requestedOccurredAt: entry.requestedOccurredAt, ...content };
    });
    const last = history.at(-1);
    if (!sameHighlightContent(last, highlight, [...highlightContentFields, 'occurredAt', 'updatedAt'])) throw new Error('重点当前内容与最新修订不一致');
  } else if (revision !== 1) throw new Error('重点修订历史缺失');
  return { ...highlight, revision, history };
}

function highlightRevision(highlight, revision, requestId = null, expectedRevision = null, requestedOccurredAt = null) {
  const { eventKey, previousText, revision: previousRevision, history, ...content } = highlight;
  return { revision, requestId, expectedRevision, requestedOccurredAt, ...content };
}

export function createRun({ id, workflow, role = null, ownerSessionId = null, trigger = 'unknown', now }) {
  assertRunId(id);
  const definition = WORKFLOWS[workflow];
  if (!definition) throw new Error('未知工作流');
  timestamp(now);
  if (!RUN_TRIGGERS.includes(trigger)) throw new Error('触发来源必须为 manual、scheduled 或 unknown');
  return {
    schemaVersion: 1, id, workflow, label: definition.label, role: shortText(role, '岗位'), ownerSessionId: shortText(ownerSessionId, '会话 ID'), status: 'running', reason: null,
    trigger, summaryState: 'unrecorded', closingSummary: null,
    createdAt: now, updatedAt: now,
    steps: definition.steps.map(step => ({ ...step, status: 'pending', reason: null, updatedAt: now })), results: [], resultsRevision: 0,
    highlights: [], highlightsRevision: 0
  };
}

export function validateRun(value, expectedId) {
  if (!value || typeof value !== 'object' || value.schemaVersion !== 1) throw new Error('不支持的进度记录版本');
  assertRunId(value.id);
  if (expectedId && value.id !== expectedId) throw new Error('进度文件名与 runId 不一致');
  const definition = WORKFLOWS[value.workflow];
  if (!definition || !['running', 'waiting', 'completed', 'failed', 'cancelled'].includes(value.status)) throw new Error('无效工作流或轮次状态');
  if (!Array.isArray(value.steps) || value.steps.length !== definition.steps.length) throw new Error('进度步骤与工作流不一致');
  const createdAt = timestamp(value.createdAt), updatedAt = timestamp(value.updatedAt);
  if (updatedAt < createdAt) throw new Error('进度更新时间早于创建时间');
  const steps = value.steps.map((step, i) => {
    if (!step || step.id !== definition.steps[i].id || !['pending', 'running', 'completed', 'skipped', 'failed'].includes(step.status)) throw new Error('无效步骤记录');
    const reason = shortText(step.reason, '步骤理由', ['skipped', 'failed'].includes(step.status));
    const stepTime = timestamp(step.updatedAt);
    if (stepTime < createdAt || stepTime > updatedAt) throw new Error('步骤更新时间超出轮次时间');
    return { id: step.id, label: definition.steps[i].label, status: step.status, reason, updatedAt: stepTime };
  });
  if (steps.filter(step => step.status === 'running').length > 1) throw new Error('一个轮次只能有一个执行中步骤');
  if (value.status === 'completed' && steps.some(step => !['completed', 'skipped'].includes(step.status))) throw new Error('完成轮次仍有未完成步骤');
  if (value.status !== 'failed' && steps.some(step => step.status === 'failed')) throw new Error('失败步骤未对应失败轮次');
  const resultsRevision = value.resultsRevision === undefined ? 0 : value.resultsRevision;
  if (!Number.isSafeInteger(resultsRevision) || resultsRevision < 0) throw new Error('结果版本必须为非负安全整数');
  const trigger = value.trigger === undefined ? 'unknown' : value.trigger;
  if (!RUN_TRIGGERS.includes(trigger)) throw new Error('触发来源必须为 manual、scheduled 或 unknown');
  const summaryState = value.summaryState === undefined ? 'unrecorded' : value.summaryState;
  if (!SUMMARY_STATES.includes(summaryState)) throw new Error('轮次摘要状态无效');
  const closingSummary = value.closingSummary === undefined ? null : shortText(value.closingSummary, '轮次收尾摘要');
  const highlightsRevision = value.highlightsRevision === undefined ? 0 : value.highlightsRevision;
  if (!Number.isSafeInteger(highlightsRevision) || highlightsRevision < 0) throw new Error('重点版本必须为非负安全整数');
  let highlights = null;
  if (value.highlights !== undefined && value.highlights !== null) {
    if (!Array.isArray(value.highlights) || value.highlights.length > MAX_RUN_HIGHLIGHTS) throw new Error(`每轮重点最多 ${MAX_RUN_HIGHLIGHTS} 条`);
    const keys = new Set();
    highlights = value.highlights.map(item => {
      const highlight = runHighlight(item);
      if (highlight.updatedAt < createdAt || highlight.updatedAt > updatedAt || highlight.occurredAt > highlight.updatedAt) throw new Error('重点时间超出有效范围');
      if (keys.has(highlight.eventKey)) throw new Error('同一轮重点的事件键重复');
      keys.add(highlight.eventKey);
      return highlight;
    });
  }
  if (summaryState === 'no_change' && ((highlights ?? []).length || !closingSummary)) throw new Error('无重要变化必须有摘要且不能含重点');
  if (summaryState === 'highlights' && !(highlights ?? []).length) throw new Error('有重点状态必须包含重点记录');
  if (summaryState === 'unrecorded' && ((highlights ?? []).length || closingSummary !== null)) throw new Error('未记录状态不能包含重点或摘要');
  let results = null;
  if (value.results !== undefined && value.results !== null) {
    if (!Array.isArray(value.results) || value.results.length > MAX_RUN_RESULTS) throw new Error(`结果记录最多 ${MAX_RUN_RESULTS} 条`);
    const ids = new Set();
    results = value.results.map(value => {
      const result = runResult(value, definition);
      if (ids.has(result.id)) throw new Error('结果记录包含重复 ID');
      if (result.updatedAt < createdAt || result.updatedAt > updatedAt) throw new Error('结果更新时间超出轮次时间');
      ids.add(result.id);
      return result;
    });
  }
  return {
    schemaVersion: 1, id: value.id, workflow: value.workflow, label: definition.label, role: shortText(value.role, '岗位'), ownerSessionId: shortText(value.ownerSessionId, '会话 ID'),
    status: value.status, reason: shortText(value.reason, '轮次理由', ['waiting', 'failed', 'cancelled'].includes(value.status)),
    trigger, summaryState, closingSummary, highlights, highlightsRevision,
    createdAt, updatedAt, steps, results, resultsRevision
  };
}

export function transitionRun(input, action, now) {
  const run = validateRun(input);
  timestamp(now);
  let requestedHighlight;
  if (action.type === 'highlight') {
    requestedHighlight = runHighlight(action.highlight, now);
    if (action.requestId !== undefined || action.expectedRevision !== undefined) {
      highlightRequestId(action.requestId);
      if (!Number.isSafeInteger(action.expectedRevision) || action.expectedRevision < 0) throw new Error('重点 expected-revision 必须为非负安全整数');
      for (const highlight of run.highlights ?? []) {
        const receipt = highlight.history?.find(entry => entry.requestId === action.requestId);
        if (!receipt) continue;
        if (highlight.eventKey !== requestedHighlight.eventKey || receipt.expectedRevision !== action.expectedRevision || receipt.requestedOccurredAt !== (action.highlight.occurredAt ?? null) || !sameHighlightContent(receipt, requestedHighlight)) throw highlightConflict('HIGHLIGHT_REQUEST_CONFLICT', '重点请求 ID 已用于不同内容，请使用新的 request');
        return run;
      }
    }
  }
  if (now < run.updatedAt) throw new Error('进度更新时间不能倒退');
  if (['completed', 'failed', 'cancelled'].includes(run.status)) throw new Error('轮次已经结束，请创建新的 runId');
  if (action.type === 'result') {
    const result = runResult(action.result, WORKFLOWS[run.workflow], now);
    const results = [...(run.results ?? [])];
    const index = results.findIndex(item => item.id === result.id);
    if (index >= 0) {
      const previous = results[index];
      if (previous.candidateId !== result.candidateId || previous.stepId !== result.stepId) throw new Error('同一结果 ID 的候选或步骤不可变更');
      if (previous.decisionId && previous.decisionId !== result.decisionId) throw new Error('结果已关联的事项不可移除或改绑');
      if (['action', 'outcome', 'attention', 'nextAction'].every(key => previous[key] === result[key]) && previous.decisionId === result.decisionId) return run;
      results[index] = result;
    } else {
      if (results.length >= MAX_RUN_RESULTS) throw new Error(`结果记录最多 ${MAX_RUN_RESULTS} 条`);
      results.push(result);
    }
    if (run.resultsRevision === Number.MAX_SAFE_INTEGER) throw new Error('结果版本已达到安全整数上限');
    return { ...run, updatedAt: now, results, resultsRevision: run.resultsRevision + 1 };
  }
  if (action.type === 'highlight') {
    const highlight = requestedHighlight;
    const highlights = [...(run.highlights ?? [])];
    const index = highlights.findIndex(item => item.eventKey === highlight.eventKey);
    if (index >= 0) {
      const previous = highlights[index];
      if (action.highlight.occurredAt != null && action.highlight.occurredAt !== previous.occurredAt) throw new Error('同一事件的发生时间不能更换');
      if (sameHighlightContent(previous, highlight)) return run;
      if (!highlight.correction) throw new Error('修改同一事件的重点必须提供更正说明');
      if (action.expectedRevision === undefined || action.requestId === undefined) throw new Error('重点更正必须提供 --expected-revision 和 --request');
      if (action.expectedRevision !== previous.revision) throw highlightConflict('HIGHLIGHT_REVISION_CONFLICT', `重点版本冲突；当前事件版本 ${previous.revision}，请重读后再更正`);
      if (previous.subjectKey !== highlight.subjectKey || previous.decisionId !== highlight.decisionId) throw new Error('同一事件的对象和关联事项不能更换');
      if (previous.revision === Number.MAX_SAFE_INTEGER) throw new Error('重点事件版本已达到安全整数上限');
      const corrected = { ...highlight, occurredAt: previous.occurredAt };
      const revision = previous.revision + 1;
      highlights[index] = {
        ...corrected, previousText: previous.text, revision,
        history: [...(previous.history ?? [highlightRevision(previous, previous.revision)]), highlightRevision(corrected, revision, action.requestId, action.expectedRevision, action.highlight.occurredAt ?? null)]
      };
    } else {
      if (action.expectedRevision !== undefined && action.expectedRevision !== 0) throw highlightConflict('HIGHLIGHT_REVISION_CONFLICT', '新事件的 expected-revision 必须为 0');
      if (highlights.length >= MAX_RUN_HIGHLIGHTS) throw new Error(`每轮重点最多 ${MAX_RUN_HIGHLIGHTS} 条`);
      highlights.push({ ...highlight, revision: 1, history: [highlightRevision(highlight, 1, action.requestId ?? null, action.expectedRevision ?? null, action.requestId ? action.highlight.occurredAt ?? null : null)] });
    }
    if (run.highlightsRevision === Number.MAX_SAFE_INTEGER) throw new Error('重点版本已达到安全整数上限');
    return validateRun({ ...run, updatedAt: now, summaryState: 'highlights', closingSummary: null, highlights, highlightsRevision: run.highlightsRevision + 1 });
  }
  if (action.type === 'summary') {
    if (!['highlights', 'no_change'].includes(action.summaryState)) throw new Error('轮次摘要状态必须为 highlights 或 no_change');
    const closingSummary = shortText(action.closingSummary, '轮次收尾摘要', true);
    if (action.summaryState === 'highlights' && !(run.highlights ?? []).length) throw new Error('标记为有重点前必须先写入至少一条重点');
    if (action.summaryState === 'no_change' && (run.highlights ?? []).length) throw new Error('已有重点的轮次不能标记无重要变化');
    if (run.summaryState === action.summaryState && run.closingSummary === closingSummary) return run;
    if (run.highlightsRevision === Number.MAX_SAFE_INTEGER) throw new Error('重点版本已达到安全整数上限');
    return { ...run, updatedAt: now, summaryState: action.summaryState, closingSummary, highlightsRevision: run.highlightsRevision + 1 };
  }
  const steps = run.steps.map(step => ({ ...step }));
  const reason = shortText(action.reason, '理由', ['wait', 'skip', 'fail', 'cancel'].includes(action.type));
  let status = run.status, runReason = null;
  if (action.type === 'step') {
    const target = steps.find(step => step.id === action.step);
    if (!target || !['pending', 'running'].includes(target.status)) throw new Error('该步骤不存在或已经结束');
    if (steps.some(step => step.status === 'running' && step.id !== target.id)) throw new Error('请先完成或跳过当前步骤');
    target.status = 'running'; target.reason = null; target.updatedAt = now; status = 'running';
  } else if (action.type === 'complete' && action.step) {
    const target = steps.find(step => step.id === action.step);
    if (!target || target.status !== 'running') throw new Error('只能完成执行中的步骤');
    target.status = 'completed'; target.reason = null; target.updatedAt = now; status = 'running';
  } else if (action.type === 'skip') {
    const target = steps.find(step => step.id === action.step);
    if (!target || !['pending', 'running'].includes(target.status)) throw new Error('只能跳过未结束步骤');
    target.status = 'skipped'; target.reason = reason; target.updatedAt = now; status = 'running';
  } else if (action.type === 'complete') {
    if (steps.some(step => !['completed', 'skipped'].includes(step.status))) throw new Error('全部步骤完成或写明跳过理由后才能结束轮次');
    status = 'completed';
  } else if (action.type === 'wait') { status = 'waiting'; runReason = reason; }
  else if (action.type === 'fail') {
    const target = action.step ? steps.find(step => step.id === action.step) : steps.find(step => step.status === 'running');
    if (action.step && (!target || !['pending', 'running'].includes(target.status))) throw new Error('不能让已结束或不存在的步骤失败');
    if (target) { target.status = 'failed'; target.reason = reason; target.updatedAt = now; }
    status = 'failed'; runReason = reason;
  } else if (action.type === 'cancel') { status = 'cancelled'; runReason = reason; }
  else throw new Error('未知进度动作');
  return validateRun({ ...run, status, reason: runReason, updatedAt: now, steps });
}

/** @param {Run} run @returns {import('./types/index.d.ts').RunResultSummary|null} */
export function summarizeRunResults(run) {
  if (run.results == null) return null;
  const candidates = new Map();
  let updatedAt = null;
  for (const result of run.results) {
    const previous = candidates.get(result.candidateId);
    if (!previous || result.attention === 'decision' || (previous === 'none' && result.attention === 'notice')) candidates.set(result.candidateId, result.attention);
    if (updatedAt === null || result.updatedAt > updatedAt) updatedAt = result.updatedAt;
  }
  const attention = [...candidates.values()];
  return { total: candidates.size, decisions: attention.filter(value => value === 'decision').length, notices: attention.filter(value => value === 'notice').length, updatedAt, revision: run.resultsRevision ?? 0 };
}

/** @param {Run|import('./types/index.d.ts').RunSummary} run @returns {import('./types/index.d.ts').RunSummary} */
export function runSummary(run) {
  const { results, resultSummary, highlights, ...summary } = run;
  return {
    ...summary,
    resultsRevision: run.resultsRevision ?? 0,
    summaryState: run.summaryState ?? 'unrecorded',
    closingSummary: run.closingSummary ?? null,
    highlightCount: run.highlightCount ?? (highlights?.length ?? 0),
    resultSummary: Object.hasOwn(run, 'results') ? summarizeRunResults(run) : resultSummary ?? null
  };
}

/**
 * Node 与原生适配器只提交这些固定源的读取结果；纯模型不接触文件系统。
 * @param {{workspace:string, generatedAt:string, ledger:object, context:object, runFiles:object, config?:object}} input
 * @param {BoardSnapshot|null} previous
 * @returns {BoardSnapshot}
 */
export function buildSnapshot(input, previous = null) {
  const diagnostics = [];
  const previousRuns = previous?.runs?.map(runSummary) ?? null;
  let candidates = null, roles = [], runs = null, ledgerUpdatedAt = null, unknownStatuses = [], contextRevision = null;
  const configSource = input.config ?? { status: 'missing' };
  const sources = {
    ledger: { status: input.ledger.status, updatedAt: null },
    context: { status: input.context.status, updatedAt: null },
    runs: { status: input.runFiles.status, updatedAt: null },
    config: { status: configSource.status, updatedAt: null }
  };
  if (input.context.status === 'ok') {
    try { roles = readRoles(input.context.text); sources.context.updatedAt = input.context.updatedAt ?? null; contextRevision = input.context.revision ?? null; }
    catch (error) {
      sources.context.status = 'error';
      diagnostics.push(diagnostic('ROLES_UNCONFIGURED', 'context', error.message));
    }
  } else diagnostics.push(diagnostic('ROLES_UNREADABLE', 'context', '未读取岗位配置：CONTEXT.md 缺失或无法读取；岗位状态未知'));
  let config;
  if (configSource.status === 'ok') {
    try {
      config = readConfig(configSource.text, sources.context.status === 'ok' ? roles : []);
      sources.config.updatedAt = configSource.updatedAt ?? null;
    } catch (error) {
      sources.config.status = 'error';
      diagnostics.push(diagnostic(error.code ?? 'CONFIG_INVALID', 'config', error.message, 'error'));
    }
  } else if (configSource.status === 'error') diagnostics.push(diagnostic('CONFIG_UNREADABLE', 'config', '无法读取本地兼容配置，标准映射仍可使用', 'error'));
  const hadConfig = previous?.candidates != null && previous.sources.config && ['ok', 'stale'].includes(previous.sources.config.status);
  if (configSource.status === 'missing' && hadConfig) diagnostics.push(diagnostic('CONFIG_MISSING', 'config', '兼容配置已缺失，保留上次映射记录（陈旧）', 'error'));
  const preserveCandidates = () => {
    candidates = previous.candidates;
    unknownStatuses = previous.unknownStatuses ?? [];
    ledgerUpdatedAt = previous.ledgerUpdatedAt;
    roles = previous.roles;
    contextRevision = previous.contextRevision ?? null;
    sources.ledger = { status: 'stale', updatedAt: previous.sources.ledger.updatedAt };
    sources.context = { status: previous.sources.context.status === 'ok' || previous.sources.context.status === 'stale' ? 'stale' : previous.sources.context.status, updatedAt: previous.sources.context.updatedAt };
    sources.config = hadConfig ? { status: 'stale', updatedAt: previous.sources.config.updatedAt } : { ...(previous.sources.config ?? { status: 'missing', updatedAt: null }) };
    diagnostics.push(...previous.diagnostics.filter(item => item.source === 'ledger'));
  };
  if (!config && hadConfig) preserveCandidates();
  else {
    if (input.ledger.status === 'ok') {
      try {
        const parsed = readCandidates(input.ledger.text, config);
        candidates = parsed.candidates; unknownStatuses = parsed.unknownStatuses; diagnostics.push(...parsed.diagnostics);
        ledgerUpdatedAt = input.ledger.updatedAt ?? null;
        sources.ledger.updatedAt = ledgerUpdatedAt;
      } catch (error) {
        sources.ledger.status = 'error';
        diagnostics.push(diagnostic('LEDGER_INVALID', 'ledger', error.message, 'error'));
      }
    } else diagnostics.push(diagnostic('LEDGER_UNREADABLE', 'ledger', input.ledger.status === 'missing' ? '未找到候选人台账，人数未知' : '无法读取候选人台账，人数未知', 'error'));
    if (candidates === null && previous?.candidates !== null && previous?.candidates !== undefined) {
      if (config || hadConfig) {
        preserveCandidates();
        diagnostics.push(diagnostic('CONFIG_SNAPSHOT_STALE', 'config', '台账读取失败，兼容配置与岗位沿用上次候选快照（陈旧）', 'error'));
      } else {
        candidates = previous.candidates; unknownStatuses = previous.unknownStatuses ?? []; ledgerUpdatedAt = previous.ledgerUpdatedAt;
        sources.ledger = { status: 'stale', updatedAt: ledgerUpdatedAt };
        diagnostics.push(...previous.diagnostics.filter(item => item.source === 'ledger' && item.code !== 'LEDGER_INVALID' && item.code !== 'LEDGER_UNREADABLE'));
      }
    }
    if (sources.context.status !== 'ok' && previous?.sources.context.updatedAt && sources.config.status !== 'stale') {
      roles = previous.roles.filter(role => role.configured);
      contextRevision = previous.contextRevision ?? null;
      sources.context = { status: 'stale', updatedAt: previous.sources.context.updatedAt };
    }
    for (const candidate of candidates ?? []) {
      if (!roles.some(role => role.name === candidate.role)) roles.push({ name: candidate.role, priority: null, status: null, configured: false });
    }
  }
  if (input.runFiles.status === 'missing' && previousRuns?.length) {
    runs = previousRuns;
    sources.runs = { status: 'stale', updatedAt: previous.sources.runs.updatedAt };
    diagnostics.push(diagnostic('RUNS_MISSING', 'runs', '进度目录已缺失，保留上次任务（陈旧记录）', 'error'));
  } else if (['ok', 'missing'].includes(input.runFiles.status)) {
    runs = [];
    let invalid = false, retained = false;
    const held = new Map((previousRuns ?? []).map(run => [run.id, run]));
    for (const file of input.runFiles.files ?? []) {
      try {
        const id = file.name.replace(/\.json$/, '');
        assertRunId(id);
        if (!file.name.endsWith('.json') || file.error) throw new Error('进度文件无法读取');
        runs.push(runSummary(validateRun(JSON.parse(file.text), id)));
      } catch {
        diagnostics.push(diagnostic('RUN_INVALID', 'runs', '一份进度文件无法读取或格式无效；其他轮次继续显示', 'error'));
        invalid = true;
        const old = held.get(file.name.replace(/\.json$/, ''));
        if (old) { runs.push(old); retained = true; }
      }
    }
    runs.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id));
    if (retained) sources.runs.status = 'stale';
    else if (invalid) sources.runs.status = 'error';
    sources.runs.updatedAt = retained ? previous.sources.runs.updatedAt : input.generatedAt;
    if (invalid && runs.length === 0) runs = null;
  } else {
    diagnostics.push(diagnostic('RUNS_UNREADABLE', 'runs', '无法读取进度目录，不能确定是否存在任务', 'error'));
    if (previousRuns) { runs = previousRuns; sources.runs = { status: 'stale', updatedAt: previous.sources.runs.updatedAt }; }
  }
  const stale = Object.values(sources).some(source => source.status === 'stale');
  const errors = diagnostics.filter(item => item.level === 'error');
  const status = stale ? 'stale' : candidates === null ? 'error' : diagnostics.some(item => item.level !== 'info') ? 'partial' : 'ok';
  return {
    schemaVersion: SCHEMA_VERSION, workspace: input.workspace, status,
    error: errors.length ? { code: errors[0].code, message: errors[0].message } : null,
    generatedAt: input.generatedAt, ledgerUpdatedAt, contextRevision, candidates,
    stages: STAGES.map(stage => ({ id: stage.id, label: stage.label, count: candidates === null ? null : candidates.filter(candidate => candidate.stage === stage.id).length })),
    roles, runs, unknownStatuses, diagnostics, sources
  };
}

/** @param {import('./types/index.d.ts').RunSummary[]|null} runs @param {import('./types/index.d.ts').TaskSelection} selection @param {boolean} hold @returns {import('./types/index.d.ts').TaskView} */
export function selectTask(runs, selection, hold = false) {
  const latest = (runs ?? []).reduce((latest, run) => latest === null || run.createdAt > latest.createdAt || (run.createdAt === latest.createdAt && run.id < latest.id) ? run : latest, /** @type {import('./types/index.d.ts').RunSummary|null} */ (null));
  const runId = selection.mode === 'live' && !(hold && selection.runId !== null) ? latest?.id ?? selection.runId : selection.runId;
  return {
    selection: { mode: selection.mode, runId }, run: runs?.find(run => run.id === runId) ?? null,
    latestRunId: latest?.id ?? null, newerRunId: latest && latest.id !== runId ? latest.id : null
  };
}

/** @param {BoardSnapshot} snapshot @param {string} role */
export function selectRole(snapshot, role = '') {
  const candidates = snapshot.candidates === null || (role && !snapshot.roles.some(item => item.name === role)) ? null : snapshot.candidates.filter(candidate => !role || candidate.role === role);
  return {
    candidates,
    total: candidates === null ? null : candidates.length,
    stages: STAGES.map(stage => ({ id: stage.id, label: stage.label, count: candidates === null ? null : candidates.filter(candidate => candidate.stage === stage.id).length }))
  };
}

/** @param {BoardSnapshot} snapshot @param {string} query @returns {Candidate[]|null} */
export function searchCandidates(snapshot, query = '') {
  if (snapshot.candidates === null) return null;
  const normalize = value => value.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();
  const search = normalize(query);
  if (!search) return [];
  const matches = /** @type {Candidate[][]} */ ([[], [], []]);
  for (const candidate of snapshot.candidates) {
    const name = normalize(candidate.name);
    if (name.includes(search)) matches[name === search ? 0 : name.startsWith(search) ? 1 : 2].push(candidate);
  }
  return matches.flat();
}

/** @param {BoardSnapshot} snapshot @param {{scope?:import('./types/index.d.ts').RoleScope, following?:string[], query?:string, role?:string}} options @returns {import('./types/index.d.ts').RoleSelection} */
export function selectRoles(snapshot, { scope = 'active', following = [], query = '', role = '' } = {}) {
  const selectedScope = ROLE_SCOPES.find(item => item.id === scope);
  if (!selectedScope) throw new Error('岗位范围必须为 active、following 或 all');
  const followed = new Set(following);
  const scopedRoles = snapshot.roles.filter(item => scope === 'all' || (scope === 'following' ? followed.has(item.name) : item.status === '在招'));
  const names = new Set(scopedRoles.map(item => item.name));
  const selectedRole = role ? snapshot.roles.find(item => item.name === role) ?? null : null;
  const selectionMissing = Boolean(role && !selectedRole);
  const outsideScope = Boolean(selectedRole && !names.has(selectedRole.name));
  const candidates = snapshot.candidates === null || selectionMissing ? null : snapshot.candidates.filter(candidate => role ? candidate.role === role : names.has(candidate.role));
  const search = query.trim().toLowerCase();
  const label = role ? selectionMissing ? `${role}（岗位已不存在，人数未知）` : `${selectedRole.name}${outsideScope ? '（不在当前范围）' : ''}` : selectedScope.label;
  return {
    roles: scopedRoles.filter(item => item.name.toLowerCase().includes(search)), selectedRole, outsideScope, selectionMissing,
    candidates, total: candidates === null ? null : candidates.length,
    stages: STAGES.map(stage => ({ id: stage.id, label: stage.label, count: candidates === null ? null : candidates.filter(candidate => candidate.stage === stage.id).length })), label
  };
}

export const RUN_LABELS = Object.freeze({ running: '进行中', waiting: '等待', completed: '已完成', failed: '失败', cancelled: '已取消' });
export const STEP_LABELS = Object.freeze({ pending: '待执行', running: '执行中', completed: '已完成', skipped: '已跳过', failed: '失败' });
export const candidateStatus = candidate => candidate.rawStatus === null ? `状态冲突：${candidate.statuses.map(status => status || '空状态').join(' / ')}` : `${candidate.rawStatus || '空状态'}${candidate.conflict ? ' · 重复记录评级冲突' : ''}`;
