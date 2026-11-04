import { createHash } from 'node:crypto';
import { validateContext } from './model.mjs';

export const DECISION_STATES = Object.freeze(['open', 'snoozed', 'decided', 'closed', 'cancelled', 'invalidated', 'history_review']);
export const ACTION_STATES = Object.freeze(['pending', 'running', 'done', 'failed', 'uncertain', 'cancelled']);
const inputError = message => Object.assign(new Error(message), { code: 'DECISION_INPUT_INVALID', status: 400 });
const stateError = message => Object.assign(new Error(message), { code: 'DECISION_STATE_INVALID', status: 409 });
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
export const decisionIdPattern = /^decision-[a-f0-9]{48}$/;
export function decisionId(value) {
  if (typeof value !== 'string' || !decisionIdPattern.test(value)) throw inputError('事项 ID 无效');
  return value;
}
export function text(value, label, max = 300) {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\x00-\x1f\x7f]/.test(value)) throw inputError(`${label} 必须为 1–${max} 字符的单行文本`);
  return value.trim();
}
export function date(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) throw inputError('时间必须为 ISO UTC 时间');
  return value;
}
function fields(value, allowed, required = []) {
  if (!object(value) || Object.keys(value).some(key => !allowed.includes(key)) || required.some(key => !Object.hasOwn(value, key))) throw inputError('事项数据缺少必填字段或包含未知字段');
}
function context(value) {
  try { return validateContext(value); }
  catch (error) { throw inputError(error.message); }
}
function key(value, label) {
  const result = text(value, label, 200);
  if (result !== value) throw inputError(`${label} 不得包含首尾空白`);
  return result;
}
export function identityOf(value) {
  fields(value, ['subjectKey', 'questionKey', 'scope'], ['subjectKey', 'questionKey', 'scope']);
  return { subjectKey: key(value.subjectKey, '对象键'), questionKey: key(value.questionKey, '问题键'), scope: key(value.scope, '适用范围') };
}
export function idForIdentity(identity) {
  const { subjectKey, questionKey, scope } = identityOf(identity);
  return `decision-${createHash('sha256').update(JSON.stringify([subjectKey, questionKey, scope])).digest('hex').slice(0, 48)}`;
}
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (object(value)) return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
}
export const requestHash = (operation, input) => createHash('sha256').update(JSON.stringify(canonical({ operation, input }))).digest('hex');

const common = ['requestId', 'expectedRevision'];
export const commandFields = {
  register: [...common, 'identity', 'title', 'source', 'evidence', 'deadline', 'blocking', 'context'],
  evidence: [...common, 'id', 'source', 'evidence', 'context'],
  decide: [...common, 'id', 'decision', 'actions', 'reason', 'source'],
  revise: [...common, 'id', 'decision', 'actions', 'reason', 'source', 'evidence'],
  reopen: [...common, 'id', 'reason', 'source', 'evidence'],
  snooze: [...common, 'id', 'until', 'reason'],
  close: [...common, 'id', 'reason'],
  cancel: [...common, 'id', 'reason'],
  invalidate: [...common, 'id', 'reason', 'evidence'],
  'resolve-history': [...common, 'id', 'resolution', 'reason', 'decision', 'actions', 'source'],
  action: [...common, 'id', 'actionId', 'status', 'reason', 'evidence', 'verification'],
  import: [...common, 'identity', 'title', 'source', 'evidence', 'createdAt', 'context']
};
export function validateCommand(operation, input) {
  if (!Object.hasOwn(commandFields, operation)) throw inputError('未知事项命令');
  const needsIdentity = operation === 'register' || operation === 'import';
  fields(input, commandFields[operation], [...common, ...(needsIdentity ? ['identity', 'title', 'source'] : ['id'])]);
  key(input.requestId, '请求 ID');
  if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0) throw inputError('expectedRevision 必须为非负安全整数');
  if (input.id !== undefined) decisionId(input.id);
  if (input.identity) identityOf(input.identity);
  if (input.title !== undefined) text(input.title, '事项标题');
  if (input.context !== undefined) context(input.context);
  for (const field of ['reason', 'evidence', 'verification']) if (input[field] !== undefined && input[field] !== null) text(input[field], field);
  if (input.source !== undefined) {
    fields(input.source, ['runId', 'resultId'], ['runId']);
    for (const field of ['runId', 'resultId']) if (input.source[field] !== undefined && (typeof input.source[field] !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(input.source[field]))) throw inputError('来源 runId/resultId 无效');
  }
  if (input.deadline != null) date(input.deadline);
  if (input.until != null) date(input.until);
  if (input.createdAt !== undefined) date(input.createdAt);
  if (input.blocking !== undefined && typeof input.blocking !== 'boolean') throw inputError('blocking 必须为布尔值');
  if (input.resolution !== undefined && !['open', 'decided', 'closed', 'cancelled', 'invalidated'].includes(input.resolution)) throw inputError('历史核对结果无效');
  return needsIdentity ? idForIdentity(input.identity) : input.id;
}

