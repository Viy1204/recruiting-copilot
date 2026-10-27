import { test, expect, mock } from 'claude-code/testing';
import type { Engine } from 'claude-code/testing';
import type { FsStat, On, RenderElement } from 'claude-code';
import type { CandidateDetail, DocumentContent, RecruitingBoardState, RoleInfo, RoleSetResult, Run, RunActivity, RunResult, RunResults } from './types';
import { createRun, LEDGER_COLUMNS } from './model.mjs';

const now = '2026-10-22T01:00:00.000Z';
const root = '/synthetic-recruit-board';
const candidateId = JSON.stringify(['合成甲', '合成岗位']);
const paneProps = { title: '招聘进展', isFocused: true, bodyColumns: 48, placement: 'dock', scroll: { offset: 0, bodyRows: 48 }, view: {} } as const;
const preferenceKey = (workspaceRoot: string) => `role-preferences:${workspaceRoot}`;
const runFile = (workspaceRoot = root, id = 'native-test') => `${workspaceRoot}/runtime/recruit-board/runs/${id}.json`;
const newRun = (id = 'native-test', createdAt = now): Run => ({ ...createRun({ id, workflow: 'daily', now: createdAt }), schemaVersion: 1, status: 'running' });

function fixturePath(env: { files: Record<string, string>; roots: Set<string>; stats: Record<string, FsStat> }, path: string) {
  const normalized = path.replace(/\\/g, '/');
  for (const candidate of [normalized, normalized.replace(/^[A-Za-z]:/, '')]) {
    if (candidate in env.files || candidate in env.stats || env.roots.has(candidate) || Object.keys(env.files).some(file => file.startsWith(`${candidate}/`))) return candidate;
  }
  return normalized;
}

function setup(on: On) {
  const clock = mock.clock(on, { now: Date.parse(now) });
  const detail: CandidateDetail = {
    candidate: { id: candidateId, name: '合成甲', rawRole: '合成岗位', role: '合成岗位', rawStatus: '已回复', rating: 'A' },
    background: '合成背景摘要', notes: '私密备注', sourceRound: 'test', warnings: ['合成资料核对提醒'],
    documents: [
      { id: 'a'.repeat(64), label: '合成档案.md', kind: 'markdown', status: 'ok', message: null, size: 200 },
      { id: 'b'.repeat(64), label: '合成简历.pdf', kind: 'pdf', status: 'ok', message: null, size: 200 },
      { id: 'c'.repeat(64), label: '缺失简历.pdf', kind: 'pdf', status: 'missing', message: '文件不存在', size: null },
      { id: 'd'.repeat(64), label: '区外资料.md', kind: 'markdown', status: 'blocked', message: '文件位于工作区外', size: null }
    ]
  };
  const content: DocumentContent = { document: detail.documents[0]!, text: '# 合成评估\n[file](file:///outside/secret)\n[external](https://example.com)\n正文哨兵', absolutePath: `${root}/03-interview/合成甲.md` };
  const env = {
    clock, detail, content, cwd: root, files: {} as Record<string, string>, roots: new Set<string>(), stats: {} as Record<string, FsStat>, calls: [] as string[][],
    store: {} as Record<string, unknown>, storeWrites: [] as { key: string; value: unknown }[], writes: 0, latest: null as RecruitingBoardState | null, opens: 0,
    errors: {} as Record<string, string>, delays: {} as Record<string, number>, roleSet: null as RoleSetResult | null, activity: null as RunActivity | null, results: null as RunResults | null,
    info: { contextRevision: '1'.repeat(64), roles: [{ name: '合成岗位', priority: 'P0', status: '在招', configured: true }], allowedStatuses: ['在招', '已下架', '已关闭', '暂停', '待核'] } as RoleInfo
  };
  addWorkspace(env);
  on('session.cwd', () => ({ value: env.cwd }));
  on('session.id', () => ({ value: 'synthetic-session' }));
  on('store.get', ($, e) => ({ value: env.store[e.key] }));
  on('store.set', ($, e) => {
    env.store[e.key] = JSON.parse(JSON.stringify(e.value));
    env.storeWrites.push({ key: e.key, value: env.store[e.key] });
    return { value: undefined };
  });
  on('state.set', { plugin: 'recruiting-board', key: 'board' }, ($, e, next) => {
    env.writes++;
    env.latest = e.value;
    return next(e);
  });
  on('fs.exists', ($, e) => {
    const path = fixturePath(env, e.path);
    return { value: env.roots.has(path) || path in env.files || Object.keys(env.files).some(file => file.startsWith(`${path}/`)) };
  });
  on('fs.stat', ($, e) => {
    const path = fixturePath(env, e.path);
    return { value: env.stats[path] ?? { kind: path in env.files ? 'file' : env.roots.has(path) || Object.keys(env.files).some(file => file.startsWith(`${path}/`)) ? 'dir' : 'other', size: path in env.files ? 100 : 0, mtimeMs: Date.parse(now), isLink: false, realPath: path } };
  });
  on('fs.read', ($, e) => {
    const path = fixturePath(env, e.path);
    if (!(path in env.files)) throw new Error('合成文件缺失');
    return { value: env.files[path]! };
  });
  on('fs.list', ($, e) => {
    const path = fixturePath(env, e.path);
    return { value: Object.keys(env.files).filter(file => file.startsWith(`${path}/`) && !file.slice(path.length + 1).includes('/')).map(file => ({ name: file.slice(path.length + 1), kind: 'file', size: 100, mtimeMs: Date.parse(now), isLink: false })) };
  });
  on('ui.open', () => { env.opens++; return { value: { isPlaced: true } }; });
  on('process.run', async ($, e) => {
    const argv = [...e.argv];
    env.calls.push(argv);
    expect(argv[0]).toBe('node');
    expect(argv[1]).toMatch(/\/scripts\/actions\.mjs$/);
    const command = argv[2]!;
    const workspaceRoot = argv[argv.indexOf('--workspace') + 1]!;
    if (env.errors[command]) {
      if (env.delays[command]) await clock.sleep(env.delays[command]!);
      return { value: { exitCode: 1, stdout: '', stderr: JSON.stringify({ error: { code: command === 'role-set' ? 'CONTEXT_CONFLICT' : 'READ_FAILED', message: env.errors[command] } }), isStdoutTruncated: false, isStderrTruncated: false } };
    }
    let value: unknown;
    if (command === 'candidate') value = env.detail;
    else if (command === 'document') value = env.content;
    else if (command === 'open-document') value = { opened: true, message: '已请求本机默认应用打开附件' };
    else if (command === 'role-info') value = env.info;
    else if (command === 'role-set') {
      const status = argv[argv.indexOf('--status') + 1]!;
      value = env.roleSet ?? { ...env.info, contextRevision: '2'.repeat(64), changed: true, role: '合成岗位', status, backup: 'runtime/recruit-board/roles/合成备份.md', roles: env.info.roles.map(role => role.name === '合成岗位' ? { ...role, status } : role) };
      env.files[`${workspaceRoot}/CONTEXT.md`] = env.files[`${workspaceRoot}/CONTEXT.md`]!.replace('| 在招 |', `| ${status} |`);
    } else if (command === 'run-results' || command === 'run-activity') {
      const runId = argv[argv.indexOf('--run') + 1]!;
      const run = JSON.parse(env.files[runFile(workspaceRoot, runId)]!) as Run;
      value = command === 'run-results' ? env.results ?? { runId, updatedAt: run.updatedAt, results: run.results ?? null, revision: run.resultsRevision ?? 0 } : env.activity ?? { runId, updatedAt: run.updatedAt, items: run.results === null ? null : [...run.results].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id)).slice(0, 3), revision: run.resultsRevision ?? 0 };
    } else throw new Error('测试未定义的动作');
    const stdout = JSON.stringify(value);
    if (env.delays[command]) await clock.sleep(env.delays[command]!);
    return { value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } };
  });
  return env;
}

function addWorkspace(env: { files: Record<string, string>; roots: Set<string> }, workspaceRoot = root) {
  env.roots.add(workspaceRoot);
  env.files[`${workspaceRoot}/CONTEXT.md`] = '## 在招岗位与优先级\n| 岗位 | 优先级 | 状态 |\n|---|---|---|\n| 合成岗位 | P0 | 在招 |';
  env.files[`${workspaceRoot}/02-sourcing/dedup-ledger.csv`] = `${LEDGER_COLUMNS.join(',')}\n1,合成甲,合成岗位,,A,已回复,test,,私密备注`;
  env.files[runFile(workspaceRoot)] = JSON.stringify(newRun());
}

async function open($: Engine, args = '') {
  return $.command.run({ command: 'recruiting-board', args, origin: { kind: 'composer' }, presentation: { columns: 100, isFullscreen: true } });
}

async function mount($: Engine, surface: 'desktop' | 'terminal' = 'desktop') {
  return $.ui.mount({ plugin: 'recruiting-board', surface, component: 'Pane', requestId: 'recruiting-board', props: paneProps });
}

function result(id: string, person = candidateId, attention: RunResult['attention'] = 'none', stepId = 'screen'): RunResult {
  return { id, candidateId: person, stepId, attention, action: `动作${id}`, outcome: `结论${id}`, nextAction: attention === 'decision' ? '请确认匹配要求' : null, updatedAt: now };
}

function setResults(env: { files: Record<string, string> }, results: RunResult[] | null, id = 'native-test', workspaceRoot = root, revision = 1) {
  const run = JSON.parse(env.files[runFile(workspaceRoot, id)]!) as Run;
  env.files[runFile(workspaceRoot, id)] = JSON.stringify({ ...run, results, resultsRevision: revision });
}

