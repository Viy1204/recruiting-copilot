import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM, VirtualConsole } from 'jsdom';
import * as model from '../skills/recruit-board/model.mjs';
import { createSnapshotController } from '../skills/recruit-board/public/live.mjs';

const [html, source] = await Promise.all([
  readFile(new URL('../skills/recruit-board/public/index.html', import.meta.url), 'utf8'),
  readFile(new URL('../skills/recruit-board/public/app.js', import.meta.url), 'utf8')
]);
const workspaceKey = 'a'.repeat(64);
const now = '2026-11-04T04:00:00.000Z';
const old = '2026-10-24T04:00:00.000Z';
const counts = () => ({ pending: 0, running: 0, done: 0, failed: 0, uncertain: 0, cancelled: 0 });

function run(id, createdAt, options = {}) {
  const value = model.createRun({ id, workflow: 'daily', trigger: 'manual', now: createdAt });
  return { ...value, status: 'completed', steps: value.steps.map(step => ({ ...step, status: 'completed' })), ...options };
}

function decision(id, options = {}) {
  return {
    schemaVersion: 1, id, title: `合成事项 ${id}`, state: 'open', effectiveState: 'open', revision: 1,
    identity: { subjectKey: `role:internal-${id}`, questionKey: `question:${id}`, scope: '合成工程岗 · 当前招聘' },
    createdAt: old, updatedAt: now, deadline: null, blocking: false, snoozedUntil: null, reason: null,
    sources: [{ runId: 'old-round', recordedAt: old }], decision: null, actions: [], history: [],
    followUp: { status: 'none', counts: counts() }, ...options
  };
}

function highlight(eventKey, options = {}) {
  return { eventKey, text: `合成重点 ${eventKey}`, evidence: '已核实的合成依据', decisionId: null, subjectKey: 'role:internal-object', occurredAt: now, updatedAt: now, correction: null, ...options };
}

function overview(decisions = [], highlights = []) {
  return {
    status: 'ok', updatedAt: now, revision: '1', decisions, highlights,
    counts: {
      open: decisions.filter(item => item.effectiveState === 'open').length,
      snoozed: decisions.filter(item => item.effectiveState === 'snoozed').length,
      history: decisions.filter(item => item.effectiveState === 'history_review').length,
      followUp: decisions.filter(item => item.state === 'decided' && ['pending', 'running', 'failed', 'uncertain'].includes(item.followUp.status)).length
    }, diagnostics: []
  };
}

function fixture() {
  const older = run('old-round', old, { highlights: [highlight('older-event', { text: '超过七天的原轮次重点', occurredAt: old, updatedAt: old })], highlightsRevision: 1, summaryState: 'highlights' });
  const recent = run('recent-round', now, { trigger: 'scheduled', summaryState: 'no_change', closingSummary: '已核查，无重要变化' });
  const snapshot = model.buildSnapshot({
    workspace: 'DOM 合成验收', generatedAt: now,
    ledger: { status: 'ok', text: `${model.LEDGER_COLUMNS.join(',')}\n1,合成甲,合成工程岗,,A,已回复,合成来源,,\n`, updatedAt: now },
    context: { status: 'ok', text: '## 四、在招岗位与优先级\n\n| 状态 | 岗位 | 优先级 |\n|---|---|---|\n| 在招 | 合成工程岗 | P0 |\n| 在招 | 合成产品岗 | P1 |\n', updatedAt: now },
    runFiles: { status: 'ok', files: [older, recent].map(value => ({ name: `${value.id}.json`, text: JSON.stringify(value) })) }
  });
  snapshot.workspaceKey = workspaceKey;
  return { snapshot, overview: overview(), runs: new Map([older, recent].map(value => [value.id, value])), overrides: new Map() };
}

async function settle() {
  for (let index = 0; index < 4; index++) await new Promise(resolve => setTimeout(resolve, 0));
}

function visible(element) {
  if (!element || element.closest('[hidden]')) return false;
  for (let parent = element; parent; parent = parent.parentElement) {
    if (parent.tagName === 'DIALOG' && !parent.open) return false;
    if (parent.tagName === 'DETAILS' && !parent.open && !parent.querySelector(':scope > summary')?.contains(element)) return false;
  }
  return true;
}

