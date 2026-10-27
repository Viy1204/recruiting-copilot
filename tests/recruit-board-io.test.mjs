import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { LEDGER_COLUMNS } from '../skills/recruit-board/model.mjs';
import { progressCLI, recordProgress } from '../skills/recruit-board/scripts/progress.mjs';
import { MAX_FILE_BYTES, readSnapshot } from '../skills/recruit-board/scripts/reader.mjs';
import { readRunResults } from '../skills/recruit-board/scripts/results.mjs';
import { createBoardServer, parseServerArgs } from '../skills/recruit-board/scripts/server.mjs';

const now = '2026-10-22T01:00:00.000Z';
const context = '## 在招岗位与优先级\n| 岗位 | 优先级 | 状态 |\n|---|---|---|\n| 合成岗位 | P0 | 在招 |\n';
const header = `${LEDGER_COLUMNS.join(',')}\n`;
async function workspace(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'recruit-board-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, '02-sourcing'));
  await writeFile(path.join(root, '02-sourcing/dedup-ledger.csv'), `${header}1,合成测试甲,合成岗位,隐私背景,A,已回复,test,秘密简历.pdf,电话00000\n`);
  await writeFile(path.join(root, 'CONTEXT.md'), context);
  return root;
}
const action = (root, id, value, extra = {}) => recordProgress({ workspace: root, id, workflow: 'daily', action: value, ...extra }, () => now);
const request = (port, pathname, options = {}) => new Promise((resolve, reject) => {
  const req = http.request({ host: '127.0.0.1', port, path: pathname, ...options }, response => {
    let body = '';
    response.setEncoding('utf8').on('data', chunk => { body += chunk; });
    response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body }));
  });
  req.on('error', reject); req.end();
});

test('进度按 run 原子持久化，独立轮次/嵌套任务互不覆盖，重复创建被拒绝', async t => {
  const root = await workspace(t);
  const [a, b] = await Promise.all([action(root, 'first', { type: 'start' }), action(root, 'nested', { type: 'start' }, { workflow: 'grill' })]);
  assert.equal(a.workflow, 'daily'); assert.equal(b.workflow, 'grill');
  await action(root, 'first', { type: 'step', step: 'unread' });
  await action(root, 'first', { type: 'wait', reason: '等待确认' });
  const snapshot = await readSnapshot(root, null, () => now);
  assert.equal(snapshot.runs.length, 2);
  assert.equal(snapshot.runs.find(run => run.id === 'first').status, 'waiting');
  assert.equal(snapshot.runs.find(run => run.id === 'nested').status, 'running');
  await assert.rejects(action(root, 'first', { type: 'start' }), /已存在/);
  const files = await readdir(path.join(root, 'runtime/recruit-board/runs'));
  assert.deepEqual(files.sort(), ['first.json', 'nested.json']);
  const persisted = JSON.parse(await readFile(path.join(root, 'runtime/recruit-board/runs/first.json'), 'utf8'));
  assert.equal(persisted.schemaVersion, 1); assert.equal(persisted.updatedAt, now);
});

test('同 run 的独占锁可验证拒绝；竞争写只允许一方获得锁', async t => {
  const root = await workspace(t);
  await action(root, 'locked', { type: 'start' });
  const lock = path.join(root, 'runtime/recruit-board/runs/locked.lock');
  await writeFile(lock, 'held by another writer');
  await assert.rejects(action(root, 'locked', { type: 'step', step: 'unread' }), /正在写入/);
  const unchanged = JSON.parse(await readFile(path.join(root, 'runtime/recruit-board/runs/locked.json'), 'utf8'));
  assert.equal(unchanged.steps[0].status, 'pending');
  await rm(lock);
  const results = await Promise.allSettled([action(root, 'locked', { type: 'step', step: 'unread' }), action(root, 'locked', { type: 'wait', reason: '并发测试' })]);
  assert.equal(results.filter(result => result.status === 'rejected').length, 1);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
});

