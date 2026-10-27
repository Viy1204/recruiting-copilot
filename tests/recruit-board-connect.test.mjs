import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFile, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { connectCLI, probeBoard } from '../skills/recruit-board/scripts/connect.mjs';
import { createBoardServer } from '../skills/recruit-board/scripts/server.mjs';

const execute = promisify(execFile);
const cli = fileURLToPath(new URL('../skills/recruit-board/scripts/connect.mjs', import.meta.url));
const serverCLI = fileURLToPath(new URL('../skills/recruit-board/scripts/server.mjs', import.meta.url));

async function workspace(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'recruit-connect-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

async function serve(t, handler) {
  const server = http.createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  return { server, url: `http://127.0.0.1:${server.address().port}` };
}

async function board(t, root) {
  const server = await createBoardServer({ workspace: root });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  return `http://127.0.0.1:${server.address().port}`;
}

const health = workspaceKey => ({ service: 'recruiting-board', schemaVersion: 1, capabilities: ['snapshot', 'run-results', 'run-activity'], workspaceKey });

function assertNoLink(result, status) {
  assert.equal(result.status, status);
  assert.equal(result.url, null);
  assert.equal(result.runUrl, null);
  assert.match(result.workspaceKey, /^[a-f0-9]{64}$/);
}

test('connect只读探测同工作区，公开链接携带稳定workspace键且runURL真实首页200', async t => {
  const root = await workspace(t);
  const url = await board(t, root);
  const expectedKey = (await (await fetch(`${url}/api/health`)).json()).workspaceKey;
  const before = await readdir(root, { recursive: true });
  const result = await probeBoard({ workspace: root, url, run: 'synthetic-run_1' });
  assert.equal(result.status, 'ready');
  assert.equal(result.workspaceKey, expectedKey);
  assert.equal(result.url, `${url}/?workspace=${expectedKey}`);
  assert.equal(result.runUrl, `${url}/?workspace=${expectedKey}&run=synthetic-run_1`);
  assert.equal((await fetch(result.url)).status, 200);
  assert.equal((await fetch(result.runUrl)).status, 200);
  const noRun = await probeBoard({ workspace: root, url: `${url}/` });
  assert.equal(noRun.runUrl, noRun.url);
  const local = await probeBoard({ workspace: root, url: url.replace('127.0.0.1', 'localhost') });
  assert.equal(local.status, 'ready');
  assert.equal(new URL(local.url).hostname, 'localhost');
  const { stdout } = await execute(process.execPath, [cli, '--workspace', root, '--url', url, '--run', 'synthetic-run_1']);
  assert.deepEqual(JSON.parse(stdout), result);
  assert.equal(stdout.includes(root), false);
  assert.deepEqual(await readdir(root, { recursive: true }), before);
});

test('默认HTTP端口支持省略或显式80的Host与Origin，probe链接可读且仍拒绝外域', async t => {
  const root = await workspace(t);
  const server = await createBoardServer({ workspace: root });
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(80, '127.0.0.1', resolve);
    });
  } catch (error) {
    if (!['EADDRINUSE', 'EACCES'].includes(error.code)) throw error;
    t.skip(`本机端口80不可用：${error.code}`);
    return;
  }
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const request = (headers, method = 'GET', body) => new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port: 80, path: method === 'POST' ? '/api/roles/status' : '/api/health', method, headers, agent: false }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.once('end', () => resolve({ status: response.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.once('error', reject);
    req.end(body);
  });
  for (const host of ['127.0.0.1', '127.0.0.1:80', 'localhost', 'localhost:80']) {
    const hostname = host.split(':')[0];
    for (const origin of [undefined, `http://${hostname}`, `http://${hostname}:80`]) {
      const response = await request({ Host: host, ...(origin ? { Origin: origin } : {}) });
      assert.equal(response.status, 200, `${host} ${origin}`);
      assert.equal(JSON.parse(response.body).service, 'recruiting-board');
    }
  }
  for (const url of ['http://127.0.0.1', 'http://127.0.0.1:80', 'http://localhost', 'http://localhost:80']) {
    const result = await probeBoard({ workspace: root, url, run: 'default-port-task' });
    assert.equal(result.status, 'ready', url);
    assert.equal((await fetch(result.runUrl)).status, 200);
  }
  const token = (await (await fetch('http://127.0.0.1/api/session')).json()).csrfToken;
  for (const origin of ['http://127.0.0.1', 'http://127.0.0.1:80']) {
    const response = await request({ Host: '127.0.0.1:80', Origin: origin, 'X-CSRF-Token': token, 'Content-Type': 'application/json' }, 'POST', '{}');
    assert.equal(response.status, 400, '合法同源写入口应进入JSON校验');
    assert.equal(JSON.parse(response.body).error.code, 'ROLE_INPUT_INVALID');
  }
  for (const headers of [
    { Host: '127.0.0.1:81' }, { Host: 'evil.example:80' }, { Host: '127.0.0.1', Origin: 'http://localhost' },
    { Host: '127.0.0.1', Origin: 'http://user@127.0.0.1' }, { Host: '127.0.0.1', Origin: 'http://127.0.0.1/' },
    { Host: '127.0.0.1', Origin: 'http://127.0.0.1:81' }
  ]) assert.equal((await request(headers)).status, 403);
});