async function page(t, data = fixture(), options = {}) {
  const errors = [], calls = [], scrolls = [], controllers = [];
  const console = new VirtualConsole();
  console.on('jsdomError', error => errors.push(error));
  const dom = new JSDOM(html, { url: `http://localhost:4397/?workspace=${workspaceKey}${options.query ?? ''}`, runScripts: 'outside-only', pretendToBeVisual: true, virtualConsole: console });
  const window = dom.window;
  window.addEventListener('error', event => errors.push(event.error));
  window.matchMedia = () => ({ matches: true, addEventListener() {}, removeEventListener() {} });
  if (!window.Element.prototype.replaceChildren) window.Element.prototype.replaceChildren = function (...children) { while (this.firstChild) this.removeChild(this.firstChild); this.append(...children); };
  window.HTMLElement.prototype.scrollIntoView = function () { scrolls.push(this.id || this.className); };
  window.HTMLElement.prototype.getClientRects = function () { return visible(this) ? [{}] : []; };
  window.scrollBy = (...args) => scrolls.push(args);
  window.scrollTo = (x, y) => { scrolls.push([x, y]); window.scrollY = y; };
  window.AbortController = AbortController; window.AbortSignal = AbortSignal;
  window.__model = model;
  window.__createSnapshotController = settings => {
    const controller = createSnapshotController({ ...settings, setTimer: () => 1, clearTimer() {} });
    controllers.push(controller); return controller;
  };
  for (const [key, value] of Object.entries(options.storage ?? {})) window.localStorage.setItem(key, value);
  window.fetch = async (path, init = {}) => {
    const url = new URL(path, window.location.href);
    calls.push({ path: url.pathname, run: url.searchParams.get('run'), key: new Headers(init.headers).get('X-Workspace-Key'), signal: init.signal });
    const override = data.overrides.get(url.pathname);
    if (override) return await override(url, init);
    let payload;
    if (url.pathname === '/api/snapshot') payload = data.snapshot;
    else if (url.pathname === '/api/workspace/overview') payload = data.overview;
    else {
      const value = data.runs.get(url.searchParams.get('run'));
      if (url.pathname === '/api/runs/highlights') payload = { runId: value.id, highlights: value.highlights ?? null, revision: value.highlightsRevision ?? 0, updatedAt: value.updatedAt, trigger: value.trigger, summaryState: value.summaryState, closingSummary: value.closingSummary };
      else if (url.pathname === '/api/runs/results') payload = { runId: value.id, results: value.results, revision: value.resultsRevision, updatedAt: value.updatedAt };
      else if (url.pathname === '/api/runs/activity') payload = { runId: value.id, items: value.results.slice(-3), revision: value.resultsRevision, updatedAt: value.updatedAt };
      else throw new Error(`未声明的测试接口 ${url.pathname}`);
    }
    return Response.json(structuredClone(payload));
  };
  const executable = source.replace(/^import .* from '\/model\.mjs';\r?\n/, 'const { candidateStatus, candidateSubject, validateContext, ROLE_SCOPES, RUN_LABELS, searchCandidates, selectRoles, selectTask, STAGES, STEP_LABELS } = window.__model;\n').replace(/^import .* from '\/live\.mjs';\r?\n/m, 'const createSnapshotController = window.__createSnapshotController;\n');
  window.eval(`(() => {\n${executable}\n})();`);
  t.after(() => { window.dispatchEvent(new window.Event('pagehide')); window.close(); assert.deepEqual(errors, []); });
  await settle();
  const $ = selector => window.document.querySelector(selector);
  const all = selector => [...window.document.querySelectorAll(selector)];
  const click = async selector => { const target = $(selector); assert.ok(visible(target), `可见交互入口 ${selector}`); target.focus(); target.click(); await settle(); };
  const refresh = async () => { await Promise.all(controllers.map(controller => controller.refresh({ invalidate: true }))); await settle(); };
  const nav = target => click(`#workspace-nav [data-nav-target="${target}"]`);
  const selectRun = async id => { await nav('tasks'); $('#run').value = id; $('#run').dispatchEvent(new window.Event('change')); await settle(); };
  const group = async value => { assert.ok(visible($('#workspace-drawer-filter'))); $('#workspace-drawer-filter').value = value; $('#workspace-drawer-filter').dispatchEvent(new window.Event('change')); await settle(); };
  const assertView = id => assert.deepEqual(all('#layout-root > section').filter(visible).map(element => element.id), [id]);
  return { data, window, $, all, click, refresh, selectRun, calls, scrolls, nav, group, assertView };
}

const homeDecision = id => `#workspace-decision-list [data-decision="${id}"] button`;
const drawerDecision = id => `#workspace-drawer-list [data-decision="${id}"] button`;

test('未接入显示未知；全部事项中的六个分组可访问且无批准按钮', async t => {
  const data = fixture();
  data.overview = { ...overview(), status: 'missing', decisions: null, highlights: null, counts: { open: null, snoozed: null, history: null, followUp: null } };
  const p = await page(t, data);
  p.assertView('assistant');
  assert.match(p.$('#workspace-overview-status').textContent, /尚未接入.*未知/);
  assert.match(p.$('#workspace-all-decisions').textContent, /未知/);
  assert.equal(p.$('#workspace-followup-link').hidden, true);
  await p.click('#workspace-all-decisions');
  assert.equal(p.$('#workspace-drawer').open, true);
  assert.equal(p.all('#workspace-drawer-filter option').length, 6);
  assert.ok(p.all('#workspace-drawer-filter option').every(option => option.textContent.includes('未知')));
  await p.group('followUp');
  assert.match(p.$('#workspace-drawer-empty').textContent, /未知/);
  assert.equal(p.all('#workspace-drawer button').some(button => /^(批准|拒绝|同意)$/.test(button.textContent)), false);
  assert.equal(p.calls.some(call => call.path === '/api/runs/highlights'), false);
  assert.ok(p.calls.every(call => call.key === workspaceKey));
});

test('工作区事项不随岗位轮次筛选；首页保留服务端处理优先顺序', async t => {
  const data = fixture();
  data.overview = overview([
    decision('blocking', { blocking: true }), decision('ordinary'), decision('first', { deadline: '2026-11-05T00:00:00.000Z' }),
    decision('later', { deadline: '2026-11-06T00:00:00.000Z' }),
    decision('snoozed', { state: 'snoozed', effectiveState: 'snoozed', snoozedUntil: '2026-12-01T00:00:00.000Z' }),
    decision('history', { state: 'history_review', effectiveState: 'history_review' })
  ]);
  const p = await page(t, data);
  assert.equal(p.$('#workspace-decisions-heading').textContent, '待你确认');
  assert.equal(p.$('#workspace-decisions-count').textContent, '4 项');
  assert.equal(p.$('#workspace-all-decisions').textContent, '全部事项 · 6');
  assert.deepEqual(p.all('#workspace-decision-list > li').map(item => item.dataset.decision), ['blocking', 'ordinary', 'first']);
  assert.doesNotMatch(p.$('#workspace-decision-list').textContent, /role:internal/);
  await p.nav('roles');
  p.$('#role').value = '合成产品岗'; p.$('#role').dispatchEvent(new p.window.Event('change'));
  await p.selectRun('old-round'); await p.nav('overview');
  assert.equal(p.$('#role').value, '合成产品岗');
  assert.equal(p.$('#workspace-all-decisions').textContent, '全部事项 · 6');
  await p.click('#workspace-all-decisions'); await p.group('open');
  assert.equal(p.all('#workspace-drawer-list [data-decision]').length, 4);
  await p.group('snoozed');
  assert.deepEqual(p.all('#workspace-drawer-list [data-decision]').map(item => item.dataset.decision), ['snoozed']);
  await p.group('history_review');
  assert.deepEqual(p.all('#workspace-drawer-list [data-decision]').map(item => item.dataset.decision), ['history']);
});