test('CLI 校验参数/安全 ID，start 返回独立 ID，有限命令支持 --session', async t => {
  const root = await workspace(t);
  const started = await progressCLI(['start', '--workspace', root, '--workflow', 'resume-review', '--session', 'synthetic-session']);
  assert.match(started.id, /^[a-z0-9-]+$/);
  assert.equal(started.ownerSessionId, 'synthetic-session');
  await assert.rejects(progressCLI(['step', '--workspace', root, '--run', started.id]), /step/);
  await assert.rejects(progressCLI(['cancel', '--workspace', root, '--run', started.id]), /reason/);
  await assert.rejects(progressCLI(['start', '--workspace', root, '--workflow', 'daily', '--run', '../escape']), /runId/);
  await assert.rejects(progressCLI(['start', '--workspace', root, '--workflow', 'daily', '--unknown', 'x']), /参数/);
  const cancelled = await progressCLI(['cancel', '--workspace', root, '--run', started.id, '--reason', '合成测试结束']);
  assert.equal(cancelled.status, 'cancelled');
  const cli = new URL('../skills/recruit-board/scripts/progress.mjs', import.meta.url);
  const { stdout } = await promisify(execFile)(process.execPath, [cli.pathname.replace(/^\/(\w:)/, '$1'), 'workflows']);
  assert.equal(JSON.parse(stdout).daily.steps.length, 9);
});

test('HTTP 绑定 loopback、只读白名单、Host/Origin 限制与无 CORS；快照不暴露路径/备注', async t => {
  const root = await workspace(t);
  const server = await createBoardServer({ workspace: root, now: () => now });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const port = server.address().port;
  assert.equal(server.address().address, '127.0.0.1');
  const response = await request(port, '/api/snapshot');
  assert.equal(response.status, 200);
  assert.equal(response.headers['access-control-allow-origin'], undefined);
  assert.equal(response.headers['cache-control'], 'no-store');
  const data = JSON.parse(response.body);
  assert.equal(data.candidates.length, 1);
  for (const privateText of [root, '秘密简历.pdf', '电话00000', '隐私背景']) assert.equal(response.body.includes(privateText), false);
  assert.equal((await request(port, '/api/snapshot', { method: 'POST' })).status, 405);
  assert.equal((await request(port, '/api/snapshot', { headers: { Host: 'evil.example' } })).status, 403);
  assert.equal((await request(port, '/api/snapshot', { headers: { Origin: 'https://evil.example' } })).status, 403);
  assert.equal((await request(port, '/api/snapshot', { headers: { Origin: `http://127.0.0.1:${port}` } })).status, 200);
  assert.equal((await request(port, '/api/snapshot', { headers: { Host: `localhost:${port}`, Origin: `http://localhost:${port}` } })).status, 200);
  assert.equal((await request(port, '/api/snapshot', { headers: { Host: `localhost:${port}`, Origin: `http://127.0.0.1:${port}` } })).status, 403);
  for (const url of ['/CONTEXT.md', '/../../package.json', '/api/snapshot?file=CONTEXT.md', '/%2e%2e/CONTEXT.md', '/runtime/recruit-board/runs/a.json']) assert.equal((await request(port, url)).status, 404, url);
  const html = await request(port, '/');
  assert.equal(html.status, 200); assert.match(html.body, /招聘进展/);
  assert.equal((await request(port, '/model.mjs')).status, 200);
  assert.equal((await request(port, '/', { method: 'HEAD' })).body, '');
});

