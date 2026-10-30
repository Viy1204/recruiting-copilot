import { candidateStatus, ROLE_SCOPES, RUN_LABELS, searchCandidates, selectRoles, selectTask, STAGES, STEP_LABELS } from '/model.mjs';
import { createSnapshotController } from '/live.mjs';

const byId = id => document.getElementById(id);
const roleSelect = byId('role'), runSelect = byId('run'), refreshButton = byId('refresh-board');
const initialURL = new URL(window.location.href), initialWorkspace = initialURL.searchParams.get('workspace');
let expectedWorkspaceKey = /^[a-f0-9]{64}$/i.test(initialWorkspace ?? '') ? initialWorkspace.toLowerCase() : null;
let workspaceBlocked = initialWorkspace !== null && expectedWorkspaceKey === null;
let snapshot = null, taskSelection = { mode: 'live', runId: null }, selectedStage = null, disconnected = false;
let selectionMessage = '', displayedRun = null, pageActive = true;
let candidateSearchLimit = 20;
let searchConfirmations = null;
const DECISION_PREVIEW = 2;
const motionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
const text = (target, value) => { const element = typeof target === 'string' ? byId(target) : target; if (element.textContent !== value) element.textContent = value; };
let selectedCandidateId = null, candidateOrigin = null, recordRequest = 0, documentRequest = 0, roleRequest = 0, roleInfo = null, csrfToken = null;
let rolePreferences = { scope: 'active', following: [], role: '' }, preferenceKey = null, temporaryPreferencesChanged = false, preferenceMessage = '';
let resultsRequest = 0;
const freshResults = runId => ({ runId, open: false, filter: 'all', data: undefined, status: 'idle', error: null, requestedVersion: null, loadedVersion: null, updatedAt: null, expanded: new Set(), decisionExpanded: new Set(), showAllDecisions: false });
let resultsState = freshResults(null);
let activityRequest = 0, activityAbort = null;
const freshActivity = runId => ({ runId, data: undefined, revision: null, requestedRevision: null, status: 'idle', error: '', retryAt: 0, ahead: null });
let activityState = freshActivity(null);
const scopeSummary = scope => ({ active: '在招岗位汇总', following: '关注岗位汇总', all: '全部岗位' }[scope]);
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
const layoutState = { editing: false, workspaceKey: null, orders: defaultLayoutOrders(), gesture: null, changedBeforeLoad: false, storageMessage: '' };
const layoutItems = new Map();
let applyingLayout = false, layoutScrollFrame = null;

const workspaceNav = byId('workspace-nav');
const workspaceNavTargets = {
  overview: byId('workbench-heading'),
  roles: byId('candidates-heading'),
  tasks: byId('execution-records').querySelector('summary h3'),
  following: byId('choose-following')
};
workspaceNavTargets.tasks.tabIndex = -1;
let workspaceNavFocus = null, followingPickerTrigger = byId('choose-following');

function focusWorkbenchTarget(element, block = 'start') {
  element.focus({ preventScroll: true });
  element.scrollIntoView({ block, behavior: motionQuery.matches ? 'instant' : 'smooth' });
}

function setWorkspaceNavTarget(target) {
  for (const button of workspaceNav.querySelectorAll('[data-nav-target]')) {
    if (button.dataset.navTarget === target) button.setAttribute('aria-current', 'location');
    else button.removeAttribute('aria-current');
  }
}

function navigateWorkspace(target) {
  if (target === 'roles' && byId('candidate-query').value) clearCandidateSearch(false);
  if (target === 'tasks') {
    byId('execution-records').open = true;
    if (snapshot && !workspaceBlocked) { renderRunResults(selectedRun()); syncActivity(selectedRun()); }
  }
  setWorkspaceNavTarget(target);
  focusWorkbenchTarget(workspaceNavTargets[target]);
}

for (const button of workspaceNav.querySelectorAll('[data-nav-target]')) button.addEventListener('click', () => navigateWorkspace(button.dataset.navTarget));

function visibleWorkbenchTarget(element) {
  const style = getComputedStyle(element);
  return element.getClientRects().length > 0 && style.display !== 'none' && style.visibility === 'visible';
}

document.addEventListener('focusin', event => {
  if (workspaceNav.contains(event.target)) workspaceNavFocus = event.target.closest('[data-nav-target]')?.dataset.navTarget ?? (event.target.closest('#workspace-choose-following') ? 'following' : 'roles');
  else if (event.target !== document.body || visibleWorkbenchTarget(workspaceNav)) workspaceNavFocus = null;
});
document.addEventListener('pointerdown', event => { if (!workspaceNav.contains(event.target)) workspaceNavFocus = null; }, true);
if (typeof ResizeObserver === 'function') {
  new ResizeObserver(() => {
    if (!workspaceNavFocus || visibleWorkbenchTarget(workspaceNav)) return;
    const active = document.activeElement;
    if (!workspaceNav.contains(active) && active !== document.body && active !== document.documentElement) { workspaceNavFocus = null; return; }
    const target = workspaceNavTargets[workspaceNavFocus];
    const fallback = workspaceNavFocus === 'tasks' ? byId('tasks-heading') : workspaceNavTargets.roles;
    workspaceNavFocus = null;
    const destination = visibleWorkbenchTarget(target) ? target : fallback;
    if (destination.matches('h1, h2, h3')) destination.tabIndex = -1;
    focusWorkbenchTarget(destination);
  }).observe(document.querySelector('.app'));
}