test('执行记录和候选阶段默认折叠，展开后保留流程与名单且不显示评级私密列', async ($, on) => {
  setup(on);
  expect((await open($)).text).toContain('已打开');
  const ui = await mount($);
  expect(await ui.find({ type: 'Text', text: /^本轮需确认$/ })).toBeDefined();
  expect(await ui.find({ key: 'run' })).toBeUndefined();
  expect(await ui.find({ key: 'run-results' })).toBeUndefined();
  expect(await ui.find({ type: 'Text', text: /共 1 条/ })).toBeUndefined();
  expect(await ui.find({ key: 'stage-talking' })).toBeUndefined();
  expect(await ui.find({ type: 'Text', text: /^最近动态$/ })).toBeUndefined();
  await ui.press({ key: 'show-records' });
  expect(await ui.find({ type: 'Text', text: /^1\. 查未处理/ })).toBeUndefined();
  await ui.press({ key: 'show-steps' });
  expect(await ui.find({ type: 'Text', text: /^1\. 查未处理/ })).toBeDefined();
  await ui.press({ key: 'show-steps' });
  expect(await ui.find({ type: 'Text', text: /^1\. 查未处理/ })).toBeUndefined();
  await ui.press({ key: 'show-records' });
  await ui.press({ key: 'show-stages' });
  expect(await ui.find({ type: 'Text', text: /共 1 条/ })).toBeDefined();
  await ui.press({ key: 'stage-talking' });
  expect(await ui.find({ type: 'Text', text: /^A$/ })).toBeUndefined();
  expect(await ui.find({ type: 'Button', text: /^合成甲$/ })).toBeDefined();
  expect(await ui.find({ type: 'Text', text: /私密备注/ })).toBeUndefined();
  await ui.unmount();
});

test('无业务变化的轮询不写状态，有源变化仍同步并保留详情和岗位草稿', async ($, on) => {
  const env = setup(on);
  await open($);
  const ui = await mount($);
  await ui.press({ key: 'show-stages' });
  await ui.press({ key: 'stage-talking' });
  await ui.press({ key: (await ui.find({ type: 'Button', text: /^合成甲$/ }))!.key! });
  await ui.press({ key: 'candidate-background' });
  const beforePoll = env.writes;
  const beforeSync = env.latest?.snapshot?.generatedAt;
  await env.clock.advance(6000);
  expect(env.writes).toBe(beforePoll);
  expect(env.latest?.snapshot?.generatedAt).toBe(beforeSync);
  expect(await ui.find({ type: 'Code', text: '私密备注' })).toBeDefined();
  env.files[runFile()] = JSON.stringify({ ...newRun(), status: 'waiting', reason: '等待合成确认', updatedAt: new Date(env.clock.now()).toISOString() });
  await env.clock.advance(2000);
  expect(env.writes).toBe(beforePoll + 1);
  expect(env.latest?.snapshot?.runs?.[0]?.status).toBe('waiting');
  expect(env.latest?.snapshot?.generatedAt).not.toBe(beforeSync);
  expect(await ui.find({ type: 'Code', text: '私密备注' })).toBeDefined();
  await ui.press({ key: 'candidate-back' });
  expect(await ui.find({ type: 'Text', text: /等待合成确认/ })).toBeDefined();
  await ui.press({ key: 'manage-roles' });
  await ui.press({ key: 'role-status-3' });
  const beforeDraftPoll = env.writes;
  await env.clock.advance(4000);
  expect(env.writes).toBe(beforeDraftPoll);
  expect((await ui.find({ key: 'role-status-3' }))?.text).toBe('暂停 · 已选');
  expect(env.calls.filter(argv => argv[2] === 'role-set')).toHaveLength(0);
  env.stats[`${root}/CONTEXT.md`] = { kind: 'file', size: 100, mtimeMs: env.clock.now(), isLink: false, realPath: `${root}/CONTEXT.md` };
  await env.clock.advance(2000);
  expect(env.writes).toBe(beforeDraftPoll + 1);
  expect((await ui.find({ key: 'role-status-3' }))?.text).toBe('暂停 · 已选');
  const afterSourceChange = env.writes;
  await env.clock.advance(4000);
  expect(env.writes).toBe(afterSourceChange);
  await ui.unmount();
});

test('兼容配置的别名保留跨原岗位记录，配置故障陈旧后能恢复', async ($, on) => {
  const env = setup(on);
  const configFile = `${root}/_shared/recruit-board.config.json`;
  const ledgerFile = `${root}/02-sourcing/dedup-ledger.csv`;
  const config = JSON.stringify({ schemaVersion: 1, statusStages: { '已沟通-待答复': 'talking' }, roleAliases: { 合成旧岗位: '合成岗位' }, description: '说明元数据哨兵' });
  env.files[configFile] = config;
  env.files[ledgerFile] = `${LEDGER_COLUMNS.join(',')}\n1,合成甲,合成旧岗位,,A,已沟通-待答复,test,,\n2,合成甲,合成岗位,,A,已回复,test,,`;
  delete env.files[runFile()];
  await open($);
  const ui = await mount($);
  expect(await ui.find({ type: 'Text', text: /尚无任务进度记录/ })).toBeDefined();
  await ui.press({ key: 'show-stages' });
  await ui.select({ key: 'role', value: '合成岗位' });
  expect(await ui.find({ type: 'Text', text: /共 2 条/ })).toBeDefined();
  await ui.press({ key: 'stage-talking' });
  expect(await ui.findAll({ type: 'Button', text: /^合成甲$/ })).toHaveLength(2);
  expect(await ui.find({ type: 'Text', text: /原岗位：合成旧岗位/ })).toBeDefined();
  expect(await ui.find({ type: 'Text', text: /合成岗位 · 已沟通-待答复/ })).toBeDefined();
  await ui.press({ key: 'show-details' });
  expect(await ui.find({ type: 'Text', text: /兼容配置 已加载/ })).toBeDefined();
  expect(await ui.find({ type: 'Text', text: /说明元数据哨兵/ })).toBeUndefined();
  env.files[configFile] = '{';
  env.files[ledgerFile] = `${LEDGER_COLUMNS.join(',')}\n1,合成乙,合成旧岗位,,A,已排除,test,,`;
  await env.clock.advance(2000);
  expect(await ui.find({ type: 'Text', text: /共 2 条/ })).toBeDefined();
  expect(await ui.find({ type: 'Text', text: /兼容配置 陈旧/ })).toBeDefined();
  expect(await ui.find({ type: 'Text', text: /合成乙/ })).toBeUndefined();
  env.files[configFile] = config;
  await env.clock.advance(2000);
  expect(await ui.find({ type: 'Text', text: /共 1 条/ })).toBeDefined();
  expect(await ui.find({ type: 'Text', text: /兼容配置 已加载/ })).toBeDefined();
  await ui.press({ key: 'stage-ended' });
  expect(await ui.find({ type: 'Button', text: /^合成乙$/ })).toBeDefined();
  await ui.unmount();
});

for (const args of ['C:/synthetic recruiting/招聘工作区', '"C:/synthetic recruiting/招聘工作区"', 'C:\\synthetic recruiting\\招聘工作区', '/synthetic recruiting/招聘工作区']) {
  test(`显式绝对路径按canonical目录读取：${args}`, async ($, on) => {
    const env = setup(on);
    const workspaceRoot = args.replace(/^"|"$/g, '').replace(/\\/g, '/');
    addWorkspace(env, workspaceRoot);
    env.cwd = '/synthetic-source-repo';
    env.stats[args.replace(/^"|"$/g, '')] = { kind: 'dir', size: 0, mtimeMs: Date.parse(now), isLink: false, realPath: workspaceRoot };
    const opened = await open($, args);
    expect(opened.text).toContain('已打开');
    const ui = await mount($);
    expect(await ui.find({ type: 'Text', text: /^招聘工作区$/ })).toBeDefined();
    await ui.press({ key: 'show-stages' });
    expect(await ui.find({ type: 'Text', text: /共 1 条/ })).toBeDefined();
    await ui.unmount();
  });
}

test('非招聘目录和相对路径不打开面板，拒绝后仍可打开当前工作区', async ($, on) => {
  const env = setup(on);
  env.roots.add('/synthetic-empty');
  const missing = await open($, '/synthetic-empty');
  expect(missing.text).toContain('不是招聘工作区');
  expect(missing.text).toContain('/recruiting-board <工作区绝对路径>');
  expect(env.opens).toBe(0);
  const relative = await open($, '../workspace');
  expect(relative.text).toContain('请提供工作区绝对路径');
  expect(env.opens).toBe(0);
  expect((await open($)).text).toContain('已打开');
});

test('工作区必须是可解析目录，台账不能链接到区外', async ($, on) => {
  const env = setup(on);
  env.stats['/synthetic-file'] = { kind: 'file', size: 100, mtimeMs: Date.parse(now), isLink: false, realPath: '/synthetic-file' };
  expect((await open($, '/synthetic-file')).text).toContain('无法定位招聘工作区目录');
  env.stats['/synthetic-unresolved'] = { kind: 'dir', size: 0, mtimeMs: Date.parse(now), isLink: false };
  expect((await open($, '/synthetic-unresolved')).text).toContain('无法定位招聘工作区目录');
  env.stats[`${root}/02-sourcing/dedup-ledger.csv`] = { kind: 'file', size: 100, mtimeMs: Date.parse(now), isLink: true, realPath: '/outside/dedup-ledger.csv' };
  expect((await open($)).text).toContain('不是工作区内的有效文件');
});