test('connect规范根相同可复用，同名不同工作区不串联且绝不返回对方URL', async t => {
  const parent = await workspace(t);
  const root = path.join(parent, 'one', 'same-name');
  const other = path.join(parent, 'two', 'same-name');
  const alias = path.join(parent, 'same-root-alias');
  await mkdir(root, { recursive: true });
  await mkdir(other, { recursive: true });
  await symlink(root, alias, process.platform === 'win32' ? 'junction' : 'dir');
  const url = await board(t, root);
  const ready = await probeBoard({ workspace: root, url });
  assert.equal((await probeBoard({ workspace: alias, url })).workspaceKey, ready.workspaceKey);
  assert.equal((await probeBoard({ workspace: path.join(root, '..', 'same-name'), url })).status, 'ready');
  const wrong = await probeBoard({ workspace: other, url, run: 'synthetic' });
  assertNoLink(wrong, 'workspace-mismatch');
  assert.notEqual(wrong.workspaceKey, ready.workspaceKey);
  assert.equal(JSON.stringify(wrong).includes(url), false);
});

test('connect拒绝非loopback、非规范URL、任意路径和非法CLI参数，受控错误不泄漏本地路径', async t => {
  const root = await workspace(t);
  const invalidURLs = [
    'https://127.0.0.1:4318', 'http://example.com:4318', 'http://localhost.evil:4318', 'http://127.0.0.1.evil:4318',
    'http://0.0.0.0:4318', 'http://127.0.0.2:4318', 'http://[::1]:4318', 'http://2130706433:4318', 'http://127.1:4318',
    'http://0177.0.0.1:4318', 'http://0x7f000001:4318', 'http://user:pass@127.0.0.1:4318', 'http://@127.0.0.1:4318',
    'http://127.0.0.1:4318/api/health', 'http://127.0.0.1:4318/.', 'http://127.0.0.1:4318//', 'http://127.0.0.1:4318?run=x',
    'http://127.0.0.1:4318?', 'http://127.0.0.1:4318#', 'http://127.0.0.1:4318/#x', 'http://127.0.0.1:0',
    'http://127.0.0.1:04318', 'http://127.0.0.1:+4318', 'http://127.0.0.1:65536', 'http://127.0.0.1:',
    ' http://127.0.0.1:4318', 'http://127.0.0.1:4318\n', 'http://localhost.:4318', 'http://127.0.0.1\\@evil.example',
    'file:///C:/private', 'javascript:alert(1)', '//127.0.0.1:4318'
  ];
  for (const url of invalidURLs) await assert.rejects(probeBoard({ workspace: root, url }), error => error.code === 'CONNECT_INPUT_INVALID', url);
  for (const run of ['', '../bad', 'bad/run', 'x'.repeat(65), 'bad.json']) await assert.rejects(probeBoard({ workspace: root, run }), error => error.code === 'CONNECT_INPUT_INVALID');
  for (const args of [[], ['--workspace', '.'], ['--workspace', root, '--exec', 'anything'], ['--workspace', root, '--url'], ['--workspace', root, '--workspace', root], ['--workspace', root, '--run', 'bad/run']]) await assert.rejects(connectCLI(args), error => error.code === 'CONNECT_INPUT_INVALID');
  await assert.rejects(probeBoard({ workspace: path.join(root, 'missing-private-workspace') }), error => error.code === 'CONNECT_INPUT_INVALID' && !error.message.includes(root));
  const file = path.join(root, 'not-directory');
  await writeFile(file, 'sentinel');
  await assert.rejects(probeBoard({ workspace: file }), error => error.code === 'CONNECT_INPUT_INVALID' && !error.message.includes(root));
  await assert.rejects(execute(process.execPath, [cli, '--workspace', path.join(root, 'missing-private-workspace')]), error => {
    assert.equal(error.code, 1);
    assert.equal(JSON.parse(error.stderr).error.code, 'CONNECT_INPUT_INVALID');
    assert.equal(error.stderr.includes(root), false);
    return true;
  });
});

test('connect网络不可用返回status且CLI正常JSON退出，不spawn服务或写配置', async t => {
  const root = await workspace(t);
  const server = http.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  await new Promise(resolve => server.close(resolve));
  const result = await probeBoard({ workspace: root, url });
  assertNoLink(result, 'unavailable');
  const { stdout, stderr } = await execute(process.execPath, [cli, '--workspace', root, '--url', url]);
  assert.deepEqual(JSON.parse(stdout), result);
  assert.equal(stderr, '');
  assert.deepEqual(await readdir(root), []);
});