const initialPreviewMode = initialURL.searchParams.get('preview');
const previewEnabled = ['wide', 'narrow'].includes(initialPreviewMode);
function setPreviewMode(mode) {
  if (!previewEnabled) return;
  document.querySelector('.app').dataset.preview = mode;
  for (const button of byId('preview-toolbar').querySelectorAll('[data-preview-mode]')) button.setAttribute('aria-pressed', String(button.dataset.previewMode === mode));
  const url = new URL(window.location.href);
  url.searchParams.set('preview', mode);
  if (url.href !== window.location.href) window.history.replaceState(null, '', url);
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

function updateLayoutControls() {
  for (const [groupId, group] of Object.entries(LAYOUT_GROUPS)) {
    const order = layoutState.orders[groupId];
    for (const member of group.members) {
      const controls = layoutItems.get(member.id), position = order.indexOf(member.id);
      controls.bar.hidden = !layoutState.editing;
      controls.handle.setAttribute('aria-label', `调整${member.label}顺序，${group.label}第 ${position + 1} / ${order.length} 位`);
      controls.up.setAttribute('aria-disabled', String(position === 0));
      controls.down.setAttribute('aria-disabled', String(position === order.length - 1));
    }
  }
}

function applyLayoutOrders(orders) {
  const focused = document.activeElement;
  const selection = focused?.matches('input, textarea') && typeof focused.selectionStart === 'number' ? [focused.selectionStart, focused.selectionEnd, focused.selectionDirection] : null;
  layoutState.orders = orders;
  applyingLayout = true;
  try {
    for (const [groupId, group] of Object.entries(LAYOUT_GROUPS)) {
      const parent = byId(group.parent);
      let position = parent.firstElementChild;
      for (const id of orders[groupId]) {
        const element = layoutItems.get(id).element;
        if (element !== position) {
          if (typeof parent.moveBefore === 'function') parent.moveBefore(element, position);
          else parent.insertBefore(element, position);
        }
        position = element.nextElementSibling;
      }
    }
    if (focused?.isConnected && document.activeElement !== focused) {
      focused.focus({ preventScroll: true });
      if (selection) focused.setSelectionRange(...selection);
    }
  } finally {
    applyingLayout = false;
  }
  updateLayoutControls();
}

function syncLayoutPreferences() {
  if (layoutState.workspaceKey || !snapshot?.workspaceKey || layoutState.gesture) return;
  layoutState.workspaceKey = snapshot.workspaceKey;
  let orders = defaultLayoutOrders();
  try {
    const saved = localStorage.getItem(`recruiting-board:layout:v1:${layoutState.workspaceKey}`);
    if (saved !== null) {
      try {
        const parsed = parseLayoutOrders(JSON.parse(saved));
        orders = parsed.orders;
        if (parsed.repaired) layoutState.storageMessage = '本机布局记录已整理：忽略无效或重复项，并补齐缺少的模块。';
      } catch (error) {
        layoutState.storageMessage = '本机布局记录损坏或版本不兼容，已恢复默认顺序。';
      }
    }
  } catch (error) {
    layoutState.storageMessage = '本机布局读取失败；本页仍可排序，刷新后可能不会保留。';
  }
  if (!layoutState.changedBeforeLoad && !layoutState.gesture) applyLayoutOrders(orders);
  else if (!layoutState.gesture) persistLayoutOrders();
  renderLayoutStorageNotice();
}

function layoutPositionMessage(groupId, id) {
  const order = layoutState.orders[groupId];
  return `${layoutItems.get(id).label}位于${LAYOUT_GROUPS[groupId].label}第 ${order.indexOf(id) + 1} / ${order.length} 位`;
}

function keepLayoutControlVisible(element) {
  const rect = element.getBoundingClientRect();
  const top = Math.min(byId('layout-toolbar').getBoundingClientRect().bottom + 8, window.innerHeight / 2);
  if (rect.top < top) window.scrollBy(0, rect.top - top);
  else if (rect.bottom > window.innerHeight - 12) window.scrollBy(0, rect.bottom - window.innerHeight + 12);
}

function clearLayoutDrop() {
  for (const { element } of layoutItems.values()) delete element.dataset.layoutDrop;
}

function previewLayoutDrop(gesture) {
  clearLayoutDrop();
  const parent = byId(LAYOUT_GROUPS[gesture.groupId].parent), bounds = parent.getBoundingClientRect();
  gesture.order = null;
  if (gesture.x < bounds.left || gesture.x > bounds.right || gesture.y < bounds.top || gesture.y > bounds.bottom) return;
  const rest = gesture.before.filter(id => id !== gesture.id);
  const visible = rest.filter(id => layoutItems.get(id).element.getClientRects().length);
  if (!visible.length) { gesture.order = gesture.before; return; }
  const next = visible.find(id => {
    const rect = layoutItems.get(id).element.getBoundingClientRect();
    return gesture.y < rect.top + rect.height / 2;
  });
  const index = next === undefined ? rest.length : rest.indexOf(next);
  gesture.order = [...rest.slice(0, index), gesture.id, ...rest.slice(index)];
  if (gesture.order.every((id, position) => id === gesture.before[position])) return;
  layoutItems.get(next ?? visible[visible.length - 1]).element.dataset.layoutDrop = next === undefined ? 'after' : 'before';
}

function scrollLayoutDrag(timestamp) {
  layoutScrollFrame = null;
  const gesture = layoutState.gesture;
  if (gesture?.kind !== 'pointer' || gesture.phase !== 'dragging') return;
  const bounds = byId(LAYOUT_GROUPS[gesture.groupId].parent).getBoundingClientRect();
  const top = Math.max(0, byId('layout-toolbar').getBoundingClientRect().bottom), edge = 64;
  const bottom = window.innerHeight;
  const inGroup = gesture.x >= bounds.left && gesture.x <= bounds.right && gesture.y >= bounds.top && gesture.y <= bounds.bottom;
  const speed = !inGroup ? 0 : gesture.y < top + edge ? -Math.min(1, (top + edge - gesture.y) / edge) : gesture.y > bottom - edge ? Math.min(1, (gesture.y - bottom + edge) / edge) : 0;
  const elapsed = gesture.lastFrame === null ? 16 : Math.min(32, timestamp - gesture.lastFrame);
  gesture.lastFrame = timestamp;
  if (speed) window.scrollBy(0, speed * elapsed * .8);
  previewLayoutDrop(gesture);
  layoutScrollFrame = requestAnimationFrame(scrollLayoutDrag);
}

function finishLayoutGesture(commit, returnFocus = false) {
  const gesture = layoutState.gesture;
  if (!gesture) return;
  layoutState.gesture = null;
  if (layoutScrollFrame !== null) cancelAnimationFrame(layoutScrollFrame);
  layoutScrollFrame = null;
  const item = layoutItems.get(gesture.id);
  item.element.classList.remove('layout-dragging', 'layout-grabbed');
  item.handle.setAttribute('aria-pressed', 'false');
  delete document.documentElement.dataset.layoutDragging;
  clearLayoutDrop();
  if (gesture.kind === 'pointer' && item.handle.hasPointerCapture?.(gesture.pointerId)) item.handle.releasePointerCapture(gesture.pointerId);
  if (gesture.kind === 'pointer' && gesture.phase === 'pending') {
    syncLayoutPreferences();
    return;
  }
  const order = gesture.kind === 'pointer' ? gesture.order : layoutState.orders[gesture.groupId];
  const accepted = commit && order !== null;
  const next = accepted ? order : gesture.before;
  const changed = next.some((id, index) => id !== gesture.before[index]);
  applyLayoutOrders({ ...layoutState.orders, [gesture.groupId]: next });
  if (accepted && changed) persistLayoutOrders();
  syncLayoutPreferences();
  announceLayout(accepted ? `${layoutPositionMessage(gesture.groupId, gesture.id)}，${changed ? '顺序已应用' : '位置未变'}。` : `${item.label}的本次移动已取消，顺序已恢复。`);
  if (returnFocus) item.handle.focus({ preventScroll: true });
}

function startKeyboardLayout(groupId, id) {
  const current = layoutState.gesture;
  if (current?.kind === 'pointer') return false;
  if (current?.id === id) return true;
  if (current) finishLayoutGesture(true);
  layoutState.gesture = { kind: 'keyboard', groupId, id, before: [...layoutState.orders[groupId]] };
  const item = layoutItems.get(id);
  item.element.classList.add('layout-grabbed');
  item.handle.setAttribute('aria-pressed', 'true');
  announceLayout(`已抓起${item.label}；↑↓ 在${LAYOUT_GROUPS[groupId].label}内移动，Enter 或空格确认，Esc 取消。`);
  return true;
}

function moveLayoutItem(groupId, id, offset, keyboard = false, trigger = null) {
  if (!layoutState.editing) return;
  if (keyboard) { if (!startKeyboardLayout(groupId, id)) return; }
  else if (layoutState.gesture) finishLayoutGesture(layoutState.gesture.kind === 'keyboard');
  const order = [...layoutState.orders[groupId]], index = order.indexOf(id), target = index + offset;
  if (target < 0 || target >= order.length) { announceLayout(`${layoutItems.get(id).label}已在同级${offset < 0 ? '最前' : '最后'}。`); return; }
  [order[index], order[target]] = [order[target], order[index]];
  applyLayoutOrders({ ...layoutState.orders, [groupId]: order });
  if (!keyboard) persistLayoutOrders();
  announceLayout(`${layoutPositionMessage(groupId, id)}。${keyboard ? 'Enter 或空格确认，Esc 取消。' : '顺序已应用。'}`);
  keepLayoutControlVisible(trigger ?? layoutItems.get(id).handle);
}

function setLayoutEditing(editing) {
  if (layoutState.gesture) finishLayoutGesture(layoutState.gesture.kind === 'keyboard');
  layoutState.editing = editing;
  byId('edit-layout').setAttribute('aria-expanded', String(editing));
  byId('layout-editor').hidden = !editing;
  byId('layout-toolbar').classList.toggle('is-editing', editing);
  byId('layout-root').classList.toggle('is-editing', editing);
  updateLayoutControls();
  renderLayoutStorageNotice();
  renderCandidateSearch();
  announceLayout(editing ? '正在调整布局。可拖动同级模块、点上移／下移，或在把手上使用上下箭头。' : '已完成布局调整。');
  if (!editing) byId('edit-layout').focus({ preventScroll: true });
}

function layoutIcon(paths) {
  const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  icon.setAttribute('viewBox', '0 0 24 24'); icon.setAttribute('aria-hidden', 'true'); icon.setAttribute('focusable', 'false');
  for (const d of paths) {
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', d); icon.append(path);
  }
  return icon;
}

for (const [groupId, group] of Object.entries(LAYOUT_GROUPS)) {
  for (const member of group.members) {
    const element = byId(group.parent).querySelector(`:scope > [data-layout-item="${member.id}"]`);
    const bar = node('div', 'layout-item-controls'); bar.hidden = true;
    bar.setAttribute('role', 'group'); bar.setAttribute('aria-label', `${member.label}布局操作`);
    const handle = node('button', 'layout-drag-handle'); handle.type = 'button'; handle.id = `layout-handle-${member.id}`;
    handle.dataset.layoutHandle = member.id;
    handle.setAttribute('aria-describedby', 'layout-help'); handle.setAttribute('aria-controls', group.parent);
    handle.setAttribute('aria-keyshortcuts', 'ArrowUp ArrowDown Enter Space Escape'); handle.setAttribute('aria-pressed', 'false');
    handle.title = `拖动${member.label}；也可用 ↑↓ 调整，Enter 确认，Esc 取消`;
    handle.append(layoutIcon(['M9 5h.01M9 12h.01M9 19h.01M15 5h.01M15 12h.01M15 19h.01']), node('span', 'layout-handle-label', member.label));
    const up = node('button', 'layout-move-button'), down = node('button', 'layout-move-button');
    for (const [button, direction, offset, path] of [[up, '上移', -1, 'M12 19V5M5 12l7-7 7 7'], [down, '下移', 1, 'M12 5v14M5 12l7 7 7-7']]) {
      button.type = 'button'; button.dataset.layoutMove = offset < 0 ? 'up' : 'down';
      button.setAttribute('aria-label', `${direction}${member.label}`); button.title = direction;
      button.append(layoutIcon([path]));
      button.addEventListener('click', () => moveLayoutItem(groupId, member.id, offset, false, button));
    }
    handle.addEventListener('keydown', event => {
      if (!layoutState.editing || event.isComposing || event.altKey || event.ctrlKey || event.metaKey) return;
      if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
        event.preventDefault(); event.stopPropagation();
        moveLayoutItem(groupId, member.id, event.key === 'ArrowUp' ? -1 : 1, true);
      } else if (event.key === ' ' || event.key === 'Enter') {
        event.preventDefault(); event.stopPropagation();
        if (event.repeat) return;
        if (layoutState.gesture?.id === member.id) finishLayoutGesture(true, true);
        else startKeyboardLayout(groupId, member.id);
      }
    });
    handle.addEventListener('click', event => {
      event.preventDefault();
      if (!layoutState.editing || event.detail !== 0 || layoutState.gesture?.kind === 'pointer') return;
      if (layoutState.gesture?.id === member.id) finishLayoutGesture(true, true);
      else startKeyboardLayout(groupId, member.id);
    });
    handle.addEventListener('pointerdown', event => {
      if (!layoutState.editing || event.button !== 0 || !event.isPrimary) return;
      event.preventDefault(); event.stopPropagation();
      if (layoutState.gesture) finishLayoutGesture(layoutState.gesture.kind === 'keyboard');
      handle.focus({ preventScroll: true });
      layoutState.gesture = { kind: 'pointer', phase: 'pending', groupId, id: member.id, pointerId: event.pointerId, before: [...layoutState.orders[groupId]], order: null, startX: event.clientX, startY: event.clientY, x: event.clientX, y: event.clientY, lastFrame: null };
      if (typeof handle.setPointerCapture === 'function') handle.setPointerCapture(event.pointerId);
    });
    handle.addEventListener('lostpointercapture', event => {
      if (layoutState.gesture?.kind === 'pointer' && layoutState.gesture.pointerId === event.pointerId) finishLayoutGesture(false);
    });
    handle.addEventListener('dragstart', event => event.preventDefault());
    bar.append(handle, up, down); element.prepend(bar);
    layoutItems.set(member.id, { ...member, groupId, element, bar, handle, up, down });
  }
}
updateLayoutControls();
byId('edit-layout').addEventListener('click', () => setLayoutEditing(!layoutState.editing));
byId('finish-layout').addEventListener('click', () => setLayoutEditing(false));
byId('reset-layout').addEventListener('click', () => {
  finishLayoutGesture(false);
  applyLayoutOrders(defaultLayoutOrders()); persistLayoutOrders();
  announceLayout('已恢复默认布局：确认事项、岗位与人选、任务与记录；组内顺序也已恢复。');
});
document.addEventListener('pointermove', event => {
  const gesture = layoutState.gesture;
  if (gesture?.kind !== 'pointer' || gesture.pointerId !== event.pointerId) return;
  gesture.x = event.clientX; gesture.y = event.clientY;
  if (gesture.phase === 'pending') {
    if (Math.hypot(gesture.x - gesture.startX, gesture.y - gesture.startY) < 6) return;
    gesture.phase = 'dragging';
    layoutItems.get(gesture.id).element.classList.add('layout-dragging');
    layoutItems.get(gesture.id).handle.setAttribute('aria-pressed', 'true');
    document.documentElement.dataset.layoutDragging = 'true';
    announceLayout(`正在移动${layoutItems.get(gesture.id).label}，仅限${LAYOUT_GROUPS[gesture.groupId].label}内；松开应用，Esc 取消。`);
    layoutScrollFrame = requestAnimationFrame(scrollLayoutDrag);
  }
  event.preventDefault(); previewLayoutDrop(gesture);
}, { passive: false });
document.addEventListener('pointerup', event => {
  const gesture = layoutState.gesture;
  if (gesture?.kind !== 'pointer' || gesture.pointerId !== event.pointerId) return;
  if (gesture.phase === 'dragging') { gesture.x = event.clientX; gesture.y = event.clientY; previewLayoutDrop(gesture); }
  finishLayoutGesture(true, true);
});
document.addEventListener('pointercancel', event => {
  if (layoutState.gesture?.kind === 'pointer' && layoutState.gesture.pointerId === event.pointerId) finishLayoutGesture(false, true);
});
document.addEventListener('keydown', event => {
  if (!layoutState.editing || event.key !== 'Escape' || event.isComposing) return;
  if (layoutState.gesture) {
    event.preventDefault(); event.stopPropagation(); finishLayoutGesture(false, true);
  } else if (event.target.closest('.layout-item-controls, #layout-toolbar')) {
    event.preventDefault(); event.stopPropagation(); setLayoutEditing(false);
  }
}, true);
document.addEventListener('focusin', event => {
  const gesture = layoutState.gesture;
  if (!applyingLayout && gesture?.kind === 'keyboard' && event.target !== layoutItems.get(gesture.id).handle) finishLayoutGesture(true);
});
window.addEventListener('blur', () => finishLayoutGesture(false));
window.addEventListener('pagehide', () => finishLayoutGesture(false));
document.addEventListener('visibilitychange', () => { if (document.hidden) finishLayoutGesture(false); });

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
  rolePreferences.scope = 'following'; rolePreferences.role = name;
  persistRolePreferences();
  if (snapshot) { const view = renderRoleControls(); renderStages(true, view); }
  setWorkspaceNavTarget('roles');
  focusWorkbenchTarget(workspaceNavTargets.roles);
}