for (const surface of ['desktop', 'terminal'] as const) {
  test(`候选详情按原记录读取，正文不开放任意链接：${surface}`, async ($, on) => {
    const env = setup(on);
    await open($);
    const ui = await mount($, surface);
    await ui.press({ key: 'show-stages' });
    await ui.press({ key: 'stage-talking' });
    const candidate = await ui.find({ type: 'Button', text: /^合成甲$/ });
    expect(candidate?.key?.length).toBeLessThan(50);
    await ui.press({ key: candidate!.key! });
    expect(env.calls.find(argv => argv[2] === 'candidate')?.slice(2)).toEqual(['candidate', '--workspace', root, '--candidate', candidateId]);
    expect(await ui.find({ type: 'Code', text: '合成背景摘要' })).toBeUndefined();
    expect(await ui.find({ type: 'Code', text: '私密备注' })).toBeUndefined();
    expect(await ui.find({ type: 'Text', text: /缺失简历.pdf · 文件缺失/ })).toBeDefined();
    await ui.press({ key: 'candidate-background' });
    expect(await ui.find({ type: 'Code', text: '合成背景摘要' })).toBeDefined();
    expect(await ui.find({ type: 'Code', text: '私密备注' })).toBeDefined();
    expect(await ui.find({ type: 'Text', text: /来源轮次：test/ })).toBeDefined();
    expect(await ui.find({ type: 'Text', text: /缺失简历.pdf · 文件缺失/ })).toBeDefined();
    expect(await ui.find({ type: 'Text', text: /区外资料.md · 未开放/ })).toBeDefined();
    expect(await ui.findAll({ type: 'Button', text: '打开 PDF' })).toHaveLength(1);
    await ui.press({ key: (await ui.find({ type: 'Button', text: '阅读正文' }))!.key! });
    expect(await ui.find({ type: 'Code', text: /正文哨兵/ })).toBeDefined();
    expect(await ui.findAll({ type: 'Markdown' })).toHaveLength(0);
    expect(await ui.findAll({ type: 'Link' })).toHaveLength(0);
    expect(await ui.find({ type: 'Text', text: /\/synthetic-recruit-board\/03-interview/ })).toBeUndefined();
    await ui.press({ key: (await ui.find({ type: 'Button', text: '打开 PDF' }))!.key! });
    expect(env.calls.find(argv => argv[2] === 'open-document')?.slice(2)).toEqual(['open-document', '--workspace', root, '--candidate', candidateId, '--document', 'b'.repeat(64)]);
    expect(await ui.find({ type: 'Text', text: /已请求本机默认应用打开附件/ })).toBeDefined();
    await ui.press({ key: 'candidate-back' });
    expect(await ui.find({ type: 'Button', text: /^合成甲$/ })).toBeDefined();
    expect(await ui.find({ type: 'Code', text: '私密备注' })).toBeUndefined();
    await ui.unmount();
  });
}

test('岗位编辑取消不写入，保存携带进入时的版本并保留个人单岗选择', async ($, on) => {
  const env = setup(on);
  await open($);
  const ui = await mount($);
  await ui.select({ key: 'role', value: '合成岗位' });
  await ui.press({ key: 'manage-roles' });
  expect((await ui.find({ key: 'role-status-0' }))?.text).toBe('在招 · 已选');
  expect((await ui.find({ key: 'role-status-1' }))?.text).toBe('已下架');
  expect((await ui.find({ key: 'role-status-2' }))?.text).toBe('已关闭');
  expect((await ui.find({ key: 'role-status-4' }))?.text).toBe('待核');
  await ui.press({ key: 'role-status-3' });
  expect(await ui.find({ type: 'Text', text: /^新状态：暂停$/ })).toBeDefined();
  expect((await ui.find({ key: 'role-status-0' }))?.text).toBe('在招');
  expect((await ui.find({ key: 'role-status-3' }))?.text).toBe('暂停 · 已选');
  expect(env.calls.filter(argv => !['run-activity', 'run-results'].includes(argv[2]!)).map(argv => argv[2])).toEqual(['role-info']);
  await ui.press({ key: 'role-cancel' });
  expect(env.calls.filter(argv => !['run-activity', 'run-results'].includes(argv[2]!)).map(argv => argv[2])).toEqual(['role-info']);
  await ui.press({ key: 'manage-roles' });
  await ui.press({ key: 'role-status-2' });
  await ui.press({ key: 'role-save' });
  expect(env.calls.at(-1)?.slice(2)).toEqual(['role-set', '--workspace', root, '--role', '合成岗位', '--status', '已关闭', '--revision', '1'.repeat(64)]);
  expect(await ui.find({ type: 'Text', text: /岗位状态已保存/ })).toBeDefined();
  expect(await ui.find({ type: 'Text', text: /当前状态：已关闭/ })).toBeDefined();
  await ui.press({ key: 'role-cancel' });
  expect((await ui.find({ key: 'role' }))?.props.value).toBe('合成岗位');
  expect((await ui.find({ key: 'role' }))?.props.options).toContainEqual({ value: '合成岗位', label: '合成岗位 · 当前范围外' });
  expect(await ui.find({ type: 'Text', text: /在当前范围外/ })).toBeDefined();
  await ui.press({ key: 'show-stages' });
  expect(await ui.find({ type: 'Text', text: /共 1 条/ })).toBeDefined();
  await ui.unmount();
});

test('岗位保存冲突提示重读，不能按旧版本连续写入', async ($, on) => {
  const env = setup(on);
  await open($);
  const ui = await mount($);
  await ui.press({ key: 'manage-roles' });
  await ui.press({ key: 'role-status-3' });
  env.errors['role-set'] = '岗位配置已被修改';
  await ui.press({ key: 'role-save' });
  expect(await ui.find({ type: 'Text', text: /CONTEXT_CONFLICT.*重新读取/ })).toBeDefined();
  expect(await ui.find({ key: 'role-save' })).toBeUndefined();
  env.info.contextRevision = '3'.repeat(64);
  env.info.roles[0]!.status = '已下架';
  await ui.press({ key: 'role-reload' });
  expect(await ui.find({ type: 'Text', text: /当前状态：已下架/ })).toBeDefined();
  expect(env.calls.filter(argv => argv[2] === 'role-set')).toHaveLength(1);
  await ui.unmount();
});

for (const outcome of ['success', 'conflict'] as const) {
  test(`岗位保存期间不能跟随最新，${outcome}反馈保留且结束后恢复导航`, async ($, on) => {
    const env = setup(on);
    env.files[runFile(root, 'newer-run')] = JSON.stringify(newRun('newer-run', '2026-10-22T01:00:01.000Z'));
    await open($);
    const ui = await mount($);
    await ui.press({ key: 'show-records' });
    await ui.select({ key: 'run', value: 'native-test' });
    await ui.press({ key: 'manage-roles' });
    await ui.press({ key: 'role-status-3' });
    expect(await ui.find({ key: 'follow-latest' })).toBeDefined();
    env.delays['role-set'] = 3000;
    if (outcome === 'conflict') env.errors['role-set'] = '岗位配置已被修改';
    const saving = ui.press({ key: 'role-save' });
    await env.clock.settle();
    expect(await ui.find({ type: 'Text', text: /正在保存岗位状态/ })).toBeDefined();
    const followWhileSaving = await ui.find({ key: 'follow-latest' });
    if (followWhileSaving) await ui.press({ key: 'follow-latest' });
    await env.clock.advance(3000);
    await saving;
    if (outcome === 'success') {
      expect(await ui.find({ type: 'Text', text: /岗位状态已保存，原文件已备份/ })).toBeDefined();
      expect(await ui.find({ type: 'Text', text: /当前状态：暂停/ })).toBeDefined();
    } else {
      expect(await ui.find({ type: 'Text', text: /CONTEXT_CONFLICT.*重新读取/ })).toBeDefined();
      expect(await ui.find({ key: 'role-reload' })).toBeDefined();
    }
    expect(followWhileSaving).toBeUndefined();
    expect(env.calls.filter(argv => argv[2] === 'role-set')).toHaveLength(1);
    expect(await ui.find({ key: 'follow-latest' })).toBeDefined();
    await ui.press({ key: 'follow-latest' });
    await ui.press({ key: 'show-records' });
    expect((await ui.find({ key: 'run' }))?.props.value).toBe('newer-run');
    expect(await ui.find({ type: 'Text', text: /^管理岗位$/ })).toBeUndefined();
    await ui.unmount();
  });
}

test('切换工作区清理候选详情、岗位草稿与旧快照，坏台账人数未知', async ($, on) => {
  const env = setup(on);
  await open($);
  const ui = await mount($);
  await ui.press({ key: 'show-stages' });
  await ui.press({ key: 'stage-talking' });
  await ui.press({ key: (await ui.find({ type: 'Button', text: /^合成甲$/ }))!.key! });
  const other = '/synthetic-other-workspace';
  addWorkspace(env, other);
  env.files[`${other}/02-sourcing/dedup-ledger.csv`] = 'broken-ledger';
  await open($, other);
  expect(await ui.find({ type: 'Code', text: '私密备注' })).toBeUndefined();
  expect(await ui.find({ key: 'candidate-back' })).toBeUndefined();
  await ui.press({ key: 'show-stages' });
  expect(await ui.find({ type: 'Text', text: /候选人阶段 · 共 未知 条/ })).toBeDefined();
  expect(await ui.find({ type: 'Text', text: /CSV 表头必须按约定排列九列/ })).toBeDefined();
  expect(await ui.find({ type: 'Text', text: /^synthetic-other-workspace$/ })).toBeDefined();
  await ui.press({ key: 'stage-talking' });
  expect(await ui.find({ type: 'Button', text: /^合成甲$/ })).toBeUndefined();
  await ui.press({ key: 'manage-roles' });
  await ui.press({ key: 'role-status-3' });
  await open($);
  expect(await ui.find({ key: 'role-status-3' })).toBeUndefined();
  expect(await ui.find({ key: 'manage-roles' })).toBeDefined();
  await ui.unmount();
});