function answer(value, revision, now) {
  fields(value, ['text', 'scope', 'authority', 'expiresAt'], ['text', 'scope']);
  return {
    text: text(value.text, '决定内容'), scope: key(value.scope, '决定范围'),
    authority: value.authority == null ? null : text(value.authority, '授权依据'), expiresAt: value.expiresAt == null ? null : date(value.expiresAt), revision, recordedAt: now
  };
}
function newActions(input = [], revision, now) {
  if (!Array.isArray(input) || input.length > 32) throw inputError('一个决定最多包含 32 项动作');
  const ids = new Set();
  return input.map(item => {
    fields(item, ['id', 'label', 'kind'], ['id', 'label', 'kind']);
    const id = key(item.id, '动作 ID');
    if (ids.has(id)) throw inputError('动作 ID 不得重复');
    ids.add(id);
    if (!['sync', 'external', 'other'].includes(item.kind)) throw inputError('动作类型必须为 sync、external 或 other');
    return { id, label: text(item.label, '动作说明'), kind: item.kind, status: 'pending', reason: null, evidence: null, verification: null, decisionRevision: revision, updatedAt: now };
  });
}
export function followUpFor(actions) {
  const counts = Object.fromEntries(ACTION_STATES.map(status => [status, actions.filter(action => action.status === status).length]));
  const status = ['uncertain', 'failed', 'running', 'pending'].find(status => counts[status]) ?? (counts.done ? 'done' : counts.cancelled ? 'cancelled' : 'none');
  return { status, counts };
}
export function decisionView(item, now = new Date().toISOString()) {
  const { history, ...record } = item;
  return {
    ...record,
    effectiveState: item.state === 'snoozed' && item.snoozedUntil !== null && item.snoozedUntil <= now ? 'open' : item.state,
    followUp: followUpFor(item.actions), history: history.map(({ requestHash, ...entry }) => entry)
  };
}