test('无待确认时直接预览后续执行；详情保留动作原因与处理历史', async t => {
  const data = fixture();
  const answer = { text: '仅同意当前合成岗位', scope: '当前合成岗位', authority: '合成聊天答复', expiresAt: null, revision: 2, recordedAt: now };
  data.overview = overview([
    decision('follow', { state: 'decided', effectiveState: 'decided', decision: answer, actions: [
      { id: 'sync', label: '同步岗位资料', kind: 'sync', status: 'pending', reason: null, evidence: null, verification: null, decisionRevision: 2, updatedAt: now },
      { id: 'external', label: '合成外部动作', kind: 'external', status: 'failed', reason: '接口拒绝', evidence: '收到失败响应', verification: null, decisionRevision: 2, updatedAt: now }
    ], followUp: { status: 'failed', counts: { ...counts(), pending: 1, failed: 1 } } }),
    decision('closed', { state: 'closed', effectiveState: 'closed', decision: answer, blocking: true })
  ]);
  const p = await page(t, data);
  assert.equal(p.$('#workspace-decisions-heading').textContent, '后续执行');
  assert.equal(p.$('#workspace-followup-link').hidden, true);
  assert.doesNotMatch(p.$('#assistant').textContent, /0 项未解决/);
  await p.click(homeDecision('follow'));
  assert.ok(visible(p.$('#workspace-drawer-detail')));
  assert.match(p.$('#workspace-drawer-detail').textContent, /资料待同步/);
  assert.match(p.$('#workspace-drawer-detail').textContent, /执行失败/);
  assert.match(p.$('#workspace-drawer-detail').textContent, /接口拒绝/);
  assert.doesNotMatch(p.$('#workspace-drawer-detail').textContent, /完成依据：收到失败响应/);
  assert.equal(p.$('#workspace-drawer-detail .workspace-decision-sources').open, false);
  await p.click('#workspace-drawer-back'); await p.group('closed'); await p.click(drawerDecision('closed'));
  assert.doesNotMatch(p.$('#workspace-drawer-detail').textContent, /有后续动作等待该决定/);
});

test('抽屉阅读期间轮询保留节点位置，新内容和新轮次仅在实际变更时提示', async t => {
  const data = fixture();
  data.overview = overview([decision('kept')], [highlight('recent-event', { runId: 'old-round', trigger: 'manual', sourceRunIds: ['old-round'] })]);
  const p = await page(t, data);
  p.$(homeDecision('kept')).focus(); await p.refresh();
  assert.equal(p.$('#workspace-reading-notice').hidden, true);
  await p.click('#workspace-all-decisions'); await p.group('open');
  assert.equal(p.$('#workspace-drawer-update').hidden, true);
  const row = p.$('#workspace-drawer-list > li');
  p.$('#workspace-drawer-content').scrollTop = 120;
  await p.click(drawerDecision('kept'));
  await p.click('#workspace-drawer-detail .workspace-decision-history > summary');
  const detail = p.$('#workspace-drawer-detail > div'), history = detail.querySelector('details.workspace-decision-history');
  history.querySelector('summary').focus(); p.$('#workspace-drawer-content').scrollTop = 330;
  const scrolls = p.scrolls.length;
  await p.refresh();
  assert.equal(p.$('#workspace-drawer-detail > div'), detail);
  assert.equal(p.window.document.activeElement, history.querySelector('summary'));
  assert.equal(p.$('#workspace-drawer-update').hidden, true);
  const newer = run('new-round', '2026-11-04T05:00:00.000Z', { trigger: 'scheduled', summaryState: 'no_change' });
  data.runs.set(newer.id, newer); data.snapshot.runs.unshift(model.runSummary(newer));
  data.overview = overview([decision('kept', { title: '更新后的决定标题', revision: 2 }), decision('new')], data.overview.highlights);
  await p.refresh();
  assert.equal(p.$('#workspace-drawer-detail > div'), detail);
  assert.equal(p.$('#run').value, 'recent-round');
  assert.equal(p.$('#workspace-drawer-update').hidden, false);
  assert.equal(p.$('#workspace-drawer-content').scrollTop, 330);
  assert.equal(p.scrolls.length, scrolls);
  await p.click('#workspace-drawer-update');
  assert.match(p.$('#workspace-drawer-detail h3').textContent, /更新后的决定标题/);
  assert.equal(p.$('#workspace-drawer-detail .workspace-decision-history').open, true);
  assert.equal(p.$('#workspace-drawer-content').scrollTop, 330);
  await p.click('#workspace-drawer-back');
  assert.equal(p.$('#workspace-drawer-filter').value, 'open');
  assert.equal(p.$('#workspace-drawer-content').scrollTop, 120);
  assert.equal(p.all('#workspace-drawer-list [data-decision]').length, 2);
  assert.notEqual(p.$('#workspace-drawer-list > li'), row);
  await p.click('#workspace-drawer-close');
  assert.equal(p.$('#workspace-return-overview').hidden, false);
  await p.click('#workspace-return-overview');
  p.assertView('tasks'); assert.equal(p.$('#run').value, 'new-round');
});