test('在招、关注、全部和岗位搜索共用统计范围，未知岗位保留且个人关注不写CONTEXT', async ($, on) => {
  const env = setup(on);
  env.files[`${root}/CONTEXT.md`] += '\n| 关闭岗位 | P1 | 已关闭 |';
  env.files[`${root}/02-sourcing/dedup-ledger.csv`] += '\n2,合成乙,关闭岗位,,B,待初筛,test,,\n3,合成丙,未知岗位,,B,初筛通过,test,,';
  await open($);
  const ui = await mount($);
  await ui.press({ key: 'show-stages' });
  expect(await ui.find({ type: 'Text', text: /共 2 条/ })).toBeDefined();
  expect((await ui.find({ key: 'role' }))?.props.options).toContainEqual({ value: '未知岗位', label: '未知岗位 · 状态未知' });
  expect((await ui.find({ key: 'role' }))?.props.options).not.toContainEqual({ value: '关闭岗位', label: '关闭岗位 · 已关闭' });
  await ui.input({ key: 'role-search', text: '合成', kind: 'change' });
  expect((await ui.find({ key: 'role' }))?.props.options).toHaveLength(2);
  expect(await ui.find({ type: 'Text', text: /共 2 条/ })).toBeDefined();
  await ui.select({ key: 'role', value: '合成岗位' });
  await ui.input({ key: 'role-search', text: '找不到' });
  expect((await ui.find({ key: 'role' }))?.props.value).toBe('合成岗位');
  expect(await ui.find({ type: 'Text', text: /不匹配当前搜索/ })).toBeDefined();
  expect(await ui.find({ type: 'Text', text: /共 1 条/ })).toBeDefined();
  await ui.press({ key: 'scope-following' });
  expect((await ui.find({ key: 'role' }))?.props.value).toBe('');
  expect(await ui.find({ type: 'Text', text: /共 0 条/ })).toBeDefined();
  expect(await ui.find({ type: 'Text', text: /尚未关注岗位/ })).toBeDefined();
  const context = env.files[`${root}/CONTEXT.md`];
  await ui.press({ key: 'choose-following' });
  await ui.input({ key: 'following-search', text: '关闭' });
  await ui.press({ key: (await ui.find({ type: 'Button', text: /^关注$/ }))!.key! });
  expect(await ui.find({ type: 'Text', text: /共 1 条/ })).toBeDefined();
  expect((await ui.find({ key: 'stage-screen' }))?.text).toBe('待初筛');
  await ui.press({ key: 'stage-screen' });
  expect(await ui.find({ type: 'Button', text: /^合成乙$/ })).toBeDefined();
  expect(env.files[`${root}/CONTEXT.md`]).toBe(context);
  expect(env.calls.filter(argv => argv[2] === 'role-set')).toHaveLength(0);
  expect(env.store[preferenceKey(root)]).toEqual({ scope: 'following', following: ['关闭岗位'], role: '' });
  await ui.press({ key: 'scope-all' });
  expect(await ui.find({ type: 'Text', text: /共 3 条/ })).toBeDefined();
  await ui.unmount();
});

test('canonical工作区偏好首次加载，轮询不抢手动选择，切工作区清查询与关注编辑并分别恢复偏好', async ($, on) => {
  const env = setup(on);
  const other = '/synthetic-other-workspace';
  addWorkspace(env, other);
  env.files[`${root}/CONTEXT.md`] += '\n| 关闭岗位 | P1 | 已关闭 |';
  env.files[`${root}/02-sourcing/dedup-ledger.csv`] += '\n2,合成乙,关闭岗位,,B,待初筛,test,,';
  env.stats['/synthetic-link'] = { kind: 'dir', size: 0, mtimeMs: Date.parse(now), isLink: true, realPath: root };
  env.store[preferenceKey(root)] = { scope: 'all', following: ['关闭岗位'], role: '关闭岗位' };
  env.store[preferenceKey(other)] = { scope: 'following', following: ['合成岗位'], role: '' };
  await open($, '/synthetic-link');
  const ui = await mount($);
  expect((await ui.find({ key: 'scope-all' }))?.text).toBe('全部 · 已选');
  expect((await ui.find({ key: 'role' }))?.props.value).toBe('关闭岗位');
  await ui.select({ key: 'role', value: '合成岗位' });
  await ui.input({ key: 'role-search', text: '合成' });
  await ui.press({ key: 'choose-following' });
  await ui.input({ key: 'following-search', text: '关闭' });
  env.files[runFile()] = JSON.stringify({ ...newRun(), status: 'waiting', reason: '等待刷新', updatedAt: '2026-10-22T01:00:01.000Z' });
  await env.clock.advance(2000);
  expect((await ui.find({ key: 'role' }))?.props.value).toBe('合成岗位');
  expect((await ui.find({ key: 'role-search' }))?.props.value).toBe('合成');
  expect((await ui.find({ key: 'following-search' }))?.props.value).toBe('关闭');
  await open($, other);
  expect((await ui.find({ key: 'scope-following' }))?.text).toBe('关注 · 已选');
  expect((await ui.find({ key: 'role-search' }))?.props.value).toBe('');
  expect(await ui.find({ key: 'following-search' })).toBeUndefined();
  await open($);
  expect((await ui.find({ key: 'scope-all' }))?.text).toBe('全部 · 已选');
  expect((await ui.find({ key: 'role' }))?.props.value).toBe('合成岗位');
  expect((await ui.find({ key: 'role-search' }))?.props.value).toBe('');
  expect(env.store[preferenceKey(root)]).toEqual({ scope: 'all', following: ['关闭岗位'], role: '合成岗位' });
  expect(env.store[preferenceKey(other)]).toEqual({ scope: 'following', following: ['合成岗位'], role: '' });
  await ui.unmount();
});

test('刷新后已选岗位消失保留选择并显示未知，空范围和无搜索匹配分别提示', async ($, on) => {
  const env = setup(on);
  await open($);
  const ui = await mount($);
  await ui.press({ key: 'show-stages' });
  await ui.input({ key: 'role-search', text: '找不到' });
  expect(await ui.find({ type: 'Text', text: /没有匹配的岗位/ })).toBeDefined();
  expect(await ui.find({ type: 'Text', text: /共 1 条/ })).toBeDefined();
  await ui.input({ key: 'role-search', text: '' });
  await ui.select({ key: 'role', value: '合成岗位' });
  env.files[`${root}/CONTEXT.md`] = '## 在招岗位与优先级\n| 岗位 | 优先级 | 状态 |\n|---|---|---|';
  env.files[`${root}/02-sourcing/dedup-ledger.csv`] = LEDGER_COLUMNS.join(',');
  await env.clock.advance(2000);
  expect((await ui.find({ key: 'role' }))?.props.value).toBe('合成岗位');
  expect(await ui.find({ type: 'Text', text: /未在当前源中，保留选择；统计未知/ })).toBeDefined();
  expect(await ui.find({ type: 'Text', text: /共 未知 条/ })).toBeDefined();
  await ui.press({ key: 'scope-active' });
  expect((await ui.find({ key: 'role' }))?.props.value).toBe('');
  expect(await ui.find({ type: 'Text', text: /当前没有在招或状态未知的岗位/ })).toBeDefined();
  expect(await ui.find({ type: 'Text', text: /共 0 条/ })).toBeDefined();
  await ui.unmount();
});

test('首页与结果页区分旧任务未记录和新任务零人，结果不常驻快照', async ($, on) => {
  const env = setup(on);
  setResults(env, null, 'native-test', root, 0);
  await open($);
  const ui = await mount($);
  expect(await ui.find({ type: 'Text', text: /尚未记录候选人处理结果，需确认人数未知/ })).toBeDefined();
  expect(await ui.find({ type: 'Text', text: /本轮需确认 0 人/ })).toBeUndefined();
  expect(env.calls.filter(argv => argv[2] === 'run-results')).toHaveLength(1);
  await ui.press({ key: 'show-records' });
  expect((await ui.find({ key: 'run-results' }))?.text).toContain('未记录');
  await ui.press({ key: 'run-results' });
  expect(await ui.find({ type: 'Text', text: /尚未记录候选人处理结果，人数未知/ })).toBeDefined();
  expect(env.calls.at(-1)?.slice(2)).toEqual(['run-results', '--workspace', root, '--run', 'native-test']);
  await ui.press({ key: 'results-back' });
  setResults(env, []);
  await env.clock.advance(2000);
  expect(await ui.find({ type: 'Text', text: /本轮需确认 0 人/ })).toBeDefined();
  expect((await ui.find({ key: 'run-results' }))?.text).toContain('本轮已记录 0 人');
  await ui.press({ key: 'run-results' });
  expect(await ui.find({ type: 'Text', text: /本轮已记录 0 人，尚无候选人处理结果/ })).toBeDefined();
  expect(env.latest?.snapshot?.runs?.[0]).not.toHaveProperty('results');
  await ui.unmount();
});