function toggleFollowingPicker(trigger) {
  const picker = byId('following-picker');
  const opening = picker.hidden || !visibleWorkbenchTarget(picker);
  if (opening && byId('candidate-query').value) clearCandidateSearch(false);
  picker.hidden = !opening;
  for (const id of ['choose-following', 'workspace-choose-following']) byId(id).setAttribute('aria-expanded', String(opening));
  if (opening) {
    followingPickerTrigger = trigger;
    renderFollowingPicker();
    focusWorkbenchTarget(byId('following-query'), 'nearest');
  }
}

function renderFollowingPicker() {
  if (byId('following-picker').hidden || !snapshot) return;
  const query = byId('following-query').value.trim().toLocaleLowerCase();
  const names = [...new Set([...snapshot.roles.map(role => role.name), ...rolePreferences.following])];
  const values = names.filter(name => name.toLocaleLowerCase().includes(query));
  const list = byId('following-list');
  const signature = JSON.stringify([values, rolePreferences.following]);
  if (list.dataset.content === signature) return;
  list.dataset.content = signature;
  const items = values.map(name => {
    const item = node('li'), label = node('label', 'following-option'), checkbox = node('input');
    checkbox.type = 'checkbox'; checkbox.checked = rolePreferences.following.includes(name);
    checkbox.dataset.role = name;
    checkbox.addEventListener('change', () => {
      rolePreferences.following = checkbox.checked ? [...rolePreferences.following, name] : rolePreferences.following.filter(value => value !== name);
      list.dataset.content = JSON.stringify([values, rolePreferences.following]);
      persistRolePreferences();
      renderRoleControls(); renderStages(true);
    });
    const title = node('span', '', name);
    if (!snapshot.roles.some(role => role.name === name)) title.append(node('span', 'muted', ' · 未在当前源中'));
    label.append(checkbox, title); item.append(label); return item;
  });
  if (!items.length) items.push(node('li', 'picker-empty', names.length ? '没有匹配的岗位。' : '当前没有可选择的岗位。'));
  list.replaceChildren(...items);
}

function renderRoleControls() {
  const view = currentRoleView(), scopeView = byId('role-query').value.trim() ? currentRoleView('') : view;
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
  const note = context !== 'ok' ? `未读取岗位配置${context === 'stale' ? '；保留上次配置（陈旧）' : '；岗位状态未知'}` : rolePreferences.role ? role?.configured ? `岗位状态：${role.status || '未填写'}${role.priority ? ` · 优先级 ${role.priority}` : ''}` : '仅见于台账，未配置岗位' : rolePreferences.scope === 'active' ? '在招与状态未知岗位的候选分布' : rolePreferences.scope === 'following' ? '关注岗位的候选分布' : '全部岗位的候选分布，含历史岗位';
  text('role-note', `${note} · ${view.total === null ? '记录数未知' : `${view.total} 条候选记录`}`);
  renderFollowingPicker();
  renderWorkspaceFollowing();
  return view;
}

function closeCandidate() {
  selectedCandidateId = null; candidateOrigin = null; recordRequest++; documentRequest++;
  byId('candidate-record').hidden = true;
  byId('candidate-list').hidden = false;
  byId('candidate-search-content').hidden = searchConfirmations !== null;
  byId('results-content').hidden = false;
  byId('stage-record-host').append(byId('candidate-record'));
}

function captureSearchPosition(trigger = null) {
  const visible = [...byId('candidate-search-list').querySelectorAll('button')].find(button => {
    const rect = button.getBoundingClientRect();
    return rect.bottom > 0 && rect.top < window.innerHeight;
  });
  const anchor = trigger?.closest('#candidate-search-list') ? trigger : visible;
  return { candidateId: anchor?.dataset.candidate ?? null, top: anchor?.getBoundingClientRect().top ?? 0, scrollY: window.scrollY };
}

function restoreSearchPosition(position, fallback) {
  const anchor = [...byId('candidate-search-list').querySelectorAll('button')].find(button => button.dataset.candidate === position.candidateId);
  const target = anchor ?? fallback;
  target.focus({ preventScroll: true });
  if (anchor) window.scrollBy(0, anchor.getBoundingClientRect().top - position.top);
  else window.scrollTo(0, position.scrollY);
  const rect = target.getBoundingClientRect();
  if (rect.top < 0 || rect.bottom > window.innerHeight) target.scrollIntoView({ block: 'nearest' });
}