export function applyDecision(previous, operation, input, now) {
  date(now);
  const id = validateCommand(operation, input);
  const hash = requestHash(operation, input);
  const replay = previous?.history.find(entry => entry.requestId === input.requestId);
  if (replay) {
    if (replay.requestHash !== hash) throw Object.assign(new Error('请求 ID 已用于不同内容，请使用新的请求 ID'), { code: 'DECISION_REQUEST_CONFLICT', status: 409 });
    return { item: previous, replayed: true, appliedRevision: replay.revision };
  }
  if ((previous?.revision ?? 0) !== input.expectedRevision) throw Object.assign(new Error(`事项版本冲突；当前版本 ${previous?.revision ?? 0}，请重读后再决定`), { code: 'DECISION_REVISION_CONFLICT', status: 409 });
  if (!previous && !['register', 'import'].includes(operation)) throw Object.assign(new Error('事项不存在'), { code: 'DECISION_NOT_FOUND', status: 404 });
  if (previous && now < previous.updatedAt) throw inputError('事项更新时间不能倒退');
  if (previous?.revision === Number.MAX_SAFE_INTEGER) throw inputError('事项版本达到安全整数上限');
  const revision = (previous?.revision ?? 0) + 1;
  const item = previous ? structuredClone(previous) : {
    schemaVersion: 1, id, identity: identityOf(input.identity), title: text(input.title, '事项标题'), state: operation === 'import' ? 'history_review' : 'open', revision: 0,
    createdAt: input.createdAt ?? now, updatedAt: now, deadline: input.deadline ?? null, blocking: input.blocking ?? false,
    snoozedUntil: null, reason: null, sources: [], decision: null, actions: [], history: []
  };
  if (item.createdAt > now) throw inputError('首次时间不得晚于记录时间');
  const needState = states => { if (!states.includes(item.state)) throw stateError(`当前 ${item.state} 状态不能执行 ${operation}`); };
  const requireReason = () => { item.reason = text(input.reason, '变更理由'); };
  const cancelPending = () => {
    item.actions = item.actions.map(action => ['pending', 'failed'].includes(action.status) ? { ...action, status: 'cancelled', reason: item.reason, updatedAt: now } : action);
  };
  const assertNoInFlight = () => {
    if (item.actions.some(action => ['running', 'uncertain'].includes(action.status))) throw stateError('执行中或结果待核实的动作须先核实，不能覆盖或归档');
  };
  const decide = () => {
    const next = answer(input.decision, revision, now);
    if (next.scope !== item.identity.scope) throw inputError('决定范围必须与事项身份范围一致；范围不同请登记独立事项');
    item.decision = next; item.actions = newActions(input.actions, revision, now); item.state = 'decided'; item.snoozedUntil = null;
  };
  if (operation === 'register' || operation === 'import') {
    if (previous && operation === 'import') throw stateError('历史事项已存在');
    if (previous && (JSON.stringify(item.identity) !== JSON.stringify(identityOf(input.identity)) || item.title !== text(input.title, '事项标题') || (input.deadline !== undefined && input.deadline !== item.deadline) || (input.blocking !== undefined && input.blocking !== item.blocking))) throw inputError('已有事项的身份、标题和范围不可用登记覆盖');
  } else if (operation === 'evidence') {
    text(input.evidence, '新增依据');
    if (!input.source) throw inputError('新增依据必须指向来源轮次');
  } else if (operation === 'decide') {
    needState(['open', 'snoozed']); decide(); item.reason = input.reason ?? null;
  } else if (operation === 'revise') {
    needState(['decided', 'closed']); requireReason(); assertNoInFlight(); decide();
  } else if (operation === 'reopen') {
    needState(['snoozed', 'decided', 'closed', 'cancelled', 'invalidated']); requireReason(); assertNoInFlight(); cancelPending(); item.state = 'open'; item.snoozedUntil = null;
  } else if (operation === 'snooze') {
    needState(['open', 'snoozed']); requireReason();
    if (!Object.hasOwn(input, 'until') || (input.until !== null && input.until <= now)) throw inputError('暂缓日期必须晚于当前时间，无期限请显式使用 null');
    item.state = 'snoozed'; item.snoozedUntil = input.until;
  } else if (operation === 'close') {
    needState(['decided']); requireReason();
    if (item.actions.some(action => !['done', 'cancelled'].includes(action.status))) throw stateError('仍有后续动作未完成，不能关闭事项');
    item.state = 'closed';
  } else if (operation === 'cancel' || operation === 'invalidate') {
    needState(['open', 'snoozed', 'decided', 'history_review']); requireReason(); assertNoInFlight();
    if (operation === 'invalidate') text(input.evidence, '失效依据');
    cancelPending(); item.state = operation === 'cancel' ? 'cancelled' : 'invalidated'; item.snoozedUntil = null;
  } else if (operation === 'resolve-history') {
    needState(['history_review']); requireReason();
    if (!['open', 'decided', 'closed', 'cancelled', 'invalidated'].includes(input.resolution)) throw inputError('历史核对结果无效');
    if (['decided', 'closed'].includes(input.resolution)) decide();
    else if (input.decision !== undefined || input.actions !== undefined) throw inputError('该核对结果不接受决定或动作');
    if (input.resolution === 'closed' && item.actions.length) throw stateError('历史归档不能同时创建待执行动作；请先记为已决定再核实动作');
    item.state = input.resolution;
  } else if (operation === 'action') {
    needState(['decided']);
    const target = item.actions.find(action => action.id === input.actionId);
    if (!target) throw inputError('动作不存在');
    if (!ACTION_STATES.includes(input.status)) throw inputError('动作状态无效');
    const transitions = {
      pending: ['running', 'done', 'failed', 'uncertain', 'cancelled'], running: ['done', 'failed', 'uncertain'],
      failed: ['pending', 'running', 'done', 'uncertain', 'cancelled'], uncertain: ['pending', 'running', 'done', 'failed', 'cancelled'], done: [], cancelled: []
    };
    if (!transitions[target.status].includes(input.status)) throw stateError(`动作不能从 ${target.status} 转为 ${input.status}`);
    if (['failed', 'uncertain', 'cancelled'].includes(input.status)) text(input.reason, '动作原因');
    if (input.status === 'done') text(input.evidence, '完成依据');
    if (target.status === 'uncertain' || (target.status === 'failed' && ['pending', 'running'].includes(input.status))) text(input.verification, '实际状态核实记录');
    Object.assign(target, { status: input.status, reason: input.reason ?? null, evidence: input.evidence ?? null, verification: input.verification ?? null, updatedAt: now });
  }
  if (input.context !== undefined) item.context = context(input.context);
  const source = input.source ? { ...input.source, recordedAt: now } : null;
  if (source && !item.sources.some(previous => previous.runId === source.runId && previous.resultId === source.resultId)) item.sources.push(source);
  item.revision = revision; item.updatedAt = now;
  item.history.push({ revision, requestId: input.requestId, requestHash: hash, operation, at: now, state: item.state, reason: input.reason ?? null, evidence: input.evidence ?? null, source, decision: structuredClone(item.decision), actions: structuredClone(item.actions), snoozedUntil: item.snoozedUntil, ...(item.context === undefined ? {} : { context: structuredClone(item.context) }) });
  return { item, replayed: false, appliedRevision: revision };
}