test('结果按人分组并优先未消解确认，同人其他步骤none不冲掉decision，未入台账可读收据', async ($, on) => {
  const env = setup(on);
  const missing = JSON.stringify(['未入账乙', '原始岗位']);
  const normal = JSON.stringify(['普通丙', '普通岗位']);
  const rows = [result('normal', normal), result('notice', missing, 'notice'), result('decision', candidateId, 'decision'), result('ledger', candidateId, 'none', 'ledger')];
  setResults(env, rows);
  await open($);
  const ui = await mount($);
  expect(await ui.find({ type: 'Text', text: /^本轮需确认 1 人$/ })).toBeDefined();
  expect(await ui.find({ type: 'Button', text: /^合成甲$/ })).toBeDefined();
  expect(await ui.find({ type: 'Text', text: /^未入账乙$/ })).toBeUndefined();
  await ui.press({ key: 'show-records' });
  expect((await ui.find({ key: 'run-results' }))?.text).toContain('本轮已记录 3 人');
  await ui.press({ key: 'run-results' });
  const summaries = await ui.findAll({ type: 'Text', text: /^(合成甲|未入账乙|普通丙)$/ });
  expect(summaries.map(item => item.text)).toEqual(['合成甲', '未入账乙', '普通丙']);
  expect(await ui.findAll({ type: 'Button', text: /^合成甲$/ })).toHaveLength(1);
  expect(await ui.find({ type: 'Button', text: /^未入账乙$/ })).toBeUndefined();
  expect(await ui.find({ type: 'Text', text: /未入台账，可查看处理记录/ })).toBeDefined();
  expect(await ui.find({ type: 'Text', text: /^原岗位：原始岗位$/ })).toBeDefined();
  expect(await ui.find({ type: 'Text', text: /下一步：请确认匹配要求/ })).toBeDefined();
  expect(await ui.find({ type: 'Text', text: /^动作decision · 需你确认$/ })).toBeDefined();
  expect(await ui.find({ type: 'Text', text: /^动作ledger$/ })).toBeUndefined();
  await ui.press({ key: (await ui.find({ type: 'Button', text: /^查看其余记录/ }))!.key! });
  const actions = await ui.findAll({ type: 'Text', text: /^动作(decision|ledger)/ });
  expect(actions.map(item => item.text)).toEqual(['动作decision · 需你确认', '动作ledger']);
  await ui.press({ key: 'results-filter-decision' });
  expect(await ui.find({ type: 'Button', text: /^合成甲$/ })).toBeDefined();
  expect(await ui.find({ type: 'Text', text: /^未入账乙$/ })).toBeUndefined();
  await ui.press({ key: (await ui.find({ type: 'Button', text: /^合成甲$/ }))!.key! });
  await ui.press({ key: 'candidate-background' });
  expect(await ui.find({ type: 'Code', text: '合成背景摘要' })).toBeDefined();
  expect((await ui.find({ key: 'candidate-back' }))?.text).toBe('返回本轮处理记录');
  await ui.press({ key: 'candidate-back' });
  expect((await ui.find({ key: 'results-filter-decision' }))?.text).toBe('需你确认 · 已选');
  expect(await ui.find({ type: 'Text', text: /^动作ledger$/ })).toBeDefined();
  expect(await ui.find({ type: 'Button', text: '收起其余记录' })).toBeDefined();
  await ui.press({ key: 'results-filter-notice' });
  expect(await ui.find({ type: 'Text', text: /^未入账乙$/ })).toBeDefined();
  expect(await ui.find({ type: 'Button', text: /^合成甲$/ })).toBeUndefined();
  await ui.press({ key: 'results-filter-decision' });
  setResults(env, rows.map(row => row.id === 'decision' ? { ...row, attention: 'none', nextAction: null } : row), 'native-test', root, 2);
  await env.clock.advance(2000);
  expect(await ui.find({ type: 'Text', text: /本轮暂无需你确认的人选/ })).toBeDefined();
  expect(await ui.find({ type: 'Text', text: /需你确认 0 人/ })).toBeDefined();
  await ui.unmount();
});

test('同毫秒同人数结果更正仍自动刷新，纯步骤变化不重读，失败保留陈旧结果且可重试', async ($, on) => {
  const env = setup(on);
  setResults(env, [result('screen', candidateId, 'decision')]);
  await open($);
  const ui = await mount($);
  await ui.press({ key: 'run-decisions' });
  const firstReads = env.calls.filter(argv => argv[2] === 'run-results').length;
  const run = JSON.parse(env.files[runFile()]!) as Run;
  env.files[runFile()] = JSON.stringify({ ...run, status: 'waiting', reason: '任务暂停等待', updatedAt: '2026-10-22T01:00:01.000Z' });
  await env.clock.advance(2000);
  expect(env.calls.filter(argv => argv[2] === 'run-results')).toHaveLength(firstReads);
  expect(await ui.find({ type: 'Text', text: /每日招聘 · 等待/ })).toBeDefined();
  setResults(env, [{ ...result('screen', candidateId, 'decision'), outcome: '同毫秒已更正结论' }], 'native-test', root, 2);
  await env.clock.advance(2000);
  expect(env.calls.filter(argv => argv[2] === 'run-results')).toHaveLength(firstReads + 2);
  expect(await ui.find({ type: 'Text', text: /^同毫秒已更正结论$/ })).toBeDefined();
  env.errors['run-results'] = '合成结果读取拒绝';
  setResults(env, [{ ...result('screen', candidateId, 'decision'), outcome: '恢复后的结论' }], 'native-test', root, 3);
  await env.clock.advance(2000);
  expect(await ui.find({ type: 'Text', text: /结果读取失败.*陈旧/ })).toBeDefined();
  expect(await ui.find({ type: 'Text', text: /^同毫秒已更正结论$/ })).toBeDefined();
  expect(await ui.find({ type: 'Text', text: /本轮已记录 0 人/ })).toBeUndefined();
  delete env.errors['run-results'];
  await ui.press({ key: 'results-reload' });
  expect(await ui.find({ type: 'Text', text: /^恢复后的结论$/ })).toBeDefined();
  expect((await ui.find({ key: 'results-filter-decision' }))?.text).toBe('需你确认 · 已选');
  await ui.unmount();
});

test('第一次结果读取失败不假零，失败任务明确说明仅展示已记录结果', async ($, on) => {
  const env = setup(on);
  setResults(env, [result('screen', candidateId, 'decision')]);
  const run = JSON.parse(env.files[runFile()]!) as Run;
  env.files[runFile()] = JSON.stringify({ ...run, status: 'failed', reason: '合成任务失败' });
  env.errors['run-results'] = '读取拒绝';
  await open($);
  const ui = await mount($);
  expect(await ui.find({ type: 'Text', text: /本轮确认列表读取失败.*当前人数未知/ })).toBeDefined();
  await ui.press({ key: 'show-records' });
  await ui.press({ key: 'run-results' });
  expect(await ui.find({ type: 'Text', text: /任务失败，以下仅为已记录/ })).toBeDefined();
  expect(await ui.find({ type: 'Text', text: /结果读取失败.*当前人数未知/ })).toBeDefined();
  expect(await ui.find({ type: 'Text', text: /本轮已记录 0 人/ })).toBeUndefined();
  await ui.unmount();
});

test('异步结果切run、切工作区或关闭后不覆盖当前视图，候选异步返回也不串工作区', async ($, on) => {
  const env = setup(on);
  const other = '/synthetic-other-workspace';
  addWorkspace(env, other);
  env.files[runFile(root, 'second-run')] = JSON.stringify(newRun('second-run'));
  setResults(env, [{ ...result('first'), outcome: '旧任务结果哨兵' }]);
  setResults(env, [{ ...result('second'), outcome: '第二任务结果哨兵' }], 'second-run');
  setResults(env, [{ ...result('other'), outcome: '另工作区结果哨兵' }], 'native-test', other);
  await open($);
  const ui = await mount($);
  await ui.press({ key: 'show-records' });
  await ui.select({ key: 'run', value: 'native-test' });
  env.delays['run-results'] = 3000;
  const first = ui.press({ key: 'run-results' });
  await env.clock.settle();
  expect(await ui.find({ type: 'Text', text: /正在读取本轮结果/ })).toBeDefined();
  delete env.delays['run-results'];
  await ui.select({ key: 'run', value: 'second-run' });
  expect(await ui.find({ type: 'Text', text: /^第二任务结果哨兵$/ })).toBeDefined();
  await env.clock.advance(3000);
  await first;
  expect(await ui.find({ type: 'Text', text: /^旧任务结果哨兵$/ })).toBeUndefined();
  expect(await ui.find({ type: 'Text', text: /^第二任务结果哨兵$/ })).toBeDefined();
  env.delays['run-results'] = 3000;
  const reload = ui.press({ key: 'results-reload' });
  await env.clock.settle();
  delete env.delays['run-results'];
  await open($, other);
  await ui.press({ key: 'show-records' });
  await ui.press({ key: 'run-results' });
  expect(await ui.find({ type: 'Text', text: /^另工作区结果哨兵$/ })).toBeDefined();
  await env.clock.advance(3000);
  await reload;
  expect(await ui.find({ type: 'Text', text: /^第二任务结果哨兵$/ })).toBeUndefined();
  env.delays['candidate'] = 3000;
  const candidate = ui.press({ key: (await ui.find({ type: 'Button', text: /^合成甲$/ }))!.key! });
  await env.clock.settle();
  await open($);
  await env.clock.advance(3000);
  await candidate;
  expect(await ui.find({ key: 'candidate-back' })).toBeUndefined();
  expect(await ui.find({ type: 'Code', text: '私密备注' })).toBeUndefined();
  env.delays['run-results'] = 3000;
  await ui.press({ key: 'show-records' });
  const closing = ui.press({ key: 'run-results' });
  await env.clock.settle();
  await ui.press({ key: 'results-back' });
  await env.clock.advance(3000);
  await closing;
  expect(env.latest?.panel).toBeNull();
  await ui.unmount();
});