test('读取失败保留最后内容与读取时间，恢复后未接入不能伪装为零', async t => {
  const data = fixture(); data.overview = overview([decision('kept')]);
  const p = await page(t, data);
  const original = p.$('#workspace-decision-list > li');
  data.overrides.set('/api/workspace/overview', () => Response.json({ error: { message: '合成读取故障' } }, { status: 503 }));
  await p.refresh();
  assert.equal(p.$('#workspace-decision-list > li'), original);
  assert.match(p.$('#workspace-overview-status').textContent, /合成读取故障.*最后成功读取/);
  await p.click('#source-details > summary');
  assert.match(p.$('#workspace-overview-recorded').textContent, /最后成功读取/);
  await p.click('#source-details > summary');
  await p.click(homeDecision('kept'));
  assert.match(p.$('#workspace-drawer-notice').textContent, /合成读取故障/);
  data.overrides.delete('/api/workspace/overview');
  data.overview = { ...overview(), status: 'missing', decisions: null, highlights: null, counts: { open: null, snoozed: null, history: null, followUp: null } };
  await p.refresh();
  assert.match(p.$('#workspace-drawer-detail h3').textContent, /合成事项 kept/);
  assert.match(p.$('#workspace-drawer-notice').textContent, /陈旧/);
  await p.click('#workspace-drawer-close');
  assert.equal(p.$('#workspace-all-decisions').textContent, '全部事项 · 1');
});

test('抽屉来源链接关闭面板进入原轮次，超过七天重点仍可读且更新保留依据', async t => {
  const data = fixture(); data.overview = overview([decision('source')]);
  const p = await page(t, data);
  await p.click(homeDecision('source'));
  await p.click('#workspace-drawer-detail .workspace-decision-sources > summary');
  const link = p.$('#workspace-drawer-detail .workspace-run-link');
  assert.equal(new URL(link.href).searchParams.get('workspace'), workspaceKey);
  assert.equal(new URL(link.href).searchParams.get('run'), 'old-round');
  await p.click('#workspace-drawer-detail .workspace-run-link');
  assert.equal(p.$('#workspace-drawer').open, false); p.assertView('tasks');
  assert.equal(p.$('#run').value, 'old-round');
  assert.match(p.$('#run-highlight-list').textContent, /超过七天的原轮次重点/);
  assert.equal(new URL(p.window.location.href).searchParams.get('run'), 'old-round');
  const original = p.$('#run-highlight-list > li');
  await p.click('#run-highlight-list .workspace-highlight-evidence > summary');
  const evidence = original.querySelector('details');
  const changed = data.runs.get('old-round');
  changed.highlights = [highlight('older-event', { text: '更正后的历史重点', correction: '核实后调整结论', occurredAt: old })]; changed.highlightsRevision = 2;
  data.snapshot.runs.find(value => value.id === 'old-round').highlightsRevision = 2;
  await p.refresh();
  assert.equal(p.$('#run-highlight-list > li'), original);
  assert.equal(p.$('#apply-run-highlights').hidden, false); assert.equal(evidence.open, true);
  await p.click('#apply-run-highlights');
  assert.match(p.$('#run-highlight-list').textContent, /更正后的历史重点/);
  assert.equal(p.$('#run-highlight-list details').open, true);
  assert.doesNotMatch(p.$('#run-highlight-list').textContent, /role:internal/);
  const readCount = p.calls.filter(call => call.path === '/api/runs/highlights').length;
  await p.click('#execution-records > summary');
  assert.equal(p.calls.filter(call => call.path === '/api/runs/highlights').length, readCount);
});

test('近期进展三行摘要，抽屉和历史轮次可回查全部版本与依据', async t => {
  const data = fixture();
  const history = [
    { revision: 1, text: '第一版合成结论', evidence: '第一版原始依据', correction: null, occurredAt: old, updatedAt: old, requestId: 'private-request-1' },
    { revision: 2, text: '第二版合成结论', evidence: '第二版复核依据', correction: '补充核对范围', occurredAt: old, updatedAt: '2026-11-03T04:00:00.000Z', requestId: 'private-request-2' },
    { revision: 3, text: '第三版合成结论', evidence: null, correction: '原依据已撤回', occurredAt: old, updatedAt: now, requestId: 'private-request-3' }
  ];
  const corrected = highlight('corrections', { ...history[2], revision: 3, history });
  data.overview = overview([], [
    { ...corrected, runId: 'old-round', trigger: 'manual', sourceRunIds: ['old-round'] },
    highlight('legacy', { runId: 'old-round', trigger: 'unknown', sourceRunIds: ['old-round'] }),
    highlight('legacy-null', { history: null, runId: 'old-round', trigger: 'unknown', sourceRunIds: ['old-round'] }),
    highlight('fourth', { runId: 'old-round' })
  ]);
  data.runs.get('old-round').highlights = [corrected, highlight('legacy'), highlight('legacy-null', { history: null })];
  const p = await page(t, data);
  assert.equal(p.all('#workspace-highlight-list > li').length, 3);
  assert.equal(p.$('#workspace-highlight-list details'), null);
  assert.doesNotMatch(p.$('#workspace-highlight-list').textContent, /第一版合成结论/);
  await p.click('#workspace-highlight-list [data-event="corrections"] button');
  const verify = async container => {
    await p.click(`${container} .workspace-highlight-evidence > summary`);
    const details = p.$(`${container} .workspace-highlight-history`);
    assert.equal(details.open, false);
    await p.click(`${container} .workspace-highlight-history > summary`);
    const rows = [...details.querySelectorAll('li')];
    assert.equal(rows.length, 3);
    for (const entry of history) {
      const row = rows.find(value => value.textContent.includes(`第 ${entry.revision} 版`));
      assert.ok(visible(row)); assert.ok(row.textContent.includes(entry.text));
      assert.ok(row.textContent.includes(entry.evidence || '依据：未记录'));
      assert.match(row.textContent, /事件时间 2026-10-24/);
      assert.ok(row.textContent.includes(`记录时间 ${entry.updatedAt.slice(0, 10)}`));
      assert.ok(row.textContent.includes(entry.correction || '首次记录'));
    }
    assert.match(rows[0].textContent, /当前记录/);
    assert.doesNotMatch(details.textContent, /private-request/);
    await p.refresh(); assert.equal(p.$(`${container} .workspace-highlight-history`), details); assert.equal(details.open, true);
  };
  await verify('#workspace-drawer-detail');
  await p.click('#workspace-drawer-back');
  assert.equal(p.all('#workspace-drawer-list [data-event]').length, 4);
  await p.click('#workspace-drawer-list [data-event="legacy-null"] button');
  assert.equal(p.$('#workspace-drawer-detail .workspace-highlight-history'), null);
  await p.click('#workspace-drawer-close');
  await p.selectRun('old-round'); await verify('#run-highlight-list');
  assert.equal(p.$('#run-highlight-list [data-event="legacy"] .workspace-highlight-history'), null);
});

