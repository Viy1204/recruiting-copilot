import { candidateStatus, candidateSubject, validateContext, ROLE_SCOPES, RUN_LABELS, searchCandidates, selectRoles, selectTask, STAGES, STEP_LABELS } from '/model.mjs';
import { createSnapshotController } from '/live.mjs';
import { ariaKeyshortcuts, bindLayer, bindPart, createChange, createReorder, createRovingFocus, createSelection, definePrimitive, formatShortcut, fuzzyScore, keepFocus, matchRanges, matchSegments, matchesShortcut, registerShortcut } from '/vendor/ui-sdk-core/index.js';

const byId = id => document.getElementById(id);
const roleSelect = byId('role'), runSelect = byId('run'), refreshButton = byId('refresh-board');
const initialURL = new URL(window.location.href), initialWorkspace = initialURL.searchParams.get('workspace');
let expectedWorkspaceKey = /^[a-f0-9]{64}$/i.test(initialWorkspace ?? '') ? initialWorkspace.toLowerCase() : null;
let workspaceBlocked = initialWorkspace !== null && expectedWorkspaceKey === null;
let snapshot = null, taskSelection = { mode: 'live', runId: null }, selectedStage = 'all', disconnected = false;
let selectionMessage = '', displayedRun = null, pageActive = true;
let candidateSearchLimit = 20, candidateStageLimit = 20, appliedCandidateActivity;
const motionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
const text = (target, value) => { const element = typeof target === 'string' ? byId(target) : target; if (element.textContent !== value) element.textContent = value; };
let selectedCandidateId = null, candidateOrigin = null, recordRequest = 0, documentRequest = 0, roleRequest = 0, roleInfo = null, csrfToken = null;
let rolePreferences = { scope: 'active', following: [], role: '' }, preferenceKey = null, temporaryPreferencesChanged = false, preferenceMessage = '';
let resultsRequest = 0;
const freshResults = runId => ({ runId, open: true, filter: 'all', data: undefined, status: 'idle', error: null, requestedVersion: null, loadedVersion: null, updatedAt: null, expanded: new Set() });
let resultsState = freshResults(null);
const overviewState = { data: null, status: 'idle', error: '', stale: false, missing: false, readAt: null, pending: null, pendingRunId: null, filter: 'auto' };
const triageState = { activeId: null, expandedId: null, drafts: new Map(), status: '', statusError: false, submittingId: null, userCollapsed: false };
let triageCleanups = [], triageInst = null, bypassOverviewFreeze = false, drawerLayerCleanup = null, pickerLayerCleanup = null, paletteLayerCleanup = null;
const paletteState = { open: false, query: '', activeIndex: 0, results: [], composing: false, returnFocus: null };
let paletteIndexCache = { snapshot: null, overview: null, items: [] };
const candidateRoving = { search: { inst: null, cleanups: [] }, stage: { inst: null, cleanups: [] } };
const drawerState = { page: null, group: 'all', listKind: 'decisions', itemId: null, returnFocus: null, listFocus: null, listScroll: 0, pageScroll: 0, expanded: new Set(), stack: [] };
let roleRangeMessage = '';
let runHighlightsRequest = 0, runHighlightsAbort = null;
const scopeSummary = scope => ({ active: '在招岗位汇总', following: '我的关注汇总', all: '全部岗位汇总' }[scope]);
const unknownRole = role => !role.configured || !['在招', '已关闭', '已下架', '暂停', '待核'].includes(role.status);
const stamp = value => {
  const date = new Date(value);
  const pad = number => String(number).padStart(2, '0');
  return { date: `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`, time: `${pad(date.getHours())}:${pad(date.getMinutes())}` };
};
const time = value => value ? (({ date, time }) => `${date} ${time}`)(stamp(value)) : '未知';
const shortTime = value => value ? (({ date, time }) => `${date.slice(5)} ${time}`)(stamp(value)) : '未知';
const node = (tag, className, text) => {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
};

const LAYOUT_GROUPS = {
  board: { parent: 'layout-root', label: '工作台分组', members: [{ id: 'assistant', label: '确认事项' }, { id: 'roles', label: '岗位与人选' }, { id: 'tasks', label: '任务与记录' }] },
  roles: { parent: 'role-blocks', label: '岗位与人选', members: [{ id: 'role-scope', label: '岗位范围' }, { id: 'candidate-stages', label: '候选阶段' }] },
  tasks: { parent: 'task-blocks', label: '任务与记录', members: [{ id: 'task-card', label: '任务摘要' }, { id: 'execution-records', label: '执行记录' }] }
};
const defaultLayoutOrders = () => Object.fromEntries(Object.entries(LAYOUT_GROUPS).map(([id, group]) => [id, group.members.map(member => member.id)]));
const layoutState = { editing: false, workspaceKey: null, orders: defaultLayoutOrders(), changedBeforeLoad: false, storageMessage: '' };
const layoutItems = new Map(), layoutGroups = new Map();
let applyingLayout = false;

const workspaceNavTargets = {
  overview: byId('workbench-heading'),
  roles: byId('candidates-heading'),
  tasks: byId('execution-records').querySelector('summary h3'),
  following: byId('choose-following')
};
workspaceNavTargets.tasks.tabIndex = -1;
const navButtons = [...document.querySelectorAll('[data-nav-target]')];
let activeView = 'overview';
let workspaceNavFocus = null;

function focusWorkbenchTarget(element, block = 'start') {
  element.focus({ preventScroll: true });
  element.scrollIntoView({ block, behavior: motionQuery.matches ? 'instant' : 'smooth' });
}

function setWorkspaceNavTarget(target) {
  activeView = target;
  document.querySelector('.app').dataset.view = target;
  for (const [view, id] of Object.entries({ overview: 'assistant', roles: 'role-browser', tasks: 'tasks' })) byId(id).hidden = !layoutState.editing && view !== target;
  text('workbench-heading', { overview: '招聘工作台', roles: '岗位与人选', tasks: '执行记录' }[target]);
  text('breadcrumb-view', { overview: '总览', roles: '岗位与人选', tasks: '执行记录' }[target]);
  text('workbench-subtitle', { overview: '先看需要你关注的事', roles: '按岗位查看阶段，点击人选查看跟进与资料', tasks: '查看每轮结论、下一步与处理经过' }[target]);
  for (const button of navButtons) {
    if (button.dataset.navTarget === target) button.setAttribute('aria-current', 'location');
    else button.removeAttribute('aria-current');
  }
}

function navigateWorkspace(target) {
  if (byId('cancel-role').disabled && activeView !== target) return;
  if (drawerState.page) closeWorkspaceDrawer(false);
  setWorkspaceNavTarget(target);
  if (target === 'tasks') {
    byId('execution-records').open = true;
    if (snapshot && !workspaceBlocked) { renderRunResults(selectedRun()); void loadRunHighlights(); }
  }
  renderWorkspaceTasks(); renderOverviewReadingNotice();
  focusWorkbenchTarget(workspaceNavTargets[target]);
}

for (const button of navButtons) button.addEventListener('click', () => navigateWorkspace(button.dataset.navTarget));

function visibleWorkbenchTarget(element) {
  const style = getComputedStyle(element);
  return element.getClientRects().length > 0 && style.display !== 'none' && style.visibility === 'visible';
}

document.addEventListener('focusin', event => {
  const navItem = event.target.closest?.('[data-nav-target]');
  workspaceNavFocus = navItem ? navItem.dataset.navTarget : null;
});
document.addEventListener('pointerdown', event => { if (!event.target.closest?.('[data-nav-target]')) workspaceNavFocus = null; }, true);
function isCompactTriage() {
  const app = document.querySelector('.app');
  if (app?.dataset.preview === 'narrow') return true;
  const width = app?.getBoundingClientRect().width ?? 0;
  if (width > 0) return width < 900;
  return typeof window.__workbenchWidth === 'number' && window.__workbenchWidth < 900;
}
let lastCompactTriage = isCompactTriage();
function syncCompactTriage() {
  const next = isCompactTriage();
  if (next === lastCompactTriage) return;
  lastCompactTriage = next;
  if (next && triageState.activeId) { triageState.expandedId = triageState.activeId; triageState.userCollapsed = false; }
  if (!next && !triageState.activeId && triageState.expandedId) triageState.activeId = triageState.expandedId;
  if (overviewState.data) renderWorkspaceOverview();
}
if (typeof ResizeObserver === 'function') {
  new ResizeObserver(() => {
    syncCompactTriage();
    if (!workspaceNavFocus) return;
    const active = document.activeElement;
    if (active !== document.body && active !== document.documentElement && visibleWorkbenchTarget(active)) return;
    const target = workspaceNavFocus;
    workspaceNavFocus = null;
    const tab = navButtons.find(button => button.dataset.navTarget === target && visibleWorkbenchTarget(button));
    if (tab) { tab.focus({ preventScroll: true }); return; }
    const heading = workspaceNavTargets[target];
    if (heading && visibleWorkbenchTarget(heading)) focusWorkbenchTarget(heading);
  }).observe(document.querySelector('.app'));
}
window.addEventListener('resize', syncCompactTriage);

const initialPreviewMode = initialURL.searchParams.get('preview');
const previewEnabled = ['wide', 'narrow'].includes(initialPreviewMode);
function setPreviewMode(mode) {
  if (!previewEnabled) return;
  document.querySelector('.app').dataset.preview = mode;
  for (const button of byId('preview-toolbar').querySelectorAll('[data-preview-mode]')) button.setAttribute('aria-pressed', String(button.dataset.previewMode === mode));
  const url = new URL(window.location.href);
  url.searchParams.set('preview', mode);
  if (url.href !== window.location.href) window.history.replaceState(null, '', url);
  syncCompactTriage();
}
byId('preview-toolbar').hidden = !previewEnabled;
if (previewEnabled) setPreviewMode(initialPreviewMode);
for (const button of byId('preview-toolbar').querySelectorAll('[data-preview-mode]')) button.addEventListener('click', () => setPreviewMode(button.dataset.previewMode));

function announceLayout(message) {
  text('layout-announcement', message);
}

function renderLayoutStorageNotice() {
  const message = layoutState.storageMessage || (!layoutState.workspaceKey && (layoutState.editing || layoutState.changedBeforeLoad) ? '尚未取得工作区标识，布局暂仅在本页保留。' : '');
  text('layout-storage-note', message);
  byId('layout-storage-note').hidden = !message;
}

function persistLayoutOrders() {
  if (!layoutState.workspaceKey) layoutState.changedBeforeLoad = true;
  else {
    try {
      localStorage.setItem(`recruiting-board:layout:v1:${layoutState.workspaceKey}`, JSON.stringify({ version: 1, orders: layoutState.orders }));
      layoutState.storageMessage = '';
      layoutState.changedBeforeLoad = false;
    } catch (error) {
      layoutState.storageMessage = '本机布局保存失败；本页排序仍有效，刷新后可能不会保留。';
    }
  }
  renderLayoutStorageNotice();
}

function parseLayoutOrders(value) {
  if (!value || value.version !== 1 || !value.orders || typeof value.orders !== 'object' || Array.isArray(value.orders)) throw new Error('布局记录格式无效');
  const orders = defaultLayoutOrders();
  let repaired = Object.keys(value.orders).some(id => !Object.hasOwn(LAYOUT_GROUPS, id));
  for (const [id, defaults] of Object.entries(orders)) {
    const saved = value.orders[id];
    if (saved !== undefined && !Array.isArray(saved)) throw new Error('布局分组格式无效');
    const known = new Set(defaults), unique = new Set((saved ?? []).filter(member => typeof member === 'string' && known.has(member)));
    orders[id] = [...unique, ...defaults.filter(member => !unique.has(member))];
    if (JSON.stringify(saved) !== JSON.stringify(orders[id])) repaired = true;
  }
  return { orders, repaired };
}

function domApplyGroupOrder(groupId, order) {
  const focused = document.activeElement, selection = focused?.matches('input, textarea') && typeof focused.selectionStart === 'number' ? [focused.selectionStart, focused.selectionEnd, focused.selectionDirection] : null;
  applyingLayout = true;
  try {
    const parent = byId(LAYOUT_GROUPS[groupId].parent);
    let position = parent.firstElementChild;
    for (const id of order) {
      const element = layoutItems.get(id)?.element;
      if (!element) continue;
      if (element !== position) { if (typeof parent.moveBefore === 'function') parent.moveBefore(element, position); else parent.insertBefore(element, position); }
      position = element.nextElementSibling;
    }
    if (focused?.isConnected && document.activeElement !== focused) { focused.focus({ preventScroll: true }); if (selection) focused.setSelectionRange(...selection); }
  } finally { applyingLayout = false; }
}

function updateLayoutControls(groupIdFilter = null) {
  for (const [groupId, group] of Object.entries(LAYOUT_GROUPS)) {
    if (groupIdFilter && groupId !== groupIdFilter) continue;
    const inst = layoutGroups.get(groupId), state = inst?.get(), order = state ? inst.api.reorder.order(state) : layoutState.orders[groupId];
    for (const member of group.members) {
      const controls = layoutItems.get(member.id), position = order.indexOf(member.id);
      if (!controls) continue;
      const moving = state ? inst.api.reorder.moving(state, member.id) : false, dragging = state ? inst.api.reorder.dragging(state, member.id) : false;
      controls.bar.hidden = !layoutState.editing;
      controls.element.classList.toggle('layout-dragging', dragging);
      controls.element.classList.toggle('layout-grabbed', moving && !dragging);
      controls.handle.setAttribute('aria-pressed', String(moving));
      controls.handle.setAttribute('aria-label', `调整${member.label}顺序，${group.label}第 ${position + 1} / ${order.length} 位`);
      controls.up.setAttribute('aria-disabled', String(position === 0));
      controls.down.setAttribute('aria-disabled', String(position === order.length - 1));
    }
  }
  if ([...layoutGroups.values()].some(inst => inst.get().draft?.pointer)) document.documentElement.dataset.layoutDragging = 'true';
  else delete document.documentElement.dataset.layoutDragging;
}

function applyLayoutOrders(orders) {
  layoutState.orders = orders;
  for (const groupId of Object.keys(LAYOUT_GROUPS)) { domApplyGroupOrder(groupId, orders[groupId]); layoutGroups.get(groupId)?.setOptions({ order: orders[groupId] }); }
  updateLayoutControls();
}

const hasActiveLayoutDraft = () => [...layoutGroups.values()].some(inst => Boolean(inst.get().draft));
const cancelLayoutDrafts = () => { for (const inst of layoutGroups.values()) inst.api.reorder.cancel(); };

function syncLayoutPreferences() {
  if (layoutState.workspaceKey || !snapshot?.workspaceKey || hasActiveLayoutDraft()) return;
  layoutState.workspaceKey = snapshot.workspaceKey;
  let orders = defaultLayoutOrders();
  try {
    const saved = localStorage.getItem(`recruiting-board:layout:v1:${layoutState.workspaceKey}`);
    if (saved !== null) {
      try {
        const parsed = parseLayoutOrders(JSON.parse(saved)); orders = parsed.orders;
        if (parsed.repaired) layoutState.storageMessage = '本机布局记录已整理：忽略无效或重复项，并补齐缺少的模块。';
      } catch { layoutState.storageMessage = '本机布局记录损坏或版本不兼容，已恢复默认顺序。'; }
    }
  } catch { layoutState.storageMessage = '本机布局读取失败；本页仍可排序，刷新后可能不会保留。'; }
  if (!layoutState.changedBeforeLoad) applyLayoutOrders(orders); else persistLayoutOrders();
  renderLayoutStorageNotice();
}

function setLayoutEditing(editing) {
  cancelLayoutDrafts(); layoutState.editing = editing;
  byId('edit-layout').setAttribute('aria-expanded', String(editing)); byId('layout-editor').hidden = !editing;
  byId('layout-toolbar').classList.toggle('is-editing', editing); byId('layout-root').classList.toggle('is-editing', editing);
  setWorkspaceNavTarget(activeView); updateLayoutControls(); renderLayoutStorageNotice(); renderCandidateSearch();
  announceLayout(editing ? '正在调整布局。可拖动同级模块、点上移／下移，或在把手上使用上下箭头。' : '已完成布局调整。');
  if (!editing) byId('edit-layout').focus({ preventScroll: true });
}

function layoutIcon(paths) {
  const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  icon.setAttribute('viewBox', '0 0 24 24'); icon.setAttribute('aria-hidden', 'true'); icon.setAttribute('focusable', 'false');
  for (const d of paths) { const path = document.createElementNS('http://www.w3.org/2000/svg', 'path'); path.setAttribute('d', d); icon.append(path); }
  return icon;
}

const layoutGroupPrimitive = definePrimitive({
  name: 'layout-group', options: { order: 'object' },
  state: options => ({ order: options.order ?? [], draft: null }), sync: options => ({ order: options.order }),
  api: context => ({
    reorder: createReorder(context, {
      key: 'order', draft: 'draft', orientation: () => 'vertical', label: id => layoutItems.get(id)?.label ?? id,
      set: next => { applyLayoutOrders({ ...layoutState.orders, [context.id]: next }); persistLayoutOrders(); announceLayout(`${LAYOUT_GROUPS[context.id].label}顺序已更新。`); return true; }
    })
  }),
  slots: slot => ({ item: slot({ props: { id: 'string' }, bind: (el, part) => part.api.reorder.bind(el, { key: part.props.id, props: part.props }) }) })
});

for (const [groupId, group] of Object.entries(LAYOUT_GROUPS)) {
  const inst = layoutGroupPrimitive({ id: groupId, order: layoutState.orders[groupId] });
  layoutGroups.set(groupId, inst);
  for (const member of group.members) {
    const element = byId(group.parent).querySelector(`:scope > [data-layout-item="${member.id}"]`);
    const bar = node('div', 'layout-item-controls'); bar.hidden = true; bar.setAttribute('role', 'group'); bar.setAttribute('aria-label', `${member.label}布局操作`);
    const handle = node('button', 'layout-drag-handle'); handle.type = 'button'; handle.id = `layout-handle-${member.id}`; handle.dataset.layoutHandle = member.id;
    handle.setAttribute('aria-describedby', 'layout-help'); handle.setAttribute('aria-controls', group.parent);
    handle.setAttribute('aria-keyshortcuts', 'ArrowUp ArrowDown Enter Space Escape'); handle.setAttribute('aria-pressed', 'false');
    handle.title = `拖动${member.label}；也可用 ↑↓ 调整，Enter 确认，Esc 取消`;
    handle.append(layoutIcon(['M9 5h.01M9 12h.01M9 19h.01M15 5h.01M15 12h.01M15 19h.01']), node('span', 'layout-handle-label', member.label));
    const up = node('button', 'layout-move-button'), down = node('button', 'layout-move-button');
    for (const [button, direction, offset, path] of [[up, '上移', -1, 'M12 19V5M5 12l7-7 7 7'], [down, '下移', 1, 'M12 5v14M5 12l7 7 7-7']]) {
      button.type = 'button'; button.dataset.layoutMove = offset < 0 ? 'up' : 'down'; button.setAttribute('aria-label', `${direction}${member.label}`); button.title = direction;
      button.append(layoutIcon([path]));
      button.addEventListener('click', () => { if (!layoutState.editing) return; inst.api.reorder.cancel(); const order = layoutState.orders[groupId], target = order.indexOf(member.id) + offset; if (target >= 0 && target < order.length) inst.api.reorder.move(member.id, target); });
    }
    handle.addEventListener('keydown', event => {
      if (!layoutState.editing || event.isComposing || event.altKey || event.ctrlKey || event.metaKey) return;
      if ((event.key === 'ArrowUp' || event.key === 'ArrowDown') && !inst.get().draft) inst.api.reorder.grab(member.id);
      if (inst.api.reorder.keydown(event, member.id)) event.stopPropagation();
    });
    handle.addEventListener('pointerdown', event => {
      if (!layoutState.editing || event.button !== 0 || !event.isPrimary) return;
      inst.api.reorder.pointerdown(event, member.id);
      event.preventDefault(); event.stopPropagation(); handle.focus({ preventScroll: true });
    });
    handle.addEventListener('dragstart', event => event.preventDefault());
    bar.append(handle, up, down); element.prepend(bar);
    layoutItems.set(member.id, { ...member, groupId, element, bar, handle, up, down });
    bindPart(inst, 'item', element, { id: member.id });
  }
  inst.subscribe(() => { if (!applyingLayout) domApplyGroupOrder(groupId, inst.api.reorder.order(inst.get())); updateLayoutControls(groupId); });
}
updateLayoutControls();
byId('edit-layout').addEventListener('click', () => setLayoutEditing(!layoutState.editing));
byId('finish-layout').addEventListener('click', () => setLayoutEditing(false));
byId('reset-layout').addEventListener('click', () => {
  cancelLayoutDrafts();
  applyLayoutOrders(defaultLayoutOrders()); persistLayoutOrders();
  announceLayout('已恢复默认布局：确认事项、岗位与人选、任务与记录；组内顺序也已恢复。');
});
document.addEventListener('keydown', event => {
  if (!layoutState.editing || event.key !== 'Escape' || event.isComposing) return;
  if (hasActiveLayoutDraft()) { event.preventDefault(); event.stopPropagation(); cancelLayoutDrafts(); }
  else if (event.target.closest('.layout-item-controls, #layout-toolbar')) { event.preventDefault(); event.stopPropagation(); setLayoutEditing(false); }
}, true);
window.addEventListener('blur', cancelLayoutDrafts);
window.addEventListener('pagehide', cancelLayoutDrafts);
document.addEventListener('visibilitychange', () => { if (document.hidden) cancelLayoutDrafts(); });

function options(select, values, selection) {
  const signature = JSON.stringify(values);
  if (select.dataset.options !== signature) {
    select.replaceChildren(...values.map(([value, label]) => {
      const option = node('option', '', label); option.value = value; return option;
    }));
    select.dataset.options = signature;
  }
  if (select.value !== selection) select.value = selection;
}

function workspaceHeaders(headers = {}) {
  return { ...headers, ...(expectedWorkspaceKey ? { 'X-Workspace-Key': expectedWorkspaceKey } : {}) };
}

async function jsonRequest(url, init = {}) {
  if (workspaceBlocked) throw new Error('服务已指向其他工作区，请重新打开');
  const response = await fetch(url, { cache: 'no-store', signal: AbortSignal.timeout(10000), ...init, headers: workspaceHeaders(init.headers) });
  const data = await response.json();
  if (!response.ok) {
    if (data.error?.code === 'WORKSPACE_MISMATCH') blockWorkspace();
    throw new Error(data.error?.message ?? '本地操作失败，请重试');
  }
  return data;
}

const DECISION_STATES = { open: '待确认', snoozed: '已暂缓', decided: '已决定', closed: '已完成', cancelled: '已取消', invalidated: '已失效', history_review: '历史待核对' };
const ACTION_STATES = { pending: '待执行', running: '执行中', done: '已完成', failed: '执行失败', uncertain: '结果待核实', cancelled: '已取消' };
const DECISION_GROUPS = { open: '当前待处理', snoozed: '已暂缓', history_review: '历史待核对', followUp: '后续执行', closed: '处理历史', all: '全部事项' };
const hasFollowUp = item => item.state === 'decided' && ['pending', 'running', 'failed', 'uncertain'].includes(item.followUp.status);
const triggerLabel = value => ({ manual: '主动任务', scheduled: '定时巡检', unknown: '来源未记录' }[value] ?? '来源未记录');
const runSummaryLabel = run => {
  if ((run.highlightCount ?? 0) > 0 && !run.closingSummary) return ['running', 'waiting'].includes(run.status) ? '已记录重点，摘要待收尾' : '已记录重点，收尾摘要未记录';
  if (run.summaryState === 'no_change') return '无重要变化';
  if (run.summaryState === 'highlights' || (run.highlightCount ?? 0) > 0) return '已记录重点';
  return '本轮未记录重点';
};
const actionLabel = action => action.kind === 'sync' ? ({ pending: '资料待同步', running: '资料同步中', done: '资料已同步', failed: '资料同步失败', uncertain: '同步结果待核实', cancelled: '同步已取消' }[action.status]) : ACTION_STATES[action.status];
function validDisplayInfo(item) {
  if (item.context !== undefined) {
    try { validateContext(item.context); } catch { return false; }
  }
  if (item.details !== undefined && (!Array.isArray(item.details) || item.details.length > 8 || item.details.some(field => !field || typeof field.label !== 'string' || typeof field.value !== 'string'))) return false;
  if (item.subjects !== undefined && (!Array.isArray(item.subjects) || item.subjects.some(subject => !subject || !['name', 'role', 'rawRole', 'candidateId'].every(key => subject[key] === null || typeof subject[key] === 'string')))) return false;
  if (item.associationMessages !== undefined && (!Array.isArray(item.associationMessages) || item.associationMessages.some(message => typeof message !== 'string'))) return false;
  return true;
}
const isHighlight = item => item && validDisplayInfo(item) && ['eventKey', 'text', 'occurredAt', 'updatedAt'].every(key => typeof item[key] === 'string') && (item.history == null || (Array.isArray(item.history) && item.history.every(entry => entry && Number.isSafeInteger(entry.revision) && entry.revision > 0 && ['text', 'occurredAt', 'updatedAt'].every(key => typeof entry[key] === 'string'))));