test('默认跟随createdAt最新，其他会话旧任务更新不抢；手选固定直到显式跟随最新', async ($, on) => {
  const env = setup(on);
  const newest = newRun('newest-run', '2026-10-22T01:00:01.000Z');
  newest.status = 'completed';
  newest.steps = newest.steps.map(step => ({ ...step, status: 'completed' }));
  env.files[runFile(root, newest.id)] = JSON.stringify(newest);
  env.files[runFile()] = JSON.stringify({ ...newRun(), ownerSessionId: 'synthetic-session', updatedAt: '2026-10-22T01:00:05.000Z' });
  await open($);
  const ui = await mount($);
  await ui.press({ key: 'show-records' });
  expect((await ui.find({ type: 'Select', key: 'run' }))?.props.value).toBe('newest-run');
  expect(env.latest?.taskSelection).toEqual({ mode: 'live', runId: 'newest-run' });
  env.files[runFile()] = JSON.stringify({ ...newRun(), ownerSessionId: 'synthetic-session', updatedAt: '2026-10-22T01:00:10.000Z' });
  await env.clock.advance(2000);
  expect((await ui.find({ key: 'run' }))?.props.value).toBe('newest-run');
  await ui.select({ key: 'run', value: 'native-test' });
  env.files[runFile(root, 'third-run')] = JSON.stringify(newRun('third-run', '2026-10-22T01:00:11.000Z'));
  await env.clock.advance(2000);
  expect((await ui.find({ key: 'run' }))?.props.value).toBe('native-test');
  expect(env.latest?.taskSelection.mode).toBe('pinned');
  expect(await ui.find({ type: 'Text', text: /有新任务，当前阅读保持不变/ })).toBeDefined();
  await ui.press({ key: (await ui.find({ type: 'Button', text: /回到最新/ }))!.key! });
  await ui.press({ key: 'show-records' });
  expect((await ui.find({ key: 'run' }))?.props.value).toBe('third-run');
  expect(env.latest?.taskSelection.mode).toBe('live');
  await ui.unmount();
});

for (const reading of ['activity-candidate', 'results', 'roles', 'steps', 'preferences'] as const) {
  test(`阅读期间新任务使当前选择固定，退出后保持并可回最新：${reading}`, async ($, on) => {
    const env = setup(on);
    setResults(env, [result('read', candidateId, 'decision')]);
    await open($);
    const ui = await mount($);
    if (reading === 'activity-candidate' || reading === 'steps') await ui.press({ key: 'show-records' });
    if (reading === 'activity-candidate') await ui.press({ key: (await ui.findAll({ type: 'Button', text: /^合成甲$/ })).find(button => button.key?.startsWith('activity-candidate-'))!.key! });
    else if (reading === 'results') await ui.press({ key: 'run-decisions' });
    else if (reading === 'roles') await ui.press({ key: 'manage-roles' });
    else if (reading === 'steps') await ui.press({ key: 'show-steps' });
    else await ui.press({ key: 'choose-following' });
    expect(env.latest?.taskSelection.mode).toBe('live');
    if (reading === 'activity-candidate' || reading === 'results' || reading === 'roles') {
      expect(await ui.find({ type: 'Text', text: /^synthetic-recruit-board$/ })).toBeDefined();
      expect(await ui.find({ type: 'Text', text: /^每日招聘 · 进行中$/ })).toBeDefined();
    }
    env.files[runFile(root, 'newer-run')] = JSON.stringify(newRun('newer-run', '2026-10-22T01:00:01.000Z'));
    await env.clock.advance(2000);
    expect(env.latest?.taskSelection).toEqual({ mode: 'pinned', runId: 'native-test' });
    expect(await ui.find({ type: 'Button', text: /回到最新/ })).toBeDefined();
    if (reading === 'activity-candidate') {
      expect((await ui.find({ type: 'Button', text: '返回最近动态' }))?.key).toBeDefined();
      await ui.press({ key: (await ui.find({ type: 'Button', text: '返回最近动态' }))!.key! });
    } else if (reading === 'results') await ui.press({ key: 'results-back' });
    else if (reading === 'roles') await ui.press({ key: 'role-cancel' });
    else if (reading === 'steps') await ui.press({ key: 'show-steps' });
    else await ui.press({ key: 'choose-following' });
    await env.clock.advance(2000);
    if (reading === 'results' || reading === 'roles' || reading === 'preferences') await ui.press({ key: 'show-records' });
    expect((await ui.find({ key: 'run' }))?.props.value).toBe('native-test');
    await ui.press({ key: (await ui.find({ type: 'Button', text: /回到最新/ }))!.key! });
    expect(env.latest?.taskSelection).toEqual({ mode: 'live', runId: 'newer-run' });
    await ui.unmount();
  });
}

test('旧runId状态迁移为固定任务，新的工作区使用live', async ($, on) => {
  const env = setup(on);
  let legacy: RecruitingBoardState | null = null;
  on('state.get', { plugin: 'recruiting-board', key: 'board' }, async ($, e, next) => {
    const current = await next(e);
    if (!legacy || !current.value) return current;
    const restored = legacy;
    legacy = null;
    return { value: { ...current.value, value: restored } };
  });
  on('session.start', ($, e) => ({ cwd: e.cwd }));
  await open($);
  const { taskSelection, activity, ...previous } = env.latest!;
  legacy = { ...previous, runId: 'native-test' } as unknown as RecruitingBoardState;
  await $.session.start({ cwd: root, surface: 'desktop', isInteractive: true });
  expect(env.latest?.taskSelection).toEqual({ mode: 'pinned', runId: 'native-test' });
  const other = '/synthetic-other-workspace';
  addWorkspace(env, other);
  await open($, other);
  expect(env.latest?.taskSelection).toEqual({ mode: 'live', runId: 'native-test' });
});

test('固定任务移除保留选择与未知，读取期间live任务消失也保持且有回最新入口', async ($, on) => {
  const env = setup(on);
  env.files[runFile(root, 'fallback-run')] = JSON.stringify({ ...newRun('fallback-run'), createdAt: '2026-10-22T00:59:00.000Z' });
  await open($);
  const ui = await mount($);
  await ui.press({ key: 'show-records' });
  await ui.select({ key: 'run', value: 'native-test' });
  delete env.files[runFile()];
  await env.clock.advance(2000);
  expect((await ui.find({ key: 'run' }))?.props.value).toBe('native-test');
  expect(await ui.find({ type: 'Text', text: /所选记录已移除/ })).toBeDefined();
  expect(await ui.find({ type: 'Text', text: /当前任务选择保持不变，人数未知/ })).toBeDefined();
  expect(await ui.find({ type: 'Button', text: /^0 人$/ })).toBeUndefined();
  env.files[runFile()] = JSON.stringify(newRun());
  await env.clock.advance(2000);
  await ui.press({ key: (await ui.find({ type: 'Button', text: /跟随最新/ }))!.key! });
  await ui.press({ key: 'show-records' });
  await ui.press({ key: 'show-steps' });
  delete env.files[runFile()];
  await env.clock.advance(2000);
  expect(env.latest?.taskSelection).toEqual({ mode: 'pinned', runId: 'native-test' });
  expect(await ui.find({ type: 'Text', text: /所选记录已移除/ })).toBeDefined();
  await ui.unmount();
});

test('最近动态仅取3条收据而非3人，默认读取一次，真实revision更正才刷新', async ($, on) => {
  const env = setup(on);
  const missing = JSON.stringify(['未入账乙', '原始岗位']);
  env.files[runFile()] = JSON.stringify({ ...newRun('native-test', '2026-10-22T00:59:58.000Z'), updatedAt: now });
  const older = { ...result('older', missing, 'notice'), updatedAt: '2026-10-22T00:59:59.000Z' };
  setResults(env, [older, result('first', candidateId, 'decision'), result('second', candidateId, 'none', 'ledger'), result('third', missing, 'notice')]);
  await open($);
  const ui = await mount($);
  expect(env.calls.filter(argv => argv[2] === 'run-activity').map(argv => argv.slice(2))).toEqual([['run-activity', '--workspace', root, '--run', 'native-test']]);
  expect(env.calls.filter(argv => argv[2] === 'run-results')).toHaveLength(1);
  await ui.press({ key: 'show-records' });
  expect(await ui.find({ type: 'Text', text: /^最近动态$/ })).toBeDefined();
  expect(await ui.findAll({ type: 'Text', text: /^结论(first|second|third)$/ })).toHaveLength(3);
  expect(await ui.find({ type: 'Text', text: /^结论older$/ })).toBeUndefined();
  expect((await ui.findAll({ type: 'Button', text: /^合成甲$/ })).filter(button => button.key?.startsWith('activity-candidate-'))).toHaveLength(2);
  expect(await ui.find({ type: 'Button', text: /^未入账乙$/ })).toBeUndefined();
  expect(await ui.find({ type: 'Text', text: /^原岗位：原始岗位$/ })).toBeDefined();
  const stableWrites = env.writes;
  await env.clock.advance(6000);
  expect(env.writes).toBe(stableWrites);
  expect(env.calls.filter(argv => argv[2] === 'run-activity')).toHaveLength(1);
  const run = JSON.parse(env.files[runFile()]!) as Run;
  env.files[runFile()] = JSON.stringify({ ...run, status: 'waiting', reason: '等待业务确认', updatedAt: '2026-10-22T01:00:01.000Z' });
  await env.clock.advance(2000);
  expect(env.calls.filter(argv => argv[2] === 'run-activity')).toHaveLength(1);
  setResults(env, run.results!.map(row => row.id === 'first' ? { ...row, outcome: '同毫秒最新业务结论' } : row), 'native-test', root, 2);
  await env.clock.advance(2000);
  expect(env.calls.filter(argv => argv[2] === 'run-activity')).toHaveLength(2);
  expect(await ui.find({ type: 'Text', text: /^同毫秒最新业务结论$/ })).toBeDefined();
  expect(env.latest?.activity?.data?.revision).toBe(2);
  expect(env.latest?.snapshot?.runs?.[0]).not.toHaveProperty('results');
  await ui.unmount();
});