test('历史收据保留当时结论，关联事项进入同一抽屉显示当前状态', async t => {
  const data = fixture();
  const value = data.runs.get('old-round');
  value.results = [{ id: 'receipt', stepId: 'screen', candidateId: data.snapshot.candidates[0].id, action: '当时提出待确认', outcome: '当时尚未作出决定', attention: 'decision', nextAction: '等待聊天决定', updatedAt: old, decisionId: 'linked' }];
  value.resultsRevision = 1;
  data.snapshot.runs = data.snapshot.runs.map(item => item.id === value.id ? model.runSummary(value) : item);
  data.overview = overview([decision('linked', { state: 'closed', effectiveState: 'closed' })]);
  const p = await page(t, data);
  await p.selectRun('old-round'); await p.click('#show-run-results');
  assert.match(p.$('#result-list').textContent, /当时尚未作出决定/);
  assert.match(p.$('#result-list').textContent, /关联事项现在：已完成/);
  await p.click('#result-list [data-linked-decision] button');
  assert.equal(p.$('#workspace-drawer').open, true);
  assert.match(p.$('#workspace-drawer-detail').textContent, /已完成/);
  await p.click('#workspace-drawer-close'); p.assertView('tasks');
  assert.equal(p.window.document.activeElement, p.$('#result-list [data-linked-decision] button'));
  data.overrides.set('/api/snapshot', () => { throw new Error('合成断连'); }); await p.refresh();
  assert.equal(p.$('#decisions-content').hidden, false);
  assert.match(p.$('#decision-list').textContent, /当时尚未作出决定/);
  assert.match(p.$('#decisions-status').textContent, /最后成功读取/);
});

test('旧轮次未接入与明确无变化分开显示，所有外部文本安全呈现', async t => {
  const data = fixture(); data.runs.get('old-round').highlights = null;
  data.overview = overview([decision('escape', { title: '<img src=x onerror=alert(1)>' })], [highlight('escape', { text: '<script>bad()</script>', runId: 'old-round', trigger: 'unknown', sourceRunIds: ['old-round'] })]);
  const p = await page(t, data);
  assert.equal(p.$('#workspace-decision-list img'), null); assert.equal(p.$('#workspace-highlight-list script'), null);
  assert.match(p.$('#workspace-highlight-list').textContent, /<script>bad\(\)<\/script>/);
  await p.click(homeDecision('escape'));
  assert.equal(p.$('#workspace-drawer-detail img'), null);
  assert.match(p.$('#workspace-drawer-detail h3').textContent, /<img src=x/);
  await p.click('#workspace-drawer-close'); await p.selectRun('old-round');
  assert.match(p.$('#run-highlights-status').textContent, /尚未接入/);
  assert.doesNotMatch(p.$('#run-highlights-status').textContent, /无重要变化/);
  await p.selectRun('recent-round');
  assert.match(p.$('#run-highlights-status').textContent, /明确记录无重要变化/);
});

test('姓名搜索切换人选视图，导航保留查询岗位与展开量，姓名不进入URL和存储', async t => {
  const data = fixture(); data.overview = overview([decision('kept')]);
  const p = await page(t, data);
  const url = p.window.location.href, storage = { ...p.window.localStorage };
  p.$('#candidate-query').value = '合成甲'; p.$('#candidate-query').dispatchEvent(new p.window.Event('input')); await settle();
  p.assertView('role-browser');
  assert.match(p.$('#candidate-search-list').textContent, /合成甲/);
  assert.equal(p.window.location.href, url); assert.deepEqual({ ...p.window.localStorage }, storage);
  await p.nav('overview'); p.assertView('assistant');
  assert.equal(p.$('#candidate-query').value, '合成甲');
  await p.nav('roles'); p.assertView('role-browser');
  assert.equal(p.$('#candidate-search-results').hidden, false);
  await p.click('#clear-candidate-search'); p.assertView('role-browser');
  p.$('#role').value = '合成工程岗'; p.$('#role').dispatchEvent(new p.window.Event('change'));
  const stage = p.$('#stages button'); stage.click(); await settle();
  const title = p.$('#detail-title').textContent;
  await p.nav('tasks'); await p.nav('roles');
  assert.equal(p.$('#role').value, '合成工程岗'); assert.equal(p.$('#detail-title').textContent, title);
  assert.equal(p.$('#candidate-detail').hidden, false);
  await p.click('#edit-layout');
  assert.equal(p.all('#layout-root > section').filter(visible).length, 3);
  const buttons = p.all('[data-layout-item="assistant"] > .layout-item-controls button'); buttons[2].click(); await settle();
  const saved = JSON.parse(p.window.localStorage.getItem(`recruiting-board:layout:v1:${workspaceKey}`));
  assert.deepEqual(saved.orders.board, ['roles', 'assistant', 'tasks']);
  await p.click('#finish-layout'); p.assertView('role-browser');
  await p.nav('overview'); assert.equal(p.$('#workspace-all-decisions').textContent, '全部事项 · 1');
});