function checkWorkspaceOverview(response) {
  const count = value => value === null || (Number.isSafeInteger(value) && value >= 0);
  const source = value => value && typeof value.runId === 'string' && typeof value.recordedAt === 'string';
  const answer = value => value === null || (value && ['text', 'scope', 'recordedAt'].every(key => typeof value[key] === 'string'));
  const action = value => value && typeof value.label === 'string' && Object.hasOwn(ACTION_STATES, value.status) && ['sync', 'external', 'other'].includes(value.kind);
  const history = value => value && typeof value.at === 'string' && Object.hasOwn(DECISION_STATES, value.state) && answer(value.decision) && Array.isArray(value.actions) && value.actions.every(action) && (value.source === null || source(value.source));
  const activity = value => value && typeof value.candidateId === 'string' && typeof value.at === 'string' && Number.isFinite(Date.parse(value.at)) && ['day', 'instant'].includes(value.precision) && ['archive', 'result'].includes(value.sourceKind);
  if (!response || !['ok', 'missing', 'stale', 'error'].includes(response.status) || !response.counts || !['open', 'snoozed', 'history', 'followUp'].every(key => count(response.counts[key])) || !Array.isArray(response.diagnostics) || response.diagnostics.some(item => !item || typeof item.message !== 'string')) throw new Error('工作区事项响应格式不兼容');
  if (response.candidateActivity !== undefined && response.candidateActivity !== null && (!Array.isArray(response.candidateActivity) || response.candidateActivity.some(item => !activity(item)))) throw new Error('人选活动时间响应格式不兼容');
  if (response.decisions !== null && (!Array.isArray(response.decisions) || response.decisions.some(item => !item || !validDisplayInfo(item) || !['id', 'title', 'createdAt', 'updatedAt'].every(key => typeof item[key] === 'string') || (item.deadline !== null && typeof item.deadline !== 'string') || !Object.hasOwn(DECISION_STATES, item.state) || !Object.hasOwn(DECISION_STATES, item.effectiveState) || !item.identity || !['subjectKey', 'questionKey', 'scope'].every(key => typeof item.identity[key] === 'string') || !Array.isArray(item.sources) || !item.sources.every(source) || !Array.isArray(item.actions) || !item.actions.every(action) || !Array.isArray(item.history) || !item.history.every(history) || !answer(item.decision) || !item.followUp || !['none', ...Object.keys(ACTION_STATES)].includes(item.followUp.status)))) throw new Error('工作区事项内容格式不兼容');
  if (response.highlights !== null && (!Array.isArray(response.highlights) || response.highlights.some(item => !isHighlight(item) || (typeof item.runId !== 'string' && !(item.runId === null && item.sourceKind === 'archive' && typeof item.sourceDocumentId === 'string'))))) throw new Error('近期重点响应格式不兼容');
  return response;
}

function overviewReading() {
  if (bypassOverviewFreeze) return false;
  const active = document.activeElement;
  return Boolean(
    drawerState.page
    || paletteState.open
    || byId('source-details').open
    || active?.closest?.('.decision-composer-input, .decision-composer-form')
    || document.querySelector('#triage-inspector details[open], .triage-inline-body details[open]')
    || (activeView === 'tasks' && byId('execution-records').open)
    || (activeView === 'roles' && (
      selectedCandidateId
      || (selectedStage && selectedStage !== 'all')
      || !byId('role-manager').hidden
      || byId('candidate-query').value.trim()
      || byId('candidate-list').contains(active)
      || byId('candidate-search-list').contains(active)
    ))
    || layoutState.editing
  );
}

function overviewDataSignature(value) {
  return JSON.stringify([value?.decisions, value?.highlights, value?.candidateActivity, value?.counts]);
}

function acceptWorkspaceOverview(response) {
  const previous = overviewState.pending ?? overviewState.data;
  const retainedDecisions = response.decisions === null && Array.isArray(previous?.decisions);
  const retainedHighlights = response.highlights === null && Array.isArray(previous?.highlights);
  const retainedActivity = response.candidateActivity == null && Array.isArray(previous?.candidateActivity);
  const next = {
    ...response,
    decisions: retainedDecisions ? previous.decisions : response.decisions,
    highlights: retainedHighlights ? previous.highlights : response.highlights,
    candidateActivity: retainedActivity ? previous.candidateActivity : response.candidateActivity,
    counts: retainedDecisions ? previous.counts : response.counts,
    updatedAt: retainedDecisions || retainedHighlights || retainedActivity ? previous.updatedAt ?? response.updatedAt : response.updatedAt
  };
  overviewState.status = response.status;
  overviewState.error = [...new Set(response.diagnostics.map(item => item.message).filter(Boolean))].join(' ');
  overviewState.stale = ['stale', 'error'].includes(response.status) || retainedDecisions || retainedHighlights || retainedActivity;
  overviewState.missing = response.status === 'missing';
  if (response.status === 'ok') overviewState.readAt = new Date().toISOString();
  if (overviewState.data && overviewReading() && overviewDataSignature(next) !== overviewDataSignature(overviewState.data)) overviewState.pending = next;
  else { overviewState.data = next; overviewState.pending = null; }
  renderCandidateOrdering();
  renderWorkspaceOverview();
  renderLinkedDecisions();
  if (snapshot) renderRunResults(selectedRun());
}

function workspaceDecisionGroups(data) {
  const items = data?.decisions;
  if (!Array.isArray(items)) return Object.fromEntries(Object.keys(DECISION_GROUPS).map(key => [key, null]));
  const current = state => items.filter(item => item.effectiveState === state);
  const open = current('open');
  return { open, snoozed: current('snoozed'), history_review: current('history_review'), followUp: items.filter(hasFollowUp), closed: items.filter(item => ['decided', 'closed', 'cancelled', 'invalidated'].includes(item.effectiveState) && !hasFollowUp(item)), all: items };
}

function workspaceRunLink(runId, label = '查看来源轮次') {
  const link = node('a', 'text-button workspace-run-link', label);
  const url = new URL(window.location.href);
  url.searchParams.set('run', runId);
  if (expectedWorkspaceKey) url.searchParams.set('workspace', expectedWorkspaceKey);
  link.href = url.href;
  link.addEventListener('click', event => {
    if (workspaceBlocked) { event.preventDefault(); return; }
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    openWorkspaceRun(runId);
  });
  return link;
}

function openWorkspaceRun(runId) {
  if (workspaceBlocked) return;
  chooseTask({ mode: 'pinned', runId });
  byId('execution-records').open = true;
  navigateWorkspace('tasks');
}

function workspaceDisclosure(key, label, className, expanded = drawerState.expanded) {
  const details = node('details', className), summary = node('summary', 'workspace-detail-summary', label);
  details.dataset.overviewDetail = key;
  details.open = expanded.has(key);
  details.append(summary);
  details.addEventListener('toggle', () => {
    if (!details.isConnected) return;
    if (details.open) expanded.add(key); else expanded.delete(key);
    renderOverviewReadingNotice();
  });
  return details;
}

function decisionFacts(rows) {
  const facts = node('dl', 'workspace-decision-facts');
  for (const [label, value] of rows) {
    const row = node('div'); row.append(node('dt', '', label), node('dd', '', value)); facts.append(row);
  }
  return facts;
}

function decisionActions(actions) {
  const list = node('ul', 'workspace-action-list');
  for (const action of actions) {
    const item = node('li', 'workspace-action'); item.dataset.state = action.status;
    const heading = node('div', 'workspace-action-heading');
    heading.append(node('strong', '', action.label), node('span', 'workspace-state', actionLabel(action) ?? '状态未记录'));
    item.append(heading, node('p', 'workspace-overview-caption', `${{ sync: '资料同步', external: '外部动作', other: '后续动作' }[action.kind]} · ${time(action.updatedAt)}`));
    if (action.reason || ['failed', 'uncertain'].includes(action.status)) item.append(node('p', 'workspace-action-reason', `原因：${action.reason || '未记录'}`));
    if (action.evidence) item.append(node('p', 'workspace-action-evidence', `${action.status === 'done' ? '完成依据' : '记录依据'}：${action.evidence}`));
    if (action.verification) item.append(node('p', 'workspace-action-evidence', `核实记录：${action.verification}`));
    list.append(item);
  }
  return list;
}

function decisionAnswer(answer) {
  return decisionFacts([['已记录决定', answer.text], ['决定范围', answer.scope], ['决定时间', time(answer.recordedAt)], ...(answer.authority ? [['授权依据', answer.authority]] : []), ...(answer.expiresAt ? [['有效至', time(answer.expiresAt)]] : [])]);
}

function itemSubjects(item) {
  let subjects = item.subjects;
  if (!subjects && item.context?.scope === 'candidate') {
    const subject = candidateSubject(item.context.candidateId);
    subjects = subject ? [subject] : [];
  } else if (!subjects && item.context?.scope === 'role') subjects = [{ candidateId: null, name: null, rawRole: item.context.role, role: item.context.role }];
  return (subjects ?? []).map(subject => {
    const current = subject.candidateId ? snapshot?.candidates?.find(candidate => candidate.id === subject.candidateId) : null;
    const mapped = new Set((snapshot?.candidates ?? []).filter(candidate => candidate.rawRole === subject.rawRole).map(candidate => candidate.role));
    const role = current?.role ?? (mapped.size === 1 ? [...mapped][0] : subject.role ?? subject.rawRole);
    return { ...subject, role, current };
  });
}

function subjectLine(item) {
  const line = node('span', 'subject-line'), subjects = itemSubjects(item);
  for (const subject of subjects) {
    const entry = node('span');
    if (subject.name) entry.append(node('strong', 'subject-name', subject.name), document.createTextNode(' · '));
    entry.append(node('span', 'subject-role', subject.role || '岗位待确认'));
    if (subject.rawRole && subject.rawRole !== subject.role) entry.title = `原岗位：${subject.rawRole}`;
    line.append(entry);
  }
  if (!subjects.length) line.append(node('span', 'subject-role', item.associationStatus === 'workspace' || item.context?.scope === 'workspace' ? '工作区事项' : '岗位待确认'));
  if ((!item.associationStatus && !item.context) || ['unknown', 'partial'].includes(item.associationStatus)) line.append(node('span', 'association-note', '关联待确认'));
  return line;
}

function subjectLinks(item) {
  const subjects = itemSubjects(item).filter(s => s.candidateId), messages = item.associationMessages ?? [];
  if (!subjects.length && !messages.length) return null;
  const bar = node('div', 'dossier-archive-bar'), actions = node('div', 'subject-links');
  if (subjects.some(s => s.current)) bar.append(node('span', 'workspace-overview-caption', '已核实候选档案'));
  for (const subject of subjects) {
    if (!subject.current) { bar.append(node('p', 'workspace-overview-caption', `${subject.name} · 当前资料不可用，保留原记录中的岗位信息。`)); continue; }
    const button = node('button', 'secondary-button dossier-archive-btn', `阅读原始档案 · ${subject.name}`); button.type = 'button';
    button.dataset.subject = subject.candidateId; button.setAttribute('aria-haspopup', 'dialog'); button.setAttribute('aria-controls', 'workspace-drawer');
    button.addEventListener('click', () => drawerState.page ? openDrawerCandidate(subject.current, button) : void openCandidate(subject.current, 'triage', button));
    actions.append(button);
  }
  if (actions.children.length) bar.append(actions);
  for (const message of messages) bar.append(node('p', 'association-note', message));
  return bar;
}

function eventDetails(item) {
  const details = node('span', 'highlight-details');
  for (const field of item.details ?? []) { const row = node('span'); row.append(node('span', 'detail-label', field.label), node('span', '', field.value)); details.append(row); }
  return details;
}

const decisionBackground = item => item.reason || [...item.history].reverse().find(entry => entry.evidence)?.evidence || '';
const formatRating = (r, spaced = false) => !r ? '' : /^[SABCD][+-]?$/i.test(r.trim()) ? `${r.trim()}${spaced ? ' ' : ''}级` : r.trim();

function triageBrief(item) {
  const subjects = itemSubjects(item), c = subjects[0]?.current ?? null, act = c ? candidateActivityMap().get(c.id) : null;
  const stageLabel = c ? (STAGES.find(stage => stage.id === c.stage)?.label ?? '未归类') : '';
  const firstRunId = item.sources?.[0]?.runId, firstRun = firstRunId ? snapshot?.runs?.find(run => run.id === firstRunId) : null;
  const firstRunLabel = firstRun ? `${firstRun.label} · ${shortTime(firstRun.createdAt)}` : firstRunId ? `轮次 ${firstRunId}` : '';
  const ratingTag = c ? formatRating(c.rating, false) : '';
  const who = c ? `${c.name}${ratingTag ? ` · ${ratingTag}` : ''}` : (subjects[0]?.name || subjects[0]?.role || '工作区事项');
  const roleBase = [...new Set(subjects.map(s => s.role || '岗位待确认'))].join(' / ') || (item.associationStatus === 'workspace' || item.context?.scope === 'workspace' ? '工作区事项' : '岗位待确认');
  const rawScope = item.decision?.scope || item.identity?.scope || '';
  const cleanScope = rawScope && (rawScope !== '历史收据待核对' || item.effectiveState === 'history_review') ? rawScope : '';
  const scopePart = cleanScope && cleanScope !== roleBase ? cleanScope : '';
  const pillText = item.blocking && item.effectiveState === 'open' ? '阻塞下一步 · 待确认' : item.state === 'decided' && item.followUp?.status && item.followUp.status !== 'none' ? `${DECISION_STATES[item.effectiveState]} · 待下一轮执行` : DECISION_STATES[item.effectiveState];
  const tone = item.blocking && item.effectiveState === 'open' ? 'urgent' : item.effectiveState === 'open' ? 'warn' : item.effectiveState;
  const facts = c
    ? [['当前阶段 / 评级', `${stageLabel} · ${formatRating(c.rating, true) || '未评级'}`], ['台账状态 / 近期动作', `${candidateStatus(c)}${act?.action ? ` · ${act.action}` : ''}`], ['应聘岗位 / 适用范围', `${subjects[0].role || '岗位待确认'} · ${cleanScope || '仅此候选'}`]]
    : [['事项对象 / 状态', `${subjects[0]?.name || subjects[0]?.role || '工作区事项'} · ${DECISION_STATES[item.effectiveState]}`], ['适用范围', `${cleanScope || '工作区范围'}`], ['来源轮次 / 更新', `${firstRunLabel || '本地事项记录'} · ${shortTime(item.updatedAt)}`]];
  const notices = [
    item.deadline && `截止 ${time(item.deadline)}`,
    item.snoozedUntil ? `暂缓至 ${time(item.snoozedUntil)}${item.state === 'snoozed' && item.effectiveState === 'open' ? ' · 已到期，恢复提醒' : ''}` : item.effectiveState === 'snoozed' && '暂缓期限未指定。',
    item.blocking && ['open', 'snoozed', 'history_review'].includes(item.effectiveState) && '有后续动作等待该决定。',
    item.effectiveState === 'history_review' && !item.decision && '历史记录尚待核对，未确认当前是否仍有效。'
  ].filter(Boolean);
  return { who, roleLabel: [roleBase, scopePart].filter(Boolean).join(' · '), pill: { text: pillText, state: item.effectiveState, tone }, background: decisionBackground(item), facts, notices, subjects };
}

const triageListPrimitive = definePrimitive({
  name: 'triage-list', state: () => ({ tabStop: null, selected: [] }),
  api: context => {
    const change = createChange(context);
    const roving = createRovingFocus(context, { slot: 'row', key: 'tabStop', orientation: () => 'vertical', loop: () => false });
    const selection = createSelection(context, { key: 'selected', set: (value, details) => change('selected', value, details), order: () => roving.items().map(entry => entry.key), multiple: () => true });
    return { roving, selection };
  },
  slots: slot => ({
    root: slot({ attrs: () => ({ role: 'listbox', 'aria-multiselectable': 'true' }) }),
    row: slot({
      props: { id: 'string' },
      attrs: (state, { props, api }) => ({ role: 'option', tabindex: api.roving.tabIndex(state, { key: props.id, props }), 'aria-selected': String(state.selected.includes(props.id)) }),
      on: { keydown: (event, { api }) => { const moved = api.roving.keydown(event, event.currentTarget); if (moved?.shift) api.selection.extend(moved.key, { from: moved.from, reason: 'keyboard-range', event }); } },
      focus: ({ props, api }) => api.roving.focus(props.id),
      bind: (el, part) => part.api.roving.bind(el, { key: part.props.id, props: part.props })
    })
  })
});

const getTriageDraft = id => { let d = triageState.drafts.get(id); if (!d) { d = { text: '', followUp: false }; triageState.drafts.set(id, d); } return d; };
const ensureCsrfToken = async () => csrfToken ?? (csrfToken = (await jsonRequest('/api/session')).csrfToken);
const rowForDecision = (root, id) => [...root.querySelectorAll('[data-decision]')].find(el => el.dataset.decision === id);