test('动态null不假零，读取失败保留陈旧记录，相同失败版本不反复写状态', async ($, on) => {
  const env = setup(on);
  setResults(env, null, 'native-test', root, 0);
  await open($);
  const ui = await mount($);
  await ui.press({ key: 'show-records' });
  expect(await ui.find({ type: 'Text', text: /尚未记录候选人处理结果，最近动态未知/ })).toBeDefined();
  expect(await ui.find({ type: 'Text', text: /还没有候选人处理记录/ })).toBeUndefined();
  env.errors['run-activity'] = '合成动态读取拒绝';
  setResults(env, [result('read')], 'native-test', root, 1);
  await env.clock.advance(2000);
  expect(await ui.find({ type: 'Text', text: /最近动态读取失败.*陈旧/ })).toBeDefined();
  const writes = env.writes;
  await env.clock.advance(4000);
  expect(env.writes).toBe(writes);
  delete env.errors['run-activity'];
  await ui.press({ key: (await ui.find({ type: 'Button', text: '重新读取最近动态' }))!.key! });
  expect(await ui.find({ type: 'Text', text: /^结论read$/ })).toBeDefined();
  env.errors['run-activity'] = '下一版本暂未读取';
  setResults(env, [{ ...result('read'), outcome: '等待恢复结论' }], 'native-test', root, 2);
  await env.clock.advance(2000);
  expect(await ui.find({ type: 'Text', text: /^结论read$/ })).toBeDefined();
  expect(await ui.find({ type: 'Text', text: /最近动态读取失败.*陈旧/ })).toBeDefined();
  delete env.errors['run-activity'];
  await ui.press({ key: (await ui.find({ type: 'Button', text: '重新读取最近动态' }))!.key! });
  expect(await ui.find({ type: 'Text', text: /^等待恢复结论$/ })).toBeDefined();
  await ui.unmount();
});

test('动态初次读取失败不显示空记录，过旧或串任务版本拒绝落入当前动态', async ($, on) => {
  const env = setup(on);
  setResults(env, [result('current')], 'native-test', root, 2);
  env.errors['run-activity'] = '合成读取拒绝';
  await open($);
  const ui = await mount($);
  expect(await ui.find({ type: 'Text', text: /最近动态读取失败.*最近动态未知/ })).toBeDefined();
  expect(await ui.find({ type: 'Text', text: /还没有候选人处理记录/ })).toBeUndefined();
  await ui.press({ key: 'show-records' });
  delete env.errors['run-activity'];
  env.activity = { runId: 'native-test', revision: 1, updatedAt: now, items: [result('too-old')] };
  await ui.press({ key: (await ui.find({ type: 'Button', text: '重新读取最近动态' }))!.key! });
  expect(await ui.find({ type: 'Text', text: /动态不属于当前任务版本/ })).toBeDefined();
  expect(await ui.find({ type: 'Text', text: /^结论too-old$/ })).toBeUndefined();
  env.activity = { runId: 'other-run', revision: 2, updatedAt: now, items: [result('wrong-run')] };
  await ui.press({ key: (await ui.find({ type: 'Button', text: '重新读取最近动态' }))!.key! });
  expect(await ui.find({ type: 'Text', text: /^结论wrong-run$/ })).toBeUndefined();
  env.activity = null;
  await ui.press({ key: (await ui.find({ type: 'Button', text: '重新读取最近动态' }))!.key! });
  expect(await ui.find({ type: 'Text', text: /^结论current$/ })).toBeDefined();
  await ui.unmount();
});

for (const destination of ['run', 'workspace', 'end'] as const) {
  test(`延迟动态由run、版本和工作区保护，旧请求不能覆盖：${destination}`, async ($, on) => {
    const env = setup(on);
    on('session.end', ($, e) => ({ sessionId: e.sessionId }));
    const other = '/synthetic-other-workspace';
    addWorkspace(env, other);
    setResults(env, [{ ...result('old'), outcome: '延迟旧动态哨兵' }]);
    setResults(env, [{ ...result('other'), outcome: '另一工作区动态哨兵' }], 'native-test', other);
    env.files[runFile(root, 'second-run')] = JSON.stringify({ ...newRun('second-run'), createdAt: '2026-10-22T00:59:00.000Z' });
    setResults(env, [{ ...result('second'), outcome: '第二任务动态哨兵' }], 'second-run');
    env.delays['run-activity'] = 3000;
    const first = open($);
    await env.clock.settle();
    const ui = await mount($);
    await ui.press({ key: 'show-records' });
    delete env.delays['run-activity'];
    if (destination === 'run') await ui.select({ key: 'run', value: 'second-run' });
    else if (destination === 'workspace') { await open($, other); await ui.press({ key: 'show-records' }); }
    else await $.session.end({ reason: 'clear', sessionId: 'synthetic-session', resume: { id: 'synthetic-session' } });
    await env.clock.advance(3000);
    await first;
    expect(await ui.find({ type: 'Text', text: /^延迟旧动态哨兵$/ })).toBeUndefined();
    if (destination === 'run') expect(await ui.find({ type: 'Text', text: /^第二任务动态哨兵$/ })).toBeDefined();
    else if (destination === 'workspace') expect(await ui.find({ type: 'Text', text: /^另一工作区动态哨兵$/ })).toBeDefined();
    else expect(env.latest?.activity).toBeNull();
    await ui.unmount();
  });
}

test('阅读详情仍显示工作区、任务与源快照陈旧提示，资料返回保留筛选且不重复读取', async ($, on) => {
  const env = setup(on);
  setResults(env, [result('decision', candidateId, 'decision'), result('ledger', candidateId, 'none', 'ledger')]);
  await open($);
  const ui = await mount($);
  await ui.press({ key: 'run-decisions' });
  await ui.press({ key: (await ui.find({ type: 'Button', text: /查看其余记录/ }))!.key! });
  const reads = env.calls.filter(argv => argv[2] === 'run-results').length;
  await ui.press({ key: (await ui.find({ type: 'Button', text: /^合成甲$/ }))!.key! });
  env.files[runFile()] = '{';
  await env.clock.advance(2000);
  expect(await ui.find({ type: 'Text', text: /^synthetic-recruit-board$/ })).toBeDefined();
  expect(await ui.find({ type: 'Text', text: /^每日招聘 · 进行中$/ })).toBeDefined();
  expect(await ui.find({ type: 'Text', text: /数据读取失败.*陈旧/ })).toBeDefined();
  expect(await ui.find({ type: 'Text', text: /任务与最近动态沿用最后记录.*陈旧/ })).toBeDefined();
  await ui.press({ key: 'candidate-back' });
  expect((await ui.find({ key: 'results-filter-decision' }))?.text).toBe('需你确认 · 已选');
  expect(await ui.find({ type: 'Text', text: /^动作ledger$/ })).toBeDefined();
  expect(env.calls.filter(argv => argv[2] === 'run-results')).toHaveLength(reads);
  await ui.press({ key: 'results-back' });
  await ui.press({ key: 'manage-roles' });
  expect(await ui.find({ type: 'Text', text: /^synthetic-recruit-board$/ })).toBeDefined();
  expect(await ui.find({ type: 'Text', text: /数据读取失败.*陈旧/ })).toBeDefined();
  await ui.unmount();
});

test('首页仅列本轮decision前五人，岗位筛选不改名单，资料可返回且每条确认依据可达', async ($, on) => {
  const env = setup(on);
  const others = Array.from({ length: 5 }, (_, index) => JSON.stringify([`需确认${index + 1}`, '另一岗位']));
  const high = JSON.stringify(['高评级人选', '合成岗位']);
  env.files[`${root}/02-sourcing/dedup-ledger.csv`] += '\n2,高评级人选,合成岗位,,A,已约面试,test,,';
  setResults(env, [
    { ...result('first', candidateId, 'decision'), nextAction: '确认业务方向' },
    { ...result('second', candidateId, 'decision', 'ledger'), nextAction: '确认到岗时间' },
    result('normal', candidateId, 'none', 'report'),
    ...others.map((id, index) => result(`other-${index}`, id, 'decision')),
    result('notice', high, 'notice')
  ]);
  await open($);
  const ui = await mount($);
  expect(await ui.find({ type: 'Text', text: /本轮需确认 6 人 · 先显示前 5 人/ })).toBeDefined();
  expect(await ui.findAll({ type: 'Button', text: '查看依据' })).toHaveLength(5);
  expect(await ui.find({ type: 'Text', text: /^高评级人选$/ })).toBeUndefined();
  expect(await ui.find({ type: 'Text', text: /^需确认5$/ })).toBeUndefined();
  expect(await ui.find({ type: 'Text', text: /^A$/ })).toBeUndefined();
  expect(await ui.find({ type: 'Text', text: /^合成岗位$/ })).toBeDefined();
  expect(await ui.find({ type: 'Text', text: /^原状态：已回复$/ })).toBeDefined();
  expect(await ui.find({ type: 'Button', text: '查看资料' })).toBeDefined();
  expect(await ui.find({ type: 'Text', text: '下一步：确认业务方向' })).toBeDefined();
  expect(await ui.find({ type: 'Text', text: '下一步：确认到岗时间' })).toBeDefined();
  expect(await ui.find({ type: 'Text', text: /^动作first/ })).toBeUndefined();
  expect(await ui.find({ type: 'Text', text: /^结论first$/ })).toBeUndefined();
  await ui.press({ key: 'scope-following' });
  expect(await ui.find({ type: 'Text', text: /本轮需确认 6 人/ })).toBeDefined();
  expect(await ui.find({ type: 'Text', text: /不受下方岗位范围筛选影响/ })).toBeDefined();
  await ui.press({ key: (await ui.find({ type: 'Button', text: '查看资料' }))!.key! });
  expect((await ui.find({ key: 'candidate-back' }))?.text).toBe('返回本轮需确认');
  expect(await ui.find({ type: 'Code', text: '私密备注' })).toBeUndefined();
  expect(await ui.find({ type: 'Button', text: '打开 PDF' })).toBeDefined();
  await ui.press({ key: 'candidate-back' });
  expect(await ui.find({ type: 'Text', text: /本轮需确认 6 人/ })).toBeDefined();
  expect(await ui.find({ type: 'Text', text: /^本轮处理记录$/ })).toBeUndefined();
  await ui.press({ key: (await ui.find({ type: 'Button', text: '查看依据' }))!.key! });
  expect((await ui.find({ key: 'results-filter-decision' }))?.text).toBe('需你确认 · 已选');
  expect(await ui.find({ type: 'Text', text: '下一步：确认业务方向' })).toBeDefined();
  expect(await ui.find({ type: 'Text', text: '下一步：确认到岗时间' })).toBeDefined();
  await ui.press({ key: 'results-back' });
  await ui.press({ key: 'run-decisions' });
  expect(await ui.find({ type: 'Text', text: /^需确认5$/ })).toBeDefined();
  expect(await ui.find({ type: 'Text', text: /^高评级人选$/ })).toBeUndefined();
  await ui.unmount();
});