test('历史重点失败保留内容；切轮后的迟到响应不覆盖新轮次', async t => {
  const data = fixture(), p = await page(t, data);
  await p.selectRun('old-round');
  const original = p.$('#run-highlight-list > li');
  data.snapshot.runs.find(value => value.id === 'old-round').highlightsRevision = 2;
  data.overrides.set('/api/runs/highlights', () => Response.json({ error: { message: '合成重点读取失败' } }, { status: 503 })); await p.refresh();
  assert.equal(p.$('#run-highlight-list > li'), original); assert.match(p.$('#run-highlights-status').textContent, /最后读取/);
  let complete;
  data.overrides.set('/api/runs/highlights', url => url.searchParams.get('run') === 'old-round' ? new Promise(resolve => { complete = resolve; }) : Response.json({ runId: 'recent-round', highlights: [], revision: 0, updatedAt: now, trigger: 'scheduled', summaryState: 'no_change', closingSummary: null }));
  await p.click('#retry-run-highlights'); assert.equal(typeof complete, 'function');
  await p.selectRun('recent-round');
  complete(Response.json({ runId: 'old-round', highlights: [highlight('late', { text: '不应出现的晚响应' })], revision: 2, updatedAt: now, trigger: 'manual', summaryState: 'highlights', closingSummary: null })); await settle();
  assert.equal(p.$('#run').value, 'recent-round'); assert.doesNotMatch(p.$('#run-highlight-list').textContent, /不应出现的晚响应/);
  assert.match(p.$('#run-highlights-status').textContent, /无重要变化/);
});

test('重点接口工作区冲突停止更新且保留已知工作区与事项', async t => {
  const data = fixture(); data.overview = overview([decision('kept')]);
  data.overrides.set('/api/runs/highlights', () => Response.json({ error: { code: 'WORKSPACE_MISMATCH', message: '工作区不匹配' } }, { status: 409 }));
  const p = await page(t, data); await p.selectRun('old-round');
  assert.equal(p.window.document.documentElement.dataset.workspaceBlocked, 'true'); assert.equal(p.$('#refresh-board').disabled, true);
  assert.ok(visible(p.$('#alerts'))); assert.match(p.$('#alerts').textContent, /其他工作区/);
  await p.nav('overview'); assert.equal(p.$('#workspace-all-decisions').textContent, '全部事项 · 1');
  assert.match(p.$('#workspace-overview-status').textContent, /连接已变化/);
  assert.equal(new URL(p.window.location.href).searchParams.get('workspace'), workspaceKey);
});

test('截图状态open0/history10/closed4进入即见三条待核对，全部历史通过抽屉可达', async t => {
  const data = fixture();
  data.overview = overview([
    ...Array.from({ length: 10 }, (_, index) => decision(`history-${index}`, { state: 'history_review', effectiveState: 'history_review', identity: { subjectKey: `legacy:${index}`, questionKey: 'receipt-review', scope: '历史收据待核对' } })),
    ...Array.from({ length: 4 }, (_, index) => decision(`closed-${index}`, { state: 'closed', effectiveState: 'closed' }))
  ]);
  const p = await page(t, data);
  p.assertView('assistant');
  assert.equal(p.$('#workspace-decisions-heading').textContent, '待核对');
  assert.equal(p.all('#workspace-decision-list > li').length, 3);
  assert.equal(p.$('#workspace-decision-list .workspace-preview-scope'), null);
  assert.match(p.$('#workspace-decision-caption').textContent, /没有待回答事项.*10 条历史待核对/);
  assert.equal(p.$('#workspace-all-decisions').textContent, '全部事项 · 14');
  assert.equal(p.all('#assistant select, #assistant details').length, 0);
  assert.equal(p.$('#workspace-followup-link').hidden, true); assert.equal(p.$('#workspace-snoozed-link').hidden, true);
  assert.equal(p.$('#workspace-overview-status').hidden, true); assert.equal(p.$('#workspace-reading-notice').hidden, true);
  assert.equal(p.all('#workspace-task-list > li').length, 1);
  await p.click('#workspace-all-decisions');
  assert.equal(p.all('#workspace-drawer-list [data-decision]').length, 14);
  assert.ok(p.all('#workspace-drawer-filter option').some(option => option.textContent === '当前待处理 · 0'));
  await p.group('history_review'); assert.equal(p.all('#workspace-drawer-list [data-decision]').length, 10);
  await p.group('closed'); assert.equal(p.all('#workspace-drawer-list [data-decision]').length, 4);
  await p.click(drawerDecision('closed-3')); assert.match(p.$('#workspace-drawer-detail h3').textContent, /closed-3/);
});

test('已知零只有一句空态和固定全部入口；无活动步骤的running显示未收尾记录', async t => {
  const data = fixture();
  const active = model.createRun({ id: 'unfinished', workflow: 'daily', trigger: 'manual', now: '2026-11-04T06:00:00.000Z' });
  data.runs.set(active.id, active); data.snapshot.runs.unshift(model.runSummary(active));
  const p = await page(t, data);
  assert.equal(p.$('#workspace-decision-empty').textContent, '当前没有待回答事项。');
  assert.equal(p.$('#workspace-decisions-count').hidden, true);
  assert.equal(p.$('#workspace-all-decisions').textContent, '全部事项 · 0');
  assert.equal(p.all('#workspace-task-list > li').length, 1);
  assert.match(p.$('#workspace-task-list').textContent, /未收尾记录/);
  assert.doesNotMatch(p.$('#workspace-task-list').textContent, /另有.*进行中|当前任务/);
  assert.equal(data.runs.get(active.id).status, 'running');
  await p.nav('tasks'); assert.match(p.$('#run-state').textContent, /进行中/);
});