function buildDecisionCommand(item, mode, payload = {}) {
  const requestId = globalThis.crypto?.randomUUID?.() ?? `req-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  const base = { id: item.id, requestId, expectedRevision: item.revision ?? 1 };
  if (mode === 'snooze') return { operation: 'snooze', input: { ...base, until: new Date(Date.now() + 86_400_000).toISOString(), reason: '看板暂缓至明日复核' } };
  const decisionText = (mode === 'preset1' ? '同意并登记待执行动作' : mode === 'preset2' ? '仅记录结论，无需外部执行动作' : payload.text ?? '').replace(/[\x00-\x1f\x7f]/g, ' ').trim();
  const actions = mode === 'preset1' ? [{ id: 'followup-action', kind: 'external', label: '按已确认方案执行外部跟进' }] : mode === 'preset2' ? [] : payload.actions ?? [];
  if (item.state === 'history_review') return { operation: 'resolve-history', input: { ...base, resolution: 'decided', reason: '看板历史核对确认', decision: { text: decisionText, scope: item.identity.scope, authority: '看板历史核对' }, actions } };
  if (item.state === 'decided' || item.state === 'closed') return { operation: 'revise', input: { ...base, reason: '看板修订决定', decision: { text: decisionText, scope: item.identity.scope, authority: '看板修订确认' }, actions } };
  return { operation: 'decide', input: { ...base, decision: { text: decisionText, scope: item.identity.scope, authority: '看板确认' }, actions } };
}

function renderTriageStatus() { const el = byId('triage-status'); text(el, triageState.status); el.hidden = !triageState.status; el.dataset.state = triageState.statusError ? 'error' : 'ok'; }

async function submitDecision(item, mode, payload = {}, { autoAdvance = true, refresh = true } = {}) {
  if (triageState.submittingId || workspaceBlocked) return false;
  triageState.submittingId = item.id;
  try {
    const token = await ensureCsrfToken();
    const result = await jsonRequest('/api/decisions', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': token }, body: JSON.stringify(buildDecisionCommand(item, mode, payload)) });
    triageState.drafts.delete(item.id); triageState.status = result.message || '已记录决定 · 待下一轮流程执行'; triageState.statusError = false;
    if (autoAdvance) {
      const next = (overviewState.data?.decisions ?? []).find(d => d.id !== item.id && ['open', 'history_review'].includes(d.effectiveState));
      triageState.activeId = next?.id ?? item.id; triageState.expandedId = next?.id ?? null; triageState.userCollapsed = false;
    }
    if (refresh) { bypassOverviewFreeze = true; try { await overviewController.refresh({ invalidate: true }); } finally { bypassOverviewFreeze = false; } }
    return true;
  } catch (error) { triageState.status = error.message; triageState.statusError = true; renderTriageStatus(); return false; }
  finally { triageState.submittingId = null; }
}

function renderDecisionComposer(item) {
  const box = node('section', 'decision-composer'); box.setAttribute('aria-label', '快速拍板');
  const inFlight = item.actions?.some(action => ['running', 'uncertain'].includes(action.status));
  if (!['open', 'snoozed', 'history_review'].includes(item.state) && (item.state !== 'decided' || inFlight)) {
    box.append(node('p', 'workspace-overview-caption', inFlight ? '存在执行中或待核实动作，请先核实后再修订。' : '当前状态已归档，无需在此操作。')); return box;
  }
  const [btn1, btn2] = [['1', '同意并登记待执行动作'], ['2', '仅记录结论（无外部动作）']].map(([k, label]) => {
    const btn = node('button', 'decision-preset-button'); btn.type = 'button'; btn.dataset.preset = k; if (k === '2') btn.dataset.variant = 'secondary';
    btn.append(node('kbd', '', k), node('span', '', label)); btn.addEventListener('click', () => void submitDecision(item, k === '1' ? 'preset1' : 'preset2')); return btn;
  });
  if (['open', 'snoozed', 'history_review'].includes(item.state)) {
    const row = node('div', 'decision-preset-row'); row.append(btn1, btn2);
    box.append(node('p', 'composer-eyebrow', '在看板内直接拍板（快捷键 1 / 2 / S 或输入补充结论）'), row);
  }
  const draft = getTriageDraft(item.id), form = node('form', 'decision-composer-form'), input = node('input', 'search-input decision-composer-input');
  input.type = 'text'; input.placeholder = '或输入补充要求（例如：先问清可出差频率再约一面）'; input.value = draft.text; input.setAttribute('aria-label', '自定义决定内容');
  input.addEventListener('input', () => { getTriageDraft(item.id).text = input.value; });
  const followLabel = node('label', 'decision-followup-toggle'), followCheck = node('input');
  followCheck.type = 'checkbox'; followCheck.checked = draft.followUp; followCheck.addEventListener('change', () => { getTriageDraft(item.id).followUp = followCheck.checked; });
  followLabel.append(followCheck, node('span', '', '登记后续待执行动作（由下一轮流程核实执行）'));
  const submit = node('button', 'primary-button', item.state === 'decided' ? '修订决定' : '记录决定'); submit.type = 'submit';
  form.addEventListener('submit', event => { event.preventDefault(); const value = input.value.trim(); if (value) void submitDecision(item, 'custom', { text: value, actions: followCheck.checked ? [{ id: 'custom-followup', kind: 'external', label: value.slice(0, 120) }] : [] }); });
  form.append(input, submit);
  if (['open', 'snoozed'].includes(item.state)) { const snooze = node('button', 'secondary-button', '暂缓至明日 (S)'); snooze.type = 'button'; snooze.dataset.action = 'snooze'; snooze.addEventListener('click', () => void submitDecision(item, 'snooze')); form.append(snooze); }
  form.append(followLabel);
  box.append(form, node('p', 'workspace-overview-caption decision-safety-note', '安全边界：点击后仅原子保存为本地「已决定」，外部平台动作保持「待执行」，不私自外发消息。'));
  return box;
}

const makePill = brief => { const pill = node('span', 'workspace-preview-state', brief.pill.text); pill.dataset.state = brief.pill.state; pill.dataset.tone = brief.pill.tone; return pill; };
function appendOptionalBadges(target, item) {
  if (hasFollowUp(item)) { const action = node('span', 'workspace-preview-state', ACTION_STATES[item.followUp.status]); action.dataset.state = item.followUp.status; target.append(action); }
  if (item.deadline && item.effectiveState === 'open') { const due = new Date(item.deadline).getTime() <= Date.now(); const dl = node('span', 'workspace-preview-deadline', `${due ? '已到期' : '截止'} ${shortTime(item.deadline)}`); dl.dataset.due = String(due); target.append(dl); }
  else if (item.blocking && item.effectiveState === 'open') target.append(node('span', 'workspace-preview-deadline', '有后续动作等待'));
}

function decisionRow(item, { triage = false, compact = false, expanded = false } = {}) {
  const row = node('li', 'workspace-decision'); row.dataset.decision = item.id;
  const openInline = collapse => {
    if (collapse) { triageState.expandedId = null; triageState.userCollapsed = true; } else { triageState.activeId = item.id; triageState.expandedId = item.id; triageState.userCollapsed = false; }
    renderWorkspaceOverview();
  };
  if (triage && compact && item.state === 'decided' && !expanded) {
    row.classList.add('triage-decided-compact');
    const receipt = node('div', 'triage-compact-receipt'), btn = node('button', 'triage-compact-toggle'), expandBtn = node('button', 'secondary-button triage-expand-btn', '展开核对');
    btn.type = expandBtn.type = 'button'; btn.dataset.triageRow = item.id; btn.setAttribute('aria-expanded', 'false');
    btn.append(node('span', 'triage-compact-who', itemSubjects(item)[0]?.name || '工作区事项'), node('span', 'triage-compact-answer', item.decision?.text ? `已记录：${item.decision.text}` : item.title));
    btn.addEventListener('click', () => openInline(false)); expandBtn.addEventListener('click', () => openInline(false));
    receipt.append(btn, makePill(triageBrief(item)), expandBtn); row.append(receipt); return row;
  }
  const brief = triageBrief(item);
  if (triage && compact) {
    row.classList.add('triage-stream-card'); if (expanded) row.classList.add('is-expanded');
    const head = node('div', 'triage-card-head'), button = node('button', 'triage-stream-summary'), badges = node('span', 'triage-stream-badges'), toggleBtn = node('button', 'secondary-button triage-expand-btn', expanded ? '收起' : '展开核对');
    button.type = toggleBtn.type = 'button'; button.dataset.triageRow = item.id; button.setAttribute('aria-expanded', String(expanded));
    badges.append(makePill(brief)); appendOptionalBadges(badges, item); button.append(subjectLine(item), node('strong', 'workspace-preview-title', item.title), badges);
    button.addEventListener('click', () => openInline(expanded)); toggleBtn.addEventListener('click', () => openInline(expanded)); head.append(button, toggleBtn); row.append(head);
    if (expanded) { const body = node('div', 'triage-inline-body'); body.append(decisionDetail(item, { inline: true }), renderDecisionComposer(item)); row.append(body); }
    return row;
  }
  if (triage) {
    const button = node('button', 'workspace-preview-row'), top = node('span', 'triage-row-top'), footer = node('span', 'workspace-preview-footer');
    button.type = 'button'; button.dataset.triageRow = item.id; if (item.id === triageState.activeId) button.classList.add('is-active');
    top.append(node('strong', 'triage-row-who', brief.who), makePill(brief));
    button.append(top, node('span', 'triage-row-role', brief.roleLabel), node('strong', 'workspace-preview-title', item.title));
    if (brief.background) button.append(node('span', 'workspace-preview-background', brief.background));
    appendOptionalBadges(footer, item); if (footer.children.length) button.append(footer);
    button.addEventListener('click', event => { if (event.shiftKey) triageInst?.api.selection.extend(item.id, { reason: 'item-press', event }); else { triageInst?.api.roving.remember(item.id); selectTriageItem(item); } });
    button.addEventListener('focus', () => { if (!isCompactTriage() && triageState.activeId !== item.id) selectTriageItem(item); });
    row.append(button); return row;
  }
  const button = node('button', 'workspace-preview-row'), heading = node('span', 'workspace-preview-subject'), avatar = node('span', 'subject-avatar'), subjects = brief.subjects, footer = node('span', 'workspace-preview-footer');
  button.type = 'button'; button.setAttribute('aria-controls', 'assistant'); avatar.setAttribute('aria-hidden', 'true');
  if (subjects.length === 1 && subjects[0].name) avatar.textContent = Array.from(subjects[0].name)[0]; else avatar.append(layoutIcon(['M3 7h18v14H3zM8 7V3h8v4M8 7v14M16 7v14']));
  heading.append(avatar, subjectLine(item), layoutIcon(['m9 6 6 6-6 6']));
  button.append(heading, node('strong', 'workspace-preview-title', item.title), node('span', 'workspace-preview-background', brief.background || '背景尚未记录，可查看来源核对。'));
  footer.append(makePill(brief)); appendOptionalBadges(footer, item); footer.append(node('span', 'workspace-preview-meta', `更新于 ${shortTime(item.updatedAt)}`)); button.append(footer);
  button.addEventListener('click', () => openWorkspaceDecision(item.id, button)); row.append(button); return row;
}

function decisionDetail(item, { inline = false } = {}) {
  const body = node('div', 'workspace-decision-body'), brief = triageBrief(item); body.dataset.decision = item.id;
  if (!inline) { const header = node('div', 'dossier-header'), tg = node('div', 'dossier-title-group'); tg.append(subjectLine(item), node('h3', 'workspace-detail-title', item.title)); header.append(tg, makePill(brief)); body.append(header); }
  const factGrid = node('div', 'triage-fact-grid'), callout = node('div', 'evidence-callout');
  for (const [label, value] of brief.facts) { const box = node('div', 'triage-fact-box'); box.append(node('span', 'fact-label', label), node('span', 'fact-value', value)); factGrid.append(box); }
  callout.append(node('span', 'callout-label', '核实依据与决策背景'), node('p', 'workspace-detail-reason', brief.background || '来源轮次未附文字摘要，可展开下方来源记录或打开原始档案核对。'), ...brief.notices.map(n => node('p', 'workspace-overview-note', n)));
  body.append(factGrid, callout);
  if (item.decision) { const rec = node('div', 'decision-recorded-box'); rec.append(node('span', 'callout-label', '已记录结论'), node('p', 'workspace-detail-answer', item.decision.text), node('p', 'workspace-overview-caption', `适用范围：${item.decision.scope} · ${shortTime(item.decision.recordedAt)}`)); body.append(rec); }
  const archiveBar = subjectLinks(item); if (archiveBar) body.append(archiveBar);
  if (item.actions.length) body.append(node('h4', '', '后续动作'), decisionActions(item.actions));
  const evidence = [...new Set(item.history.map(entry => entry.evidence).filter(Boolean))];
  if (evidence.length) {
    const details = workspaceDisclosure(`evidence:${item.id}`, '依据', 'workspace-decision-evidence'), list = node('ul', 'workspace-evidence-list');
    list.append(...evidence.map(value => node('li', '', value))); details.append(list); body.append(details);
  }
  const sources = workspaceDisclosure(`sources:${item.id}`, '来源与记录信息', 'workspace-decision-sources');
  sources.append(decisionFacts([['首次提出', time(item.createdAt)], ['最近更新', time(item.updatedAt)]]));
  if (item.decision) sources.append(decisionFacts([['决定范围', item.decision.scope], ['决定时间', time(item.decision.recordedAt)], ...(item.decision.authority ? [['授权依据', item.decision.authority]] : []), ...(item.decision.expiresAt ? [['有效至', time(item.decision.expiresAt)]] : [])]));
  for (const source of item.sources) {
    const row = node('div', 'workspace-source'), run = snapshot?.runs?.find(value => value.id === source.runId);
    row.append(workspaceRunLink(source.runId, run ? `${run.label} · ${shortTime(run.createdAt)}` : `来源轮次 ${source.runId}`), node('span', 'workspace-overview-caption', `记录于 ${time(source.recordedAt)}`));
    sources.append(row);
  }
  if (!item.sources.length) sources.append(node('p', 'workspace-overview-caption', '未关联来源轮次。'));
  const history = workspaceDisclosure(`history:${item.id}`, `处理历史 · ${item.history.length} 条`, 'workspace-decision-history'), entries = node('ol', 'workspace-history-list');
  for (const entry of [...item.history].reverse()) {
    const row = node('li', 'workspace-history-item');
    row.append(node('p', 'workspace-history-heading', `${time(entry.at)} · ${DECISION_STATES[entry.state] ?? '状态未记录'}`));
    for (const [k, v] of [['原因', entry.reason], ['依据', entry.evidence], ['暂缓至', entry.snoozedUntil && time(entry.snoozedUntil)]]) if (v) row.append(node('p', '', `${k}：${v}`));
    if (entry.decision) row.append(decisionAnswer(entry.decision));
    if (entry.actions.length) row.append(decisionActions(entry.actions));
    if (entry.source) row.append(workspaceRunLink(entry.source.runId, `来源轮次 ${entry.source.runId}`));
    entries.append(row);
  }
  if (!item.history.length) entries.append(node('li', 'workspace-overview-caption', '尚未记录处理历史。'));
  history.append(entries); body.append(sources, history);
  return body;
}

function renderOverviewReadingNotice() {
  const pending = overviewState.pending !== null, newer = Boolean(overviewState.pendingRunId && overviewState.pendingRunId !== taskSelection.runId);
  byId('workspace-reading-notice').hidden = !pending && !newer;
  text('workspace-reading-message', pending ? '事项或近期进展有更新。' : newer ? '有新的任务记录。' : '');
  byId('workspace-apply-updates').hidden = !pending;
  byId('candidate-reading-notice').hidden = !pending;
  byId('workspace-return-overview').hidden = !newer;
  byId('workspace-drawer-update').hidden = !pending;
}

function recordedRunState(run) {
  return run.status === 'running' && !run.steps.some(step => step.status === 'running') ? '未收尾记录' : `${RUN_LABELS[run.status]}记录`;
}

function renderWorkspaceTasks() {
  const list = byId('workspace-task-list'), runs = snapshot?.runs;
  const recent = runs?.reduce((latest, run) => !latest || run.createdAt > latest.createdAt ? run : latest, null);
  const run = runs?.find(item => item.id === taskSelection.runId) ?? recent;
  const note = workspaceBlocked ? '工作区连接已变化；保留最后任务记录。' : disconnected ? '连接断开；保留最后任务记录。' : !snapshot ? '正在读取任务…' : runs === null ? '任务状态未知，尚未成功读取。' : snapshot.sources.runs.status === 'stale' ? '任务源陈旧；保留最后任务记录。' : !runs.length ? '尚无任务进度记录。' : '';
  text('workspace-task-note', note); byId('workspace-task-note').hidden = !note;
  const signature = JSON.stringify(run);
  if (list.dataset.content === signature || (list.dataset.content && overviewReading())) return;
  list.dataset.content = signature;
  list.replaceChildren();
  if (!run) return;
  const item = node('li', 'workspace-task');
  const heading = node('div', 'workspace-task-heading');
  const label = [...runSelect.options].find(option => option.value === run.id)?.textContent ?? [run.label, shortTime(run.createdAt), runObjectLabel(run)].filter(Boolean).join(' · ');
  heading.append(node('span', 'workspace-overview-caption', recent?.id === run.id ? '最近任务' : '所选任务'), workspaceRunLink(run.id, label));
  const meta = node('p', 'workspace-task-meta');
  const status = node('span', 'workspace-state', recordedRunState(run)); status.dataset.state = run.status;
  meta.append(status, node('span', 'workspace-overview-caption', `最后记录 ${shortTime(run.updatedAt)}`));
  const link = workspaceRunLink(run.id, '执行记录'); link.classList.add('workspace-task-open'); link.append(layoutIcon(['M5 12h14m-6-6 6 6-6 6']));
  item.append(heading, meta, link);
  list.append(item);
}

const autoDecisionFilter = groups => groups.open?.length ? 'open' : groups.history_review?.length ? 'history_review' : groups.followUp?.length ? 'followUp' : 'open';

function renderTriageInspector(item) {
  const inspector = byId('triage-inspector');
  if (isCompactTriage() || !item) { inspector.hidden = true; delete inspector.dataset.decision; delete inspector.dataset.signature; inspector.replaceChildren(); return; }
  const signature = JSON.stringify([item, triageBrief(item), snapshot?.runs?.length ?? 0]);
  inspector.hidden = false;
  if (inspector.dataset.decision === item.id && inspector.dataset.signature === signature) return;
  inspector.dataset.decision = item.id; inspector.dataset.signature = signature;
  inspector.replaceChildren(decisionDetail(item), renderDecisionComposer(item));
}

function selectTriageItem(item) {
  triageState.activeId = item.id; triageState.expandedId = item.id; triageState.userCollapsed = false;
  for (const row of byId('workspace-decision-list').querySelectorAll('[data-triage-row]')) row.classList.toggle('is-active', row.dataset.triageRow === item.id);
  renderTriageInspector(item);
}

function renderTriageBatchBar(inst, items) {
  const bar = byId('triage-batch-bar'), selected = inst ? inst.get().selected : [];
  const openSelected = selected.map(id => items.find(d => d.id === id)).filter(d => d && ['open', 'snoozed'].includes(d.effectiveState));
  bar.hidden = selected.length < 2;
  if (bar.hidden) { bar.replaceChildren(); return; }
  const btn = node('button', 'primary-button', `批量暂缓 (${openSelected.length})`); btn.type = 'button'; btn.disabled = !openSelected.length || Boolean(triageState.submittingId);
  btn.addEventListener('click', async () => { for (const target of openSelected) await submitDecision(target, 'snooze', {}, { autoAdvance: false, refresh: false }); bypassOverviewFreeze = true; try { await overviewController.refresh({ invalidate: true }); } finally { bypassOverviewFreeze = false; } });
  bar.replaceChildren(node('span', '', `已选 ${selected.length} 项`), btn);
}

function renderTriageWorkbench(items, groupKey) {
  const list = byId('workspace-decision-list'), compact = isCompactTriage(), activeItems = items ?? [];
  byId('triage-workbench').hidden = !activeItems.length;
  const queueHead = byId('triage-queue-head');
  queueHead.hidden = compact || !activeItems.length;
  if (!queueHead.hidden) text('triage-queue-title', `分拣队列 (${activeItems.length})`);
  renderTriageStatus();
  if (!activeItems.length) { triageCleanups.forEach(fn => fn?.()); triageCleanups = []; triageInst?.destroy(); triageInst = null; list.replaceChildren(); delete list.dataset.content; renderTriageBatchBar(null, []); renderTriageInspector(null); return; }
  if (!triageState.activeId || !activeItems.some(d => d.id === triageState.activeId)) triageState.activeId = (activeItems.find(d => ['open', 'history_review'].includes(d.effectiveState)) ?? activeItems[0]).id;
  if (compact) {
    if (triageState.expandedId && !activeItems.some(d => d.id === triageState.expandedId)) triageState.expandedId = null;
    if (triageState.expandedId === null && !triageState.userCollapsed) triageState.expandedId = activeItems.find(d => ['open', 'history_review'].includes(d.effectiveState))?.id ?? null;
  }
  renderTriageInspector(activeItems.find(d => d.id === triageState.activeId) ?? activeItems[0]);
  const signature = JSON.stringify([compact, groupKey, compact ? triageState.expandedId : null, activeItems.map(item => [item, triageBrief(item)])]);
  if (list.dataset.content === signature) return;
  const focusedId = list.contains(document.activeElement) ? document.activeElement.closest('[data-decision]')?.dataset.decision : null;
  const prevStop = triageInst?.get().tabStop ?? focusedId ?? triageState.activeId, prevSelected = triageInst?.get().selected ?? [];
  triageCleanups.forEach(fn => fn?.()); triageCleanups = []; triageInst?.destroy();
  triageInst = triageListPrimitive({ id: 'workspace-triage' }); triageCleanups.push(bindPart(triageInst, 'root', list));
  if (groupKey === 'all') { delete list.dataset.content; renderDecisionRoleGroups(list, activeItems, item => decisionRow(item, { triage: true, compact, expanded: compact && triageState.expandedId === item.id })); }
  else list.replaceChildren(...activeItems.map(item => decisionRow(item, { triage: true, compact, expanded: compact && triageState.expandedId === item.id })));
  list.dataset.content = signature;
  const byItem = new Map(activeItems.map(item => [item.id, item]));
  for (const rowBtn of list.querySelectorAll('[data-triage-row]')) if (byItem.has(rowBtn.dataset.triageRow)) triageCleanups.push(bindPart(triageInst, 'row', rowBtn, { id: rowBtn.dataset.triageRow }));
  for (const id of prevSelected) if (byItem.has(id)) triageInst.api.selection.toggle(id, { reason: 'restore' });
  triageCleanups.push(triageInst.subscribe(() => renderTriageBatchBar(triageInst, activeItems))); renderTriageBatchBar(triageInst, activeItems);
  const stopTarget = [focusedId, prevStop, triageState.activeId].find(id => id && byItem.has(id));
  if (stopTarget) triageInst.api.roving.remember(stopTarget);
  if (focusedId) {
    const nextFocusId = byItem.has(focusedId) ? focusedId : triageState.activeId;
    const findRow = () => rowForDecision(list, nextFocusId)?.querySelector('[data-triage-row]') ?? list.querySelector('[data-triage-row]');
    const targetBtn = findRow();
    if (targetBtn && document.activeElement !== targetBtn) targetBtn.focus({ preventScroll: true });
    keepFocus(findRow);
  }
}

function renderWorkspaceOverview() {
  const state = overviewState, groups = workspaceDecisionGroups(state.data);
  const retained = Boolean(state.data && (Array.isArray(state.data.decisions) || Array.isArray(state.data.highlights)));
  const updated = state.data?.updatedAt ? `记录更新 ${time(state.data.updatedAt)}。` : '';
  const readAt = state.readAt ? `最后成功读取 ${time(state.readAt)}。` : updated;
  text('workspace-overview-recorded', `${updated}${readAt}` || '尚无成功读取记录');
  const message = workspaceBlocked ? `工作区连接已变化，保留上次信息，请重新打开看板。` : disconnected ? `连接断开，${retained ? '保留最后成功读取的信息（陈旧）。' : '事项数量未知。'}` : state.status === 'error' || state.stale ? `${state.error || '工作区信息暂不可读。'}${retained ? ' 保留最后成功读取的信息（陈旧）。' : ' 事项数量未知。'}` : state.missing ? '事项记录尚未接入，待确认数量未知。' : !state.data ? '正在读取工作区事项…' : state.error;
  const status = byId('workspace-overview-status');
  text(status, message); status.hidden = !message; status.dataset.state = workspaceBlocked || disconnected || state.stale || state.status === 'error' ? 'error' : state.status;
  text('workspace-drawer-notice', message); byId('workspace-drawer-notice').hidden = !message;
  byId('retry-workspace-overview').hidden = workspaceBlocked || !['error', 'stale', 'missing'].includes(state.status);
  const group = state.filter === 'auto' ? autoDecisionFilter(groups) : state.filter, items = groups[group];
  const labels = { open: '待确认', followUp: '后续执行', history_review: '历史待核对', snoozed: '已暂缓', all: '全部事项' };
  text('workspace-decisions-heading', '待你关注');
  text('workspace-decisions-count', items?.length ? `${items.length}` : ''); byId('workspace-decisions-count').hidden = !items?.length;
  const filters = byId('workspace-decision-filters');
  for (const button of filters.querySelectorAll('button')) {
    const key = button.dataset.overviewFilter;
    button.hidden = key === 'all' ? state.filter !== 'all' : !groups[key]?.length && !(state.filter === key && groups[key] !== null);
    button.setAttribute('aria-pressed', String(key === group));
    text(button, `${labels[key]}${groups[key] === null ? ' · 未知' : ` ${groups[key].length}`}`);
  }
  filters.hidden = ![...filters.children].some(button => !button.hidden);
  const caption = group === 'history_review' && groups.open?.length === 0 ? `当前没有待回答事项；另有 ${items.length} 条历史待核对。` : '';
  text('workspace-decision-caption', caption); byId('workspace-decision-caption').hidden = !caption;
  const empty = byId('workspace-decision-empty');
  text(empty, items === null || items.length ? '' : { open: '当前没有待回答事项。', followUp: '当前没有待执行的后续动作。', history_review: '当前没有历史待核对事项。', snoozed: '当前没有已暂缓事项。', all: '当前没有待处理事项。' }[group]);
  empty.hidden = items === null || Boolean(items.length);
  renderTriageWorkbench(items, group);
  text('workspace-decision-summary', items === null ? '事项数量未知' : `${items.length} 项${{ open: '等待确认', followUp: '后续动作未完成', history_review: '历史记录待核对', snoozed: '已暂缓提醒', all: '工作区事项' }[group]}`);
  text('workspace-all-decisions', `全部事项 · ${groups.all === null ? '未知' : groups.all.length}`);
  for (const [id, key] of [['workspace-snoozed-link', 'snoozed'], ['workspace-followup-link', 'followUp']]) {
    byId(id).hidden = !groups[key]?.length || group === key;
    text(id, `${DECISION_GROUPS[key]} · ${groups[key]?.length ?? 0}${key === 'followUp' ? ' · 已决定，无需重复回答' : ''}`);
  }
  renderWorkspaceHighlights(); renderOverviewReadingNotice(); renderWorkspaceDrawer();
}

function updatePreviewList(list, items, key, makeRow) {
  const signature = JSON.stringify(items.map(item => [item, itemSubjects(item).map(subject => [subject.role, Boolean(subject.current)])]));
  if (list.dataset.content === signature) return;
  const previous = new Map([...list.children].map(item => [item.dataset[key], item]));
  const rows = items.map(item => {
    const id = key === 'decision' ? item.id : item.eventKey;
    const content = JSON.stringify([item, itemSubjects(item).map(subject => [subject.role, Boolean(subject.current)])]), existing = previous.get(id);
    if (existing?.dataset.content === content) return existing;
    const row = makeRow(item); row.dataset.content = content; return row;
  });
  for (const item of [...list.children]) if (!rows.includes(item)) item.remove();
  let position = list.firstElementChild;
  for (const row of rows) { if (row !== position) list.insertBefore(row, position); position = row.nextElementSibling; }
  list.dataset.content = signature;
}

function highlightEvidence(highlight, expanded = drawerState.expanded) {
  const history = Array.isArray(highlight.history) ? highlight.history : [];
  if (!highlight.evidence && !history.length) return null;
  const details = workspaceDisclosure(`highlight:${highlight.eventKey}`, '查看依据', 'workspace-highlight-evidence', expanded);
  details.append(node('p', '', highlight.evidence || '当前依据未记录。'), node('p', 'workspace-overview-caption', `事件时间 ${highlight.timePrecision === 'day' ? progressTime(highlight) : time(highlight.occurredAt)}`));
  if (history.length) {
    const changes = workspaceDisclosure(`highlight-history:${highlight.eventKey}`, `更正历史 · ${history.length} 版`, 'workspace-highlight-history', expanded);
    const list = node('ol', 'workspace-history-list');
    for (const entry of [...history].reverse()) {
      const item = node('li', 'workspace-history-item');
      item.append(
        node('p', 'workspace-history-heading', `第 ${entry.revision} 版${entry.revision === highlight.revision ? ' · 当前记录' : ''}`),
        node('p', '', entry.text),
        eventDetails(entry),
        node('p', '', `依据：${entry.evidence || '未记录'}`),
        node('p', 'workspace-overview-caption', `事件时间 ${time(entry.occurredAt)}`),
        node('p', 'workspace-overview-caption', `记录时间 ${time(entry.updatedAt)}`),
        node('p', '', entry.correction ? `更正原因：${entry.correction}` : entry.revision === 1 ? '首次记录' : '更正原因：未记录')
      );
      list.append(item);
    }
    changes.append(list); details.append(changes);
  }
  return details;
}

function progressTime(highlight, short = false) {
  if (highlight.timePrecision === 'day') return highlight.occurredAt.slice(0, 10) + '（当日，未记时分）';
  return (short ? shortTime : time)(highlight.updatedAt);
}

function highlightRow(highlight) {
  const row = node('li', 'workspace-highlight'); row.dataset.event = highlight.eventKey;
  const button = node('button', 'workspace-preview-row'); button.type = 'button';
  button.setAttribute('aria-haspopup', 'dialog'); button.setAttribute('aria-controls', 'workspace-drawer');
  button.append(subjectLine(highlight), node('strong', 'workspace-preview-title', highlight.text), eventDetails(highlight));
  const footer = node('span', 'workspace-preview-footer');
  footer.append(node('span', 'workspace-preview-meta', `${highlight.sourceKind === 'archive' ? '发生于' : '更新于'} ${progressTime(highlight, true)}${highlight.correction ? ' · 已更正' : ''}`), node('span', 'workspace-preview-action', '查看进展 ›'));
  button.append(footer);
  button.addEventListener('click', () => openWorkspaceHighlight(highlight.eventKey, button));
  row.append(button); return row;
}

function renderWorkspaceHighlights() {
  const highlights = overviewState.data?.highlights;
  const message = !Array.isArray(highlights) ? '近期进展尚未成功读取。' : highlights.length ? '' : '最近 7 天暂无已记录进展，可查看执行记录。';
  text('workspace-highlights-status', message); byId('workspace-highlights-status').hidden = !message;
  updatePreviewList(byId('workspace-highlight-list'), highlights?.slice(0, 3) ?? [], 'event', highlightRow);
  byId('workspace-show-highlights').hidden = !highlights || highlights.length <= 3;
  text('workspace-show-highlights', `全部近期进展 · ${highlights?.length ?? 0}`);
  const gaps = (overviewState.data?.diagnostics ?? []).filter(item => item.code === 'PROGRESS_EVENT_MISSING');
  byId('progress-coverage').hidden = !gaps.length;
  text('progress-coverage-summary', `${gaps.length} 份档案的进展记录待核对`);
  const list = byId('progress-coverage-list'), signature = JSON.stringify([gaps, snapshot?.candidates?.map(item => [item.id, item.role])]);
  if (list.dataset.content !== signature) {
    list.replaceChildren(...gaps.map(gap => {
      const candidate = snapshot?.candidates?.find(item => item.id === gap.candidateId), row = node('li', 'document-row');
      row.append(node('p', '', candidate ? candidate.name + ' · ' + candidate.role : '候选档案'), node('p', 'muted', '有面试安排，缺少可核对的发生日期事件。'));
      if (candidate) {
        const button = node('button', 'text-button', '查看档案进度'); button.type = 'button';
        button.addEventListener('click', () => { showWorkspaceDrawer(button); openDrawerCandidate(candidate, button); }); row.append(button);
      }
      return row;
    }));
    list.dataset.content = signature;
  }
}

function highlightDetail(highlight) {
  const body = node('div', 'workspace-highlight-detail'); body.dataset.event = highlight.eventKey;
  body.append(subjectLine(highlight), node('h3', 'workspace-detail-title', highlight.text), eventDetails(highlight));
  if (highlight.evidence) body.append(node('p', 'workspace-detail-reason', highlight.evidence));
  body.append(node('p', 'workspace-overview-caption', `${highlight.sourceKind === 'archive' ? '面试档案记录' : triggerLabel(highlight.trigger)} · ${highlight.timePrecision === 'day' ? '发生于' : '更新于'} ${progressTime(highlight)}`));
  const links = subjectLinks(highlight); if (links) body.append(links);
  if (highlight.correction) body.append(node('p', 'workspace-highlight-correction', `更正：${highlight.correction}`));
  if (highlight.decisionId) {
    const button = node('button', 'text-button', '查看关联事项'); button.type = 'button'; button.dataset.linkedItem = highlight.decisionId;
    button.addEventListener('click', () => openWorkspaceDecision(highlight.decisionId, button)); body.append(button);
  }
  const evidence = highlightEvidence(highlight);
  if (evidence) body.append(evidence);
  const sources = workspaceDisclosure(`highlight-sources:${highlight.eventKey}`, '来源记录', 'workspace-highlight-sources');
  for (const runId of new Set([highlight.runId, ...(highlight.sourceRunIds ?? [])].filter(Boolean))) sources.append(workspaceRunLink(runId));
  if (highlight.sourceDocumentId && highlight.context?.candidateId) {
    const link = node('a', 'text-button', '打开来源档案');
    link.href = documentURL(highlight.context.candidateId, highlight.sourceDocumentId); link.target = '_blank'; link.rel = 'noopener noreferrer'; sources.append(link);
  }
  body.append(sources); return body;
}

function applyWorkspaceUpdates() {
  if (overviewState.pending) { overviewState.data = overviewState.pending; overviewState.pending = null; }
  renderCandidateOrdering();
}

function showWorkspaceDrawer(trigger) {
  const dialog = byId('workspace-drawer');
  if (dialog.open) return;
  drawerState.returnFocus = trigger ?? document.activeElement; drawerState.pageScroll = window.scrollY;
  document.documentElement.classList.add('drawer-open');
  if (typeof dialog.showModal === 'function') dialog.showModal();
  else { dialog.setAttribute('open', ''); byId('workspace-drawer-backdrop').hidden = false; document.querySelector('.app').setAttribute('inert', ''); }
  drawerLayerCleanup?.();
  drawerLayerCleanup = bindLayer(dialog, { onDismiss: (reason, event) => { if (reason === 'escape-key') { event.preventDefault(); closeWorkspaceDrawer(); } } });
}

function openWorkspaceList(kind = 'highlights', group = drawerState.group, trigger = document.activeElement) {
  if (kind === 'decisions') { if (drawerState.page) closeWorkspaceDrawer(false); overviewState.filter = group; setWorkspaceNavTarget('overview'); renderWorkspaceOverview(); focusWorkbenchTarget(byId('workspace-decisions-heading')); return; }
  if (drawerState.listKind !== kind || drawerState.group !== group) { drawerState.listScroll = 0; drawerState.listFocus = null; }
  if (drawerState.page === 'candidate') closeCandidate();
  drawerState.stack = []; drawerState.page = 'list'; drawerState.listKind = 'highlights'; drawerState.group = group;
  showWorkspaceDrawer(trigger); renderWorkspaceDrawer();
  byId('workspace-drawer-content').scrollTop = drawerState.listScroll; byId('workspace-drawer-title').focus({ preventScroll: true }); renderOverviewReadingNotice();
}

function saveDrawerPage(trigger) { if (drawerState.page) drawerState.stack.push({ page: drawerState.page, itemId: drawerState.itemId, scroll: byId('workspace-drawer-content').scrollTop, expanded: new Set(drawerState.expanded), trigger }); }

function openDrawerCandidate(candidate, trigger) {
  if (!drawerState.page) { void openCandidate(candidate, 'triage', trigger); return; }
  saveDrawerPage(trigger); drawerState.page = 'candidate'; drawerState.itemId = candidate.id;
  renderWorkspaceDrawer(); byId('workspace-drawer-content').scrollTop = 0; void openCandidate(candidate, 'drawer', trigger);
}

function returnDrawerPage() {
  if (drawerState.page === 'candidate' && !drawerState.stack.length) { closeWorkspaceDrawer(); return; }
  if (drawerState.page === 'candidate') closeCandidate();
  const previous = drawerState.stack.pop();
  drawerState.page = previous?.page ?? 'list'; drawerState.itemId = previous?.itemId ?? null; drawerState.expanded = previous?.expanded ?? new Set();
  delete byId('workspace-drawer-detail').dataset.content; renderWorkspaceDrawer();
  byId('workspace-drawer-content').scrollTop = previous?.scroll ?? drawerState.listScroll;
  let target = previous?.trigger ?? drawerState.listFocus;
  if (target && !target.isConnected) {
    if (target.dataset.subject) target = [...byId('workspace-drawer-detail').querySelectorAll('[data-subject]')].find(button => button.dataset.subject === target.dataset.subject);
    else if (target.dataset.linkedItem) target = byId('workspace-drawer-detail').querySelector('[data-linked-item]');
    else { const row = target.closest('[data-event]'); target = [...byId('workspace-drawer-list').querySelectorAll('[data-event]')].find(item => row && item.dataset.event === row.dataset.event)?.querySelector('button'); }
  }
  (target?.isConnected ? target : byId('workspace-drawer-title')).focus({ preventScroll: true });
}

function openWorkspaceDetail(kind, id, trigger) {
  if (drawerState.page !== kind || drawerState.itemId !== id) saveDrawerPage(trigger);
  if (drawerState.page === 'list') { drawerState.listScroll = byId('workspace-drawer-content').scrollTop; drawerState.listFocus = trigger ?? document.activeElement; }
  else if (!drawerState.page) drawerState.listKind = 'highlights';
  if (drawerState.page !== kind || drawerState.itemId !== id) { drawerState.expanded.clear(); delete byId('workspace-drawer-detail').dataset.content; }
  drawerState.page = kind; drawerState.itemId = id;
  showWorkspaceDrawer(trigger); renderWorkspaceDrawer();
  byId('workspace-drawer-content').scrollTop = 0; byId('workspace-drawer-title').focus({ preventScroll: true }); renderOverviewReadingNotice();
}

function openWorkspaceDecision(id) {
  if (drawerState.page) closeWorkspaceDrawer(false);
  if (overviewState.pending) applyWorkspaceUpdates();
  if (overviewState.data?.decisions?.some(value => value.id === id)) {
    const groups = workspaceDecisionGroups(overviewState.data), activeKey = overviewState.filter === 'auto' ? autoDecisionFilter(groups) : overviewState.filter;
    if (!groups[activeKey]?.some(d => d.id === id)) overviewState.filter = ['open', 'history_review', 'followUp', 'snoozed'].find(k => groups[k]?.some(d => d.id === id)) ?? 'all';
    triageState.activeId = id; triageState.expandedId = id; triageState.userCollapsed = false;
  }
  setWorkspaceNavTarget('overview'); renderWorkspaceOverview();
  const row = rowForDecision(byId('workspace-decision-list'), id), target = row?.querySelector('[data-triage-row]') ?? workspaceNavTargets.overview;
  if (isCompactTriage() && row) { target.focus({ preventScroll: true }); (row.closest('.workspace-decision') ?? row).scrollIntoView({ block: 'start', behavior: 'instant' }); }
  else focusWorkbenchTarget(target, 'nearest');
}

const openWorkspaceHighlight = (id, trigger = document.activeElement) => openWorkspaceDetail('highlight', id, trigger);

function renderDecisionRoleGroups(list, items, makeRow = decisionRow) {
  const groups = new Map();
  for (const item of items) {
    const roles = [...new Set(itemSubjects(item).map(subject => subject.role).filter(Boolean))].sort();
    const label = roles.length ? roles.join(' / ') : item.associationStatus === 'workspace' || item.context?.scope === 'workspace' ? '工作区事项' : '岗位待确认';
    if (!groups.has(label)) groups.set(label, []);
    groups.get(label).push(item);
  }
  const entries = [];
  for (const [label, decisions] of groups) {
    const group = node('li', 'decision-role-group'); group.dataset.roleGroup = label;
    const heading = node('div', 'decision-role-heading'); heading.append(node('h3', '', label), node('span', '', `${decisions.length} 项`));
    const rows = node('ul', 'workspace-decision-list'); rows.setAttribute('aria-label', `${label}的事项`); rows.append(...decisions.map(makeRow));
    group.append(heading, rows); entries.push(group);
  }
  list.replaceChildren(...entries);
}

function renderWorkspaceDrawer() {
  if (!drawerState.page) return;
  const state = drawerState, listView = byId('workspace-drawer-list-view'), detail = byId('workspace-drawer-detail');
  const listing = state.page === 'list', following = state.page === 'following', candidate = state.page === 'candidate';
  listView.hidden = !listing; detail.hidden = listing || following || candidate;
  byId('following-picker').hidden = !following; byId('drawer-record-host').hidden = !candidate;
  byId('workspace-drawer-back').hidden = listing || following;
  text('workspace-drawer-back', { highlight: '返回进展', list: '返回列表' }[state.stack.at(-1)?.page] ?? (candidate ? { search: '返回搜索结果', results: '返回处理名单', activity: '返回近期流水', triage: '返回分拣台', palette: '返回工作台' }[candidateOrigin?.source] ?? '返回人选名单' : '返回进展列表'));
  text('workspace-drawer-title', following ? '选择关注岗位' : candidate ? '人选资料' : listing ? '近期进展' : '进展详情');
  text('workspace-drawer-footer', following ? '个人关注与招聘状态分别保存。' : '资料与关注来自当前工作区。');
  if (following) { renderFollowingPicker(); return; }
  if (candidate) return;
  if (listing) {
    byId('workspace-drawer-filter').hidden = true;
    const items = overviewState.data?.highlights ?? null, list = byId('workspace-drawer-list');
    text('workspace-drawer-empty', items === null ? '尚未成功读取，数量未知。' : !items.length ? '暂无近期进展。' : ''); byId('workspace-drawer-empty').hidden = Boolean(items?.length);
    if (list.dataset.kind !== 'event') { list.replaceChildren(); delete list.dataset.content; list.dataset.kind = 'event'; }
    updatePreviewList(list, items ?? [], 'event', highlightRow); return;
  }
  const item = overviewState.data?.highlights?.find(value => value.eventKey === state.itemId);
  const signature = JSON.stringify([state.page, state.itemId, item, item && itemSubjects(item).map(subject => [subject.role, Boolean(subject.current)])]);
  if (detail.dataset.content !== signature) {
    const scroll = byId('workspace-drawer-content').scrollTop;
    detail.replaceChildren(item ? highlightDetail(item) : node('p', 'workspace-overview-note', '暂未读到关联记录；请刷新后再查看。'));
    detail.dataset.content = signature; byId('workspace-drawer-content').scrollTop = scroll;
  }
}

function closeWorkspaceDrawer(restoreFocus = true) {
  if (!drawerState.page) return;
  pickerLayerCleanup?.(); pickerLayerCleanup = null; drawerLayerCleanup?.(); drawerLayerCleanup = null;
  const dialog = byId('workspace-drawer'), origin = drawerState.page === 'candidate' ? candidateOrigin : null;
  if (drawerState.page === 'list') drawerState.listScroll = byId('workspace-drawer-content').scrollTop;
  if (drawerState.page === 'candidate') closeCandidate();
  drawerState.page = null; drawerState.stack = []; byId('following-picker').hidden = true;
  for (const id of ['choose-following', 'workspace-choose-following']) byId(id).setAttribute('aria-expanded', 'false');
  if (dialog.open && typeof dialog.close === 'function') dialog.close(); else dialog.removeAttribute('open');
  byId('workspace-drawer-backdrop').hidden = true; document.querySelector('.app').removeAttribute('inert'); document.documentElement.classList.remove('drawer-open');
  if (restoreFocus) {
    let target = drawerState.returnFocus;
    if (target && !target.isConnected) {
      const list = byId({ stage: 'candidate-list', search: 'candidate-search-list', results: 'result-list' }[origin?.source]);
      if (list) target = [...list.querySelectorAll('button')].find(button => button.dataset.candidate === origin.candidateId || (target.dataset.resultFocus && button.dataset.resultFocus === target.dataset.resultFocus));
      else if (target.dataset.subject) target = [...byId('assistant').querySelectorAll('[data-subject]')].find(button => button.dataset.subject === target.dataset.subject);
      else { const row = target.closest('[data-event]'); target = [...byId('assistant').querySelectorAll('[data-event]')].find(item => row && item.dataset.event === row.dataset.event)?.querySelector('button'); }
    }
    (target?.isConnected && !target.closest('[hidden]') && visibleWorkbenchTarget(target) ? target : workspaceNavTargets[activeView]).focus({ preventScroll: true });
    if (window.scrollY !== drawerState.pageScroll) window.scrollTo(0, drawerState.pageScroll);
  }
  renderWorkspaceTasks(); renderOverviewReadingNotice();
}

byId('workspace-drawer-back').addEventListener('click', returnDrawerPage);
byId('workspace-drawer-close').addEventListener('click', () => closeWorkspaceDrawer());
byId('workspace-drawer-backdrop').addEventListener('click', () => closeWorkspaceDrawer());
byId('workspace-drawer').addEventListener('cancel', event => { event.preventDefault(); if (!byId('material-picker')) closeWorkspaceDrawer(); });
byId('workspace-drawer').addEventListener('close', event => { if (!event.currentTarget.open) closeWorkspaceDrawer(); });
byId('workspace-drawer').addEventListener('click', event => {
  if (event.target !== event.currentTarget) return;
  const rect = event.currentTarget.getBoundingClientRect();
  if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) closeWorkspaceDrawer();
});
byId('workspace-drawer').addEventListener('keydown', event => {
  if (event.key !== 'Tab') return;
  const available = [...event.currentTarget.querySelectorAll('button, a[href], input, select, summary, [tabindex="0"]')].filter(element => {
    if (element.disabled || element.closest('[hidden]')) return false;
    for (let parent = element.parentElement; parent && parent !== event.currentTarget; parent = parent.parentElement) {
      if (parent.matches('details:not([open])') && !parent.querySelector(':scope > summary')?.contains(element)) return false;
    }
    return true;
  });
  const first = available[0], last = available.at(-1), active = document.activeElement;
  if (!first) { event.preventDefault(); event.currentTarget.focus(); }
  else if (event.shiftKey && (active === first || !available.includes(active))) { event.preventDefault(); last.focus(); }
  else if (!event.shiftKey && (active === last || !available.includes(active))) { event.preventDefault(); first.focus(); }
});

function renderLinkedDecisions() {
  const data = overviewState.pending ?? overviewState.data;
  for (const element of document.querySelectorAll('[data-linked-decision]')) {
    const item = data?.decisions?.find(value => value.id === element.dataset.linkedDecision);
    const status = item ? `${DECISION_STATES[item.effectiveState]}${hasFollowUp(item) ? ` · 后续${ACTION_STATES[item.followUp.status]}` : ''}` : '当前状态尚未读取';
    text(element.querySelector('p'), `关联事项现在：${status}${overviewState.stale || disconnected || workspaceBlocked ? '（最后读取记录）' : ''}`);
  }
}

for (const button of byId('workspace-decision-filters').querySelectorAll('button')) button.addEventListener('click', () => {
  overviewState.filter = button.dataset.overviewFilter;
  renderWorkspaceOverview();
});
byId('workspace-all-decisions').addEventListener('click', () => { overviewState.filter = 'all'; renderWorkspaceOverview(); });
byId('workspace-followup-link').addEventListener('click', () => { overviewState.filter = 'followUp'; renderWorkspaceOverview(); });
byId('workspace-snoozed-link').addEventListener('click', () => { overviewState.filter = 'snoozed'; renderWorkspaceOverview(); });
byId('workspace-show-highlights').addEventListener('click', event => openWorkspaceList('highlights', drawerState.group, event.currentTarget));
document.addEventListener('keydown', event => {
  if (activeView !== 'overview' || drawerState.page || paletteState.open || layoutState.editing || event.isComposing || event.keyCode === 229 || event.ctrlKey || event.metaKey || event.altKey) return;
  if (document.querySelector('dialog[open]') || event.target.closest?.('input, textarea, select, [contenteditable="true"]')) return;
  const key = event.key.toLowerCase();
  if (!['1', '2', 's'].includes(key)) return;
  const targetId = isCompactTriage() ? (triageState.expandedId ?? triageState.activeId) : triageState.activeId;
  const item = overviewState.data?.decisions?.find(d => d.id === targetId);
  if (!item) return;
  if (key === 's' && ['open', 'snoozed'].includes(item.state)) { event.preventDefault(); void submitDecision(item, 'snooze'); }
  else if ((key === '1' || key === '2') && ['open', 'snoozed', 'history_review'].includes(item.state)) { event.preventDefault(); void submitDecision(item, key === '1' ? 'preset1' : 'preset2'); }
});
byId('workspace-highlight-history').addEventListener('click', () => navigateWorkspace('tasks'));
for (const id of ['workspace-apply-updates', 'workspace-drawer-update', 'candidate-apply-updates']) byId(id).addEventListener('click', () => {
  applyWorkspaceUpdates(); renderWorkspaceOverview(); renderLinkedDecisions();
  if (drawerState.page) byId('workspace-drawer-title').focus({ preventScroll: true });
  else if (id === 'candidate-apply-updates') byId('candidates-heading').focus({ preventScroll: true });
});
byId('workspace-return-overview').addEventListener('click', () => {
  const runId = overviewState.pendingRunId;
  overviewState.pendingRunId = null;
  if (runId) openWorkspaceRun(runId);
  renderOverviewReadingNotice();
});

function readTaskURL() {
  const id = new URL(window.location.href).searchParams.get('run');
  selectionMessage = id !== null && !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(id) ? '任务链接格式无效，已恢复实时跟随；也可从列表选择任务。' : '';
  return id !== null && !selectionMessage ? { mode: 'pinned', runId: id } : { mode: 'live', runId: null };
}

function writeTaskURL() {
  const url = new URL(window.location.href);
  if (taskSelection.mode === 'pinned' && taskSelection.runId) url.searchParams.set('run', taskSelection.runId);
  else url.searchParams.delete('run');
  if (expectedWorkspaceKey) url.searchParams.set('workspace', expectedWorkspaceKey);
  if (url.href !== window.location.href) window.history.replaceState(null, '', url);
}

taskSelection = readTaskURL();
setWorkspaceNavTarget(taskSelection.mode === 'pinned' ? 'tasks' : 'overview');
if (activeView === 'tasks') byId('execution-records').open = true;

function renderPreferenceNotice() {
  const message = snapshot?.workspaceKey ? preferenceMessage : '尚未取得工作区标识，岗位偏好仅在本页保留。';
  text('role-preferences-note', message);
  byId('role-preferences-note').hidden = !message;
  renderWorkspaceFollowing();
}

function persistRolePreferences() {
  if (!snapshot?.workspaceKey) {
    temporaryPreferencesChanged = true;
    renderPreferenceNotice();
    return;
  }
  try {
    localStorage.setItem(`recruiting-board:role-preferences:${snapshot.workspaceKey}`, JSON.stringify(rolePreferences));
    preferenceMessage = '';
  } catch (error) {
    console.warn('岗位偏好保存失败', error);
    preferenceMessage = '本机偏好保存失败；当前选择在本页继续有效。';
  }
  renderPreferenceNotice();
}

function syncRolePreferences() {
  const key = snapshot.workspaceKey;
  if (key && key !== preferenceKey) {
    const keepTemporary = preferenceKey === null && temporaryPreferencesChanged;
    preferenceKey = key;
    if (keepTemporary) persistRolePreferences();
    else {
      rolePreferences = { scope: 'active', following: [], role: '' };
      preferenceMessage = '';
      try {
        const saved = localStorage.getItem(`recruiting-board:role-preferences:${key}`);
        if (saved) {
          const value = JSON.parse(saved);
          if (!value || !ROLE_SCOPES.some(scope => scope.id === value.scope) || !Array.isArray(value.following) || value.following.some(name => typeof name !== 'string') || typeof value.role !== 'string') throw new Error('岗位偏好格式无效');
          rolePreferences = { scope: value.scope, following: [...new Set(value.following)], role: value.role };
        }
      } catch (error) {
        console.warn('岗位偏好读取失败', error);
        preferenceMessage = '本机偏好读取失败；本次使用默认岗位范围。';
      }
    }
    temporaryPreferencesChanged = false;
  }
  renderPreferenceNotice();
}

function currentRoleView(query = byId('role-query').value) {
  return selectRoles(snapshot, { ...rolePreferences, query });
}

function renderWorkspaceFollowing() {
  const list = byId('workspace-following'), note = byId('workspace-following-note');
  const names = rolePreferences.following;
  const signature = JSON.stringify(names);
  if (list.dataset.content !== signature) {
    const previous = new Map([...list.children].map(button => [button.dataset.role, button]));
    const buttons = names.map(name => {
      const button = previous.get(name) ?? node('button', 'workspace-role-button', name);
      if (!previous.has(name)) {
        button.type = 'button'; button.dataset.role = name; button.setAttribute('aria-controls', 'role-browser');
        button.addEventListener('click', () => chooseWorkspaceRole(name));
      }
      return button;
    });
    const focused = list.contains(document.activeElement) ? document.activeElement : null;
    for (const button of previous.values()) if (!buttons.includes(button)) button.remove();
    let position = list.firstElementChild;
    for (const button of buttons) { if (button !== position) list.insertBefore(button, position); position = button.nextElementSibling; }
    list.dataset.content = signature;
    if (focused && document.activeElement !== focused) (focused.isConnected ? focused : byId('workspace-choose-following')).focus({ preventScroll: true });
  }
  for (const button of list.children) button.setAttribute('aria-pressed', String(rolePreferences.scope === 'following' && rolePreferences.role === button.dataset.role));
  const context = snapshot?.sources.context;
  let state = 'ready', message = '';
  if (workspaceBlocked) { state = 'error'; message = '工作区连接已变化；关注岗位保留上次记录，请重新打开看板。'; }
  else if (disconnected) { state = 'error'; message = snapshot ? '连接断开；关注岗位保留上次读取的配置。' : '连接失败，关注岗位未知。'; }
  else if (!snapshot) { state = 'loading'; message = '正在读取关注岗位…'; }
  else if (context.status !== 'ok' || context.stale) {
    state = context.status === 'stale' || context.stale ? 'stale' : context.status === 'error' ? 'error' : 'unknown';
    message = state === 'stale' ? '岗位配置陈旧；保留上次配置与本机关注。' : state === 'error' ? '岗位配置读取失败，关注岗位信息待核对。' : '岗位配置尚未读取，关注岗位信息未知。';
  }
  if (preferenceMessage) { state = 'error'; message = [message, preferenceMessage].filter(Boolean).join(' '); }
  if (!snapshot?.workspaceKey && snapshot) { state = 'unknown'; message = [message, '尚未取得工作区标识，关注仅在本页保留。'].filter(Boolean).join(' '); }
  if (!message && !names.length) { state = 'empty'; message = '尚未关注岗位，可通过设置或正文的“选择关注”添加。'; }
  note.dataset.state = state;
  text(note, message); note.hidden = !message;
}

function chooseWorkspaceRole(name) {
  if (byId('candidate-query').value) clearCandidateSearch(false);
  if (candidateOrigin?.source === 'stage') closeCandidate();
  rolePreferences.scope = 'following'; rolePreferences.role = name; roleRangeMessage = '';
  persistRolePreferences();
  if (snapshot) { const view = renderRoleControls(); renderStages(true, view); }
  setWorkspaceNavTarget('roles');
  focusWorkbenchTarget(workspaceNavTargets.roles);
}

function toggleFollowingPicker(trigger) {
  if (drawerState.page === 'following') { closeWorkspaceDrawer(); return; }
  drawerState.page = 'following'; drawerState.stack = [];
  for (const id of ['choose-following', 'workspace-choose-following']) byId(id).setAttribute('aria-expanded', 'true');
  showWorkspaceDrawer(trigger); renderWorkspaceDrawer();
  byId('following-query').focus({ preventScroll: true });
}

function renderFollowingPicker() {
  if (byId('following-picker').hidden || !snapshot) return;
  const query = byId('following-query').value.trim().toLocaleLowerCase();
  const names = [...new Set([...snapshot.roles.map(role => role.name), ...rolePreferences.following])];
  const values = names.filter(name => name.toLocaleLowerCase().includes(query));
  const list = byId('following-list');
  const signature = JSON.stringify([values, rolePreferences.following, snapshot.roles]);
  if (list.dataset.content === signature) return;
  list.dataset.content = signature;
  const items = values.map(name => {
    const item = node('li'), label = node('label', 'following-option'), checkbox = node('input');
    checkbox.type = 'checkbox'; checkbox.checked = rolePreferences.following.includes(name);
    checkbox.dataset.role = name;
    checkbox.addEventListener('change', () => {
      rolePreferences.following = checkbox.checked ? [...rolePreferences.following, name] : rolePreferences.following.filter(value => value !== name);
      list.dataset.content = JSON.stringify([values, rolePreferences.following, snapshot.roles]);
      if (rolePreferences.scope === 'following' && rolePreferences.role && !rolePreferences.following.includes(rolePreferences.role)) {
        roleRangeMessage = `已取消关注“${rolePreferences.role}”，显示我的关注汇总。`;
        rolePreferences.role = '';
      }
      persistRolePreferences();
      renderRoleControls(); renderStages(true);
    });
    const title = node('span', '', name);
    const role = snapshot.roles.find(role => role.name === name);
    title.append(node('span', 'following-role-state', role ? role.status || '状态待确认' : '未在当前源中'));
    label.append(checkbox, title); item.append(label); return item;
  });
  if (!items.length) items.push(node('li', 'picker-empty', names.length ? '没有匹配的岗位。' : '当前没有可选择的岗位。'));
  list.replaceChildren(...items);
}

function renderRoleControls() {
  const view = currentRoleView(), scopeView = byId('role-query').value.trim() ? currentRoleView('') : view;
  text('role-range-message', roleRangeMessage); byId('role-range-message').hidden = !roleRangeMessage;
  const unknown = snapshot.roles.filter(unknownRole);
  text('unknown-roles-link', `另有 ${unknown.length} 个岗位状态待确认`);
  byId('unknown-roles-link').hidden = !unknown.length;
  const roleCountsKnown = !disconnected && !workspaceBlocked && snapshot.sources.context.status === 'ok' && snapshot.sources.ledger.status === 'ok' && !['stale', 'error'].includes(snapshot.sources.config?.status);
  const allActive = roleCountsKnown && snapshot.roles.length > 0 && snapshot.roles.every(role => role.status === '在招');
  text('role-all-active', allActive ? '当前全部岗位均在招' : ''); byId('role-all-active').hidden = !allActive;
  for (const button of byId('role-scopes').querySelectorAll('button')) {
    const count = selectRoles(snapshot, { scope: button.dataset.scope, following: rolePreferences.following }).roles.length;
    text(button, `${ROLE_SCOPES.find(scope => scope.id === button.dataset.scope).label} · ${roleCountsKnown ? count : '未知'}`);
  }
  const unknownList = byId('unknown-role-list');
  const unknownSignature = JSON.stringify(unknown);
  if (unknownList.dataset.content !== unknownSignature) {
    unknownList.replaceChildren(...unknown.map(role => {
      const row = node('li'), button = node('button', 'text-button', role.name); button.type = 'button';
      button.addEventListener('click', () => {
        rolePreferences.scope = 'all'; rolePreferences.role = role.name; byId('role-query').value = '';
        persistRolePreferences(); renderRoleControls(); renderStages(true);
        roleSelect.focus({ preventScroll: true });
      });
      row.append(button, node('span', 'scope-note', role.configured ? `状态待确认${role.status ? ` · 原值：${role.status}` : ''}` : '仅见于台账，尚未配置岗位'));
      return row;
    }));
    unknownList.dataset.content = unknownSignature;
  }
  const scopeLabel = ROLE_SCOPES.find(scope => scope.id === rolePreferences.scope).label;
  for (const button of byId('role-scopes').querySelectorAll('button')) button.setAttribute('aria-pressed', String(button.dataset.scope === rolePreferences.scope));
  const values = [['', scopeSummary(rolePreferences.scope)], ...view.roles.map(role => [role.name, `${role.name} · ${role.status || '状态未知'}`])];
  if (rolePreferences.role && !view.roles.some(role => role.name === rolePreferences.role)) {
    const suffix = view.selectionMissing ? '未在当前源中' : scopeView.roles.some(role => role.name === rolePreferences.role) ? '当前选择 · 不匹配搜索' : `当前选择 · 不在${scopeLabel}范围`;
    values.push([rolePreferences.role, `${rolePreferences.role} · ${suffix}`]);
  }
  options(roleSelect, values, rolePreferences.role);
  const messages = [];
  if (!scopeView.roles.length) messages.push(rolePreferences.scope === 'following' ? rolePreferences.following.length ? '关注岗位未在当前源中，可重新选择关注。' : '尚未选择关注岗位，可从全部岗位中选择关注。' : `当前${scopeLabel}范围没有岗位。`);
  else if (!view.roles.length) messages.push('搜索没有匹配岗位；汇总数字仍按当前范围统计。');
  if (view.selectionMissing) messages.push('所选岗位已不在当前源中，候选记录数未知。');
  else if (rolePreferences.role && !view.roles.some(role => role.name === rolePreferences.role)) messages.push(scopeView.roles.some(role => role.name === rolePreferences.role) ? '保留所选岗位；它不匹配当前搜索。' : `保留所选岗位；它不在${scopeLabel}范围内。`);
  text('role-options-note', messages.join(' '));
  byId('role-options-note').hidden = !messages.length;
  const roleQuery = byId('role-query').value.trim();
  text('role-query-note-text', roleQuery ? `已筛选岗位：${roleQuery}` : '');
  byId('role-query-note').hidden = !roleQuery;
  const role = view.selectedRole;
  const context = snapshot.sources.context.status;
  const note = context !== 'ok' ? `未读取岗位配置${context === 'stale' ? '；保留上次配置（陈旧）' : '；岗位状态未知'}` : rolePreferences.role ? role?.configured ? `岗位状态：${role.status || '未填写'}${role.priority ? ` · 优先级 ${role.priority}` : ''}` : '仅见于台账，未配置岗位' : rolePreferences.scope === 'active' ? '明确在招岗位的候选分布' : rolePreferences.scope === 'following' ? '关注岗位的候选分布' : '全部岗位的候选分布，含历史岗位';
  text('role-note', `${note} · ${view.total === null ? '记录数未知' : `${view.total} 条候选记录`}`);
  renderFollowingPicker();
  renderWorkspaceFollowing();
  return view;
}

function closeCandidate() {
  pickerLayerCleanup?.(); pickerLayerCleanup = null;
  selectedCandidateId = null; candidateOrigin = null; recordRequest++; documentRequest++;
  byId('candidate-record').hidden = true;
  byId('record-content').replaceChildren();
}

const ACTIVITY_LABELS = { archive: '档案事件', result: '处理记录' };
let activityCache = { source: undefined, map: new Map() };

function candidateActivityMap() {
  const source = overviewState.data?.candidateActivity;
  if (activityCache.source === source) return activityCache.map;
  activityCache = { source, map: new Map((source ?? []).map(item => [item.candidateId, item])) };
  return activityCache.map;
}

function activityOrder(candidates) {
  if (!Array.isArray(candidates)) return candidates;
  const activity = candidateActivityMap(), at = candidate => activity.get(candidate.id)?.at ?? '';
  return [...candidates].sort((a, b) => at(b).localeCompare(at(a)));
}

function activityLabel(activity) {
  return `${activity.precision === 'day' ? activity.at.slice(0, 10) : shortTime(activity.at)} · ${ACTIVITY_LABELS[activity.sourceKind]}`;
}

function renderCandidateOrdering() {
  const activity = overviewState.data?.candidateActivity;
  const message = overviewState.stale ? Array.isArray(activity) ? '进展时间来源待核验，名单暂按上次读取的记录排序。' : '进展时间暂不可读取，暂无法按最近进展排序。' : '';
  text('candidate-activity-status', message); byId('candidate-activity-status').hidden = !message;
  const signature = JSON.stringify(activity ?? null);
  if (signature === appliedCandidateActivity) return;
  appliedCandidateActivity = signature;
  if (!snapshot) return;
  renderStages(); renderCandidateSearch();
}

function candidateListRow(candidate, origin, existing = null) {
  const item = existing ?? node('li', 'candidate-row candidate'); item.dataset.candidate = candidate.id;
  if (!existing) {
    const button = node('button', 'candidate-list-button candidate-link'); button.type = 'button'; button.dataset.candidate = candidate.id;
    button.setAttribute('aria-haspopup', 'dialog'); button.setAttribute('aria-controls', 'workspace-drawer');
    button.addEventListener('click', () => {
      const current = snapshot?.candidates?.find(value => value.id === button.dataset.candidate);
      if (current) void openCandidate(current, origin, button);
    });
    const person = node('span', 'candidate-person'), avatar = node('span', 'person-avatar'); avatar.setAttribute('aria-hidden', 'true');
    person.append(avatar, node('strong', 'person-name candidate-name'));
    const role = node('span', 'person-role'); role.append(node('span', 'candidate-role'), node('span', 'candidate-raw-role'));
    const stage = node('span', 'candidate-stage'); stage.append(node('span', 'candidate-stage-label'), node('span', 'person-status'));
    const activity = node('span', 'candidate-activity');
    activity.append(node('span', 'candidate-activity-label', '最近进展'), node('span', 'candidate-activity-value'));
    button.append(person, role, stage, activity, node('span', 'person-rating'), layoutIcon(['m9 6 6 6-6 6'])); item.append(button);
  }
  const button = item.querySelector('button');
  button.setAttribute('aria-label', `查看 ${candidate.name} 的候选资料，原岗位：${candidate.rawRole}`);
  text(item.querySelector('.person-avatar'), Array.from(candidate.name)[0]);
  text(item.querySelector('.person-name'), candidate.name);
  text(item.querySelector('.candidate-role'), candidate.role);
  const raw = item.querySelector('.candidate-raw-role'); text(raw, `原岗位：${candidate.rawRole}`); raw.hidden = candidate.rawRole === candidate.role;
  text(item.querySelector('.candidate-stage-label'), STAGES.find(stage => stage.id === candidate.stage)?.label ?? '未归类');
  text(item.querySelector('.person-status'), `原状态：${candidateStatus(candidate)}`);
  const record = candidateActivityMap().get(candidate.id), known = Array.isArray(overviewState.data?.candidateActivity);
  text(item.querySelector('.candidate-activity-value'), record ? activityLabel(record) : known ? '无可核实时间' : '时间未知');
  item.querySelector('.candidate-activity').title = record ? `进展记录 ${activityLabel(record)}` : known ? '没有可核实的档案事件或处理记录时间，排在名单后面' : '候选进展时间尚未成功读取';
  text(item.querySelector('.person-rating'), candidate.rating || '未评级');
  return item;
}

const candidateListPrimitive = definePrimitive({
  name: 'candidate-list',
  state: () => ({ tabStop: null }),
  api: context => ({
    roving: createRovingFocus(context, { slot: 'row', key: 'tabStop', orientation: () => 'vertical', loop: () => false })
  }),
  slots: slot => ({
    root: slot({}),
    row: slot({
      props: { id: 'string' },
      attrs: (state, { props, api }) => ({ tabindex: api.roving.tabIndex(state, { key: props.id, props }) }),
      on: { keydown: (event, { api }) => { api.roving.keydown(event, event.currentTarget); } },
      focus: ({ props, api }) => api.roving.focus(props.id),
      bind: (el, part) => part.api.roving.bind(el, { key: part.props.id, props: part.props })
    })
  })
});

function cleanupCandidateRoving(key) {
  const slot = candidateRoving[key];
  slot.cleanups.forEach(fn => fn?.());
  slot.cleanups = [];
  slot.inst?.destroy();
  slot.inst = null;
}

function bindCandidateRoving(key, list, prevStop, focusedId) {
  const buttons = [...list.querySelectorAll('.candidate-list-button')];
  if (!buttons.length) return;
  const slot = candidateRoving[key];
  slot.inst = candidateListPrimitive({ id: `candidate-roving-${key}` });
  slot.cleanups.push(bindPart(slot.inst, 'root', list));
  const ids = new Set();
  for (const button of buttons) {
    const id = button.dataset.candidate;
    ids.add(id);
    slot.cleanups.push(bindPart(slot.inst, 'row', button, { id }));
  }
  const stopTarget = [focusedId, prevStop].find(id => id && ids.has(id));
  if (stopTarget) slot.inst.api.roving.remember(stopTarget);
  if (focusedId) {
    const findRow = () => [...list.querySelectorAll('.candidate-list-button')].find(btn => btn.dataset.candidate === focusedId) ?? list.querySelector('.candidate-list-button');
    const targetBtn = findRow();
    if (targetBtn && document.activeElement !== targetBtn) targetBtn.focus({ preventScroll: true });
    keepFocus(findRow);
  }
}

function renderCandidateSearch() {
  const query = byId('candidate-query').value;
  const searching = query.trim().length > 0;
  const results = byId('candidate-search-results');
  byId('role-blocks').hidden = searching && !layoutState.editing;
  text('role-browser-title', searching ? '全工作区搜索结果' : '岗位与人选');
  results.hidden = !searching;
  byId('clear-candidate-search').hidden = !query.length;
  if (!searching) return;
  const matches = activityOrder(snapshot ? searchCandidates(snapshot, query) : null);
  const shown = matches?.slice(0, candidateSearchLimit) ?? [];
  text('candidate-search-status', matches === null ? '候选台账尚未成功读取，匹配人数未知。' : `找到 ${matches.length} 条候选记录 · 已显示 ${shown.length} 条`);
  const stale = workspaceBlocked ? '工作区连接已变化，以下保留上次搜索记录，请重新打开看板。' : disconnected ? '连接断开，以下搜索结果来自上次读取的台账。' : snapshot?.sources.ledger.status === 'stale' ? '以下搜索结果沿用上次候选记录（陈旧）。' : '';
  text('candidate-search-stale', stale); byId('candidate-search-stale').hidden = !stale;
  const more = byId('show-more-candidates');
  more.hidden = matches === null || shown.length === matches.length;
  const list = byId('candidate-search-list');
  const signature = JSON.stringify([matches === null, shown.map(candidate => [candidate.id, candidate.name, candidate.role, candidate.rawRole, candidate.stage, candidate.rating, candidateStatus(candidate), candidateActivityMap().get(candidate.id) ?? null])]);
  if (list.dataset.content === signature) return;
  list.dataset.content = signature;
  const focused = list.contains(document.activeElement) ? document.activeElement : null;
  const focusedId = focused?.closest?.('[data-candidate]')?.dataset.candidate ?? null;
  const prevStop = candidateRoving.search.inst?.get().tabStop ?? focusedId;
  cleanupCandidateRoving('search');
  const previous = new Map([...list.children].map(item => [item.dataset.candidate, item]));
  const items = shown.map(candidate => candidateListRow(candidate, 'search', previous.get(candidate.id)));
  if (!items.length) items.push(node('li', 'empty-state', matches === null ? '等待成功读取台账后再显示匹配结果。' : '未找到匹配的人选，请尝试完整姓名或部分姓名。'));
  for (const item of previous.values()) if (!items.includes(item)) item.remove();
  let position = list.firstElementChild;
  for (const item of items) { if (item !== position) list.insertBefore(item, position); position = item.nextElementSibling; }
  bindCandidateRoving('search', list, prevStop, focusedId);
  if (focused && !focusedId && document.activeElement !== focused) (focused.isConnected ? focused : byId('candidate-query')).focus({ preventScroll: true });
}

function changeCandidateSearch() {
  setWorkspaceNavTarget('roles');
  candidateSearchLimit = 20;
  if (candidateOrigin) closeCandidate();
  renderCandidateSearch();
  if (snapshot) renderRunResults(selectedRun());
}

function clearCandidateSearch(focusInput = true) {
  byId('candidate-query').value = '';
  changeCandidateSearch();
  if (focusInput) byId('candidate-query').focus({ preventScroll: true });
}

function markdownView(text) {
  const body = node('div', 'document-markdown');
  const plain = value => value.replace(/\*\*([^*]+)\*\*/g, '$1').replace(/`([^`]+)`/g, '$1');
  let paragraph = [], bullets = null, code = null;
  const flush = () => { if (paragraph.length) { body.append(node('p', '', plain(paragraph.join('\n')))); paragraph = []; } };
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*```/.test(line)) {
      flush(); bullets = null;
      if (code) { body.append(node('pre', 'document-text', code.join('\n'))); code = null; } else code = [];
      continue;
    }
    if (code) { code.push(line); continue; }
    const heading = /^(#{1,6})\s+(.+)$/.exec(line), bullet = /^\s*[-*+]\s+(.+)$/.exec(line);
    if (heading) { flush(); bullets = null; body.append(node(`h${Math.min(6, heading[1].length + 3)}`, '', plain(heading[2]))); }
    else if (bullet) { flush(); if (!bullets) { bullets = node('ul'); body.append(bullets); } bullets.append(node('li', '', plain(bullet[1]))); }
    else if (/^>\s?/.test(line)) { flush(); bullets = null; body.append(node('blockquote', '', plain(line.replace(/^>\s?/, '')))); }
    else if (!line.trim()) { flush(); bullets = null; }
    else { bullets = null; paragraph.push(line); }
  }
  flush(); if (code) body.append(node('pre', 'document-text', code.join('\n')));
  return body;
}

function documentURL(candidate, document, download = false) {
  return `/api/candidates/document?${new URLSearchParams({ candidate, document, ...(download ? { download: '1' } : {}), ...(expectedWorkspaceKey ? { workspace: expectedWorkspaceKey } : {}) })}`;
}

function candidateProgressView(detail) {
  const section = node('section', 'candidate-progress'); section.id = 'candidate-progress';
  const heading = node('h4', '', '面试与跟进'); heading.id = 'candidate-progress-heading';
  section.setAttribute('aria-labelledby', heading.id); section.append(heading);
  const progress = detail.progress;
  if (progress?.message) section.append(node('p', progress.status === 'error' || progress.status === 'partial' ? 'record-error' : 'muted', progress.message));
  if (!progress) section.append(node('p', 'muted', '面试进度尚未读取，可打开面试档案查看。'));
  for (const record of progress?.records ?? []) {
    const entry = node('div', 'candidate-progress-entry');
    if (record.currentStatus) entry.append(node('p', 'candidate-progress-status', record.currentStatus));
    const interviews = node('ul', 'candidate-interviews');
    for (const interview of record.interviews) {
      const item = node('li', 'candidate-interview');
      const title = node('div', 'result-person-heading');
      title.append(node('strong', '', interview.round || '面试安排'));
      if (interview.status) title.append(node('span', 'muted', interview.status));
      item.append(title);
      const facts = node('dl', 'record-facts');
      for (const [label, value] of [['时间', interview.time], ['形式', interview.format], ['面试官', interview.interviewers]]) {
        const row = node('div'); row.append(node('dt', '', label), node('dd', '', value || '未记录')); facts.append(row);
      }
      item.append(facts); interviews.append(item);
    }
    entry.append(interviews);
    if (record.conclusion) entry.append(node('p', 'candidate-progress-conclusion', '当前结论：' + record.conclusion));
    if (record.nextAction) entry.append(node('p', 'candidate-progress-next', '下一步：' + record.nextAction));
    const source = node('a', 'text-button', '打开面试档案');
    source.href = documentURL(detail.candidate.id, record.documentId); source.target = '_blank'; source.rel = 'noopener noreferrer';
    if ((progress?.records.length ?? 0) > 1) source.textContent = '来源：' + record.label;
    entry.append(source); section.append(entry);
  }
  return section;
}

async function openCandidate(candidate, origin = 'stage', trigger = null, { preserveScroll = false } = {}) {
  const pending = ++recordRequest;
  documentRequest++; selectedCandidateId = candidate.id;
  candidateOrigin = { source: origin, trigger, candidateId: candidate.id };
  if (origin !== 'drawer') {
    showWorkspaceDrawer(trigger);
    drawerState.stack = []; drawerState.page = 'candidate'; drawerState.itemId = candidate.id;
  }
  const host = byId('drawer-record-host'), record = byId('candidate-record');
  if (record.parentElement !== host) host.append(record);
  record.hidden = false;
  renderWorkspaceDrawer();
  const content = byId('record-content');
  if (!preserveScroll) {
    content.replaceChildren(node('p', 'muted', '正在读取候选资料…'));
    byId('workspace-drawer-content').scrollTop = 0;
    byId('workspace-drawer-title').focus({ preventScroll: true });
  }
  renderOverviewReadingNotice();
  try {
    const detail = await jsonRequest(`/api/candidates/detail?${new URLSearchParams({ candidate: candidate.id })}`);
    if (pending !== recordRequest) return;
    const heading = node('h3', 'record-name', detail.candidate.name);
    const facts = node('dl', 'record-facts');
    const identityFacts = [['岗位', detail.candidate.role]];
    if (detail.candidate.rawRole && detail.candidate.rawRole !== detail.candidate.role) identityFacts.push(['原岗位', detail.candidate.rawRole]);
    identityFacts.push(['原状态', detail.candidate.rawStatus ?? '状态冲突，请核对台账']);
    for (const [label, value] of identityFacts) {
      const row = node('div'); row.append(node('dt', '', label), node('dd', '', value)); facts.append(row);
    }
    const evaluation = node('details', 'record-evaluation'), evaluationFacts = node('dl', 'record-facts');
    evaluation.append(node('summary', 'panel-summary', '背景与评估'));
    for (const [label, value] of [['评级', detail.candidate.rating || '未评级'], ['现职 / 背景', detail.background || '未填写'], ['评估备注', detail.notes || '未填写'], ['来源轮次', detail.sourceRound || '未填写']]) {
      const row = node('div'); row.append(node('dt', '', label), node('dd', '', value)); evaluationFacts.append(row);
    }
    evaluation.append(evaluationFacts);
    const warnings = node('div', 'record-warnings');
    warnings.append(...detail.warnings.map(message => node('p', 'muted', message)));
    const documents = node('ul', 'document-list');
    const existingPreview = preserveScroll ? content.querySelector(':scope > .document-preview') : null;
    const preview = existingPreview && !existingPreview.hidden ? existingPreview : node('section', 'document-preview');
    if (preview !== existingPreview) preview.hidden = true;
    for (const document of detail.documents) {
      const item = node('li', 'document-row'), title = node('p', '', document.label);
      item.append(title, node('p', 'muted document-category', { resume: '简历材料', archive: '面试档案', brief: '候选人介绍', other: '其他资料' }[document.category] ?? '其他资料'));
      if (document.status !== 'ok') item.append(node('p', 'muted', document.message || '文件暂不可读'));
      else {
        const actions = node('div', 'document-actions');
        if (['markdown', 'text'].includes(document.kind)) {
          const view = node('button', 'text-button', '查看'); view.type = 'button';
          view.addEventListener('click', async () => {
            const reading = ++documentRequest;
            preview.hidden = false; preview.replaceChildren(node('p', 'muted', '正在读取文档…'));
            try {
              if (workspaceBlocked) throw new Error('服务已指向其他工作区，请重新打开');
              const response = await fetch(documentURL(detail.candidate.id, document.id), { cache: 'no-store', signal: AbortSignal.timeout(10000), headers: workspaceHeaders() });
              if (!response.ok) { const data = await response.json(); if (data.error?.code === 'WORKSPACE_MISMATCH') blockWorkspace(); throw new Error(data.error?.message ?? '文档读取失败'); }
              const text = await response.text();
              if (reading !== documentRequest || selectedCandidateId !== detail.candidate.id) return;
              preview.replaceChildren(node('h4', '', document.label), document.kind === 'markdown' ? markdownView(text) : node('pre', 'document-text', text));
            } catch (error) {
              if (reading === documentRequest && selectedCandidateId === detail.candidate.id) preview.replaceChildren(node('p', 'record-error', error.message));
            }
          });
          actions.append(view);
        }
        const link = node('a', 'text-button', document.kind === 'pdf' ? '打开 PDF' : document.downloadOnly ? '下载原件' : '打开文件');
        link.href = documentURL(detail.candidate.id, document.id, Boolean(document.downloadOnly)); link.target = '_blank'; link.rel = 'noopener noreferrer';
        const download = node('a', 'text-button', '下载'); download.href = documentURL(detail.candidate.id, document.id, true); download.download = '';
        actions.append(link); if (!document.downloadOnly) actions.append(download); item.append(actions);
      }
      documents.append(item);
    }
    if (!detail.documents.length) documents.append(node('li', 'muted', '暂无已关联资料。'));
    const tools = node('div', 'subsection-heading');
    const associate = node('button', 'text-button', '关联资料'); associate.type = 'button';
    associate.addEventListener('click', () => { void openMaterialPicker(detail, associate); });
    tools.append(node('h4', '', '本地资料'), associate);
    const drawerContent = byId('workspace-drawer-content'), savedScroll = preserveScroll ? drawerContent.scrollTop : 0;
    content.replaceChildren(heading, facts, candidateProgressView(detail), tools, documents, preview, warnings, evaluation);
    if (preserveScroll) drawerContent.scrollTop = savedScroll;
  } catch (error) {
    if (pending === recordRequest) content.replaceChildren(node('p', 'record-error', error.message));
  }
}

function renderRoleAliases() {
  const section = byId('role-alias-manager'), list = byId('role-alias-list');
  section.hidden = byId('role-manager').hidden || !roleInfo;
  if (!roleInfo) return;
  const aliases = roleInfo.roleAliases ?? {};
  const names = [...new Set([...(roleInfo.unconfiguredRoles ?? []).map(role => role.name), ...Object.keys(aliases)])];
  const rows = names.map(role => {
    const row = node('li', 'document-row');
    const title = node('strong', '', role), label = node('label', 'muted', '归入正式岗位');
    const select = node('select', 'material-select');
    options(select, [['', '待归并'], ...roleInfo.roles.map(item => [item.name, item.name])], aliases[role] ?? '');
    select.setAttribute('aria-label', role + '归入正式岗位'); label.append(select);
    const save = node('button', 'text-button', '保存归并'); save.type = 'button';
    save.addEventListener('click', async () => {
      if (!roleInfo || !csrfToken || workspaceBlocked) return;
      save.disabled = true; select.disabled = true;
      text('role-alias-result', '正在保存岗位归并…');
      try {
        const result = await jsonRequest('/api/roles/alias', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken }, body: JSON.stringify({ role, target: select.value || null, revision: roleInfo.configRevision }) });
        roleInfo = result; text('role-alias-result', result.message); renderRoleAliases();
        await snapshotController.refresh({ invalidate: true });
      } catch (error) { text('role-alias-result', error.message + '，请重新打开岗位管理后重试。'); }
      finally { save.disabled = false; select.disabled = false; }
    });
    row.append(title, label, save); return row;
  });
  list.replaceChildren(...rows);
  if (!rows.length) list.append(node('li', 'muted', '暂无需要归并的历史名称。'));
}

async function openMaterialPicker(detail, trigger) {
  const candidateId = detail.candidate.id, pending = recordRequest;
  const drawerContent = byId('workspace-drawer-content'), initialScroll = drawerContent.scrollTop;
  trigger.disabled = true;
  pickerLayerCleanup?.(); pickerLayerCleanup = null;
  byId('material-picker')?.remove();
  const panel = node('section', 'material-picker'); panel.id = 'material-picker';
  const closePicker = (restore = true) => {
    const keepScroll = drawerContent.scrollTop;
    pickerLayerCleanup?.(); pickerLayerCleanup = null;
    panel.remove();
    if (restore) trigger.focus({ preventScroll: true });
    drawerContent.scrollTop = keepScroll;
  };
  const message = node('p', 'muted', '正在读取工作区资料…'); message.setAttribute('role', 'status');
  panel.append(node('h4', '', '关联资料'), message); byId('record-content').append(panel);
  pickerLayerCleanup = bindLayer(panel, {
    contains: target => trigger.contains(target),
    onDismiss: (_reason, event) => { event?.preventDefault?.(); event?.stopPropagation?.(); closePicker(true); }
  });
  try {
    const data = await jsonRequest('/api/candidates/materials?' + new URLSearchParams({ candidate: candidateId }));
    if (pending !== recordRequest || selectedCandidateId !== candidateId) return;
    const selected = new Map((data.files ?? []).filter(file => file.status === 'ok').map(file => [file.path, { path: file.path, label: file.label, category: file.category ?? 'other' }]));
    const choices = [...new Map([...(data.files ?? []), ...(data.options ?? [])].map(file => [file.path, file])).values()];
    const search = node('input', 'search-input'); search.type = 'search'; search.placeholder = '按姓名或文件名查找资料'; search.setAttribute('aria-label', '查找工作区资料');
    const list = node('ul', 'document-list material-options');
    const categories = [['resume', '原始简历'], ['archive', '面试档案'], ['brief', '候选人介绍'], ['other', '其他资料']];
    const render = () => {
      const query = search.value.trim().toLocaleLowerCase();
      const matching = choices.filter(file => !query || (file.label + ' ' + file.path).toLocaleLowerCase().includes(query));
      list.replaceChildren(...matching.slice(0, 100).map(file => {
        const item = node('li', 'document-row'), label = node('label', 'material-choice');
        const checkbox = node('input'); checkbox.type = 'checkbox'; checkbox.checked = selected.has(file.path);
        checkbox.disabled = Boolean(file.status && file.status !== 'ok');
        const title = node('span', '', file.label || file.path); label.append(checkbox, title);
        const category = node('select', 'material-select'); category.setAttribute('aria-label', (file.label || file.path) + '资料类别');
        options(category, categories, selected.get(file.path)?.category ?? file.category ?? 'other');
        checkbox.addEventListener('change', () => { if (checkbox.checked) selected.set(file.path, { path: file.path, label: file.label || file.path.split('/').at(-1), category: category.value }); else selected.delete(file.path); });
        category.addEventListener('change', () => { if (selected.has(file.path)) selected.get(file.path).category = category.value; });
        item.append(label, node('p', 'muted', file.path), category);
        if (checkbox.disabled) item.append(node('p', 'record-error', file.message || '文件暂不可用，保存时移除此失效关联。'));
        return item;
      }));
      if (!matching.length) list.append(node('li', 'muted', '未找到工作区资料；可先在聊天中补取或归档原件。'));
    };
    search.addEventListener('input', render); render();
    const controls = node('div', 'control-actions'), save = node('button', 'primary-button', '确认关联'), cancel = node('button', 'text-button', '取消');
    save.type = cancel.type = 'button';
    cancel.addEventListener('click', () => closePicker(true));
    save.addEventListener('click', async () => {
      save.disabled = true; cancel.disabled = true; message.textContent = '正在保存资料关联…';
      try {
        const prevScroll = drawerContent.scrollTop;
        const token = await ensureCsrfToken();
        await jsonRequest('/api/candidates/materials', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': token }, body: JSON.stringify({ candidateId, revision: data.revision, files: [...selected.values()] }) });
        if (pending !== recordRequest || selectedCandidateId !== candidateId) return;
        closePicker(false);
        const origin = candidateOrigin;
        await openCandidate(detail.candidate, origin.source, origin.trigger, { preserveScroll: true });
        byId('record-content').querySelector('.subsection-heading button')?.focus({ preventScroll: true });
        drawerContent.scrollTop = prevScroll;
      } catch (error) { message.textContent = error.message + '，请重新打开关联资料后重试。'; }
      finally { save.disabled = false; cancel.disabled = false; }
    });
    message.textContent = '只选择已核实属于此人的资料；取消勾选可更正已有映射。' + (data.truncated ? ' 资料列表较多，请先按文件名查找。' : '');
    controls.append(save, cancel); panel.append(search, list, controls);
    search.focus({ preventScroll: true }); drawerContent.scrollTop = initialScroll;
  } catch (error) { message.textContent = error.message; }
  finally { trigger.disabled = false; }
}

function updateManagedStatus() {
  const role = roleInfo?.roles.find(item => item.name === byId('managed-role').value);
  const known = roleInfo?.allowedStatuses.includes(role?.status);
  const values = roleInfo?.allowedStatuses.map(status => [status, status]) ?? [];
  if (!known) values.unshift(['', role?.status ? `请选择状态（当前：${role.status}）` : '请选择状态']);
  options(byId('managed-status'), values, known ? role.status : '');
}

async function openRoleManager() {
  const pending = ++roleRequest;
  const form = byId('role-manager');
  form.hidden = false; byId('cancel-role').disabled = false; byId('manage-roles').setAttribute('aria-expanded', 'true');
  byId('role-result').textContent = '正在读取当前岗位配置…';
  byId('save-role').disabled = true; roleInfo = null;
  try {
    const [info, session] = await Promise.all([jsonRequest('/api/roles'), jsonRequest('/api/session')]);
    if (pending !== roleRequest) return;
    roleInfo = info; csrfToken = session.csrfToken; renderRoleAliases();
    const selected = info.roles.some(role => role.name === roleSelect.value) ? roleSelect.value : info.roles[0]?.name ?? '';
    options(byId('managed-role'), info.roles.map(role => [role.name, role.name]), selected);
    updateManagedStatus();
    byId('save-role').disabled = !info.roles.length;
    byId('role-result').textContent = info.roles.length ? '' : '当前标准表尚未配置岗位。';
    byId('managed-role').focus({ preventScroll: true });
  } catch (error) { if (pending === roleRequest) byId('role-result').textContent = error.message; }
}

function closeRoleManager() {
  roleRequest++; roleInfo = null;
  byId('role-manager').hidden = true; byId('role-alias-manager').hidden = true; byId('manage-roles').setAttribute('aria-expanded', 'false');
  byId('manage-roles').focus({ preventScroll: true });
}

const stageButtons = new Map(STAGES.map(stage => {
  const button = byId('stage-template').content.firstElementChild.cloneNode(true);
  button.id = `stage-${stage.id}`;
  button.dataset.stage = stage.id;
  button.querySelector('.stage-name').textContent = stage.label;
  button.addEventListener('click', () => {
    if (candidateOrigin?.source === 'stage') closeCandidate();
    selectedStage = selectedStage === stage.id ? 'all' : stage.id; candidateStageLimit = 20;
    if (snapshot) { renderStages(); focusWorkbenchTarget(byId('detail-title'), 'nearest'); }
  });
  byId('stages').append(button);
  return [stage.id, button];
}));

function stepLabel(step, run) {
  if (step.status !== 'running') return STEP_LABELS[step.status];
  return { waiting: '当前 · 等待', cancelled: '已停止', failed: '已中断' }[run.status] ?? STEP_LABELS.running;
}

function selectedRun() {
  return snapshot?.runs?.find(run => run.id === taskSelection.runId);
}

function flash(element) {
  if (!document.hidden && pageActive && !motionQuery.matches) element.dataset.update = element.dataset.update === 'a' ? 'b' : 'a';
}

function resultVersion(run) {
  return JSON.stringify([run.id, run.resultSummary?.revision ?? null]);
}

function resetRunResults(runId) {
  resultsRequest++;
  if (['results', 'decisions'].includes(candidateOrigin?.source)) closeCandidate();
  resultsState = freshResults(runId);
  for (const id of ['result-list', 'decision-list']) {
    byId(id).replaceChildren();
    delete byId(id).dataset.content;
  }
  byId('decisions-content').hidden = true;
}

function groupRunResults(results) {
  if (results === null) return null;
  const people = new Map();
  for (const [order, receipt] of new Map(results.map((item, order) => [item.id, [order, item]])).values()) {
    const subject = candidateSubject(receipt.candidateId);
    if (!subject) throw new Error('处理名单中的姓名或原岗位格式无效');
    const person = people.get(receipt.candidateId) ?? { ...subject, receipts: [] };
    person.receipts.push({ ...receipt, order });
    people.set(receipt.candidateId, person);
  }
  for (const person of people.values()) {
    person.receipts.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || b.order - a.order);
    person.attention = person.receipts[0].attention;
  }
  return [...people.values()];
}

function runHighlightCandidate(highlight) {
  if (highlight.context?.scope && highlight.context.scope !== 'candidate') return null;
  const ids = new Set();
  const add = value => { if (candidateSubject(value)) ids.add(value); };
  add(highlight.context?.candidateId); add(highlight.subjectKey);
  for (const subject of highlight.subjects ?? []) add(subject.candidateId);
  const decision = overviewState.data?.decisions?.find(item => item.id === highlight.decisionId);
  for (const subject of decision ? itemSubjects(decision) : []) add(subject.candidateId);
  for (const person of resultsState.data ?? []) if (person.receipts.some(receipt => receipt.decisionId && receipt.decisionId === highlight.decisionId)) add(person.candidateId);
  return ids.size === 1 ? [...ids][0] : null;
}

function mergedRunPeople() {
  const people = new Map((resultsState.data ?? []).map(person => [person.candidateId, { ...person, highlights: [] }]));
  for (const highlight of runHighlightsState.data ?? []) {
    const id = runHighlightCandidate(highlight);
    if (!id) continue;
    const subject = candidateSubject(id);
    const person = people.get(id) ?? { ...subject, receipts: [], attention: 'notice', highlights: [] };
    person.highlights.push(highlight); people.set(id, person);
  }
  for (const person of people.values()) person.highlights.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const updated = person => [person.receipts[0]?.updatedAt, person.highlights[0]?.updatedAt].filter(Boolean).sort().at(-1) ?? '';
  return [...people.values()].sort((a, b) => updated(b).localeCompare(updated(a)) || a.candidateId.localeCompare(b.candidateId));
}

async function loadRunResults() {
  const run = selectedRun();
  if (!run || resultsState.runId !== run.id || document.hidden || !pageActive || disconnected || workspaceBlocked) return;
  const pending = ++resultsRequest, version = resultVersion(run), workspaceKey = expectedWorkspaceKey;
  resultsState.status = 'loading'; resultsState.error = null; resultsState.requestedVersion = version;
  renderRunResults(run);
  try {
    const response = await jsonRequest(`/api/runs/results?${new URLSearchParams({ run: run.id })}`);
    if (pending !== resultsRequest || resultsState.runId !== run.id || workspaceKey !== expectedWorkspaceKey || workspaceBlocked) return;
    const current = selectedRun();
    if (!current || resultVersion(current) !== version) {
      resultsState.status = 'idle'; resultsState.requestedVersion = null;
      renderRunResults(current);
      return;
    }
    if (response.runId !== run.id || (response.results !== null && !Array.isArray(response.results))) throw new Error('处理名单响应格式不兼容');
    if (response.revision !== (run.resultSummary?.revision ?? 0)) throw new Error('处理记录版本已变化，等待任务汇总同步后重试');
    const data = groupRunResults(response.results);
    if (run.resultSummary && (!Array.isArray(data) || data.filter(person => person.receipts.some(receipt => receipt.attention === 'decision')).length !== run.resultSummary.decisions)) throw new Error('确认名单与任务汇总不一致，请重试');
    resultsState.data = data; resultsState.updatedAt = response.updatedAt;
    resultsState.loadedVersion = version; resultsState.status = 'ready';
    renderRunResults(current);
  } catch (error) {
    if (pending !== resultsRequest || resultsState.runId !== run.id || workspaceBlocked) return;
    resultsState.status = 'error'; resultsState.error = error.message;
    renderRunResults(selectedRun());
  }
}

function receiptView(receipt, run, showNext = true) {
  const view = node('div', 'result-receipt');
  const action = node('p', 'result-action', receipt.action);
  const step = run.steps.find(step => step.id === receipt.stepId);
  action.append(node('span', 'result-step', ` · ${step?.label ?? receipt.stepId}`));
  view.append(action, node('p', 'result-outcome', receipt.outcome));
  if (showNext) view.append(node('p', 'result-next', `下一步：${receipt.nextAction ?? '未记录'}`));
  const timestamp = node('time', 'result-time', time(receipt.updatedAt)); timestamp.dateTime = receipt.updatedAt;
  view.append(timestamp);
  if (receipt.decisionId) {
    const linked = node('div', 'linked-decision'); linked.dataset.linkedDecision = receipt.decisionId;
    const button = node('button', 'text-button', '查看关联事项'); button.type = 'button';
    button.addEventListener('click', () => openWorkspaceDecision(receipt.decisionId));
    linked.append(node('p', '', '关联事项现在：正在读取'), button); view.append(linked);
  }
  return view;
}

function renderResultList(run) {
  const list = byId('result-list'), people = mergedRunPeople();
  const signature = JSON.stringify([run.id, people, resultsState.filter, snapshot.candidates?.map(candidate => [candidate.id, candidate.role])]);
  if (list.dataset.content === signature) return;
  const active = list.contains(document.activeElement) ? document.activeElement.dataset.resultFocus : null;
  const previous = new Map([...list.children].map(item => [item.dataset.candidate, item]));
  const filtered = people.filter(person => resultsState.filter === 'all' || person.attention === resultsState.filter);
  const items = filtered.map(person => {
    const content = JSON.stringify([person, snapshot.candidates?.find(candidate => candidate.id === person.candidateId)?.role]);
    const existing = previous.get(person.candidateId);
    if (existing?.dataset.content === content) return existing;
    const item = node('li', 'result-person'); item.dataset.candidate = person.candidateId; item.dataset.content = content;
    const heading = node('div', 'result-person-heading');
    const candidate = snapshot.candidates?.find(candidate => candidate.id === person.candidateId);
    const name = node(candidate ? 'button' : 'strong', 'person-name candidate-link', person.name);
    if (candidate) {
      name.type = 'button'; name.dataset.resultFocus = 'name:' + person.candidateId;
      name.setAttribute('aria-label', '查看 ' + person.name + ' 的候选资料');
      name.addEventListener('click', () => { const current = snapshot.candidates?.find(value => value.id === person.candidateId); if (current) void openCandidate(current, 'results', name); });
    }
    heading.append(name, node('span', 'result-attention', '已记录'));
    const receipt = person.receipts[0], highlight = person.highlights[0];
    const useHighlight = highlight && (!receipt || highlight.updatedAt >= receipt.updatedAt);
    item.append(heading, node('p', 'result-role', candidate?.role ?? person.rawRole));
    item.append(node('p', 'result-outcome', useHighlight ? highlight.text : receipt.outcome));
    const newestDecision = receipt?.decisionId ? overviewState.data?.decisions?.find(value => value.id === receipt.decisionId) : null;
    const nextAction = newestDecision && newestDecision.effectiveState !== 'open' ? null : receipt?.nextAction;
    if (nextAction) item.append(node('p', 'result-next', '下一步：' + nextAction));
    item.append(node('time', 'result-time', time(useHighlight ? highlight.updatedAt : receipt.updatedAt)));
    const details = node('details', 'result-history');
    const summary = node('summary', 'result-history-summary', '处理经过与依据'); summary.dataset.resultFocus = 'history:' + person.candidateId;
    details.open = resultsState.expanded.has(person.candidateId);
    details.append(summary);
    for (const value of person.receipts) details.append(receiptView(value, run));
    for (const value of person.highlights) {
      const event = node('div', 'result-receipt'); event.dataset.event = value.eventKey;
      if (value.text !== receipt?.outcome) event.append(node('p', 'result-outcome', value.text));
      event.append(eventDetails(value));
      const evidence = highlightEvidence(value, runHighlightsState.expanded); if (evidence) event.append(evidence);
      details.append(event);
    }
    details.addEventListener('toggle', () => { if (resultsState.runId !== run.id || !details.isConnected) return; if (details.open) resultsState.expanded.add(person.candidateId); else resultsState.expanded.delete(person.candidateId); });
    item.append(details);
    return item;
  });
  if (!items.length && (Array.isArray(resultsState.data) || runHighlightsState.data?.length)) items.push(node('li', 'result-empty', people.length ? '当前筛选没有处理记录。' : '本轮已明确记录 0 人。'));
  list.replaceChildren(...items); list.dataset.content = signature;
  if (active) [...list.querySelectorAll('[data-result-focus]')].find(element => element.dataset.resultFocus === active)?.focus({ preventScroll: true });
}

function confirmationView(run) {
  const data = overviewState.pending ?? overviewState.data;
  const linked = data?.decisions?.filter(item => item.sources.some(source => source.runId === run?.id) || (resultsState.data ?? []).some(person => person.receipts.some(receipt => receipt.decisionId === item.id)) || (runHighlightsState.data ?? []).some(highlight => highlight.decisionId === item.id)) ?? [];
  const pending = linked.filter(item => item.effectiveState === 'open');
  const known = Boolean(run && Array.isArray(data?.decisions) && !overviewState.stale && !overviewState.missing && !workspaceBlocked && !disconnected && snapshot?.sources.runs.status === 'ok');
  return { known, pending, history: linked.filter(item => item.effectiveState !== 'open'), linked, decisions: known ? pending.length : null, message: known ? pending.length ? '当前仍需回答的事项，按关联事项计数。' : '本轮暂无待回答事项。' : '待回答事项尚未成功读取，数量未知。' };
}

const freshRunHighlights = runId => ({ runId, data: undefined, revision: null, status: 'idle', error: '', readAt: null, pending: null, expanded: new Set() });
let runHighlightsState = freshRunHighlights(null);

function resetRunHighlights(runId) {
  runHighlightsRequest++; runHighlightsAbort?.abort();
  runHighlightsState = freshRunHighlights(runId);
}

async function loadRunHighlights() {
  const run = selectedRun();
  if (!run || !byId('execution-records').open || document.hidden || !pageActive || disconnected || workspaceBlocked || !expectedWorkspaceKey) return;
  if (runHighlightsState.runId !== run.id) resetRunHighlights(run.id);
  if (runHighlightsState.status === 'loading') return;
  const pending = ++runHighlightsRequest, workspaceKey = expectedWorkspaceKey;
  runHighlightsAbort = new AbortController();
  runHighlightsState.status = 'loading';
  renderRunHighlights(run);
  try {
    const response = await fetch(`/api/runs/highlights?${new URLSearchParams({ run: run.id })}`, { cache: 'no-store', signal: AbortSignal.any([runHighlightsAbort.signal, AbortSignal.timeout(10000)]), headers: workspaceHeaders() });
    if (response.status === 409) { blockWorkspace(); return; }
    const raw = await response.text();
    let payload = null;
    try { payload = raw ? JSON.parse(raw) : null; } catch { throw new Error('本轮重点响应格式不兼容'); }
    if (!response.ok) {
      if (payload?.error?.code === 'WORKSPACE_MISMATCH') blockWorkspace();
      throw new Error(payload?.error?.message ?? (response.status === 404 ? '本机看板尚未提供本轮重点接口' : '本轮重点读取失败'));
    }
    if (!payload || payload.runId !== run.id || (payload.highlights !== null && (!Array.isArray(payload.highlights) || !payload.highlights.every(isHighlight)))) throw new Error('本轮重点响应格式不兼容');
    if (pending !== runHighlightsRequest || workspaceKey !== expectedWorkspaceKey || workspaceBlocked || selectedRun()?.id !== run.id) return;
    const state = runHighlightsState;
    const reading = state.expanded.size > 0 || byId('run-highlight-list').contains(document.activeElement);
    if (state.data !== undefined && reading && JSON.stringify(state.data) !== JSON.stringify(payload.highlights)) state.pending = { highlights: payload.highlights };
    else { state.data = payload.highlights; state.pending = null; }
    state.revision = payload.revision ?? null; state.status = 'ready'; state.error = ''; state.readAt = new Date().toISOString();
    state.trigger = payload.trigger; state.summaryState = payload.summaryState; state.closingSummary = payload.closingSummary;
  } catch (error) {
    if (pending !== runHighlightsRequest || workspaceBlocked || selectedRun()?.id !== run.id) return;
    runHighlightsState.status = 'error'; runHighlightsState.error = error.message;
  }
  if (pending === runHighlightsRequest) { renderRunHighlights(selectedRun()); renderRunResults(selectedRun()); renderLinkedDecisions(); }
}

function renderRunHighlights(run) {
  const section = byId('run-highlights'), list = byId('run-highlight-list'), status = byId('run-highlights-status'), retry = byId('retry-run-highlights');
  section.hidden = !run || (runHighlightsState.status === 'ready' && !(runHighlightsState.data ?? []).some(item => !runHighlightCandidate(item)));
  if (!run) return;
  const state = runHighlightsState, retained = state.data !== undefined;
  const stale = workspaceBlocked || disconnected || state.status === 'error';
  const readAt = stale && state.readAt ? ` 最后读取 ${time(state.readAt)}。` : '';
  const summary = state.summaryState ?? run.summaryState;
  const message = workspaceBlocked || disconnected ? retained ? '连接中断，以下保留最后成功读取的本轮重点。' : '连接中断，本轮重点未知。' : state.status === 'loading' ? (retained ? '正在更新本轮重点；以下保留上次记录。' : '正在读取本轮重点…') : state.status === 'error' ? `本轮重点读取失败：${state.error}${retained ? '；以下保留上次记录。' : '；可重试。'}` : !retained ? '展开执行记录后读取本轮重点。' : state.data === null ? '此任务未记录重点（尚未接入重点记录）。' : state.data.length ? `本轮记录 ${state.data.length} 条重点 · ${triggerLabel(state.trigger ?? run.trigger)}` : summary === 'no_change' ? '本轮明确记录无重要变化。' : '本轮尚未写入重点。';
  text(status, `${message}${readAt}${state.pending ? ' 本轮重点已有更新，当前依据保持原位。' : ''}`); status.hidden = false;
  status.dataset.state = stale ? 'error' : state.status;
  retry.hidden = workspaceBlocked || state.status !== 'error';
  byId('apply-run-highlights').hidden = state.pending === null;
  const signature = JSON.stringify([run.id, state.data, (state.data ?? []).map(item => runHighlightCandidate(item))]);
  if (list.dataset.content === signature) return;
  const previous = new Map([...list.children].map(item => [`${item.dataset.run}:${item.dataset.event}`, item]));
  const items = (state.data ?? []).filter(highlight => !runHighlightCandidate(highlight)).map(highlight => {
    const content = JSON.stringify(highlight), existing = previous.get(`${run.id}:${highlight.eventKey}`);
    if (existing?.dataset.content === content) return existing;
    const item = node('li', 'workspace-highlight'); item.dataset.run = run.id; item.dataset.event = highlight.eventKey; item.dataset.content = content;
    item.append(subjectLine(highlight), node('p', 'workspace-highlight-text', highlight.text), eventDetails(highlight));
    const meta = node('p', 'workspace-overview-caption', `事件时间 ${highlight.timePrecision === 'day' ? progressTime(highlight) : time(highlight.occurredAt)}`);
    if (highlight.correction) meta.append(node('span', 'workspace-highlight-correction', ` · 更正：${highlight.correction}`));
    item.append(meta);
    const evidence = highlightEvidence(highlight, state.expanded);
    if (evidence) item.append(evidence);
    if (highlight.decisionId) {
      const linked = node('div', 'linked-decision'); linked.dataset.linkedDecision = highlight.decisionId;
      const button = node('button', 'text-button', '查看关联事项'); button.type = 'button';
      button.addEventListener('click', () => openWorkspaceDecision(highlight.decisionId));
      linked.append(node('p', '', '关联事项现在：正在读取'), button); item.append(linked);
    }
    return item;
  });
  for (const item of [...list.children]) if (!items.includes(item)) item.remove();
  let position = list.firstElementChild;
  for (const item of items) { if (item !== position) list.insertBefore(item, position); position = item.nextElementSibling; }
  list.dataset.content = signature;
}

byId('retry-run-highlights').addEventListener('click', () => { void loadRunHighlights(); });
byId('apply-run-highlights').addEventListener('click', () => {
  if (runHighlightsState.pending === null) return;
  runHighlightsState.data = runHighlightsState.pending.highlights; runHighlightsState.pending = null;
  renderRunHighlights(selectedRun()); renderLinkedDecisions();
});

function renderConfirmations(run, view) {
  const section = byId('confirmations');
  section.hidden = !run || (view.known && !view.pending.length && !view.history.length && !(resultsState.data ?? []).some(person => person.receipts.some(receipt => receipt.attention === 'decision')));
  text('decisions-heading-label', '待回答事项');
  text('decisions-count', view.decisions === null ? '未知' : view.decisions + ' 项');
  byId('decisions-count').hidden = view.decisions === 0;
  text('decisions-status', view.message); byId('decisions-status').hidden = false;
  const list = byId('decision-list');
  updatePreviewList(list, view.pending, 'decision', decisionRow);
  byId('decisions-content').hidden = !view.pending.length;
  const history = byId('confirmation-history-list');
  const signature = JSON.stringify([view.history, resultsState.data?.flatMap(person => person.receipts.filter(receipt => receipt.attention === 'decision'))]);
  if (history.dataset.content !== signature) {
    history.replaceChildren(...view.history.map(decisionRow));
    const known = new Set(view.linked.map(item => item.id));
    for (const person of resultsState.data ?? []) for (const receipt of person.receipts) if (receipt.attention === 'decision' && !known.has(receipt.decisionId)) {
      const item = node('li', 'result-receipt'); item.append(node('strong', '', person.name), node('p', '', '历史收据，当前关联待核对'), receiptView(receipt, run)); history.append(item);
    }
    history.dataset.content = signature;
  }
  byId('confirmation-history').hidden = !history.children.length;
  text('run-confirmation-note', view.message);
  byId('run-confirmation-note').hidden = view.decisions !== 0;
  byId('show-run-decisions').hidden = view.decisions === 0;
  text('run-result-decisions', view.decisions === null ? '未知' : view.decisions + ' 项');
  byId('retry-decisions').hidden = view.known;
}

function renderRunResults(run) {
  const state = resultsState, stale = workspaceBlocked || disconnected || snapshot?.sources.runs.status !== 'ok' || snapshot?.sources.runs.stale === true;
  byId('run-result-summary').hidden = !run; byId('run-results').hidden = !run || !state.open;
  renderConfirmations(run, confirmationView(run));
  text('run-summary-state', run ? triggerLabel(run.trigger) + ' · ' + runSummaryLabel(run) : '任务尚未读取。');
  text('run-closing-summary', run?.closingSummary ?? ''); byId('run-closing-summary').hidden = !run?.closingSummary;
  const people = mergedRunPeople();
  text('run-result-total', state.status === 'ready' && runHighlightsState.status === 'ready' ? people.length + ' 人' : run?.resultSummary == null ? '未记录' : run.resultSummary.total + ' 人');
  byId('show-run-results').setAttribute('aria-expanded', String(state.open));
  byId('show-run-decisions').setAttribute('aria-expanded', String(!byId('confirmations').hidden));
  byId('result-stale-note').hidden = !stale || !run;
  text('result-stale-note', '读取中断，以下保留上次成功读取的记录。');
  if (!run) return;
  text('run-results-heading', '人选处理结果');
  if (state.open) {
    const message = state.status === 'error' ? '处理记录读取失败：' + state.error + '。' + (state.data !== undefined ? '以下保留上次成功读取的记录。' : '请重试。') : state.status === 'loading' ? '正在读取处理记录…' : state.data === null ? '此任务尚未记录逐人处理经过。' : '';
    text('results-status', message); byId('results-status').hidden = !message;
    byId('retry-results').hidden = state.status !== 'error';
    byId('result-list').hidden = !Array.isArray(state.data) && !runHighlightsState.data?.some(item => runHighlightCandidate(item));
    renderResultList(run); renderRunHighlights(run); renderLinkedDecisions();
  }
  if (!stale && byId('execution-records').open && state.open && state.requestedVersion !== resultVersion(run)) void loadRunResults();
}

function openRunResults(filter) {
  if (!selectedRun()) return;
  if (candidateOrigin?.source === 'results') closeCandidate();
  byId('execution-records').open = true;
  setWorkspaceNavTarget('tasks'); resultsState.open = true; resultsState.filter = 'all';
  applyWorkspaceUpdates(); renderRunResults(selectedRun());
  focusWorkbenchTarget(byId(filter === 'decision' ? 'decisions-heading' : 'run-results-heading'), 'start');
}

function runObjectLabel(run) {
  if (run.role) return run.role;
  const linked = [...(overviewState.data?.highlights ?? []).filter(item => item.runId === run.id || item.sourceRunIds?.includes(run.id)), ...(overviewState.data?.decisions ?? []).filter(item => item.sources.some(source => source.runId === run.id))];
  const subjects = linked.flatMap(itemSubjects), people = [...new Set(subjects.map(subject => subject.name).filter(Boolean))], roles = [...new Set(subjects.map(subject => subject.role).filter(Boolean))];
  if (people.length === 1) return people[0];
  return roles.length === 1 ? roles[0] : roles.length > 1 ? `已记录 ${roles.length} 个岗位` : '';
}

function renderRuns() {
  const runs = snapshot.runs === null ? null : [...snapshot.runs].sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id));
  const hold = Boolean(overviewReading() || byId('candidate-query').value.trim() || (activeView === 'roles' && (byId('role-query').value.trim() || byId('role-search-disclosure').open || !byId('following-picker').hidden)) || (activeView === 'tasks' && (resultsState.open || byId('steps-detail').open)));
  const choice = selectTask(runs, taskSelection, hold);
  if (hold && taskSelection.mode === 'live' && taskSelection.runId && choice.newerRunId) choice.selection = { mode: 'pinned', runId: taskSelection.runId };
  taskSelection = choice.selection;
  const run = choice.run, selectedRunId = taskSelection.runId;
  const labels = (runs ?? []).map(value => [value.label, shortTime(value.createdAt), runObjectLabel(value)].filter(Boolean).join(' · '));
  const totals = new Map(), seen = new Map();
  for (const label of labels) totals.set(label, (totals.get(label) ?? 0) + 1);
  const values = (runs ?? []).map((value, index) => {
    const label = labels[index], ordinal = (seen.get(label) ?? 0) + 1;
    seen.set(label, ordinal);
    return [value.id, `${label}${totals.get(label) > 1 ? ` · 第 ${ordinal} 次` : ''}`];
  });
  if (selectedRunId && !run) values.unshift([selectedRunId, runs === null ? '所选任务暂不可读' : '所选任务记录已移除']);
  if (!values.length) values.push(['', runs === null ? '进度读取失败' : '尚无任务进度记录']);
  options(runSelect, values, selectedRunId ?? ''); runSelect.disabled = !runs?.length;
  for (const [id, mode] of [['follow-live', 'live'], ['pin-run', 'pinned']]) if (byId(id).getAttribute('aria-pressed') !== String(taskSelection.mode === mode)) byId(id).setAttribute('aria-pressed', String(taskSelection.mode === mode));
  byId('latest-run').hidden = taskSelection.mode === 'live' && !choice.newerRunId;
  const notice = [selectionMessage, choice.newerRunId ? '新任务可查看；当前记录保持选定。' : taskSelection.mode === 'pinned' ? '已固定所选任务，自动读取该任务的更新。' : document.hidden ? '后台低频读取；返回后恢复跟随。' : '自动跟随最新创建的任务。'].filter(Boolean).join(' ');
  text('selection-note', notice); byId('selection-note').hidden = false; writeTaskURL();
  if (resultsState.runId !== selectedRunId) { if (candidateOrigin?.source !== 'search') closeCandidate(); resetRunResults(selectedRunId); resetRunHighlights(selectedRunId); byId('steps-detail').open = false; }
  const transition = run ? JSON.stringify([run.status, run.steps.map(step => [step.id, step.status]), run.resultSummary?.revision ?? 0]) : null;
  if (run && displayedRun?.id === run.id && displayedRun.signature !== transition) flash(byId('task-card'));
  displayedRun = run ? { id: run.id, signature: transition } : null;
  renderRunResults(run);
  renderRunHighlights(run);
  if (byId('execution-records').open && run && (runHighlightsState.status === 'idle' || (runHighlightsState.status === 'ready' && run.highlightsRevision !== undefined && runHighlightsState.revision !== run.highlightsRevision))) void loadRunHighlights();
  text('run-id', run?.id ?? selectedRunId ?? '—'); text('run-owner', run?.ownerSessionId ?? '未绑定');
  byId('progress-area').hidden = !run; byId('workflow-name').hidden = !run;
  text('execution-reason', run?.reason ?? '');
  byId('execution-reason').hidden = !run?.reason || !['completed', 'cancelled'].includes(run.status);
  text('run-time', run ? `最后记录 ${time(run.updatedAt)}${snapshot.sources.runs.status === 'stale' ? ' · 陈旧记录' : ''}` : '任务更新时间未知');
  text('task-recorded', `最后记录 · ${run ? time(run.updatedAt) : '未知'}`);
  const sourceStale = snapshot.sources.runs.status === 'stale' || snapshot.sources.runs.stale === true;
  text('task-sync', disconnected ? '连接断开 · 保留记录' : document.hidden ? '后台低频读取' : sourceStale ? '任务源陈旧 · 保留记录' : snapshot.sources.runs.status === 'ok' ? '任务文件读取正常' : snapshot.sources.runs.status === 'missing' ? '尚无任务文件' : '任务源读取异常');
  const syncing = String(Boolean(run?.status === 'running' && taskSelection.mode === 'live' && !disconnected && !sourceStale && snapshot.sources.runs.status === 'ok' && !document.hidden && pageActive));
  if (byId('task-card').dataset.syncing !== syncing) byId('task-card').dataset.syncing = syncing;
  const status = byId('run-state');
  text('task-heading', choice.newerRunId || taskSelection.mode === 'pinned' ? '所选任务' : '最近任务');
  byId('task-card').dataset.state = run?.status ?? (runs === null ? 'error' : 'missing');
  byId('task-recorded').hidden = !run || ['completed', 'cancelled'].includes(run.status);
  byId('current-step').hidden = Boolean(run && ['completed', 'cancelled'].includes(run.status));
  if (!run) {
    const missing = selectedRunId !== null && runs !== null;
    text('run-state', runs === null ? '读取失败' : missing ? '记录已移除' : '无记录'); status.dataset.state = runs === null ? 'error' : 'missing';
    text('task-position', '工作区记录');
    text('current-step', runs === null ? '任务状态未知' : missing ? '所选记录已移除' : '尚无任务进度记录');
    text('task-reason', runs === null ? '无法读取任务进度，恢复后继续同步。' : missing ? '可在执行记录中选择其他任务。' : '工作流开始记录后会在这里显示步骤。');
    byId('task-reason').hidden = false;
    text('run-context', byId('task-reason').textContent); return;
  }
  text('run-state', RUN_LABELS[run.status]); status.dataset.state = run.status;
  text('workflow-name', `${run.label}${run.role ? ` · ${run.role}` : ''}`);
  text('run-context', run.ownerSessionId ? '工作区任务，已记录绑定会话；当前网页未核验会话归属。' : '工作区记录，尚未绑定当前会话。');
  const current = run.steps.find(step => step.status === 'running') ?? (run.status === 'failed' ? run.steps.find(step => step.status === 'failed') : null);
  const completed = run.steps.filter(step => step.status === 'completed').length, skipped = run.steps.filter(step => step.status === 'skipped').length;
  text('task-position', current ? `${run.status === 'waiting' ? '停留步骤' : run.status === 'running' ? '当前步骤' : '最后步骤'} ${run.steps.indexOf(current) + 1} / ${run.steps.length}` : `共 ${run.steps.length} 个步骤`);
  text('current-step', current ? `${run.status === 'waiting' ? '停留步骤' : run.status === 'running' ? '当前记录步骤' : '最后记录步骤'}：${current.label}` : run.status === 'completed' ? '任务已完成' : '当前无执行中步骤');
  const reason = run.reason ?? current?.reason ?? { waiting: '任务等待后续处理。', failed: '任务失败，保留最后记录。', cancelled: '任务已取消，保留最后记录。' }[run.status] ?? '';
  text('task-reason', reason); byId('task-reason').hidden = !reason || ['completed', 'cancelled'].includes(run.status);
  text('completion-count', `已完成 ${completed} / ${run.steps.length} · 已跳过 ${skipped}`);
  text('steps-summary', byId('steps-detail').open ? '收起全部步骤' : '查看全部步骤');
  const signature = JSON.stringify([run.id, run.status, run.steps]), track = byId('step-track'), steps = byId('steps');
  if (track.dataset.content === signature) return;
  const sameRun = track.dataset.run === run.id;
  if (!sameRun) { track.replaceChildren(); steps.replaceChildren(); }
  track.dataset.content = signature; track.dataset.run = run.id; track.dataset.runState = run.status; steps.dataset.runState = run.status;
  track.setAttribute('aria-label', `共 ${run.steps.length} 个步骤，已完成 ${completed}，已跳过 ${skipped}；${RUN_LABELS[run.status]}`);
  for (const [index, step] of run.steps.entries()) {
    let segment = track.children[index], item = steps.children[index];
    if (!segment) {
      segment = node('li', 'track-segment'); segment.append(node('span', 'sr-only')); track.append(segment);
      item = node('li', 'step-row step'); const content = node('div'); content.append(node('p', 'step-title'), node('p', 'step-reason'));
      const number = node('span', 'step-index step-number', String(index + 1)); number.setAttribute('aria-hidden', 'true');
      item.append(number, content, node('span', 'step-state')); steps.append(item);
    }
    if (sameRun && segment.dataset.state !== step.status) flash(item);
    segment.dataset.state = step.status; segment.title = `${index + 1}. ${step.label} · ${stepLabel(step, run)}`; segment.firstElementChild.textContent = segment.title;
    item.dataset.state = step.status;
    if (step.status === 'running') item.setAttribute('aria-current', 'step'); else item.removeAttribute('aria-current');
    item.querySelector('.step-title').textContent = step.label; item.querySelector('.step-reason').textContent = step.reason ?? '';
    item.querySelector('.step-reason').hidden = !step.reason; item.querySelector('.step-state').textContent = stepLabel(step, run);
  }
}

function renderStages(announce = false, view = currentRoleView()) {
  text('candidate-total-summary', view.total === null ? '· 记录数未知' : `· ${view.total} 条`);
  text('stage-scope', `当前范围：${view.label}`);
  const ledgerSource = snapshot.sources.ledger.status;
  text('ledger-state', ledgerSource === 'stale' ? '以下保留上次候选记录（陈旧）。' : view.total === null ? view.selectionMissing ? '所选岗位未在当前源中，记录数未知。' : '台账尚未成功读取，记录数未知。' : `台账更新 ${time(snapshot.ledgerUpdatedAt)} · ${view.label}`);
  const unclassified = view.stages.find(stage => stage.id === 'unclassified').count;
  const notes = unclassified > 0 ? [`含 ${unclassified} 条未归类候选记录，保留原状态。`] : [];
  if (view.total === null) notes.unshift(view.selectionMissing ? '所选岗位已不在当前源中，候选记录数未知。' : '候选记录数未知，等待成功读取台账。');
  else if (view.total === 0) notes.unshift(rolePreferences.role ? '这个岗位还没有候选记录。' : '当前岗位范围没有候选记录。');
  const noteSignature = JSON.stringify(notes);
  if (byId('candidate-notes').dataset.content !== noteSignature) {
    byId('candidate-notes').dataset.content = noteSignature;
    byId('candidate-notes').replaceChildren(...notes.map(message => node('p', '', message)));
  }
  for (const stage of view.stages) {
    const button = stageButtons.get(stage.id);
    const expanded = selectedStage === stage.id;
    text(button.querySelector('.stage-number'), stage.count === null ? '—' : String(stage.count));
    button.dataset.empty = String(stage.count === 0);
    button.setAttribute('aria-expanded', String(expanded));
    button.setAttribute('aria-label', `${stage.label}，${stage.count === null ? '候选记录数未知' : `${stage.count} 条候选记录`}，${expanded ? '收起' : '展开'}名单`);
  }
  const detail = byId('candidate-detail');
  detail.hidden = selectedStage === null;
  byId('show-all-stage-candidates').setAttribute('aria-pressed', String(selectedStage === 'all'));
  if (selectedStage !== null) {
    const stage = selectedStage === 'all' ? { label: '全部阶段', count: view.total } : view.stages.find(stage => stage.id === selectedStage);
    const members = activityOrder(view.candidates?.filter(candidate => selectedStage === 'all' || candidate.stage === selectedStage));
    const shown = members?.slice(0, candidateStageLimit) ?? [];
    text('detail-title', stage.label);
    text('detail-count', stage.count === null ? '记录数未知' : `${stage.count} 条候选记录${members.length > shown.length ? ` · 已显示 ${shown.length} 条` : ''}`);
    byId('show-more-stage-candidates').hidden = !members || shown.length === members.length;
    const signature = JSON.stringify([rolePreferences.scope, rolePreferences.following, rolePreferences.role, selectedStage, stage.count, shown, shown.map(candidate => candidateActivityMap().get(candidate.id) ?? null)]);
    const list = byId('candidate-list');
    if (list.dataset.content !== signature) {
      list.dataset.content = signature;
      const focused = list.contains(document.activeElement) ? document.activeElement : null;
      const focusedId = focused?.closest?.('[data-candidate]')?.dataset.candidate ?? null;
      const prevStop = candidateRoving.stage.inst?.get().tabStop ?? focusedId;
      cleanupCandidateRoving('stage');
      const previous = new Map([...list.children].map(item => [item.dataset.candidate, item]));
      const candidates = shown.map(candidate => candidateListRow(candidate, 'stage', previous.get(candidate.id)));
      if (!candidates.length) candidates.push(node('li', 'empty-state', stage.count === null ? '台账未读取，记录数未知' : selectedStage === 'all' ? '当前岗位范围没有候选记录' : '此阶段暂无候选记录'));
      list.replaceChildren(...candidates);
      bindCandidateRoving('stage', list, prevStop, focusedId);
    }
  }
  if (announce) byId('filter-announcement').textContent = `${view.label}，${view.total === null ? '候选记录数未知' : `共 ${view.total} 条候选记录`}；工作区任务保持选定。`;
}

function render() {
  text('workspace', snapshot.workspace);
  text('nav-workspace', snapshot.workspace);
  syncLayoutPreferences();
  syncRolePreferences();
  const view = renderRoleControls();
  const ordinaryCodes = ['UNKNOWN_STATUS', 'DUPLICATE_KEY', 'ROLE_ALIAS_COLLISION'];
  const messages = snapshot.diagnostics.filter(item => !ordinaryCodes.includes(item.code)).map(item => item.message);
  if (snapshot.status === 'stale') messages.unshift('数据读取失败，以下保留上次成功记录（陈旧）。');
  if (disconnected) messages.unshift('连接已断开，以下是最后成功读取的数据。');
  const alerts = byId('alerts');
  const messageSignature = JSON.stringify(messages);
  alerts.hidden = messages.length === 0;
  alerts.dataset.state = disconnected || snapshot.status === 'error' || snapshot.status === 'stale' || snapshot.diagnostics.some(item => item.level === 'error') ? 'error' : 'warning';
  if (alerts.dataset.content !== messageSignature) {
    alerts.dataset.content = messageSignature;
    alerts.replaceChildren(...messages.map(message => node('p', '', message)));
  }
  const sync = byId('sync');
  text('sync', disconnected ? '连接断开' : document.hidden ? '后台低频读取' : { ok: '读取正常', partial: '有读取提示', error: '读取失败', stale: '数据源陈旧' }[snapshot.status]);
  const refreshLabel = disconnected ? '重新连接' : '刷新';
  refreshButton.setAttribute('aria-label', refreshLabel); refreshButton.title = refreshLabel;
  sync.dataset.state = disconnected || ['error', 'stale'].includes(snapshot.status) ? 'error' : snapshot.status === 'partial' ? 'warning' : 'ok';
  byId('source-dot').dataset.state = sync.dataset.state;
  text('source-status', disconnected ? '本地文件 · 连接断开' : snapshot.status === 'stale' ? '本地文件 · 数据陈旧' : snapshot.status === 'error' ? '本地文件 · 读取失败' : snapshot.status === 'partial' ? '本地文件 · 有读取提示' : '本地台账 · 候选资料只读');
  text('updated', `最近读取 ${time(snapshot.generatedAt)}`);
  const diagnostics = byId('source-diagnostics');
  const config = snapshot.sources.config ?? { status: 'missing', updatedAt: null };
  const configLabel = { ok: '已加载', missing: '未配置，使用标准映射', error: '读取或校验失败', stale: '陈旧，保留上次记录' }[config.status];
  const diagnosticSignature = JSON.stringify([snapshot.diagnostics, config]);
  if (diagnostics.dataset.content !== diagnosticSignature) {
    diagnostics.dataset.content = diagnosticSignature;
    diagnostics.replaceChildren(node('p', '', `兼容配置：${configLabel}${config.updatedAt ? ` · ${time(config.updatedAt)}` : ''}`), ...snapshot.diagnostics.map(item => node('p', '', item.message)), node('p', '', '按姓名＋原岗位计数，同人不同原岗位不自动合并。'));
  }
  renderRuns(); renderStages(false, view); renderCandidateSearch();
  renderWorkspaceTasks(); renderWorkspaceOverview(); renderLinkedDecisions();
  if (paletteState.open) renderCommandPalette();
}

function scoreFuzzyTokens(searchText, query) {
  const trimmed = String(query ?? '').trim();
  if (!trimmed) return 0;
  const tokens = trimmed.split(/\s+/).filter(Boolean);
  if (!tokens.length) return 0;
  if (tokens.length === 1) {
    const score = fuzzyScore(searchText, tokens[0]);
    return score > 0 ? score : null;
  }
  let total = 0;
  for (const tok of tokens) {
    const score = fuzzyScore(searchText, tok);
    if (!(score > 0)) return null;
    total += score;
  }
  const whole = fuzzyScore(searchText, trimmed);
  if (whole > 0) total += whole;
  return total;
}

function mergeMatchRanges(ranges) {
  if (ranges.length <= 1) return ranges;
  const sorted = [...ranges].sort((a, b) => a.start - b.start || a.end - b.end);
  const merged = [{ start: sorted[0].start, end: sorted[0].end }];
  for (let i = 1; i < sorted.length; i++) {
    const prev = merged[merged.length - 1], next = sorted[i];
    if (next.start <= prev.end) prev.end = Math.max(prev.end, next.end);
    else merged.push({ start: next.start, end: next.end });
  }
  return merged;
}

function clipMatchRanges(ranges, offset, length) {
  const out = [];
  for (const { start, end } of ranges) {
    const s = Math.max(start, offset) - offset, e = Math.min(end, offset + length) - offset;
    if (e > s) out.push({ start: s, end: e });
  }
  return out;
}

function renderMatchedSegments(textValue, ranges, container = document.createDocumentFragment()) {
  for (const seg of matchSegments(textValue, ranges)) {
    container.append(seg.match ? node('mark', 'palette-match', seg.text) : document.createTextNode(seg.text));
  }
  return container;
}

function highlightFuzzyNode(labelText, query) {
  const span = node('span');
  if (!labelText) return span;
  const tokens = String(query ?? '').trim().split(/\s+/).filter(Boolean);
  if (!tokens.length) { span.textContent = labelText; return span; }
  const ranges = mergeMatchRanges(tokens.flatMap(tok => matchRanges(labelText, tok, 'fuzzy')));
  return renderMatchedSegments(labelText, ranges, span);
}

function highlightFuzzyPair(title, subtitle, query) {
  const tokens = String(query ?? '').trim().split(/\s+/).filter(Boolean);
  const titleEl = node('strong', 'command-palette-title'), subEl = node('span', 'command-palette-subtitle');
  if (!tokens.length || !subtitle) {
    titleEl.append(highlightFuzzyNode(title, query));
    if (subtitle) subEl.textContent = subtitle;
    return { titleEl, subEl };
  }
  const titleRanges = [], subRanges = [];
  const combined = `${title} ${subtitle}`;
  for (const tok of tokens) {
    const rt = matchRanges(title, tok, 'fuzzy');
    const rs = matchRanges(subtitle, tok, 'fuzzy');
    if (rt.length || rs.length) {
      titleRanges.push(...rt);
      subRanges.push(...rs);
    } else {
      const rc = matchRanges(combined, tok, 'fuzzy');
      titleRanges.push(...clipMatchRanges(rc, 0, title.length));
      subRanges.push(...clipMatchRanges(rc, title.length + 1, subtitle.length));
    }
  }
  renderMatchedSegments(title, mergeMatchRanges(titleRanges), titleEl);
  renderMatchedSegments(subtitle, mergeMatchRanges(subRanges), subEl);
  return { titleEl, subEl };
}

function openWorkspaceRole(name) {
  if (drawerState.page) closeWorkspaceDrawer(false);
  if (byId('candidate-query').value) clearCandidateSearch(false);
  if (candidateOrigin?.source === 'stage') closeCandidate();
  rolePreferences.scope = 'all'; rolePreferences.role = name; roleRangeMessage = '';
  persistRolePreferences();
  if (snapshot) { const view = renderRoleControls(); renderStages(true, view); }
  setWorkspaceNavTarget('roles');
  focusWorkbenchTarget(workspaceNavTargets.roles);
}

function buildPaletteItems() {
  const overview = overviewState.data;
  if (paletteIndexCache.snapshot === snapshot && paletteIndexCache.overview === overview && paletteIndexCache.revision === overview?.revision) return paletteIndexCache.items;
  const items = [];
  const decisions = [...(overview?.decisions ?? [])].sort((a, b) => {
    const rank = item => item.effectiveState === 'open' ? 0 : item.effectiveState === 'history_review' ? 1 : item.effectiveState === 'snoozed' ? 2 : 3;
    return rank(a) - rank(b) || b.updatedAt.localeCompare(a.updatedAt);
  });
  for (const item of decisions) {
    const subjects = itemSubjects(item);
    const stateText = DECISION_STATES[item.effectiveState] ?? item.effectiveState;
    const subjectText = subjects.map(s => [s.name, s.role].filter(Boolean).join(' · ')).filter(Boolean).join(' / ');
    items.push({
      id: `decision:${item.id}`, kind: 'decision', kindLabel: '事项', stateText, badgeState: item.effectiveState,
      priority: item.effectiveState === 'open' ? 0 : item.effectiveState === 'history_review' ? 1 : 2,
      title: item.title,
      subtitle: [subjectText, item.identity?.scope].filter(Boolean).join(' · '),
      searchText: [item.title, ...subjects.flatMap(s => [s.name, s.role, s.rawRole]), stateText, item.reason, item.identity?.scope].filter(Boolean).join(' '),
      run: () => openWorkspaceDecision(item.id)
    });
  }
  for (const candidate of activityOrder(snapshot?.candidates ?? [])) {
    const stageLabel = STAGES.find(stage => stage.id === candidate.stage)?.label ?? '未归类';
    const statusText = candidateStatus(candidate);
    items.push({
      id: `candidate:${candidate.id}`, kind: 'candidate', kindLabel: '候选人档案', stateText: stageLabel, badgeState: null,
      priority: 4,
      title: candidate.name,
      subtitle: [candidate.role, candidate.rawRole !== candidate.role ? `原岗位：${candidate.rawRole}` : '', statusText, candidate.location, candidate.background].filter(Boolean).join(' · '),
      searchText: [candidate.name, candidate.role, candidate.rawRole, statusText, stageLabel, candidate.location, candidate.background].filter(Boolean).join(' '),
      run: trigger => { void openCandidate(candidate, 'palette', trigger); }
    });
  }
  for (const role of snapshot?.roles ?? []) {
    const statusText = role.status || '状态待确认';
    items.push({
      id: `role:${role.name}`, kind: 'role', kindLabel: '岗位', stateText: statusText, badgeState: null,
      priority: 5,
      title: role.name,
      subtitle: [statusText, role.priority ? `优先级 ${role.priority}` : ''].filter(Boolean).join(' · '),
      searchText: [role.name, statusText, role.priority].filter(Boolean).join(' '),
      run: () => openWorkspaceRole(role.name)
    });
  }
  const runs = [...(snapshot?.runs ?? [])].sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id));
  for (const run of runs) {
    const stateText = RUN_LABELS[run.status] ?? run.status;
    const obj = runObjectLabel(run);
    items.push({
      id: `run:${run.id}`, kind: 'run', kindLabel: '执行记录', stateText, badgeState: run.status,
      priority: 6,
      title: [run.label, shortTime(run.createdAt), obj].filter(Boolean).join(' · '),
      subtitle: [run.role, run.id].filter(Boolean).join(' · '),
      searchText: [run.label, run.id, run.role, stateText, obj].filter(Boolean).join(' '),
      run: () => openWorkspaceRun(run.id)
    });
  }
  paletteIndexCache = { snapshot, overview, revision: overview?.revision, items };
  return items;
}

function rankPaletteItems(items, query, limit = 16) {
  const trimmed = String(query ?? '').trim();
  if (!trimmed) return items.slice(0, limit).map(item => ({ item, score: 0 }));
  const scored = [];
  for (let order = 0; order < items.length; order++) {
    const item = items[order];
    const score = scoreFuzzyTokens(item.searchText, trimmed);
    if (score !== null) scored.push({ item, score, titleScore: fuzzyScore(item.title, trimmed), order });
  }
  scored.sort((a, b) => (b.score - a.score) || (b.titleScore - a.titleScore) || (a.item.priority - b.item.priority) || (a.order - b.order));
  return scored.slice(0, limit).map(({ item, score }) => ({ item, score }));
}

function updatePaletteSelection() {
  const input = byId('command-palette-input'), list = byId('command-palette-list');
  const options = [...list.querySelectorAll('[role="option"]')];
  if (!options.length) { input.removeAttribute('aria-activedescendant'); return; }
  const idx = Math.max(0, Math.min(paletteState.activeIndex, options.length - 1));
  paletteState.activeIndex = idx;
  for (let i = 0; i < options.length; i++) options[i].setAttribute('aria-selected', String(i === idx));
  const activeEl = options[idx];
  input.setAttribute('aria-activedescendant', activeEl.id);
  activeEl.scrollIntoView?.({ block: 'nearest' });
}

function setPaletteSelection(index) {
  if (!paletteState.results.length) return;
  paletteState.activeIndex = Math.max(0, Math.min(index, paletteState.results.length - 1));
  updatePaletteSelection();
}

function movePaletteSelection(delta) {
  if (!paletteState.results.length) return;
  const count = paletteState.results.length;
  paletteState.activeIndex = (paletteState.activeIndex + delta + count) % count;
  updatePaletteSelection();
}

function executePaletteSelection(index = paletteState.activeIndex) {
  const entry = paletteState.results[index];
  if (!entry) return;
  const trigger = paletteState.returnFocus;
  closeCommandPalette({ restoreFocus: false });
  entry.item.run(trigger);
}

function renderCommandPalette() {
  const items = buildPaletteItems();
  const ranked = rankPaletteItems(items, paletteState.query);
  paletteState.results = ranked;
  if (paletteState.activeIndex >= ranked.length) paletteState.activeIndex = 0;
  const list = byId('command-palette-list');
  const trimmed = paletteState.query.trim();
  text('command-palette-status', trimmed ? `找到 ${ranked.length} 条匹配结果` : `共 ${items.length} 条工作区记录 · 显示前 ${ranked.length} 条`);
  if (!ranked.length) {
    list.replaceChildren(node('li', 'empty-state', items.length ? '未找到匹配结果，请尝试姓名、岗位或事项关键词。' : '正在等待工作区数据读取…'));
    updatePaletteSelection();
    return;
  }
  const rows = ranked.map(({ item }, index) => {
    const li = node('li', 'command-palette-item'); li.setAttribute('role', 'presentation');
    const option = node('button', 'command-palette-option'); option.type = 'button'; option.id = `command-palette-option-${index}`;
    option.setAttribute('role', 'option'); option.setAttribute('aria-selected', String(index === paletteState.activeIndex));
    option.dataset.paletteKind = item.kind;
    const copy = node('span', 'command-palette-copy');
    const { titleEl, subEl } = highlightFuzzyPair(item.title, item.subtitle, paletteState.query);
    copy.append(titleEl);
    if (item.subtitle) copy.append(subEl);
    const badges = node('span', 'command-palette-badges');
    badges.append(node('span', 'command-palette-badge', item.kindLabel));
    if (item.stateText) {
      const statePill = node('span', 'workspace-preview-state', item.stateText);
      if (item.badgeState) statePill.dataset.state = item.badgeState;
      badges.append(statePill);
    }
    option.append(copy, badges);
    option.addEventListener('click', () => executePaletteSelection(index));
    li.append(option);
    return li;
  });
  list.replaceChildren(...rows);
  updatePaletteSelection();
}

function openCommandPalette(trigger = document.activeElement) {
  if (paletteState.open) { byId('command-palette-input').focus({ preventScroll: true }); return; }
  paletteState.open = true; paletteState.query = ''; paletteState.activeIndex = 0; paletteState.composing = false;
  paletteState.returnFocus = trigger && trigger.isConnected ? trigger : document.activeElement;
  byId('open-command-palette').setAttribute('aria-expanded', 'true');
  const dialog = byId('command-palette'), input = byId('command-palette-input');
  input.value = '';
  if (typeof dialog.showModal === 'function') dialog.showModal();
  else { dialog.setAttribute('open', ''); byId('command-palette-backdrop').hidden = false; }
  paletteLayerCleanup?.();
  paletteLayerCleanup = bindLayer(dialog, {
    onDismiss: (reason, event) => {
      if (reason === 'escape-key' || reason === 'outside-press') {
        event?.preventDefault?.(); event?.stopPropagation?.();
        closeCommandPalette({ restoreFocus: true });
      }
    }
  });
  renderCommandPalette();
  input.focus({ preventScroll: true });
}

function closeCommandPalette({ restoreFocus = true } = {}) {
  if (!paletteState.open) return;
  paletteState.open = false; paletteState.composing = false; paletteState.query = '';
  paletteLayerCleanup?.(); paletteLayerCleanup = null;
  byId('open-command-palette').setAttribute('aria-expanded', 'false');
  const dialog = byId('command-palette');
  if (dialog.open && typeof dialog.close === 'function') dialog.close();
  else dialog.removeAttribute('open');
  byId('command-palette-backdrop').hidden = true;
  if (restoreFocus) {
    const target = paletteState.returnFocus;
    if (target?.isConnected && visibleWorkbenchTarget(target)) target.focus({ preventScroll: true });
    else if (drawerState.page) byId('workspace-drawer-title').focus({ preventScroll: true });
    else byId('open-command-palette').focus({ preventScroll: true });
  }
  paletteState.returnFocus = null;
  renderOverviewReadingNotice();
}

const toggleCommandPalette = () => {
  if (paletteState.open) closeCommandPalette({ restoreFocus: true });
  else openCommandPalette(document.activeElement);
};
text('command-palette-shortcut', formatShortcut('Mod+K'));
byId('open-command-palette').setAttribute('aria-keyshortcuts', ariaKeyshortcuts('Mod+K'));
byId('open-command-palette').addEventListener('click', event => openCommandPalette(event.currentTarget));
byId('command-palette-close').addEventListener('click', () => closeCommandPalette({ restoreFocus: true }));
byId('command-palette-backdrop').addEventListener('click', () => closeCommandPalette({ restoreFocus: true }));
byId('command-palette').addEventListener('cancel', event => { event.preventDefault(); closeCommandPalette({ restoreFocus: true }); });
byId('command-palette').addEventListener('close', () => { if (paletteState.open) closeCommandPalette({ restoreFocus: true }); });
byId('command-palette').addEventListener('keydown', event => {
  if (event.key !== 'Tab') return;
  const focusables = [byId('command-palette-input'), byId('command-palette-close')];
  const active = document.activeElement;
  event.preventDefault();
  focusables[active === focusables[0] ? 1 : 0].focus({ preventScroll: true });
});
byId('command-palette-input').addEventListener('compositionstart', () => { paletteState.composing = true; });
byId('command-palette-input').addEventListener('compositionend', event => {
  paletteState.composing = false;
  paletteState.query = event.currentTarget.value;
  paletteState.activeIndex = 0;
  renderCommandPalette();
});
byId('command-palette-input').addEventListener('input', event => {
  paletteState.query = event.currentTarget.value;
  paletteState.activeIndex = 0;
  renderCommandPalette();
});
byId('command-palette-input').addEventListener('keydown', event => {
  if (event.isComposing || event.keyCode === 229 || paletteState.composing) return;
  if (event.key === 'ArrowDown') { event.preventDefault(); movePaletteSelection(1); }
  else if (event.key === 'ArrowUp') { event.preventDefault(); movePaletteSelection(-1); }
  else if (event.key === 'Home') { event.preventDefault(); setPaletteSelection(0); }
  else if (event.key === 'End') { event.preventDefault(); setPaletteSelection(paletteState.results.length - 1); }
  else if (event.key === 'Enter') { event.preventDefault(); executePaletteSelection(); }
});
const modShortcut = ariaKeyshortcuts('Mod+K');
const altShortcut = modShortcut === 'Meta+K' ? 'Control+K' : 'Meta+K';
registerShortcut('Mod+K', toggleCommandPalette, { allowInInput: true, description: '打开快速跳转' });
registerShortcut(altShortcut, toggleCommandPalette, { allowInInput: true, description: '打开快速跳转' });
document.addEventListener('keydown', event => {
  if (event.defaultPrevented || event.isComposing || event.keyCode === 229) return;
  if (matchesShortcut(event, modShortcut) || matchesShortcut(event, altShortcut)) {
    event.preventDefault();
    toggleCommandPalette();
  }
});

for (const scope of ROLE_SCOPES) {
  const button = node('button', '', scope.label); button.type = 'button'; button.dataset.scope = scope.id;
  button.setAttribute('aria-pressed', String(scope.id === rolePreferences.scope));
  button.addEventListener('click', () => {
    if (rolePreferences.scope === scope.id) return;
    if (candidateOrigin?.source === 'stage') closeCandidate();
    const previousRole = rolePreferences.role;
    const available = snapshot ? selectRoles(snapshot, { scope: scope.id, following: rolePreferences.following }).roles : [];
    rolePreferences.scope = scope.id;
    roleRangeMessage = '';
    if (previousRole && !available.some(role => role.name === previousRole)) {
      rolePreferences.role = '';
      roleRangeMessage = `“${previousRole}”不在${scope.label}范围，已显示${scope.label}汇总。`;
    }
    byId('unknown-roles').hidden = true;
    persistRolePreferences();
    if (snapshot) { const view = renderRoleControls(); renderStages(true, view); }
  });
  byId('role-scopes').append(button);
}
byId('unknown-roles-link').addEventListener('click', () => {
  if (candidateOrigin?.source === 'stage') closeCandidate();
  rolePreferences.scope = 'all'; rolePreferences.role = ''; roleRangeMessage = '';
  byId('role-query').value = ''; byId('unknown-roles').hidden = false;
  persistRolePreferences(); renderRoleControls(); renderStages(true);
  focusWorkbenchTarget(byId('unknown-roles'), 'nearest');
});
byId('close-unknown-roles').addEventListener('click', () => {
  byId('unknown-roles').hidden = true; byId('unknown-roles-link').focus({ preventScroll: true });
});
byId('candidate-query').addEventListener('input', changeCandidateSearch);
byId('candidate-query').addEventListener('keydown', event => {
  if (event.key === 'Escape' && !event.isComposing && event.keyCode !== 229) { event.preventDefault(); clearCandidateSearch(); }
});
byId('clear-candidate-search').addEventListener('click', clearCandidateSearch);
byId('show-more-candidates').addEventListener('click', () => {
  const firstNew = activityOrder(searchCandidates(snapshot, byId('candidate-query').value))?.[candidateSearchLimit]?.id;
  candidateSearchLimit += 20;
  renderCandidateSearch();
  [...byId('candidate-search-list').querySelectorAll('button')].find(button => button.dataset.candidate === firstNew)?.focus({ preventScroll: true });
});
byId('role-query').addEventListener('input', () => { if (snapshot) { const view = renderRoleControls(); renderStages(false, view); } });
byId('role-search-disclosure').addEventListener('toggle', () => {
  byId('role-search-disclosure').querySelector('summary').setAttribute('aria-expanded', String(byId('role-search-disclosure').open));
});
byId('clear-role-search').addEventListener('click', () => {
  byId('role-query').value = '';
  if (snapshot) { const view = renderRoleControls(); renderStages(false, view); }
  (byId('role-search-disclosure').open ? byId('role-query') : byId('role-search-disclosure').querySelector('summary')).focus({ preventScroll: true });
});
byId('view-decisions-records').addEventListener('click', () => openRunResults('decision'));

for (const id of ['choose-following', 'workspace-choose-following']) byId(id).addEventListener('click', event => toggleFollowingPicker(event.currentTarget));
byId('following-query').addEventListener('input', () => { if (snapshot) renderFollowingPicker(); });
byId('finish-following').addEventListener('click', () => closeWorkspaceDrawer());
byId('show-run-results').addEventListener('click', () => openRunResults('all'));
byId('show-run-decisions').addEventListener('click', () => openRunResults('decision'));
byId('collapse-results').addEventListener('click', () => {
  if (candidateOrigin?.source === 'results') closeCandidate();
  resultsState.open = false; renderRunResults(selectedRun()); byId('show-run-results').focus({ preventScroll: true });
});
byId('retry-results').addEventListener('click', () => { void loadRunResults(); });
byId('retry-decisions').addEventListener('click', () => { void overviewController.refresh({ invalidate: true }); });

byId('execution-records').addEventListener('toggle', () => {
  if (!byId('execution-records').open) {
    if (['results', 'activity', 'decisions'].includes(candidateOrigin?.source)) closeCandidate();
    resultsState.open = false; byId('steps-detail').open = false;
  }
  if (snapshot && !workspaceBlocked) {
    renderRunResults(selectedRun());
    if (byId('execution-records').open) void loadRunHighlights();
  }
});
byId('candidate-stages').addEventListener('toggle', () => {
  if (byId('candidate-stages').open) return;
  if (candidateOrigin?.source === 'stage') closeCandidate();
  selectedStage = null;
  if (snapshot) renderStages();
});
byId('manage-roles').addEventListener('click', () => { if (byId('role-manager').hidden) void openRoleManager(); else closeRoleManager(); });
byId('cancel-role').addEventListener('click', closeRoleManager);
byId('managed-role').addEventListener('change', updateManagedStatus);
byId('role-manager').addEventListener('submit', async event => {
  event.preventDefault();
  if (!roleInfo || !csrfToken || byId('save-role').disabled) return;
  const pending = roleRequest;
  const role = byId('managed-role').value, status = byId('managed-status').value;
  byId('save-role').disabled = true; byId('cancel-role').disabled = true; byId('manage-roles').disabled = true;
  byId('managed-role').disabled = true; byId('managed-status').disabled = true;
  byId('role-result').textContent = '正在保存…';
  try {
    const result = await jsonRequest('/api/roles/status', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken }, body: JSON.stringify({ role, status, revision: roleInfo.contextRevision }) });
    if (pending !== roleRequest) return;
    roleInfo = { ...roleInfo, ...result }; renderRoleAliases();
    byId('role-result').textContent = result.message;
    await snapshotController.refresh({ invalidate: true });
  } catch (error) {
    if (pending === roleRequest) {
      byId('role-result').textContent = error.message;
      roleInfo = null;
      const retry = node('button', 'text-button', '重新读取岗位'); retry.type = 'button';
      retry.addEventListener('click', () => { void openRoleManager(); });
      byId('role-result').append(retry);
    }
  } finally {
    byId('manage-roles').disabled = false; byId('managed-role').disabled = false; byId('managed-status').disabled = false;
    if (pending === roleRequest) { byId('save-role').disabled = !roleInfo; byId('cancel-role').disabled = false; }
  }
});
roleSelect.addEventListener('change', () => {
  if (candidateOrigin?.source === 'stage') closeCandidate();
  rolePreferences.role = roleSelect.value; roleRangeMessage = ''; persistRolePreferences();
  if (snapshot) { const view = renderRoleControls(); renderStages(true, view); }
});
function chooseTask(selection, message = '') {
  const changed = taskSelection.runId !== selection.runId || selection.mode === 'live';
  if (changed) { if (candidateOrigin?.source !== 'search') closeCandidate(); resetRunResults(selection.runId); resetRunHighlights(selection.runId); byId('steps-detail').open = false; }
  taskSelection = selection; selectionMessage = message; writeTaskURL();
  if (snapshot) renderRuns();
}
runSelect.addEventListener('change', () => chooseTask({ mode: 'pinned', runId: runSelect.value || null }));
byId('pin-run').addEventListener('click', () => { taskSelection.mode = 'pinned'; selectionMessage = ''; if (snapshot) renderRuns(); runSelect.focus({ preventScroll: true }); });
for (const id of ['follow-live', 'latest-run']) byId(id).addEventListener('click', () => {
  chooseTask({ mode: 'live', runId: null });
  if (id === 'latest-run') byId('follow-live').focus({ preventScroll: true });
});
window.addEventListener('popstate', () => {
  const selection = readTaskURL();
  chooseTask(selection, selectionMessage);
  navigateWorkspace(selection.mode === 'pinned' ? 'tasks' : 'overview');
  renderCandidateSearch();
});
byId('steps-detail').addEventListener('toggle', () => { byId('steps-summary').textContent = byId('steps-detail').open ? '收起全部步骤' : '查看全部步骤'; });
byId('show-all-stage-candidates').addEventListener('click', () => {
  selectedStage = 'all'; candidateStageLimit = 20;
  byId('candidate-stages').open = true;
  if (snapshot) { renderStages(); focusWorkbenchTarget(byId('detail-title'), 'nearest'); }
});
byId('show-more-stage-candidates').addEventListener('click', () => {
  const members = activityOrder(currentRoleView().candidates?.filter(candidate => selectedStage === 'all' || candidate.stage === selectedStage));
  const firstNew = members?.[candidateStageLimit]?.id;
  candidateStageLimit += 20; renderStages();
  [...byId('candidate-list').querySelectorAll('button')].find(button => button.dataset.candidate === firstNew)?.focus({ preventScroll: true });
});
byId('collapse-stage').addEventListener('click', () => {
  if (candidateOrigin?.source === 'stage') closeCandidate();
  const previous = selectedStage;
  selectedStage = null;
  if (snapshot) renderStages();
  (stageButtons.get(previous) ?? byId('show-all-stage-candidates')).focus({ preventScroll: true });
});

const themeButton = byId('theme');
function setTheme(dark) {
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  const label = dark ? '切换浅色主题' : '切换深色主题';
  themeButton.setAttribute('aria-pressed', String(dark));
  themeButton.setAttribute('aria-label', label);
  themeButton.title = label;
}
setTheme(window.matchMedia('(prefers-color-scheme: dark)').matches);
themeButton.addEventListener('click', () => setTheme(document.documentElement.dataset.theme !== 'dark'));

function blockWorkspace() {
  workspaceBlocked = true; snapshotController.suspend(); overviewController.suspend();
  runHighlightsRequest++; runHighlightsAbort?.abort();
  resultsRequest++; recordRequest++; documentRequest++; roleRequest++;
  document.documentElement.dataset.workspaceBlocked = 'true';
  text('sync', '工作区连接已变化'); byId('sync').dataset.state = 'error';
  text('task-sync', '工作区连接已变化'); byId('task-card').dataset.syncing = 'false';
  renderConfirmations(selectedRun(), confirmationView(selectedRun()));
  const alerts = byId('alerts'); alerts.hidden = false; alerts.dataset.state = 'error';
  const reopen = node('a', 'text-button', '重新打开看板'); reopen.href = '/';
  alerts.replaceChildren(node('p', '', initialWorkspace !== null && !/^[a-f0-9]{64}$/i.test(initialWorkspace) ? '工作区链接格式无效，请重新打开看板。' : '服务已指向其他工作区，请重新打开；当前保留上次记录。'), reopen);
  byId('refresh-board').disabled = true; byId('save-role').disabled = true;
  renderCandidateSearch();
  renderWorkspaceFollowing();
  renderWorkspaceTasks(); renderWorkspaceOverview(); renderRunHighlights(selectedRun()); renderLinkedDecisions();
}

const overviewController = createSnapshotController({
  isVisible: () => !document.hidden,
  load: async signal => {
    if (!expectedWorkspaceKey) throw new Error('尚未取得工作区标识，等待连接后读取事项。');
    const key = expectedWorkspaceKey;
    const response = await fetch('/api/workspace/overview', { cache: 'no-store', signal, headers: workspaceHeaders() });
    if (response.status === 409) { blockWorkspace(); throw new Error('服务已指向其他工作区，请重新打开'); }
    if (response.status === 404) throw new Error('本机看板尚未提供工作区事项接口；事项数量未知。');
    const raw = await response.text();
    let payload = null;
    try { payload = raw ? JSON.parse(raw) : null; } catch { payload = null; }
    if (!response.ok) {
      if (payload?.error?.code === 'WORKSPACE_MISMATCH') blockWorkspace();
      throw new Error(payload?.error?.message ?? '工作区事项读取失败，请重试。');
    }
    if (!payload) throw new Error('工作区事项响应格式不兼容');
    if (payload.workspaceKey && payload.workspaceKey !== key) { blockWorkspace(); throw new Error('工作区连接已变化'); }
    if (key !== expectedWorkspaceKey) throw new Error('工作区连接已变化');
    return checkWorkspaceOverview(payload);
  },
  onSnapshot: acceptWorkspaceOverview,
  onError: error => {
    if (workspaceBlocked) return;
    overviewState.status = 'error'; overviewState.error = error.message; overviewState.stale = true;
    renderCandidateOrdering(); renderWorkspaceOverview(); renderLinkedDecisions();
  }
});
byId('retry-workspace-overview').addEventListener('click', () => { void overviewController.refresh({ invalidate: true }); });

const snapshotController = createSnapshotController({
  isVisible: () => !document.hidden,
  load: async signal => {
    const next = await jsonRequest('/api/snapshot', { signal });
    if (next.schemaVersion !== 1 || !next.sources) throw new Error('快照格式不兼容');
    if (expectedWorkspaceKey && next.workspaceKey !== expectedWorkspaceKey) { blockWorkspace(); throw new Error('服务已指向其他工作区，请重新打开'); }
    if (!expectedWorkspaceKey && next.workspaceKey) expectedWorkspaceKey = next.workspaceKey;
    return next;
  },
  onSnapshot: next => {
    const first = snapshot === null;
    const latest = next.runs?.reduce((current, run) => !current || run.createdAt > current.createdAt ? run : current, null);
    if (!first && latest && !snapshot.runs?.some(run => run.id === latest.id) && taskSelection.runId && latest.id !== taskSelection.runId) overviewState.pendingRunId = latest.id;
    snapshot = next; disconnected = false; render();
    if (first && expectedWorkspaceKey && !workspaceBlocked) void overviewController.resume();
  },
  onError: () => {
    if (workspaceBlocked) return;
    disconnected = true;
    if (snapshot) render();
    else {
      text('sync', '连接失败'); byId('sync').dataset.state = 'error';
      refreshButton.setAttribute('aria-label', '重新连接'); refreshButton.title = '重新连接'; text('task-sync', '连接失败');
      const alerts = byId('alerts'); alerts.hidden = false; alerts.dataset.state = 'error';
      if (alerts.dataset.content !== 'disconnected') { alerts.dataset.content = 'disconnected'; alerts.replaceChildren(node('p', '', '无法连接本机看板，尚无成功读取的数据。页面会继续重试。')); }
      text('run-state', '读取失败'); byId('run-state').dataset.state = 'error';
      text('current-step', '任务状态未知'); text('task-reason', '无法连接本机看板，等待恢复读取。');
      byId('task-reason').hidden = false;
      renderConfirmations(null, confirmationView(null));
      renderCandidateSearch();
      renderWorkspaceFollowing();
      renderWorkspaceTasks(); renderWorkspaceOverview();
      text('run-context', '进度未知，等待恢复读取。'); text('ledger-state', '候选记录数未知，等待恢复读取。');
      text('source-status', '本地文件 · 连接失败'); byId('source-dot').dataset.state = 'error';
    }
  }
});
byId('refresh-board').addEventListener('click', () => {
  void snapshotController.refresh({ invalidate: true });
  if (expectedWorkspaceKey && !workspaceBlocked) void overviewController.refresh({ invalidate: true });
});
function resumeReading() {
  pageActive = true; document.documentElement.dataset.pageVisible = String(!document.hidden);
  if (workspaceBlocked) return;
  if (snapshot) renderRuns();
  void snapshotController.resume();
  if (expectedWorkspaceKey) void overviewController.resume();
}
document.addEventListener('visibilitychange', () => {
  document.documentElement.dataset.pageVisible = String(!document.hidden);
  if (snapshot && !workspaceBlocked) renderRuns();
  if (!document.hidden) resumeReading();
});
window.addEventListener('focus', resumeReading);
window.addEventListener('pageshow', resumeReading);
window.addEventListener('pagehide', () => {
  pageActive = false; document.documentElement.dataset.pageVisible = 'false'; snapshotController.suspend(); overviewController.suspend();
  runHighlightsRequest++; runHighlightsAbort?.abort(); if (runHighlightsState.status === 'loading') runHighlightsState.status = 'idle';
  resultsRequest++; if (resultsState.status === 'loading') { resultsState.status = 'idle'; resultsState.requestedVersion = null; }
});
if (workspaceBlocked) blockWorkspace(); else resumeReading();