test('首页自动确认列表不固定阅读且只在run或revision变化时重读，失败版本隐藏旧确认', async ($, on) => {
  const env = setup(on);
  setResults(env, [result('initial', candidateId, 'decision')]);
  await open($);
  const ui = await mount($);
  const writes = env.writes;
  await env.clock.advance(6000);
  expect(env.writes).toBe(writes);
  expect(env.calls.filter(argv => argv[2] === 'run-results')).toHaveLength(1);
  const nextId = 'next-run';
  env.files[runFile(root, nextId)] = JSON.stringify(newRun(nextId, '2026-10-22T01:00:01.000Z'));
  setResults(env, [{ ...result('next', JSON.stringify(['新轮人选', '合成岗位']), 'decision'), updatedAt: '2026-10-22T01:00:01.000Z' }], nextId);
  await env.clock.advance(2000);
  expect(env.latest?.taskSelection).toEqual({ mode: 'live', runId: nextId });
  expect(await ui.find({ type: 'Text', text: /^新轮人选$/ })).toBeDefined();
  expect(await ui.find({ type: 'Button', text: /^合成甲$/ })).toBeUndefined();
  expect(await ui.find({ key: 'follow-latest' })).toBeUndefined();
  expect(env.calls.filter(argv => argv[2] === 'run-results')).toHaveLength(2);
  env.errors['run-results'] = '确认列表暂未读取';
  setResults(env, [{ ...result('next', JSON.stringify(['新轮人选', '合成岗位']), 'decision'), updatedAt: '2026-10-22T01:00:01.000Z', nextAction: '确认新版本要求' }], nextId, root, 2);
  await env.clock.advance(2000);
  expect(await ui.find({ type: 'Text', text: /确认列表读取失败.*当前人数未知/ })).toBeDefined();
  expect(await ui.find({ type: 'Text', text: /^新轮人选$/ })).toBeUndefined();
  expect(await ui.find({ type: 'Text', text: /本轮需确认 0 人/ })).toBeUndefined();
  expect(await ui.find({ type: 'Text', text: /^下一步：/ })).toBeUndefined();
  const failedWrites = env.writes;
  await env.clock.advance(4000);
  expect(env.writes).toBe(failedWrites);
  expect(env.calls.filter(argv => argv[2] === 'run-results')).toHaveLength(3);
  delete env.errors['run-results'];
  await ui.press({ key: 'confirmations-reload' });
  expect(await ui.find({ type: 'Text', text: '下一步：确认新版本要求' })).toBeDefined();
  env.errors['run-results'] = '空版本的结果读取失败';
  setResults(env, [], nextId, root, 3);
  await env.clock.advance(2000);
  expect(await ui.find({ type: 'Text', text: /本轮需确认 0 人/ })).toBeDefined();
  expect(await ui.find({ type: 'Text', text: /^新轮人选$/ })).toBeUndefined();
  expect(await ui.find({ type: 'Text', text: /^下一步：/ })).toBeUndefined();
  setResults(env, null, nextId, root, 4);
  await env.clock.advance(2000);
  expect(await ui.find({ type: 'Text', text: /尚未记录候选人处理结果，需确认人数未知/ })).toBeDefined();
  expect(await ui.find({ type: 'Text', text: /本轮需确认 0 人/ })).toBeUndefined();
  expect(await ui.find({ type: 'Text', text: /^下一步：/ })).toBeUndefined();
  await ui.unmount();
});

test('首页确认仅显示与正常摘要同版本的结果，超前版本等摘要刷新且更新中不露旧下一步', async ($, on) => {
  const env = setup(on);
  setResults(env, [{ ...result('current', candidateId, 'decision'), nextAction: '原版本下一步' }]);
  const future = { ...result('future', candidateId, 'decision'), nextAction: '新版本下一步' };
  env.results = { runId: 'native-test', revision: 2, updatedAt: now, results: [future] };
  await open($);
  const ui = await mount($);
  expect(await ui.find({ type: 'Text', text: /确认记录版本超前.*当前人数未知/ })).toBeDefined();
  expect(await ui.find({ type: 'Text', text: /^下一步：/ })).toBeUndefined();
  expect(await ui.find({ type: 'Text', text: /本轮需确认 0 人/ })).toBeUndefined();
  const writes = env.writes;
  await env.clock.advance(4000);
  expect(env.writes).toBe(writes);
  expect(env.calls.filter(argv => argv[2] === 'run-results')).toHaveLength(1);
  env.results = null;
  setResults(env, [future], 'native-test', root, 2);
  await env.clock.advance(2000);
  expect(await ui.find({ type: 'Text', text: '下一步：新版本下一步' })).toBeDefined();
  env.delays['run-results'] = 3000;
  setResults(env, [{ ...future, nextAction: '再次更新的下一步' }], 'native-test', root, 3);
  await env.clock.advance(2000);
  expect(await ui.find({ type: 'Text', text: /正在更新本轮确认列表，当前人数未知/ })).toBeDefined();
  expect(await ui.find({ type: 'Text', text: /^下一步：/ })).toBeUndefined();
  expect(await ui.find({ type: 'Text', text: /本轮需确认 0 人/ })).toBeUndefined();
  await env.clock.advance(3000);
  expect(await ui.find({ type: 'Text', text: '下一步：再次更新的下一步' })).toBeDefined();
  const valid = env.files[runFile()]!;
  env.files[runFile()] = '{';
  await env.clock.advance(2000);
  expect(await ui.find({ type: 'Text', text: /任务摘要未能读取最新记录，需确认人数未知/ })).toBeDefined();
  expect(await ui.find({ type: 'Text', text: /^下一步：/ })).toBeUndefined();
  env.files[runFile()] = valid;
  await env.clock.advance(2000);
  expect(await ui.find({ type: 'Text', text: '下一步：再次更新的下一步' })).toBeDefined();
  await ui.unmount();
});

for (const destination of ['run', 'workspace', 'end'] as const) {
  test(`首页确认旧请求不会串入当前视图：${destination}`, async ($, on) => {
    const env = setup(on);
    on('session.end', ($, e) => ({ sessionId: e.sessionId }));
    const other = '/synthetic-other-workspace';
    addWorkspace(env, other);
    env.files[runFile(root, 'second-run')] = JSON.stringify({ ...newRun('second-run', '2026-10-22T00:59:00.000Z'), updatedAt: now });
    setResults(env, [result('old', JSON.stringify(['旧确认人选', '合成岗位']), 'decision')]);
    setResults(env, [result('second', JSON.stringify(['第二轮确认人选', '合成岗位']), 'decision')], 'second-run');
    setResults(env, [result('other', JSON.stringify(['另一工作区确认人选', '合成岗位']), 'decision')], 'native-test', other);
    env.delays['run-results'] = 3000;
    const first = open($);
    await env.clock.settle();
    const ui = await mount($);
    delete env.delays['run-results'];
    if (destination === 'run') {
      await ui.press({ key: 'show-records' });
      await ui.select({ key: 'run', value: 'second-run' });
      await ui.press({ key: 'show-records' });
    } else if (destination === 'workspace') await open($, other);
    else await $.session.end({ reason: 'clear', sessionId: 'synthetic-session', resume: { id: 'synthetic-session' } });
    await env.clock.advance(3000);
    await first;
    expect(await ui.find({ type: 'Text', text: /^旧确认人选$/ })).toBeUndefined();
    if (destination === 'run') expect(await ui.find({ type: 'Text', text: /^第二轮确认人选$/ })).toBeDefined();
    else if (destination === 'workspace') expect(await ui.find({ type: 'Text', text: /^另一工作区确认人选$/ })).toBeDefined();
    else expect(env.latest?.confirmations).toBeNull();
    await ui.unmount();
  });
}

for (const surface of ['desktop', 'terminal'] as const) {
  test(`窄栏阶段分两列，正常宽度三列；焦点在对话侧仍同步：${surface}`, async ($, on) => {
    const env = setup(on);
    await open($);
    const ui = await mount($, surface);
    await ui.press({ key: 'show-stages' });
    const stageRows = (element: RenderElement): number[] => {
      const children = 'children' in element ? element.children ?? [] : [];
      const stageCount = children.filter(child => typeof child !== 'string' && child.type === 'Box' && child.children?.some(item => typeof item !== 'string' && item.type === 'Button' && item.props.key.startsWith('stage-'))).length;
      return stageCount ? [stageCount] : children.flatMap(child => typeof child === 'string' ? [] : stageRows(child));
    };
    expect(stageRows(await ui.drawn())).toEqual([3, 3, 3]);
    await ui.redraw({ ...paneProps, bodyColumns: 36, isFocused: false });
    expect(stageRows(await ui.drawn())).toEqual([2, 2, 2, 2, 1]);
    const run = JSON.parse(env.files[runFile()]!) as Run;
    env.files[runFile()] = JSON.stringify({ ...run, status: 'waiting', reason: '焦点在对话时仍应出现', updatedAt: '2026-10-22T01:00:01.000Z' });
    await env.clock.advance(2000);
    expect(await ui.find({ type: 'Text', text: /^焦点在对话时仍应出现$/ })).toBeDefined();
    expect((await ui.find({ type: 'Text', text: /最后记录/ }))?.text).toContain(new Date('2026-10-22T01:00:01.000Z').toLocaleString('zh-CN', { hour12: false }));
    await ui.unmount();
  });
}