test('抽屉长历史不插入首页；列表返回位置、焦点循环、Escape与背景关闭可用', async t => {
  const data = fixture();
  const history = Array.from({ length: 40 }, (_, index) => ({ at: now, state: 'open', decision: null, actions: [], source: null, evidence: `第${index}条长证据`.repeat(20), reason: `历史原因${index}` }));
  data.overview = overview([decision('long', { history }), decision('other')]);
  const p = await page(t, data);
  const initial = p.$('#assistant').textContent;
  p.window.scrollY = 190;
  await p.click('#workspace-all-decisions'); await p.group('open');
  const trigger = p.$(drawerDecision('long'));
  p.$('#workspace-drawer-content').scrollTop = 180;
  await p.click(drawerDecision('long'));
  assert.ok(p.window.document.documentElement.classList.contains('drawer-open'));
  await p.click('#workspace-drawer-detail .workspace-decision-history > summary');
  assert.equal(p.all('#workspace-drawer-detail .workspace-history-item').length, 40);
  assert.equal(p.$('#assistant').textContent, initial);
  const last = p.$('#workspace-drawer-detail .workspace-decision-history > summary'); last.focus();
  last.dispatchEvent(new p.window.KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }));
  assert.equal(p.window.document.activeElement, p.$('#workspace-drawer-back'));
  p.$('#workspace-drawer-back').dispatchEvent(new p.window.KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true }));
  assert.equal(p.window.document.activeElement, last);
  await p.click('#workspace-drawer-back');
  assert.equal(p.$('#workspace-drawer-content').scrollTop, 180); assert.equal(p.window.document.activeElement, trigger);
  assert.equal(p.$('#workspace-drawer-filter').value, 'open');
  p.$('#workspace-drawer').dispatchEvent(new p.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })); await settle();
  assert.equal(p.$('#workspace-drawer').open, false); assert.equal(p.window.scrollY, 190);
  assert.equal(p.window.document.activeElement, p.$('#workspace-all-decisions'));
  assert.equal(p.window.document.documentElement.classList.contains('drawer-open'), false);
  await p.click(homeDecision('long')); await p.click('#workspace-drawer-backdrop');
  assert.equal(p.window.document.activeElement, p.$(homeDecision('long')));
});

test('近期进展关联事项复用同一抽屉，返回进展入口含义明确', async t => {
  const data = fixture(); data.overview = overview([decision('linked')], [highlight('related', { runId: 'old-round', decisionId: 'linked' })]);
  const p = await page(t, data);
  await p.click('#workspace-highlight-list [data-event="related"] button');
  await p.click('#workspace-drawer-detail > div > button');
  assert.equal(p.all('dialog[open]').length, 1);
  assert.match(p.$('#workspace-drawer-detail h3').textContent, /linked/);
  assert.equal(p.$('#workspace-drawer-back').textContent, '返回进展');
  await p.click('#workspace-drawer-back');
  assert.equal(p.$('#workspace-drawer-title').textContent, '进展详情');
  assert.match(p.$('#workspace-drawer-detail h3').textContent, /related/);
  await p.click('#workspace-drawer-back');
  assert.equal(p.$('#workspace-drawer-title').textContent, '近期进展');
  assert.equal(p.$('#workspace-drawer-filter').hidden, true);
  assert.equal(p.all('#workspace-drawer-list [data-event]').length, 1);
});

test('run深链直接进入执行记录，旧布局存储只影响显式布局编辑', async t => {
  const storage = { [`recruiting-board:layout:v1:${workspaceKey}`]: JSON.stringify({ version: 1, orders: { board: ['tasks', 'roles', 'assistant'], roles: ['candidate-stages', 'role-scope'], tasks: ['execution-records', 'task-card'] } }) };
  const p = await page(t, fixture(), { query: '&run=old-round', storage });
  p.assertView('tasks'); assert.equal(p.$('#run').value, 'old-round');
  assert.match(p.$('#run-highlight-list').textContent, /超过七天/);
  assert.equal(p.$('#workspace-nav [data-nav-target="tasks"]').getAttribute('aria-current'), 'location');
  assert.equal(p.$('#view-tabs [data-nav-target="tasks"]').getAttribute('aria-current'), 'location');
  await p.nav('overview'); p.assertView('assistant');
  await p.click('#edit-layout');
  assert.deepEqual(p.all('#layout-root > section').filter(visible).map(item => item.id), ['tasks', 'role-browser', 'assistant']);
  await p.click('#finish-layout'); p.assertView('assistant');
  await p.nav('tasks'); assert.equal(p.$('#run').value, 'old-round');
});

test('主动显示更新后关闭详情，焦点恢复到同一事项的新摘要行', async t => {
  const data = fixture(); data.overview = overview([decision('revised')]);
  const p = await page(t, data);
  await p.click(homeDecision('revised'));
  data.overview = overview([decision('revised', { title: '已修订的事项', revision: 2 })]);
  await p.refresh(); await p.click('#workspace-drawer-update'); await p.click('#workspace-drawer-close');
  assert.equal(p.window.document.activeElement, p.$(homeDecision('revised')));
  assert.match(p.$(homeDecision('revised')).textContent, /已修订的事项/);
});

test('岗位保存期间导航保持岗位视图和所选轮次', async t => {
  const p = await page(t);
  await p.nav('roles');
  p.$('#role-manager').hidden = false;
  p.$('#cancel-role').disabled = true;
  const selected = p.$('#run').value;
  await p.nav('overview'); p.assertView('role-browser');
  await p.nav('tasks'); p.assertView('role-browser');
  const newer = run('during-save', '2026-11-04T06:00:00.000Z');
  p.data.runs.set(newer.id, newer); p.data.snapshot.runs.unshift(model.runSummary(newer)); await p.refresh();
  assert.equal(p.$('#run').value, selected);
  p.$('#cancel-role').disabled = false; p.$('#role-manager').hidden = true;
  await p.nav('overview'); p.assertView('assistant');
});