export function validateDecision(item, expectedId) {
  if (!object(item) || item.schemaVersion !== 1 || idForIdentity(item.identity) !== item.id || (expectedId && item.id !== expectedId) || !DECISION_STATES.includes(item.state)) throw inputError('事项版本、身份或状态无效');
  text(item.title, '事项标题'); date(item.createdAt); date(item.updatedAt);
  if (item.context !== undefined) context(item.context);
  if (item.createdAt > item.updatedAt || !Number.isSafeInteger(item.revision) || item.revision < 1 || !Array.isArray(item.history) || item.history.length !== item.revision) throw inputError('事项版本或历史无效');
  if (typeof item.blocking !== 'boolean' || (item.deadline !== null && !date(item.deadline)) || (item.snoozedUntil !== null && !date(item.snoozedUntil))) throw inputError('事项期限无效');
  if (item.reason !== null) text(item.reason, '理由');
  if (item.state !== 'snoozed' && item.snoozedUntil !== null) throw inputError('非暂缓事项不能设置提醒日期');
  if (!Array.isArray(item.sources) || !item.sources.length || !Array.isArray(item.actions)) throw inputError('事项来源或动作无效');
  const validateAnswer = value => {
    if (value === null) return;
    if (!object(value) || !Number.isSafeInteger(value.revision) || value.revision < 1 || value.revision > item.revision || value.scope !== item.identity.scope) throw inputError('决定版本或范围无效');
    text(value.text, '决定内容'); date(value.recordedAt);
    if (value.authority !== null) text(value.authority, '授权依据');
    if (value.expiresAt !== null) date(value.expiresAt);
  };
  const validateActions = actions => {
    if (!Array.isArray(actions) || actions.length > 32 || new Set(actions.map(action => action.id)).size !== actions.length) throw inputError('动作列表无效');
    for (const action of actions) {
      key(action.id, '动作 ID'); text(action.label, '动作说明'); date(action.updatedAt);
      if (!['sync', 'external', 'other'].includes(action.kind) || !ACTION_STATES.includes(action.status) || !Number.isSafeInteger(action.decisionRevision) || action.decisionRevision < 1 || action.decisionRevision > item.revision) throw inputError('动作记录无效');
      for (const field of ['reason', 'evidence', 'verification']) if (action[field] !== null) text(action[field], field);
      if (action.status === 'done' && !action.evidence) throw inputError('完成动作缺少证据');
    }
  };
  const sourceKeys = new Set();
  for (const source of item.sources) {
    if (!object(source) || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(source.runId) || (source.resultId !== undefined && !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(source.resultId))) throw inputError('事项来源无效');
    date(source.recordedAt);
    const sourceKey = JSON.stringify([source.runId, source.resultId]);
    if (sourceKeys.has(sourceKey)) throw inputError('事项来源重复');
    sourceKeys.add(sourceKey);
  }
  const requests = new Set(); let lastTime = item.createdAt;
  for (const [index, entry] of item.history.entries()) {
    if (!object(entry) || entry.revision !== index + 1 || !/^[a-f0-9]{64}$/.test(entry.requestHash) || !Object.hasOwn(commandFields, entry.operation) || !DECISION_STATES.includes(entry.state)) throw inputError('事项历史无效');
    key(entry.requestId, '请求 ID'); date(entry.at);
    if (requests.has(entry.requestId) || entry.at < lastTime || entry.at > item.updatedAt) throw inputError('事项历史时间或请求重复');
    requests.add(entry.requestId); lastTime = entry.at;
    validateAnswer(entry.decision); validateActions(entry.actions);
    if (entry.context !== undefined) context(entry.context);
  }
  validateAnswer(item.decision); validateActions(item.actions);
  if (['decided', 'closed'].includes(item.state) && item.decision === null) throw inputError('已决定事项缺少决定内容');
  if (item.state === 'closed' && item.actions.some(action => !['done', 'cancelled'].includes(action.status))) throw inputError('关闭事项仍有未完成动作');
  const latest = item.history.at(-1);
  for (const field of ['state', 'decision', 'actions', 'snoozedUntil', 'context']) if (JSON.stringify(canonical(item[field])) !== JSON.stringify(canonical(latest[field]))) throw inputError('事项当前值与最后修订不一致');
  if (latest.at !== item.updatedAt) throw inputError('事项更新时间与最后修订不一致');
  return item;
}