function renderCandidateSearch() {
  const query = byId('candidate-query').value;
  const searching = query.trim().length > 0;
  const results = byId('candidate-search-results');
  byId('role-blocks').hidden = searching && !layoutState.editing;
  text('role-browser-title', searching ? '全工作区搜索结果' : '岗位与人选');
  results.hidden = !searching;
  byId('candidate-search-status').hidden = searchConfirmations !== null;
  byId('search-record-host').hidden = searchConfirmations !== null;
  byId('return-to-search').hidden = !searching || searchConfirmations === null;
  byId('clear-candidate-search').hidden = !query.length;
  if (!searching) return;
  const matches = snapshot ? searchCandidates(snapshot, query) : null;
  const shown = matches?.slice(0, candidateSearchLimit) ?? [];
  text('candidate-search-status', matches === null ? '候选台账尚未成功读取，匹配人数未知。' : `找到 ${matches.length} 条候选记录 · 已显示 ${shown.length} 条`);
  const stale = workspaceBlocked ? '工作区连接已变化，以下保留上次搜索记录，请重新打开看板。' : disconnected ? '连接断开，以下搜索结果来自上次读取的台账。' : snapshot?.sources.ledger.status === 'stale' ? '以下搜索结果沿用上次候选记录（陈旧）。' : '';
  text('candidate-search-stale', stale); byId('candidate-search-stale').hidden = !stale;
  byId('candidate-search-content').hidden = searchConfirmations !== null || candidateOrigin?.source === 'search';
  const more = byId('show-more-candidates');
  more.hidden = matches === null || shown.length === matches.length;
  const list = byId('candidate-search-list');
  const signature = JSON.stringify([matches === null, shown.map(candidate => [candidate.id, candidate.name, candidate.role, candidate.rawRole, candidateStatus(candidate)])]);
  if (list.dataset.content === signature) return;
  list.dataset.content = signature;
  const focused = list.contains(document.activeElement) ? document.activeElement : null;
  const previous = new Map([...list.children].map(item => [item.dataset.candidate, item]));
  const items = shown.map(candidate => {
    let item = previous.get(candidate.id);
    if (!item) {
      item = node('li', 'candidate-row'); item.dataset.candidate = candidate.id;
      const heading = node('div', 'person-heading');
      const button = node('button', 'person-name candidate-link'); button.type = 'button'; button.dataset.candidate = candidate.id;
      button.addEventListener('click', () => { const current = snapshot?.candidates?.find(value => value.id === button.dataset.candidate); if (current) void openCandidate(current, 'search', button); });
      heading.append(button);
      item.append(heading, node('p', 'person-role search-role'), node('p', 'person-role search-raw-role'), node('span', 'person-status'));
    }
    const button = item.querySelector('button');
    text(button, candidate.name); button.setAttribute('aria-label', `查看 ${candidate.name} 的候选资料，原岗位：${candidate.rawRole}`);
    text(item.querySelector('.search-role'), `岗位：${candidate.role}`);
    const rawRole = item.querySelector('.search-raw-role');
    text(rawRole, `原岗位：${candidate.rawRole}`); rawRole.hidden = candidate.rawRole === candidate.role;
    text(item.querySelector('.person-status'), `原状态：${candidateStatus(candidate)}`);
    return item;
  });
  if (!items.length) items.push(node('li', 'empty-state', matches === null ? '等待成功读取台账后再显示匹配结果。' : '未找到匹配的人选，请尝试完整姓名或部分姓名。'));
  for (const item of previous.values()) if (!items.includes(item)) item.remove();
  let position = list.firstElementChild;
  for (const item of items) { if (item !== position) list.insertBefore(item, position); position = item.nextElementSibling; }
  if (focused && document.activeElement !== focused) (focused.isConnected ? focused : byId('candidate-query')).focus({ preventScroll: true });
}