test('跨站文档GET可打开完整首页链接，API及其他跨站请求仍受同源与工作区限制', async t => {
  const root = await workspace(t);
  const server = await createBoardServer({ workspace: root });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const port = server.address().port;
  const key = JSON.parse((await request(port, '/api/health')).body).workspaceKey;
  const pathname = `/?workspace=${key}&run=linked-task`;
  const headers = { 'Sec-Fetch-Site': 'cross-site', 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Dest': 'document' };
  const file = path.join(root, 'CONTEXT.md');
  const before = await readFile(file);
  const page = await request(port, pathname, { headers });
  assert.equal(page.status, 200);
  assert.match(page.headers['content-type'], /text\/html/);
  assert.match(page.body, /招聘进展/);
  assert.equal(page.body.includes('合成测试甲'), false);
  assert.equal((await request(port, `/api/snapshot?workspace=${key}`)).status, 200);
  for (const endpoint of ['/api/health', '/api/snapshot', '/api/session', '/api/roles', '/api/runs/results?run=linked-task', '/api/candidates/detail?candidate=bad']) {
    assert.equal((await request(port, endpoint, { headers })).status, 403, endpoint);
  }
  assert.equal((await request(port, '/api/roles/status', { method: 'POST', headers })).status, 403);
  for (const options of [
    { method: 'POST', headers }, { method: 'HEAD', headers },
    { headers: { ...headers, 'Sec-Fetch-Mode': 'cors' } },
    { headers: { ...headers, 'Sec-Fetch-Dest': 'iframe' } },
    { headers: { ...headers, Host: 'evil.example' } },
    { headers: { ...headers, Origin: 'https://evil.example' } }
  ]) assert.equal((await request(port, pathname, options)).status, 403);
  const wrong = key === 'a'.repeat(64) ? 'b'.repeat(64) : 'a'.repeat(64);
  assert.equal((await request(port, `/?workspace=${wrong}`, { headers })).status, 409);
  assert.equal((await request(port, `${pathname}&run=duplicate`, { headers })).status, 400);
  assert.deepEqual(await readFile(file), before);
});

test('固定兼容配置作用于 HTTP 快照且保留原岗位，字典、说明与文件不对外暴露', async t => {
  const root = await workspace(t);
  const server = await createBoardServer({ workspace: root, now: () => now });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const port = server.address().port;
  const standard = JSON.parse((await request(port, '/api/snapshot')).body);
  assert.equal(standard.sources.config.status, 'missing');
  assert.ok(!standard.diagnostics.some(item => item.source === 'config'));
  await mkdir(path.join(root, '_shared'));
  const configFile = path.join(root, '_shared/recruit-board.config.json');
  await writeFile(configFile, JSON.stringify({
    schemaVersion: 1,
    statusStages: { '已沟通-待答复': 'talking', 未使用配置哨兵: 'ended' },
    roleAliases: { 合成旧岗位: '合成岗位' },
    description: '说明元数据哨兵', verifiedAt: '核对元数据哨兵', source: { note: '来源元数据哨兵' }
  }));
  await utimes(configFile, new Date(now), new Date(now));
  await writeFile(path.join(root, '02-sourcing/dedup-ledger.csv'), `${header}1,合成测试甲,合成旧岗位,,A,已沟通-待答复,test,,\n2,合成测试甲,合成岗位,,A,已回复,test,,\n`);
  const response = await request(port, '/api/snapshot');
  const snapshot = JSON.parse(response.body);
  assert.equal(snapshot.status, 'ok');
  assert.deepEqual(snapshot.sources.config, { status: 'ok', updatedAt: now });
  assert.equal(snapshot.candidates.length, 2);
  assert.deepEqual(snapshot.candidates.map(candidate => [candidate.role, candidate.rawRole, candidate.stage]), [['合成岗位', '合成旧岗位', 'talking'], ['合成岗位', '合成岗位', 'talking']]);
  assert.equal(snapshot.candidates[0].id, JSON.stringify(['合成测试甲', '合成旧岗位']));
  assert.deepEqual(snapshot.unknownStatuses, []);
  assert.deepEqual(snapshot.runs, []);
  assert.equal(snapshot.sources.runs.status, 'missing');
  assert.ok(snapshot.diagnostics.some(item => item.code === 'ROLE_ALIAS_COLLISION' && item.level === 'info'));
  for (const privateText of ['statusStages', 'roleAliases', '未使用配置哨兵', '说明元数据哨兵', '核对元数据哨兵', '来源元数据哨兵']) assert.equal(response.body.includes(privateText), false, privateText);
  assert.equal((await request(port, '/_shared/recruit-board.config.json')).status, 404);
});

test('配置文件变坏或删除时整份候选快照陈旧保留，恢复后重读新台账与岗位', async t => {
  const root = await workspace(t);
  const ledgerFile = path.join(root, '02-sourcing/dedup-ledger.csv');
  await mkdir(path.join(root, '_shared'));
  const configFile = path.join(root, '_shared/recruit-board.config.json');
  const config = JSON.stringify({ schemaVersion: 1, statusStages: { '已沟通-待答复': 'talking' }, roleAliases: { 合成旧岗位: '合成岗位' } });
  await writeFile(configFile, config);
  await utimes(configFile, new Date(now), new Date(now));
  await writeFile(ledgerFile, `${header}1,合成测试甲,合成旧岗位,,A,已沟通-待答复,test,,\n`);
  const first = await readSnapshot(root, null, () => now);
  assert.equal(first.sources.config.status, 'ok');
  await writeFile(ledgerFile, `${header}1,合成测试乙,合成旧岗位,,A,已排除,test,,\n2,合成测试丙,合成岗位,,A,已回复,test,,\n`);
  await writeFile(path.join(root, 'CONTEXT.md'), `${context}| 合成新岗位 | P1 | 在招 |\n`);
  await writeFile(configFile, '{');
  const invalid = await readSnapshot(root, first);
  assert.equal(invalid.status, 'stale');
  assert.deepEqual(invalid.candidates, first.candidates);
  assert.deepEqual(invalid.roles, first.roles);
  assert.equal(invalid.ledgerUpdatedAt, first.ledgerUpdatedAt);
  for (const source of ['ledger', 'context', 'config']) assert.deepEqual(invalid.sources[source], { status: 'stale', updatedAt: first.sources[source].updatedAt });
  assert.ok(invalid.diagnostics.some(item => item.code === 'CONFIG_INVALID'));
  await rm(configFile);
  const missing = await readSnapshot(root, invalid);
  assert.deepEqual(missing.candidates, first.candidates);
  assert.equal(missing.sources.config.status, 'stale');
  assert.ok(missing.diagnostics.some(item => item.code === 'CONFIG_MISSING'));
  await writeFile(configFile, config);
  const later = '2026-10-22T01:01:00.000Z';
  await utimes(configFile, new Date(later), new Date(later));
  const recovered = await readSnapshot(root, missing);
  assert.equal(recovered.status, 'ok');
  assert.deepEqual(recovered.sources.config, { status: 'ok', updatedAt: later });
  assert.equal(recovered.sources.ledger.updatedAt, (await stat(ledgerFile)).mtime.toISOString());
  assert.equal(recovered.candidates.length, 2);
  assert.equal(recovered.candidates[0].stage, 'ended');
  assert.equal(recovered.candidates[0].rawRole, '合成旧岗位');
  assert.equal(recovered.candidates[0].role, '合成岗位');
  assert.ok(recovered.roles.some(role => role.name === '合成新岗位' && role.configured));
  assert.deepEqual(recovered.diagnostics, []);
});

test('每请求重读台账，坏文件保留上次数据且标陈旧；初次失败不假报零', async t => {
  const root = await workspace(t);
  const server = await createBoardServer({ workspace: root });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const port = server.address().port;
  const first = JSON.parse((await request(port, '/api/snapshot')).body);
  await writeFile(path.join(root, '02-sourcing/dedup-ledger.csv'), 'broken');
  const stale = JSON.parse((await request(port, '/api/snapshot')).body);
  assert.equal(stale.status, 'stale'); assert.deepEqual(stale.candidates, first.candidates);
  await writeFile(path.join(root, '02-sourcing/dedup-ledger.csv'), header);
  const empty = JSON.parse((await request(port, '/api/snapshot')).body);
  assert.equal(empty.status, 'ok'); assert.equal(empty.candidates.length, 0);
  await rm(path.join(root, '02-sourcing/dedup-ledger.csv'));
  const missing = await readSnapshot(root);
  assert.equal(missing.candidates, null); assert.equal(missing.status, 'error');
});

test('并发 HTTP 快照读取保持顺序，读取失败只退回最新完成的记录', async t => {
  const root = await workspace(t);
  let releaseFirst, firstEntered;
  const firstGate = new Promise(resolve => { releaseFirst = resolve; });
  const entered = new Promise(resolve => { firstEntered = resolve; });
  let reads = 0;
  const server = await createBoardServer({ workspace: root, read: async (_root, previous) => {
    reads++;
    if (reads === 1) { firstEntered(); await firstGate; return { marker: 'first' }; }
    if (reads === 2) return { marker: 'second' };
    return { ...previous, stale: true };
  } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const port = server.address().port;
  const first = request(port, '/api/snapshot');
  await entered;
  const secondArrived = new Promise(resolve => server.once('request', resolve));
  const second = request(port, '/api/snapshot');
  await secondArrived;
  assert.equal(reads, 1, '首个读取未结束时第二个请求必须排队');
  releaseFirst();
  assert.equal(JSON.parse((await first).body).marker, 'first');
  assert.equal(JSON.parse((await second).body).marker, 'second');
  assert.deepEqual(JSON.parse((await request(port, '/api/snapshot')).body), { marker: 'second', stale: true, workspaceKey: createHash('sha256').update(await realpath(root)).digest('hex') });
});

test('工作区必须显式存在，端口与未知参数不能绕过验证', async () => {
  await assert.rejects(createBoardServer({}), /workspace/);
  await assert.rejects(createBoardServer({ workspace: 'Z:/no-such-recruit-board-test' }));
  assert.throws(() => parseServerArgs([]), /workspace/);
  assert.equal(parseServerArgs(['--workspace', '.', '--port', '0']).port, 0);
  for (const args of [['--workspace', '.', '--port', '-1'], ['--workspace', '.', '--port', '65536'], ['--workspace', '.', '--port', 'nope'], ['--workspace', '.', '--port', '1.5'], ['--workspace', '.', '--host', '0.0.0.0']]) assert.throws(() => parseServerArgs(args));
});

const receipt = (value = {}) => ({ id: 'screen-1', stepId: 'screen', candidateId: JSON.stringify(['未入台账合成甲', '原岗位']), action: '初筛', outcome: '合成结论', attention: 'none', nextAction: null, ...value });

test('并行轮次隔离结果持久化，结果不改台账或等待步骤，幂等重试不重写原文件', async t => {
  const root = await workspace(t);
  const ledgerFile = path.join(root, '02-sourcing/dedup-ledger.csv');
  const ledger = await readFile(ledgerFile);
  await Promise.all([action(root, 'round-a', { type: 'start' }), action(root, 'round-b', { type: 'start' })]);
  await action(root, 'round-a', { type: 'step', step: 'screen' });
  const waiting = await action(root, 'round-a', { type: 'wait', reason: '等待用户确认' });
  const [a, b] = await Promise.all([
    action(root, 'round-a', { type: 'result', result: receipt({ attention: 'decision', nextAction: '确认后再推进' }) }),
    action(root, 'round-b', { type: 'result', result: receipt({ outcome: '另一轮独立结论' }) })
  ]);
  assert.equal(a.status, 'waiting');
  assert.equal(a.reason, '等待用户确认');
  assert.deepEqual(a.steps, waiting.steps);
  assert.equal(a.results.length, 1);
  assert.equal(b.results[0].outcome, '另一轮独立结论');
  assert.deepEqual((await readRunResults(root, 'round-a')).results, a.results);
  assert.deepEqual((await readRunResults(root, 'round-b')).results, b.results);
  assert.deepEqual(await readFile(ledgerFile), ledger);
  const file = path.join(root, 'runtime/recruit-board/runs/round-a.json');
  const originalText = (await readFile(file, 'utf8')).replaceAll('\n', '\r\n');
  await writeFile(file, originalText);
  await utimes(file, new Date(now), new Date(now));
  const before = await stat(file);
  const repeated = await recordProgress({ workspace: root, id: 'round-a', action: { type: 'result', result: receipt({ attention: 'decision', nextAction: '确认后再推进' }) } }, () => '2026-10-22T01:01:00.000Z');
  assert.deepEqual(repeated, a);
  assert.equal(await readFile(file, 'utf8'), originalText);
  assert.equal((await stat(file)).mtimeMs, before.mtimeMs);
  const sameTime = await action(root, 'round-a', { type: 'result', result: receipt({ outcome: '同毫秒更正', attention: 'decision', nextAction: '确认后再推进' }) });
  assert.equal(sameTime.updatedAt, a.updatedAt);
  assert.equal(sameTime.resultsRevision, 2);
  assert.equal((await readRunResults(root, 'round-a')).revision, 2);
  const snapshot = await readSnapshot(root, null, () => now);
  assert.equal(snapshot.runs.find(run => run.id === 'round-a').resultSummary.revision, 2);
  assert.ok(snapshot.runs.every(run => !Object.hasOwn(run, 'results')));
  assert.equal(snapshot.candidates.length, 1);
  const cancelled = await action(root, 'round-a', { type: 'cancel', reason: '合成轮次结束' });
  assert.deepEqual(cancelled.results, sameTime.results);
  await assert.rejects(action(root, 'round-a', { type: 'result', result: receipt({ outcome: '终态不允许更改' }) }), /已经结束/);
  assert.equal((await readRunResults(root, 'round-a')).results[0].outcome, '同毫秒更正');
});

test('结果CLI按固定参数构造原人岗ID，完整run返回，非法输入失败且不覆盖原文', async t => {
  const root = await workspace(t);
  await action(root, 'result-cli', { type: 'start' });
  const args = ['result', '--workspace', root, '--run', 'result-cli', '--result', 'screen-cli', '--step', 'screen', '--name', '合成姓名', '--role', '原岗甲', '--action', '初筛', '--outcome', '需要确认', '--attention', 'decision', '--next-action', '确认后推进'];
  const recorded = await progressCLI(args);
  assert.equal(recorded.results[0].candidateId, JSON.stringify(['合成姓名', '原岗甲']));
  assert.equal(recorded.results[0].nextAction, '确认后推进');
  assert.equal(recorded.resultsRevision, 1);
  assert.equal(recorded.steps.length, 9);
  const cli = new URL('../skills/recruit-board/scripts/progress.mjs', import.meta.url);
  const { stdout } = await promisify(execFile)(process.execPath, [cli.pathname.replace(/^\/(\w:)/, '$1'), ...args]);
  assert.equal(JSON.parse(stdout).resultsRevision, 1);
  const file = path.join(root, 'runtime/recruit-board/runs/result-cli.json');
  const before = await readFile(file);
  for (const key of ['--result', '--step', '--name', '--role', '--action', '--outcome', '--attention']) {
    const missing = [...args]; const index = missing.indexOf(key); missing.splice(index, 2);
    await assert.rejects(progressCLI(missing), /必须指定/);
  }
  for (const [flag, value] of [['--result', '../bad'], ['--step', '不存在'], ['--name', ' '], ['--role', ' 原岗甲'], ['--attention', 'unknown'], ['--action', 'x'.repeat(81)]]) {
    const invalid = [...args]; invalid[invalid.indexOf(flag) + 1] = value;
    await assert.rejects(progressCLI(invalid));
  }
  await assert.rejects(progressCLI(args.slice(0, -2)), /下一步/);
  await assert.rejects(progressCLI([...args, '--result', 'duplicate']), /重复参数/);
  await assert.rejects(progressCLI([...args, '--file', 'CONTEXT.md']), /参数/);
  assert.deepEqual(await readFile(file), before);
  assert.deepEqual((await readdir(path.dirname(file))).sort(), ['result-cli.json']);
});

test('超出文件上限的结果写入被拒绝且原文件逐字节保留，清理临时文件与锁', async t => {
  const root = await workspace(t);
  await action(root, 'too-large', { type: 'start' });
  const file = path.join(root, 'runtime/recruit-board/runs/too-large.json');
  const before = await readFile(file);
  const huge = receipt({ candidateId: JSON.stringify(['合'.repeat(MAX_FILE_BYTES), '原岗']) });
  await assert.rejects(action(root, 'too-large', { type: 'result', result: huge }), /文件大小上限/);
  assert.deepEqual(await readFile(file), before);
  assert.deepEqual((await readdir(path.dirname(file))).sort(), ['too-large.json']);
  await action(root, 'too-large', { type: 'result', result: receipt() });
  const valid = await readFile(file);
  await assert.rejects(action(root, 'too-large', { type: 'result', result: receipt({ candidateId: JSON.stringify(['另一合成姓名', '原岗']) }) }), /候选或步骤/);
  assert.deepEqual(await readFile(file), valid);
});

test('HTTP工作区标识稳定且基于规范根，同名目录不会串到同一个标识且不泄漏路径', async t => {
  const parent = await mkdtemp(path.join(tmpdir(), 'recruit-key-test-'));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const roots = [path.join(parent, 'one', 'same-name'), path.join(parent, 'two', 'same-name')];
  const responses = [];
  for (const root of roots) {
    await mkdir(root, { recursive: true });
    const server = await createBoardServer({ workspace: root });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise(resolve => server.close(resolve)));
    const port = server.address().port;
    const first = await request(port, '/api/snapshot');
    const snapshot = JSON.parse(first.body);
    assert.equal(snapshot.workspace, 'same-name');
    assert.equal(snapshot.workspaceKey, createHash('sha256').update(await realpath(root)).digest('hex'));
    assert.equal(JSON.parse((await request(port, '/api/snapshot')).body).workspaceKey, snapshot.workspaceKey);
    assert.equal(first.body.includes(root), false);
    assert.equal(first.body.includes(await realpath(root)), false);
    assert.equal(Object.hasOwn(await readSnapshot(root), 'workspaceKey'), false);
    responses.push(snapshot);
  }
  assert.notEqual(responses[0].workspaceKey, responses[1].workspaceKey);
});

test('health严格只读仅返回固定能力与规范工作区键，不触碰损坏业务文件并遵守同源限制', async t => {
  const root = await workspace(t);
  await writeFile(path.join(root, '02-sourcing/dedup-ledger.csv'), 'invalid private ledger sentinel');
  await writeFile(path.join(root, 'CONTEXT.md'), 'invalid private context sentinel');
  let reads = 0;
  const server = await createBoardServer({ workspace: root, read: async () => { reads++; throw new Error('must not read snapshot'); } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const port = server.address().port;
  const before = await readdir(root, { recursive: true });
  const response = await request(port, '/api/health');
  assert.equal(response.status, 200);
  const health = JSON.parse(response.body);
  assert.deepEqual(health, { service: 'recruiting-board', schemaVersion: 1, capabilities: ['snapshot', 'run-results', 'run-activity'], workspaceKey: createHash('sha256').update(await realpath(root)).digest('hex') });
  assert.equal(reads, 0);
  assert.deepEqual(await readdir(root, { recursive: true }), before);
  assert.equal(response.headers['cache-control'], 'no-store');
  assert.equal(response.headers['cross-origin-resource-policy'], 'same-origin');
  assert.equal(response.headers['access-control-allow-origin'], undefined);
  for (const secret of [root, await realpath(root), 'invalid private', '合成测试甲', '电话00000', '秘密简历.pdf']) assert.equal(response.body.includes(secret), false);
  assert.equal((await request(port, '/api/health', { method: 'HEAD' })).body, '');
  assert.equal((await request(port, '/api/health', { method: 'POST' })).status, 405);
  for (const headers of [{ Host: 'evil.example' }, { Host: `192.168.1.2:${port}` }, { Origin: 'https://evil.example' }, { 'Sec-Fetch-Site': 'cross-site' }]) assert.equal((await request(port, '/api/health', { headers })).status, 403);
  assert.equal((await request(port, '/api/health', { headers: { Host: `localhost:${port}`, Origin: `http://localhost:${port}` } })).status, 200);
  for (const query of ['?file=CONTEXT.md', '?run=x', '?limit=3']) assert.equal((await request(port, `/api/health${query}`)).status, 400);
  assert.equal((await request(port, '/api/snapshot')).status, 500);
  assert.equal(reads, 1);
});

test('首页单run与workspace链接可访问，严格拒绝重复和越界query；工作区fence在读取前拒绝', async t => {
  const root = await workspace(t);
  let reads = 0;
  const server = await createBoardServer({ workspace: root, read: async () => { reads++; return { marker: 'read reached' }; } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const port = server.address().port;
  const key = JSON.parse((await request(port, '/api/health')).body).workspaceKey;
  const wrong = key === 'a'.repeat(64) ? 'b'.repeat(64) : 'a'.repeat(64);
  for (const query of ['?run=valid-run_1', `?workspace=${key}`, `?workspace=${key}&run=valid-run_1`]) {
    const page = await request(port, `/${query}`);
    assert.equal(page.status, 200, query);
    assert.match(page.headers['content-type'], /text\/html/);
  }
  for (const query of ['?run=', '?run=../bad', '?run=a&run=b', '?file=CONTEXT.md', '?run=valid&limit=3', '?workspace=bad', `?workspace=${key}&workspace=${key}`]) assert.equal((await request(port, `/${query}`)).status, 400, query);
  const endpoints = ['/', '/api/health', '/api/snapshot', '/api/session', '/api/roles', '/api/runs/results?run=missing', '/api/runs/activity?run=missing', '/api/candidates/detail?candidate=bad', '/api/candidates/document?candidate=bad&document=bad'];
  for (const endpoint of endpoints) {
    for (const options of [{ headers: { 'X-Workspace-Key': wrong } }, { query: true }]) {
      const url = options.query ? `${endpoint}${endpoint.includes('?') ? '&' : '?'}workspace=${wrong}` : endpoint;
      const response = await request(port, url, options);
      assert.equal(response.status, 409, url);
      assert.equal(JSON.parse(response.body).error.code, 'WORKSPACE_MISMATCH');
      assert.equal(response.body.includes(root), false);
    }
  }
  assert.equal(reads, 0);
  const malformed = await request(port, '/api/snapshot', { headers: { 'X-Workspace-Key': 'bad' } });
  assert.equal(malformed.status, 400);
  assert.equal(JSON.parse(malformed.body).error.code, 'WORKSPACE_INPUT_INVALID');
  const conflict = await request(port, `/api/snapshot?workspace=${key}`, { headers: { 'X-Workspace-Key': wrong } });
  assert.equal(conflict.status, 409);
  for (const options of [{ headers: { 'X-Workspace-Key': key } }, {}]) assert.equal((await request(port, '/api/snapshot', options)).status, 200);
  assert.equal((await request(port, `/api/snapshot?workspace=${key}`)).status, 200);
  assert.equal(reads, 3);
});