test('connect不跟随重定向、不采信服务返回URL或恶意message，旧server和缺失能力不可复用', async t => {
  const root = await workspace(t);
  const key = (await probeBoard({ workspace: root, url: 'http://127.0.0.1:1' })).workspaceKey;
  let targetReads = 0;
  const target = await serve(t, (_request, response) => { targetReads++; response.end(JSON.stringify(health(key))); });
  let mode = 'redirect';
  const source = await serve(t, (_request, response) => {
    if (mode === 'redirect') { response.writeHead(302, { Location: target.url }); response.end(); return; }
    if (mode === 'legacy') { response.statusCode = 404; response.end('<html>old server</html>'); return; }
    const value = health(key);
    if (mode === 'no-capabilities') delete value.capabilities;
    if (mode === 'partial-capabilities') value.capabilities = ['snapshot', 'run-results'];
    if (mode === 'wrong-service') value.service = 'other';
    if (mode === 'wrong-schema') value.schemaVersion = 2;
    if (mode === 'invalid-key') value.workspaceKey = 'path/C:/private';
    value.url = 'https://evil.example/private';
    value.message = `malicious-response-${root}`;
    response.end(JSON.stringify(value));
  });
  for (const value of ['redirect', 'legacy', 'no-capabilities', 'partial-capabilities', 'wrong-service', 'wrong-schema', 'invalid-key']) {
    mode = value;
    const result = await probeBoard({ workspace: root, url: source.url });
    assertNoLink(result, 'incompatible');
    assert.equal(JSON.stringify(result).includes(root), false);
    assert.equal(JSON.stringify(result).includes('evil.example'), false);
  }
  assert.equal(targetReads, 0);
  mode = 'ready';
  const ready = await probeBoard({ workspace: root, url: source.url });
  assert.equal(ready.status, 'ready');
  assert.equal(new URL(ready.url).origin, source.url);
  assert.equal(ready.message, '看板已就绪');
});

test('connect限制health响应8KiB，拒绝坏JSON与UTF8，精确上限仍可用', async t => {
  const root = await workspace(t);
  const key = (await probeBoard({ workspace: root, url: 'http://127.0.0.1:1' })).workspaceKey;
  const normal = JSON.stringify(health(key));
  let body = normal;
  const source = await serve(t, (_request, response) => { response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(body); });
  for (const value of ['{', 'null', '[]', Buffer.from([0xff, 0xfe]), `${normal}${' '.repeat(8193 - Buffer.byteLength(normal))}`, JSON.stringify({ ...health(key), filler: 'x'.repeat(9000) })]) {
    body = value;
    assertNoLink(await probeBoard({ workspace: root, url: source.url }), 'incompatible');
  }
  body = `${normal}${' '.repeat(8192 - Buffer.byteLength(normal))}`;
  assert.equal((await probeBoard({ workspace: root, url: source.url })).status, 'ready');
});

test('connect有2s总超时，未发headers与持续慢body均受控结束', { timeout: 7000 }, async t => {
  const root = await workspace(t);
  const pending = await serve(t, () => {});
  const slow = await serve(t, (_request, response) => {
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.write('{');
    const interval = setInterval(() => response.write(' '), 50);
    response.once('close', () => clearInterval(interval));
  });
  const start = performance.now();
  const results = await Promise.all([probeBoard({ workspace: root, url: pending.url }), probeBoard({ workspace: root, url: slow.url })]);
  for (const result of results) assertNoLink(result, 'unavailable');
  assert.ok(performance.now() - start < 5500, '总超时必须覆盖持续传输的响应');
});

test('server CLI port0打印可连接ready事件，host结束后释放真实监听端口', { timeout: 10000 }, async t => {
  const root = await workspace(t);
  const child = spawn(process.execPath, [serverCLI, '--workspace', root, '--port', '0'], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  t.after(() => { if (child.exitCode === null) child.kill(); });
  let stderr = '';
  child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
  const ready = await new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => reject(new Error(`server ready未出现：${stderr}`)), 4000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`server过早退出 ${code}：${stderr}`)); });
    child.stdout.setEncoding('utf8').on('data', chunk => {
      output += chunk;
      const newline = output.indexOf('\n');
      if (newline < 0) return;
      clearTimeout(timer);
      try { resolve(JSON.parse(output.slice(0, newline))); }
      catch (error) { reject(error); }
    });
  });
  assert.equal(ready.event, 'ready');
  assert.equal(ready.service, 'recruiting-board');
  assert.match(ready.workspaceKey, /^[a-f0-9]{64}$/);
  const url = new URL(ready.url);
  assert.equal(url.hostname, '127.0.0.1');
  assert.notEqual(url.port, '0');
  const connected = await probeBoard({ workspace: root, url: ready.url, run: 'synthetic-task' });
  assert.equal(connected.status, 'ready');
  assert.equal(connected.workspaceKey, ready.workspaceKey);
  assert.equal((await fetch(connected.runUrl)).status, 200);
  const exited = new Promise(resolve => child.once('exit', resolve));
  child.kill('SIGTERM');
  await exited;
  assertNoLink(await probeBoard({ workspace: root, url: ready.url }), 'unavailable');
  assert.equal(stderr, '');
  assert.deepEqual(await readdir(root), []);
});