function changeCandidateSearch() {
  candidateSearchLimit = 20;
  searchConfirmations = null;
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

async function openCandidate(candidate, origin = 'stage', trigger = null) {
  const pending = ++recordRequest;
  documentRequest++; selectedCandidateId = candidate.id;
  candidateOrigin = { source: origin, trigger, candidateId: candidate.id, searchPosition: origin === 'search' ? captureSearchPosition(trigger) : null };
  const host = { decisions: 'decision-record-host', results: 'run-record-host', activity: 'activity-record-host', stage: 'stage-record-host', search: 'search-record-host' }[origin];
  byId(host).append(byId('candidate-record'));
  byId('candidate-list').hidden = origin === 'stage';
  byId('candidate-search-content').hidden = searchConfirmations !== null || origin === 'search';
  byId('results-content').hidden = origin === 'results';
  if (origin === 'decisions') byId('decisions-content').hidden = true;
  byId('candidate-record').hidden = false;
  byId('back-to-list').textContent = { decisions: '返回确认名单', results: '返回处理名单', activity: '返回近期流水', stage: '返回名单', search: '返回搜索结果' }[origin];
  const content = byId('record-content');
  content.replaceChildren(node('p', 'muted', '正在读取候选资料…'));
  byId('back-to-list').focus({ preventScroll: true });
  if (origin === 'search') byId('back-to-list').scrollIntoView({ block: 'nearest' });
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
    const preview = node('section', 'document-preview'); preview.hidden = true;
    for (const document of detail.documents) {
      const item = node('li', 'document-row'), title = node('p', '', document.label);
      item.append(title);
      if (document.status !== 'ok') item.append(node('p', 'muted', document.message || '文件暂不可读'));
      else {
        const actions = node('div', 'document-actions');
        if (document.kind !== 'pdf') {
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
        const link = node('a', 'text-button', document.kind === 'pdf' ? '打开 PDF' : '新窗口打开');
        link.href = documentURL(detail.candidate.id, document.id); link.target = '_blank'; link.rel = 'noopener noreferrer';
        const download = node('a', 'text-button', '下载'); download.href = documentURL(detail.candidate.id, document.id, true); download.download = '';
        actions.append(link, download); item.append(actions);
      }
      documents.append(item);
    }
    if (!detail.documents.length) documents.append(node('li', 'muted', '暂无已关联资料。'));
    content.replaceChildren(heading, facts, warnings, node('h4', '', '本地资料'), documents, preview, evaluation);
  } catch (error) {
    if (pending === recordRequest) content.replaceChildren(node('p', 'record-error', error.message));
  }
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
    roleInfo = info; csrfToken = session.csrfToken;
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
  byId('role-manager').hidden = true; byId('manage-roles').setAttribute('aria-expanded', 'false');
  byId('manage-roles').focus({ preventScroll: true });
}

const stageButtons = new Map(STAGES.map(stage => {
  const button = byId('stage-template').content.firstElementChild.cloneNode(true);
  button.id = `stage-${stage.id}`;
  button.dataset.stage = stage.id;
  button.querySelector('.stage-name').textContent = stage.label;
  button.addEventListener('click', () => {
    if (candidateOrigin?.source === 'stage') closeCandidate();
    selectedStage = selectedStage === stage.id ? null : stage.id;
    if (snapshot) renderStages();
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

function resetActivity(runId) {
  activityRequest++; activityAbort?.abort(); activityAbort = null;
  activityState = freshActivity(runId);
  byId('activity-list').replaceChildren(); delete byId('activity-list').dataset.run; delete byId('activity-list').dataset.revision;
}

async function loadActivity(force = false) {
  const run = selectedRun();
  if (!run || document.hidden || !pageActive || disconnected || workspaceBlocked) return;
  const revision = run.resultSummary?.revision ?? 0, workspaceKey = expectedWorkspaceKey;
  if (!force && (activityState.status === 'loading' || activityState.requestedRevision === revision || Date.now() < activityState.retryAt)) return;
  const pending = ++activityRequest;
  activityAbort?.abort(); activityAbort = new AbortController();
  activityState.status = 'loading'; activityState.requestedRevision = revision;
  renderActivity(run);
  try {
    const response = await jsonRequest(`/api/runs/activity?${new URLSearchParams({ run: run.id })}`, { signal: AbortSignal.any([activityAbort.signal, AbortSignal.timeout(10000)]) });
    if (pending !== activityRequest || selectedRun()?.id !== run.id || workspaceKey !== expectedWorkspaceKey || workspaceBlocked) return;
    if (response.runId !== run.id || !Number.isSafeInteger(response.revision) || (response.items !== null && (!Array.isArray(response.items) || response.items.length > 3))) throw new Error('动态响应格式不兼容');
    for (const item of response.items ?? []) {
      const identity = JSON.parse(item.candidateId);
      if (!Array.isArray(identity) || identity.length !== 2 || identity.some(value => typeof value !== 'string')) throw new Error('动态中的姓名或原岗位格式无效');
    }
    const currentRevision = selectedRun().resultSummary?.revision ?? 0;
    if (response.revision < currentRevision) {
      activityState.status = 'stale'; activityState.requestedRevision = null; activityState.retryAt = Date.now() + 1000;
    } else if (response.revision > currentRevision) {
      activityState.status = 'ahead'; activityState.ahead = response;
    } else acceptActivity(response);
  } catch (error) {
    if (pending !== activityRequest || workspaceBlocked) return;
    activityState.status = 'error'; activityState.error = error.message;
    activityState.requestedRevision = null; activityState.retryAt = Date.now() + 2000;
  }
  if (pending === activityRequest) renderActivity(selectedRun());
}

function acceptActivity(response) {
  activityState.data = response.items; activityState.revision = response.revision;
  activityState.requestedRevision = response.revision; activityState.status = 'ready'; activityState.ahead = null;
}

function syncActivity(run) {
  if (!run) {
    if (activityState.status === 'loading') { activityRequest++; activityAbort?.abort(); activityState.status = 'idle'; activityState.requestedRevision = null; }
    return;
  }
  const revision = run.resultSummary?.revision ?? 0;
  if (activityState.ahead?.revision === revision) acceptActivity(activityState.ahead);
  else if (activityState.ahead && activityState.ahead.revision < revision) { activityState.ahead = null; activityState.requestedRevision = null; }
  renderActivity(run);
  if (byId('execution-records').open) void loadActivity();
}

function renderActivity(run) {
  byId('run-activity').hidden = !run;
  if (!run) return;
  const state = activityState, retained = state.data !== undefined;
  const sourceStale = snapshot.sources.runs.status === 'stale' || snapshot.sources.runs.stale === true;
  const message = disconnected ? retained ? '连接断开，以下是上次读取的动态。' : '连接断开，最近动态尚未成功读取。' : state.status === 'error' ? `动态读取失败：${state.error}${retained ? '；以下保留上次记录。' : '；可重试。'}` : state.status === 'stale' ? '动态版本较旧，正在重新读取。' : state.status === 'ahead' ? '新记录已写入，等待任务汇总同步。' : !retained ? '正在读取最近动态…' : sourceStale ? '任务源陈旧，以下保留上次记录。' : state.data === null ? '此任务尚未记录处理名单。' : !state.data.length ? '本轮已明确记录 0 条处理记录。' : '';
  text('activity-status', message); byId('activity-status').hidden = !message;
  if (byId('activity-status').dataset.state !== state.status) byId('activity-status').dataset.state = state.status;
  byId('retry-activity').hidden = !['error', 'stale'].includes(state.status);
  const list = byId('activity-list');
  if (state.data?.length && (list.contains(document.activeElement) || candidateOrigin?.source === 'activity') && list.dataset.revision !== String(state.revision)) {
    text('activity-status', '最近动态已有更新，返回后显示。'); byId('activity-status').hidden = false; return;
  }
  const previous = new Map([...list.children].map(item => [item.dataset.receipt, item]));
  const baseline = list.dataset.run === run.id && list.dataset.revision !== undefined;
  const changed = baseline && list.dataset.revision !== String(state.revision);
  const items = (state.data ?? []).map(receipt => {
    const [name, rawRole] = JSON.parse(receipt.candidateId);
    const candidate = snapshot.candidates?.find(value => value.id === receipt.candidateId);
    const signature = JSON.stringify([receipt, Boolean(candidate)]);
    let item = previous.get(receipt.id);
    if (!item) { item = node('li', 'activity-item'); item.dataset.receipt = receipt.id; }
    if (item.dataset.content !== signature) {
      let button = item.querySelector('button');
      if (!button) {
        button = node('button', 'person-name candidate-link'); button.type = 'button';
        button.addEventListener('click', () => { const current = snapshot.candidates?.find(value => value.id === button.dataset.candidate); if (current) void openCandidate(current, 'activity', button); else openRunResults('all'); });
        const heading = node('div', 'activity-person');
        const who = node('div', 'activity-who');
        who.append(button, node('span', 'activity-role'));
        heading.append(who, node('span', 'result-attention'));
        item.append(heading, node('p', 'activity-action'), node('p', 'activity-outcome'), node('p', 'activity-next'), node('time', 'result-time'));
      }
      button.textContent = name; button.dataset.candidate = receipt.candidateId;
      button.setAttribute('aria-label', `${candidate ? '查看候选资料' : '查看本轮完整记录'}：${name}`);
      item.dataset.attention = receipt.attention;
      item.querySelector('.result-attention').textContent = { decision: '需你确认', notice: '提醒', none: '已记录' }[receipt.attention];
      const roleLabel = item.querySelector('.activity-role');
      roleLabel.textContent = rawRole ?? ''; roleLabel.hidden = !rawRole;
      item.querySelector('.activity-action').textContent = receipt.action;
      item.querySelector('.activity-outcome').textContent = receipt.outcome;
      const next = item.querySelector('.activity-next'); next.textContent = receipt.nextAction ? `下一步：${receipt.nextAction}` : ''; next.hidden = !receipt.nextAction;
      const timestamp = item.querySelector('time'); timestamp.textContent = time(receipt.updatedAt); timestamp.dateTime = receipt.updatedAt;
      item.dataset.content = signature;
      if (changed) flash(item);
    }
    return item;
  });
  for (const item of previous.values()) if (!items.includes(item)) item.remove();
  let position = list.firstElementChild;
  for (const item of items) { if (item !== position) list.insertBefore(item, position); position = item.nextElementSibling; }
  if (list.dataset.run !== run.id) list.dataset.run = run.id;
  if (state.revision !== null && list.dataset.revision !== String(state.revision)) list.dataset.revision = String(state.revision);
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
  const people = new Map(), attentionOrder = { decision: 0, notice: 1, none: 2 };
  const receipts = new Map(results.map((receipt, order) => [receipt.id, { ...receipt, order }]));
  for (const receipt of receipts.values()) {
    const identity = JSON.parse(receipt.candidateId);
    if (!Array.isArray(identity) || identity.length !== 2 || identity.some(value => typeof value !== 'string')) throw new Error('处理名单中的姓名或原岗位格式无效');
    const person = people.get(receipt.candidateId) ?? { candidateId: receipt.candidateId, name: identity[0], rawRole: identity[1], receipts: [] };
    person.receipts.push(receipt);
    people.set(person.candidateId, person);
  }
  const latestFirst = (a, b) => b.updatedAt.localeCompare(a.updatedAt) || b.order - a.order;
  for (const person of people.values()) {
    person.receipts.sort((a, b) => attentionOrder[a.attention] - attentionOrder[b.attention] || latestFirst(a, b));
    person.attention = person.receipts[0].attention;
  }
  return [...people.values()].sort((a, b) => attentionOrder[a.attention] - attentionOrder[b.attention] || latestFirst(a.receipts[0], b.receipts[0]));
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
    if (run.resultSummary && (!Array.isArray(data) || data.filter(person => person.attention === 'decision').length !== run.resultSummary.decisions)) throw new Error('确认名单与任务汇总不一致，请重试');
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
  return view;
}

function renderResultList(run) {
  const list = byId('result-list'), data = resultsState.data;
  const signature = JSON.stringify([run.id, resultsState.loadedVersion, resultsState.filter, snapshot.candidates?.map(candidate => candidate.id)]);
  if (list.dataset.content === signature) return;
  list.dataset.content = signature;
  const active = list.contains(document.activeElement) ? document.activeElement.dataset.resultFocus : null;
  const people = data?.filter(person => resultsState.filter === 'all' || person.attention === resultsState.filter) ?? [];
  const items = people.map(person => {
    const item = node('li', 'result-person'); item.dataset.attention = person.attention;
    const heading = node('div', 'result-person-heading');
    const candidate = snapshot.candidates?.find(candidate => candidate.id === person.candidateId);
    let name;
    if (candidate) {
      name = node('button', 'person-name candidate-link result-candidate-link', person.name); name.type = 'button';
      name.dataset.candidate = person.candidateId; name.dataset.resultFocus = `name:${person.candidateId}`;
      name.setAttribute('aria-label', `查看 ${person.name} 的候选资料`);
      name.addEventListener('click', () => {
        const current = snapshot.candidates?.find(candidate => candidate.id === person.candidateId);
        if (current) void openCandidate(current, 'results', name);
      });
    } else name = node('strong', 'person-name', person.name);
    heading.append(name, node('span', 'result-attention', { decision: '需你确认', notice: '提醒', none: '已记录' }[person.attention]));
    item.append(heading, node('p', 'result-role', `原岗位：${person.rawRole}`));
    if (!candidate) item.append(node('p', 'result-unavailable', '尚无可打开的台账资料'));
    const receipts = resultsState.filter === 'decision' ? person.receipts.filter(receipt => receipt.attention === 'decision') : person.receipts;
    item.append(receiptView(receipts[0], run));
    if (receipts.length > 1) {
      const details = node('details', 'result-history'), summary = node('summary', 'result-history-summary', `查看其余 ${receipts.length - 1} 条处理记录`);
      summary.dataset.resultFocus = `history:${person.candidateId}`;
      details.open = resultsState.expanded.has(person.candidateId);
      details.append(summary, ...receipts.slice(1).map(receipt => receiptView(receipt, run)));
      details.addEventListener('toggle', () => {
        if (resultsState.runId !== run.id || !details.isConnected) return;
        if (details.open) resultsState.expanded.add(person.candidateId); else resultsState.expanded.delete(person.candidateId);
      });
      item.append(details);
    }
    return item;
  });
  if (!items.length && Array.isArray(data)) items.push(node('li', 'result-empty', data.length ? resultsState.filter === 'decision' ? '当前没有需要你确认的人选。' : '当前没有仅需提醒的人选；需确认事项请查看“需确认”。' : '本轮已明确记录 0 人。'));
  list.replaceChildren(...items);
  if (active) [...list.querySelectorAll('[data-result-focus]')].find(element => element.dataset.resultFocus === active)?.focus({ preventScroll: true });
}

function renderDecisionList(run, people) {
  const list = byId('decision-list'), state = resultsState;
  const signature = JSON.stringify([run.id, state.loadedVersion, state.showAllDecisions, people.map(person => snapshot.candidates?.find(candidate => candidate.id === person.candidateId))]);
  if (list.dataset.content === signature) return;
  if (candidateOrigin?.source === 'decisions') return;
  const active = list.contains(document.activeElement) ? document.activeElement.dataset.decisionFocus : null;
  const previous = new Map([...list.children].map(item => [item.dataset.candidate, item]));
  const items = (state.showAllDecisions ? people : people.slice(0, DECISION_PREVIEW)).map(person => {
    const candidate = snapshot.candidates?.find(candidate => candidate.id === person.candidateId);
    const receipts = person.receipts.filter(receipt => receipt.attention === 'decision');
    const content = JSON.stringify([receipts, candidate, run.steps.map(step => [step.id, step.label])]);
    let item = previous.get(person.candidateId);
    if (!item) { item = node('li', 'decision-person'); item.dataset.candidate = person.candidateId; }
    if (item.dataset.content === content) return item;
    const heading = node('div', 'decision-person-heading');
    let name;
    if (candidate) {
      name = node('button', 'person-name candidate-link', person.name); name.type = 'button';
      name.dataset.candidate = person.candidateId; name.dataset.decisionFocus = `name:${person.candidateId}`;
      name.setAttribute('aria-label', `查看 ${person.name} 的候选资料`);
      name.addEventListener('click', () => {
        const current = snapshot.candidates?.find(candidate => candidate.id === person.candidateId);
        if (current) void openCandidate(current, 'decisions', name);
      });
    } else name = node('strong', 'person-name', person.name);
    const title = node('h3', 'decision-name'); title.append(name);
    const status = node('span', 'decision-status', candidate ? candidateStatus(candidate) : '原状态未知');
    status.title = candidate ? `台账原状态：${candidateStatus(candidate)}` : '尚无关联台账记录，原状态未知';
    status.setAttribute('aria-label', status.title);
    heading.append(title, status);
    const meta = node('p', 'decision-meta', candidate?.role ?? person.rawRole);
    const request = node('div', 'decision-request'), next = node('ul', 'decision-next');
    next.append(...receipts.map(receipt => node('li', '', receipt.nextAction || '尚未记录，请查看依据')));
    request.append(node('p', 'decision-label', '下一步需确认'), next);
    const footer = node('div', 'decision-footer');
    if (candidate) {
      const view = node('button', 'secondary-button decision-profile', '查看资料'); view.type = 'button';
      view.dataset.candidate = person.candidateId; view.dataset.decisionFocus = `profile:${person.candidateId}`;
      view.setAttribute('aria-label', `查看 ${person.name} 的候选资料`);
      view.addEventListener('click', () => {
        const current = snapshot.candidates?.find(candidate => candidate.id === person.candidateId);
        if (current) void openCandidate(current, 'decisions', view);
      });
      footer.append(view);
    } else footer.append(node('p', 'decision-unavailable', '尚无可打开的台账资料'));
    const details = node('details', 'decision-evidence'), summary = node('summary', 'decision-evidence-summary', '查看依据');
    summary.dataset.decisionFocus = `evidence:${person.candidateId}`;
    summary.setAttribute('aria-label', `查看 ${person.name} 的依据，共 ${receipts.length} 条确认记录`);
    details.open = state.decisionExpanded.has(person.candidateId);
    details.append(summary, ...receipts.map(receipt => receiptView(receipt, run, false)));
    details.addEventListener('toggle', () => {
      if (resultsState !== state || !details.isConnected) return;
      if (details.open) state.decisionExpanded.add(person.candidateId); else state.decisionExpanded.delete(person.candidateId);
    });
    footer.append(details);
    item.replaceChildren(heading, meta, request, footer);
    item.dataset.content = content;
    return item;
  });
  for (const item of previous.values()) if (!items.includes(item)) item.remove();
  let position = list.firstElementChild;
  for (const item of items) { if (item !== position) list.insertBefore(item, position); position = item.nextElementSibling; }
  state.decisionExpanded = new Set([...state.decisionExpanded].filter(id => people.some(person => person.candidateId === id)));
  list.dataset.content = signature;
  if (active) [...list.querySelectorAll('[data-decision-focus]')].find(element => element.dataset.decisionFocus === active)?.focus({ preventScroll: true });
}

function confirmationView(run) {
  const counts = run?.resultSummary;
  const decisions = Number.isSafeInteger(counts?.decisions) && counts.decisions >= 0 ? counts.decisions : null;
  const historical = Boolean(run && snapshot?.runs?.some(value => value.createdAt > run.createdAt || (value.createdAt === run.createdAt && value.id < run.id)));
  const base = { decisions, historical, round: historical ? '该任务' : '本轮' };
  if (workspaceBlocked) return { ...base, kind: 'error', fresh: false, message: '工作区连接已变化，请重新打开看板；确认名单已停止更新。' };
  if (disconnected) return { ...base, kind: 'error', fresh: false, message: '连接断开，当前确认事项未知；重新连接后更新。' };
  if (!snapshot) return { ...base, kind: 'loading', fresh: false, message: '正在读取工作区…' };
  if (!run && snapshot.runs !== null && ['ok', 'missing'].includes(snapshot.sources.runs.status)) return { ...base, kind: 'unknown', decisions: null, fresh: false, message: taskSelection.runId ? '所选任务暂不可读，确认事项未知。' : '尚无任务记录，确认事项未知。' };
  if (snapshot.sources.runs.status !== 'ok' || snapshot.sources.runs.stale === true) return { ...base, kind: 'error', fresh: false, message: '任务源暂不可用，当前确认事项未知；等待更新。' };
  if (!run) return { ...base, kind: 'unknown', decisions: null, fresh: false, message: '任务读取失败，确认事项未知。' };
  if (resultsState.status === 'error') return { ...base, kind: 'error', fresh: true, message: `确认名单读取失败：${resultsState.error}。请重试。` };
  if (counts === undefined) return { ...base, kind: 'unknown', decisions: null, fresh: true, message: '此版本未提供确认事项汇总，可在执行记录中查看已有记录。' };
  if (counts === null) return { ...base, kind: 'unknown', decisions: null, fresh: true, message: `${base.round}尚未记录确认事项。` };
  if (decisions === null) return { ...base, kind: 'unknown', decisions: null, fresh: true, message: `${base.round}确认事项数量未知，可在执行记录中查看已有记录。` };
  if (decisions === 0) return { ...base, kind: 'empty', fresh: true, message: `${base.round}暂无需确认` };
  if (!(resultsState.loadedVersion === resultVersion(run) && resultsState.status === 'ready')) return { ...base, kind: 'loading', fresh: true };
  const people = resultsState.data.filter(person => person.receipts.some(receipt => receipt.attention === 'decision'));
  return { ...base, kind: 'pending', fresh: true, people };
}

function renderConfirmations(run, view) {
  const section = byId('confirmations'), heading = byId('decisions-heading'), count = byId('decisions-count');
  const scope = byId('decisions-scope'), status = byId('decisions-status'), summary = byId('decisions-summary');
  const summaryText = byId('decisions-summary-text'), viewButton = byId('view-decisions-records');
  const content = byId('decisions-content'), more = byId('show-more-decisions'), retry = byId('retry-decisions');
  const searching = byId('candidate-query').value.trim().length > 0;
  const listHadFocus = byId('decision-list').contains(document.activeElement);
  const counted = Number.isSafeInteger(view.decisions) && view.decisions >= 0;
  const active = view.fresh && counted && view.decisions > 0 && ['pending', 'loading', 'error'].includes(view.kind);
  const collapsed = searching && searchConfirmations === null && Boolean(run);
  const people = view.people ?? [];
  section.dataset.state = view.kind;
  byId('assistant').dataset.confirmationState = view.kind;
  text('decisions-heading-label', active ? `${view.round}需确认` : '确认事项');
  count.hidden = !active || collapsed;
  text(count, counted ? String(view.decisions) : '');
  count.setAttribute('aria-label', `${view.round}需确认 ${counted ? view.decisions : '未知'} 人`);
  scope.hidden = !active || collapsed;
  const message = view.kind === 'error' ? view.message : view.kind === 'loading' ? view.message ?? `正在${resultsState.data === undefined ? '读取' : '更新'}${view.round}确认名单…` : '';
  text(status, message);
  status.hidden = !message || (collapsed && view.kind !== 'error');
  status.dataset.state = view.kind === 'error' ? 'error' : view.kind;
  retry.hidden = !(view.kind === 'error' && view.fresh);
  const showSummary = view.kind === 'empty' || view.kind === 'unknown' || collapsed;
  summary.hidden = !showSummary;
  text(summaryText, view.kind === 'empty' || view.kind === 'unknown' ? view.message : collapsed ? active ? `${view.round}有 ${view.decisions} 人需确认` : `${view.round}确认事项未知` : '');
  text(viewButton, collapsed && active ? '查看' : '查看记录');
  viewButton.setAttribute('aria-controls', collapsed && active ? 'decisions-content' : 'execution-records');
  viewButton.setAttribute('aria-expanded', String(collapsed && active ? false : byId('execution-records').open));
  viewButton.hidden = !showSummary || (view.kind === 'unknown' && !run);
  const cards = view.kind === 'pending' && (!searching || searchConfirmations !== null) && candidateOrigin?.source !== 'decisions';
  content.hidden = !cards;
  more.hidden = !cards || people.length <= DECISION_PREVIEW;
  text(more, resultsState.showAllDecisions ? '收起其余人选' : `查看其余 ${Math.max(0, people.length - DECISION_PREVIEW)} 人`);
  more.setAttribute('aria-expanded', String(resultsState.showAllDecisions));
  if (cards) renderDecisionList(run, people);
  else if (view.kind === 'empty' || view.kind === 'unknown') {
    resultsState.decisionExpanded.clear(); resultsState.showAllDecisions = false;
    byId('decision-list').replaceChildren(); delete byId('decision-list').dataset.content;
  }
  if (listHadFocus && content.hidden) {
    const target = viewButton.hidden ? (heading.hidden ? status : heading) : viewButton;
    target.focus({ preventScroll: true });
  }
}

function renderRunResults(run) {
  const summary = byId('run-result-summary'), region = byId('run-results'), state = resultsState;
  const historical = Boolean(run && snapshot?.runs?.some(value => value.createdAt > run.createdAt || (value.createdAt === run.createdAt && value.id < run.id)));
  const round = historical ? '该任务' : '本轮';
  const stale = workspaceBlocked || disconnected || snapshot?.sources.runs.status !== 'ok' || snapshot?.sources.runs.stale === true;
  summary.hidden = !run; region.hidden = !run || !state.open;
  const scope = byId('decisions-scope');
  const scopeSignature = JSON.stringify([run?.id, run?.label, run?.role, run?.createdAt, historical, Boolean(searchConfirmations)]);
  if (scope.dataset.content !== scopeSignature) {
    const children = [];
    if (run) {
      const task = node('p', 'decision-task');
      const name = node('span', 'decision-task-name', `${run.label}${run.role ? ` · ${run.role}` : ''}`);
      const created = node('time', 'decision-task-time', time(run.createdAt));
      created.dateTime = run.createdAt;
      task.append(name, created); children.push(task);
    }
    if (!historical) children.push(node('p', 'decision-task-note', '仅此任务，岗位筛选不改变本轮。'));
    if (searchConfirmations) children.push(node('p', 'decision-task-note', '此处显示整轮确认事项，不受姓名搜索筛选。'));
    if (historical) children.push(node('p', 'decision-task-notice', '有新任务，当前保留所选记录。'));
    scope.replaceChildren(...children);
    scope.dataset.content = scopeSignature;
  }
  text('run-results-heading', `${round}处理记录`);
  if (state.status === 'loading' && (!run || state.requestedVersion !== resultVersion(run))) { resultsRequest++; state.status = 'idle'; state.requestedVersion = null; }
  const view = confirmationView(run);
  renderConfirmations(run, view);
  const counts = run?.resultSummary;
  text('run-result-total', counts == null ? '未记录' : `${counts.total} 人`);
  text('run-result-decisions', view.decisions === null ? '未记录' : `${view.decisions} 人`);
  for (const id of ['show-run-results', 'show-run-decisions']) if (byId(id).getAttribute('aria-expanded') !== String(state.open)) byId(id).setAttribute('aria-expanded', String(state.open));
  byId('result-stale-note').hidden = !stale || !run;
  text('result-stale-note', disconnected ? '连接断开，人数与名单以最近一次成功读取为准。' : '任务源陈旧，人数与名单以最近一次成功读取为准。');
  if (!run) return;
  if (state.open) {
    for (const button of byId('results-filters').querySelectorAll('button')) button.setAttribute('aria-pressed', String(button.dataset.resultsFilter === state.filter));
    const status = byId('results-status');
    status.dataset.state = state.status;
    const message = state.status === 'loading' ? state.data === undefined ? '正在读取处理名单…' : '正在更新处理名单；以下保留上次读取的记录。' : state.status === 'error' ? `处理名单读取失败：${state.error}。${state.data !== undefined ? '以下是上次成功读取的记录（陈旧），未代表本次更新。' : '可重试读取。'}` : state.data === null ? '此任务尚未记录处理名单。' : state.data !== undefined ? `已读取 ${state.data.length} 人的处理记录${state.updatedAt ? ` · 收据更新 ${time(state.updatedAt)}` : ''}` : '等待读取处理名单。';
    text(status, message);
    byId('retry-results').hidden = state.status !== 'error';
    byId('results-filters').hidden = !Array.isArray(state.data) || !state.data.length;
    byId('result-list').hidden = !Array.isArray(state.data);
    byId('result-list').dataset.state = ['loading', 'error'].includes(state.status) ? 'stale' : 'ready';
    renderResultList(run);
  }
  if (!stale && (state.open || (view.decisions ?? 0) > 0) && state.requestedVersion !== resultVersion(run)) void loadRunResults();
}

function openRunResults(filter) {
  const run = selectedRun();
  if (!run) return;
  if (['results', 'decisions'].includes(candidateOrigin?.source)) closeCandidate();
  byId('execution-records').open = true;
  resultsState.open = true; resultsState.filter = filter;
  renderRunResults(run);
}

function renderRuns() {
  const runs = snapshot.runs === null ? null : [...snapshot.runs].sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id));
  const hold = Boolean(layoutState.editing || selectedCandidateId || selectedStage || resultsState.open || resultsState.decisionExpanded.size || resultsState.showAllDecisions || byId('candidate-query').value.trim() || byId('role-query').value.trim() || byId('role-search-disclosure').open || byId('execution-records').open || !byId('following-picker').hidden || !byId('role-manager').hidden || byId('steps-detail').open || document.activeElement?.closest('.workbench-search, #workspace-nav, .search-section, #role-browser, #confirmations, .task-section'));
  const choice = selectTask(runs, taskSelection, hold);
  if (hold && taskSelection.mode === 'live' && taskSelection.runId && choice.newerRunId) choice.selection = { mode: 'pinned', runId: taskSelection.runId };
  taskSelection = choice.selection;
  const run = choice.run, selectedRunId = taskSelection.runId;
  const labels = (runs ?? []).map(value => `${value.label}${value.role ? ` · ${value.role}` : ''}`);
  const values = (runs ?? []).map((value, index) => [value.id, `${labels[index]} · ${shortTime(value.createdAt)}${labels.filter(label => label === labels[index]).length > 1 ? ` · ${value.id}` : ''}`]);
  if (selectedRunId && !run) values.unshift([selectedRunId, runs === null ? '所选任务暂不可读' : '所选任务记录已移除']);
  if (!values.length) values.push(['', runs === null ? '进度读取失败' : '尚无任务进度记录']);
  options(runSelect, values, selectedRunId ?? ''); runSelect.disabled = !runs?.length;
  for (const [id, mode] of [['follow-live', 'live'], ['pin-run', 'pinned']]) if (byId(id).getAttribute('aria-pressed') !== String(taskSelection.mode === mode)) byId(id).setAttribute('aria-pressed', String(taskSelection.mode === mode));
  byId('latest-run').hidden = taskSelection.mode === 'live' && !choice.newerRunId;
  const notice = [selectionMessage, choice.newerRunId ? '新任务可查看；当前记录保持选定。' : taskSelection.mode === 'pinned' ? '已固定所选任务，自动读取该任务的更新。' : document.hidden ? '后台低频读取；返回后恢复跟随。' : '自动跟随最新创建的任务。'].filter(Boolean).join(' ');
  text('selection-note', notice); byId('selection-note').hidden = false; writeTaskURL();
  if (resultsState.runId !== selectedRunId) { if (candidateOrigin?.source !== 'search') closeCandidate(); resetRunResults(selectedRunId); resetActivity(selectedRunId); byId('steps-detail').open = false; }
  const transition = run ? JSON.stringify([run.status, run.steps.map(step => [step.id, step.status]), run.resultSummary?.revision ?? 0]) : null;
  if (run && displayedRun?.id === run.id && displayedRun.signature !== transition) flash(byId('task-card'));
  displayedRun = run ? { id: run.id, signature: transition } : null;
  renderRunResults(run); syncActivity(run); byId('run-activity').hidden = !run;
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
  if (selectedStage !== null) {
    const stage = view.stages.find(stage => stage.id === selectedStage);
    const members = view.candidates?.filter(candidate => candidate.stage === selectedStage);
    text('detail-title', stage.label);
    text('detail-count', stage.count === null ? '记录数未知' : `${stage.count} 条候选记录`);
    const signature = JSON.stringify([rolePreferences.scope, rolePreferences.following, rolePreferences.role, selectedStage, stage.count, members]);
    const list = byId('candidate-list');
    if (list.dataset.content !== signature) {
      list.dataset.content = signature;
      const candidates = (members ?? []).map(candidate => {
        const item = node('li', 'candidate-row candidate');
        const body = node('div'), heading = node('div', 'person-heading candidate-heading');
        const name = node('button', 'person-name candidate-name candidate-link', candidate.name); name.type = 'button'; name.dataset.candidate = candidate.id;
        name.setAttribute('aria-label', `查看 ${candidate.name} 的候选资料`);
        name.addEventListener('click', () => { void openCandidate(candidate, 'stage', name); });
        heading.append(name);
        const status = node('span', 'person-status', candidateStatus(candidate));
        status.setAttribute('aria-label', `原始状态：${candidateStatus(candidate)}`);
        body.append(heading, node('p', 'person-role candidate-meta', candidate.role));
        if (candidate.rawRole && candidate.rawRole !== candidate.role) body.append(node('p', 'person-role', `原岗位：${candidate.rawRole}`));
        body.append(status);
        item.append(body); return item;
      });
      if (!candidates.length) candidates.push(node('li', 'empty-state', stage.count === null ? '台账未读取，记录数未知' : '此阶段暂无候选记录'));
      list.replaceChildren(...candidates);
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
}

byId('back-to-list').addEventListener('click', () => {
  const origin = candidateOrigin;
  closeCandidate();
  if (snapshot && !workspaceBlocked) renderRunResults(selectedRun());
  if (origin?.source === 'search') renderCandidateSearch();
  const list = byId({ decisions: 'decision-list', results: 'result-list', activity: 'activity-list', stage: 'candidate-list', search: 'candidate-search-list' }[origin?.source ?? 'stage']);
  const decisionFocus = origin?.trigger?.dataset.decisionFocus;
  const target = origin?.trigger?.isConnected ? origin.trigger : decisionFocus ? [...list.querySelectorAll('[data-decision-focus]')].find(button => button.dataset.decisionFocus === decisionFocus) : [...list.querySelectorAll('.candidate-link')].find(button => button.dataset.candidate === origin?.candidateId);
  const fallback = origin?.source === 'search' ? byId('candidate-query') : origin?.source === 'decisions' ? byId('decisions-heading') : origin?.source === 'stage' ? stageButtons.get(selectedStage) : byId(resultsState.filter === 'decision' ? 'show-run-decisions' : 'show-run-results');
  if (origin?.searchPosition) restoreSearchPosition(origin.searchPosition, fallback);
  else (target?.getClientRects().length ? target : fallback)?.focus({ preventScroll: true });
});
for (const scope of ROLE_SCOPES) {
  const button = node('button', '', scope.label); button.type = 'button'; button.dataset.scope = scope.id;
  button.setAttribute('aria-pressed', String(scope.id === rolePreferences.scope));
  button.addEventListener('click', () => {
    if (rolePreferences.scope === scope.id) return;
    if (candidateOrigin?.source === 'stage') closeCandidate();
    rolePreferences.scope = scope.id; rolePreferences.role = '';
    persistRolePreferences();
    if (snapshot) { const view = renderRoleControls(); renderStages(true, view); }
  });
  byId('role-scopes').append(button);
}
byId('candidate-query').addEventListener('input', changeCandidateSearch);
byId('candidate-query').addEventListener('keydown', event => {
  if (event.key === 'Escape' && !event.isComposing && event.keyCode !== 229) { event.preventDefault(); clearCandidateSearch(); }
});
byId('clear-candidate-search').addEventListener('click', clearCandidateSearch);
byId('show-more-candidates').addEventListener('click', () => {
  const firstNew = searchCandidates(snapshot, byId('candidate-query').value)?.[candidateSearchLimit]?.id;
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
byId('view-decisions-records').addEventListener('click', () => {
  const searching = byId('candidate-query').value.trim().length > 0;
  const view = confirmationView(selectedRun());
  if (searching && (view.decisions ?? 0) > 0 && view.fresh) {
    searchConfirmations = candidateOrigin?.searchPosition ?? captureSearchPosition();
    if (candidateOrigin) closeCandidate();
    renderCandidateSearch();
    renderRunResults(selectedRun());
    focusWorkbenchTarget(byId('decisions-heading'), 'nearest');
    return;
  }
  byId('execution-records').open = true;
  focusWorkbenchTarget(workspaceNavTargets.tasks, 'nearest');
});
byId('return-to-search').addEventListener('click', () => {
  const position = searchConfirmations;
  searchConfirmations = null;
  if (candidateOrigin) closeCandidate();
  renderCandidateSearch();
  if (snapshot) renderRunResults(selectedRun());
  if (position) restoreSearchPosition(position, byId('candidate-query'));
});
for (const id of ['choose-following', 'workspace-choose-following']) byId(id).addEventListener('click', event => toggleFollowingPicker(event.currentTarget));
byId('following-query').addEventListener('input', () => { if (snapshot) renderFollowingPicker(); });
byId('finish-following').addEventListener('click', () => {
  byId('following-picker').hidden = true;
  for (const id of ['choose-following', 'workspace-choose-following']) byId(id).setAttribute('aria-expanded', 'false');
  const target = visibleWorkbenchTarget(followingPickerTrigger) ? followingPickerTrigger : byId('choose-following');
  target.focus({ preventScroll: true });
});
byId('show-run-results').addEventListener('click', () => openRunResults('all'));
byId('show-run-decisions').addEventListener('click', () => openRunResults('decision'));
for (const button of byId('results-filters').querySelectorAll('button')) button.addEventListener('click', () => {
  resultsState.filter = button.dataset.resultsFilter;
  renderRunResults(selectedRun());
});
byId('collapse-results').addEventListener('click', () => {
  if (candidateOrigin?.source === 'results') closeCandidate();
  const target = resultsState.filter === 'decision' ? 'show-run-decisions' : 'show-run-results';
  resultsState.open = false; renderRunResults(selectedRun()); byId(target).focus({ preventScroll: true });
});
byId('retry-results').addEventListener('click', () => { void loadRunResults(); });
byId('retry-decisions').addEventListener('click', () => { void loadRunResults(); });
byId('show-more-decisions').addEventListener('click', () => {
  resultsState.showAllDecisions = !resultsState.showAllDecisions;
  renderRunResults(selectedRun());
});
byId('execution-records').addEventListener('toggle', () => {
  if (!byId('execution-records').open) {
    if (['results', 'activity'].includes(candidateOrigin?.source)) closeCandidate();
    resultsState.open = false; byId('steps-detail').open = false;
  }
  if (snapshot && !workspaceBlocked) { renderRunResults(selectedRun()); syncActivity(selectedRun()); }
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
    roleInfo = result;
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
  rolePreferences.role = roleSelect.value; persistRolePreferences();
  if (snapshot) { const view = renderRoleControls(); renderStages(true, view); }
});
function chooseTask(selection, message = '') {
  const changed = taskSelection.runId !== selection.runId || selection.mode === 'live';
  if (changed) { if (candidateOrigin?.source !== 'search') closeCandidate(); resetRunResults(selection.runId); resetActivity(selection.runId); byId('steps-detail').open = false; }
  taskSelection = selection; selectionMessage = message; writeTaskURL();
  if (snapshot) renderRuns();
}
runSelect.addEventListener('change', () => chooseTask({ mode: 'pinned', runId: runSelect.value || null }));
byId('pin-run').addEventListener('click', () => { taskSelection.mode = 'pinned'; selectionMessage = ''; if (snapshot) renderRuns(); runSelect.focus({ preventScroll: true }); });
for (const id of ['follow-live', 'latest-run']) byId(id).addEventListener('click', () => {
  chooseTask({ mode: 'live', runId: null });
  if (id === 'latest-run') byId('follow-live').focus({ preventScroll: true });
});
window.addEventListener('popstate', () => { const selection = readTaskURL(); chooseTask(selection, selectionMessage); });
byId('steps-detail').addEventListener('toggle', () => { byId('steps-summary').textContent = byId('steps-detail').open ? '收起全部步骤' : '查看全部步骤'; });
byId('collapse-stage').addEventListener('click', () => {
  if (candidateOrigin?.source === 'stage') closeCandidate();
  const previous = selectedStage;
  selectedStage = null;
  if (snapshot) renderStages();
  stageButtons.get(previous)?.focus({ preventScroll: true });
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
  workspaceBlocked = true; snapshotController.suspend(); activityRequest++; activityAbort?.abort();
  resultsRequest++; recordRequest++; documentRequest++; roleRequest++;
  text('activity-status', '工作区连接已变化，以下保留上次读取的动态。'); byId('activity-status').hidden = false;
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
}

const snapshotController = createSnapshotController({
  isVisible: () => !document.hidden,
  load: async signal => {
    const next = await jsonRequest('/api/snapshot', { signal });
    if (next.schemaVersion !== 1 || !next.sources) throw new Error('快照格式不兼容');
    if (expectedWorkspaceKey && next.workspaceKey !== expectedWorkspaceKey) { blockWorkspace(); throw new Error('服务已指向其他工作区，请重新打开'); }
    if (!expectedWorkspaceKey && next.workspaceKey) expectedWorkspaceKey = next.workspaceKey;
    return next;
  },
  onSnapshot: next => { snapshot = next; disconnected = false; render(); },
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
      text('run-context', '进度未知，等待恢复读取。'); text('ledger-state', '候选记录数未知，等待恢复读取。');
      text('source-status', '本地文件 · 连接失败'); byId('source-dot').dataset.state = 'error';
    }
  }
});
byId('retry-activity').addEventListener('click', () => { void loadActivity(true); });
byId('refresh-board').addEventListener('click', () => { void snapshotController.refresh({ invalidate: true }); });
function resumeReading() {
  pageActive = true; document.documentElement.dataset.pageVisible = String(!document.hidden);
  if (workspaceBlocked) return;
  if (snapshot) renderRuns();
  void snapshotController.resume();
}
document.addEventListener('visibilitychange', () => {
  document.documentElement.dataset.pageVisible = String(!document.hidden);
  if (snapshot && !workspaceBlocked) renderRuns();
  if (!document.hidden) resumeReading();
});
window.addEventListener('focus', resumeReading);
window.addEventListener('pageshow', resumeReading);
window.addEventListener('pagehide', () => {
  pageActive = false; document.documentElement.dataset.pageVisible = 'false'; snapshotController.suspend();
  activityRequest++; activityAbort?.abort(); activityState.status = 'idle'; activityState.requestedRevision = null;
  resultsRequest++; if (resultsState.status === 'loading') { resultsState.status = 'idle'; resultsState.requestedVersion = null; }
});
if (workspaceBlocked) blockWorkspace(); else resumeReading();