test('新事项展示人岗和背景，完整列表按岗位分组且不重复计数', async t => {
  const data = fixture();
  const subject = model.candidateSubject(JSON.stringify(['合成甲', '合成工程岗']));
  const other = model.candidateSubject(JSON.stringify(['合成甲', '合成历史岗']));
  data.overview = overview([
    decision('first', { subjects: [subject], associationStatus: 'resolved', associationMessages: [], history: [{ at: now, state: 'open', decision: null, actions: [], source: null, evidence: '具备经历但地点待确认' }] }),
    decision('old', { state: 'history_review', effectiveState: 'history_review', subjects: [other], associationStatus: 'resolved', associationMessages: [] }),
    decision('second', { subjects: [subject], associationStatus: 'resolved', associationMessages: [] }),
    decision('workspace', { subjects: [], associationStatus: 'workspace', associationMessages: [] }),
    decision('unknown', { subjects: [], associationStatus: 'unknown', associationMessages: ['来源结果缺失'] })
  ]);
  const p = await page(t, data);
  assert.match(p.$(homeDecision('first')).textContent, /合成甲.*合成工程岗.*具备经历但地点待确认/);
  await p.click('#workspace-all-decisions');
  assert.deepEqual(p.all('.decision-role-heading h3').map(element => element.textContent), ['合成工程岗', '合成历史岗', '工作区事项', '岗位待确认']);
  assert.equal(p.all('#workspace-drawer-list [data-decision]').length, 5);
  await p.click(drawerDecision('old'));
  assert.match(p.$('#workspace-drawer-detail').textContent, /合成历史岗/);
  assert.match(p.$('#workspace-drawer-detail').textContent, /当前资料不可用/);
  assert.equal(p.all('#workspace-drawer-detail [data-subject]').length, 0);
});

test('进展到关联事项再到人选资料可逐层返回，保留详情位置与焦点', async t => {
  const data = fixture(), subject = model.candidateSubject(JSON.stringify(['合成甲', '合成工程岗']));
  const association = { subjects: [subject], associationStatus: 'resolved', associationMessages: [] };
  data.overview = overview([decision('linked', association)], [highlight('related', { runId: 'old-round', decisionId: 'linked', ...association, details: [{ label: '预约时段', value: '明日 14:00–15:00' }, { label: '面试官', value: '合成面试官' }] })]);
  data.overrides.set('/api/candidates/detail', async () => Response.json({ candidate: { ...data.snapshot.candidates[0] }, background: '合成背景', notes: '', sourceRound: '', documents: [], warnings: [] }));
  const p = await page(t, data);
  await p.click('#workspace-highlight-list button');
  assert.match(p.$('#workspace-drawer-detail').textContent, /预约时段明日 14:00–15:00/);
  p.$('#workspace-drawer-content').scrollTop = 90;
  await p.click('#workspace-drawer-detail [data-linked-item]');
  p.$('#workspace-drawer-content').scrollTop = 130;
  await p.click('#workspace-drawer-detail [data-subject]');
  assert.equal(p.$('#workspace-drawer-title').textContent, '人选资料');
  assert.equal(p.all('dialog[open]').length, 1);
  assert.equal(p.$('#record-content .record-name').textContent, '合成甲');
  await p.click('#workspace-drawer-back');
  assert.equal(p.$('#workspace-drawer-title').textContent, '事项详情');
  assert.equal(p.$('#workspace-drawer-content').scrollTop, 130);
  assert.equal(p.window.document.activeElement, p.$('#workspace-drawer-detail [data-subject]'));
  await p.click('#workspace-drawer-back');
  assert.equal(p.$('#workspace-drawer-title').textContent, '进展详情');
  assert.equal(p.$('#workspace-drawer-content').scrollTop, 90);
  assert.equal(p.window.document.activeElement, p.$('#workspace-drawer-detail [data-linked-item]'));
});

test('在招严格筛选，切范围保留有效岗位并清除范围外岗位，未知入口可达', async t => {
  const data = fixture();
  data.snapshot.roles.push({ name: '合成暂停岗', status: '暂停', configured: true }, { name: '合成未知岗', status: null, configured: false });
  const p = await page(t, data);
  await p.nav('roles');
  assert.equal(p.all('#role option').some(option => option.value === '合成未知岗'), false);
  p.$('#role').value = '合成工程岗'; p.$('#role').dispatchEvent(new p.window.Event('change'));
  await p.click('[data-scope="all"]');
  assert.equal(p.$('#role').value, '合成工程岗');
  p.$('#role').value = '合成暂停岗'; p.$('#role').dispatchEvent(new p.window.Event('change'));
  await p.click('[data-scope="active"]');
  assert.equal(p.$('#role').value, '');
  assert.match(p.$('#role-range-message').textContent, /合成暂停岗.*已显示/);
  await p.click('#unknown-roles-link');
  assert.equal(p.$('[data-scope="all"]').getAttribute('aria-pressed'), 'true');
  assert.match(p.$('#unknown-role-list').textContent, /合成未知岗.*尚未配置/);
});

test('关注在独立面板编辑，跨状态可选且关闭后保持原页面', async t => {
  const data = fixture(); data.snapshot.roles.push({ name: '合成关闭岗', status: '已关闭', configured: true });
  const p = await page(t, data);
  await p.click('#workspace-choose-following');
  assert.equal(p.$('#workspace-drawer-title').textContent, '选择关注岗位');
  p.assertView('assistant');
  await p.click('#following-list input[data-role="合成关闭岗"]');
  await p.click('#finish-following');
  assert.equal(p.$('#workspace-drawer').open, false);
  assert.equal(p.window.document.activeElement, p.$('#workspace-choose-following'));
  await p.nav('roles'); await p.click('[data-scope="following"]');
  assert.ok(p.all('#role option').some(option => option.value === '合成关闭岗'));
  assert.equal(data.snapshot.roles.find(role => role.name === '合成关闭岗').status, '已关闭');
});

test('同分钟同名任务使用序号，时间不同不添编号且详情保留ID', async t => {
  const data = fixture(), same = run('b1234567-1111-4111-8111-111111111111', now), different = run('c1234567-1111-4111-8111-111111111111', '2026-11-04T04:05:00.000Z');
  for (const value of [same, different]) { data.runs.set(value.id, value); data.snapshot.runs.push(model.runSummary(value)); }
  const p = await page(t, data); await p.nav('tasks');
  const labels = p.all('#run option').map(option => option.textContent);
  assert.ok(labels.every(label => !/[0-9a-f]{8}-[0-9a-f]{4}-/.test(label)));
  assert.equal(labels.filter(label => /第 \d+ 次/.test(label)).length, 2);
  await p.selectRun(same.id);
  assert.equal(p.$('#run-id').textContent, same.id);
});
