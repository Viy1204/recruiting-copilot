import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { assertRunId } from '../model.mjs';
import { readSnapshot, resolveWorkspace, workspaceKeyForRoot } from './reader.mjs';
import { readCandidateDetail, readCandidateDocument } from './records.mjs';
import { readRoleInfo, setRoleStatus } from './roles.mjs';
import { readRunActivity, readRunResults } from './results.mjs';
import { actionError } from './actions.mjs';

const publicRoot = fileURLToPath(new URL('../public/', import.meta.url));
const assets = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/live.mjs', ['live.mjs', 'text/javascript; charset=utf-8']],
  ['/style.css', ['style.css', 'text/css; charset=utf-8']],
  ['/model.mjs', ['../model.mjs', 'text/javascript; charset=utf-8']]
]);
const securityHeaders = {
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'"
};

async function readRoleRequest(request) {
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(request.headers['content-type'] ?? '')) throw Object.assign(new Error('保存岗位状态必须使用 JSON'), { code: 'JSON_REQUIRED', status: 415 });
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 8192) throw Object.assign(new Error('岗位请求超过大小上限'), { code: 'REQUEST_TOO_LARGE', status: 413 });
    chunks.push(chunk);
  }
  let value;
  try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw Object.assign(new Error('岗位请求不是有效 JSON'), { code: 'JSON_INVALID', status: 400 }); }
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 3 || Object.keys(value).some(key => !['role', 'status', 'revision'].includes(key))) throw Object.assign(new Error('岗位请求仅接受 role、status 和 revision'), { code: 'ROLE_INPUT_INVALID', status: 400 });
  return value;
}

export async function createBoardServer({ workspace, now, read = readSnapshot }) {
  const root = await resolveWorkspace(workspace);
  const workspaceKey = workspaceKeyForRoot(root);
  const csrfToken = randomBytes(32).toString('hex');
  let previous = null, readQueue = Promise.resolve();
  const nextSnapshot = () => {
    const pending = readQueue.then(async () => {
      const snapshot = await read(root, previous, now);
      previous = snapshot;
      return snapshot;
    });
    // 每个失败仍返回给该 HTTP 请求；队列只释放顺序，下一次读取可恢复。
    readQueue = pending.then(() => undefined, () => undefined);
    return pending;
  };
  const server = http.createServer(async (request, response) => {
    const send = (status, type, body, extra = {}) => {
      response.writeHead(status, { ...securityHeaders, 'Content-Type': type, ...extra });
      response.end(request.method === 'HEAD' ? undefined : body);
    };
    const address = server.address();
    const hosts = new Set([`127.0.0.1:${address.port}`, `localhost:${address.port}`, ...(address.port === 80 ? ['127.0.0.1', 'localhost'] : [])]);
    if (!hosts.has(request.headers.host)) { send(403, 'text/plain; charset=utf-8', '仅允许从本机看板访问'); return; }
    const origin = new URL(`http://${request.headers.host}`).origin;
    const sameOrigin = request.headers.origin === origin || (address.port === 80 && request.headers.origin === `${origin}:80`);
    let url;
    try { url = new URL(request.url, origin); }
    catch { send(400, 'text/plain; charset=utf-8', '请求地址无效'); return; }
    if (url.origin !== origin) { send(400, 'text/plain; charset=utf-8', '请求地址必须同源'); return; }
    const homepageNavigation = request.method === 'GET' && url.pathname === '/' && request.headers['sec-fetch-mode'] === 'navigate' && request.headers['sec-fetch-dest'] === 'document';
    if ((request.headers.origin && !sameOrigin) || (request.headers['sec-fetch-site'] === 'cross-site' && !homepageNavigation)) {
      send(403, 'text/plain; charset=utf-8', '仅允许从本机看板访问'); return;
    }
    if (url.pathname === '/' || url.pathname.startsWith('/api/')) {
      const keys = url.searchParams.getAll('workspace');
      const headerKey = request.headers['x-workspace-key'];
      if (keys.length > 1 || keys.some(key => !/^[a-f0-9]{64}$/.test(key)) || (headerKey !== undefined && (typeof headerKey !== 'string' || !/^[a-f0-9]{64}$/.test(headerKey)))) {
        send(400, 'application/json; charset=utf-8', JSON.stringify({ error: { code: 'WORKSPACE_INPUT_INVALID', message: '工作区标识参数无效' } })); return;
      }
      if (keys.some(key => key !== workspaceKey) || (headerKey !== undefined && headerKey !== workspaceKey)) {
        send(409, 'application/json; charset=utf-8', JSON.stringify({ error: { code: 'WORKSPACE_MISMATCH', message: '此地址的服务属于另一工作区，请重新连接当前工作区看板' } })); return;
      }
    }
    const params = new URLSearchParams(url.searchParams);
    params.delete('workspace');
    const resource = `${url.pathname}${params.size ? `?${params}` : ''}`;
    if (request.method === 'POST' && resource === '/api/roles/status') {
      const token = request.headers['x-csrf-token'];
      if (typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token) || !timingSafeEqual(Buffer.from(token), Buffer.from(csrfToken)) || (!sameOrigin && request.headers['sec-fetch-site'] !== 'same-origin')) {
        send(403, 'application/json; charset=utf-8', JSON.stringify({ error: { code: 'CSRF_REJECTED', message: '请从本机看板重新打开岗位管理后保存' } })); return;
      }
      try {
        const input = await readRoleRequest(request);
        const result = await setRoleStatus({ workspace: root, ...input });
        const { backup, ...data } = result;
        send(200, 'application/json; charset=utf-8', JSON.stringify({ ...data, message: result.changed ? '岗位状态已保存，原配置已备份' : '岗位状态未变化' }));
      } catch (error) { send(error.status ?? 500, 'application/json; charset=utf-8', JSON.stringify(actionError(error))); }
      return;
    }
    if (!['GET', 'HEAD'].includes(request.method)) {
      send(405, 'text/plain; charset=utf-8', '此资源只提供读取请求', { Allow: 'GET, HEAD' }); return;
    }
    if (url.pathname === '/api/health') {
      if (params.size) { send(400, 'application/json; charset=utf-8', JSON.stringify({ error: { code: 'HEALTH_INPUT_INVALID', message: '健康检查不接受其他参数' } })); return; }
      send(200, 'application/json; charset=utf-8', JSON.stringify({ service: 'recruiting-board', schemaVersion: 1, capabilities: ['snapshot', 'run-results', 'run-activity'], workspaceKey })); return;
    }
    if (resource === '/api/session') {
      send(200, 'application/json; charset=utf-8', JSON.stringify({ csrfToken })); return;
    }
    if (resource === '/api/roles') {
      try { send(200, 'application/json; charset=utf-8', JSON.stringify(await readRoleInfo(root))); }
      catch (error) { send(error.status ?? 500, 'application/json; charset=utf-8', JSON.stringify(actionError(error))); }
      return;
    }
    if (['/api/runs/results', '/api/runs/activity'].includes(url.pathname)) {
      if ([...params.keys()].length !== 1 || params.getAll('run').length !== 1) {
        send(400, 'application/json; charset=utf-8', JSON.stringify({ error: { code: 'RUN_INPUT_INVALID', message: '轮次请求仅接受一个 run 参数' } })); return;
      }
      const readRun = url.pathname.endsWith('/activity') ? readRunActivity : readRunResults;
      try { send(200, 'application/json; charset=utf-8', JSON.stringify(await readRun(root, params.get('run')))); }
      catch (error) { send(error.status ?? 500, 'application/json; charset=utf-8', JSON.stringify(actionError(error))); }
      return;
    }
    if (['/api/candidates/detail', '/api/candidates/document'].includes(url.pathname)) {
      const allowed = url.pathname.endsWith('/detail') ? ['candidate'] : ['candidate', 'document', 'download'];
      if ([...params.keys()].some(key => !allowed.includes(key) || params.getAll(key).length !== 1) || !params.has('candidate') || (url.pathname.endsWith('/document') && (!params.has('document') || (params.has('download') && params.get('download') !== '1')))) {
        send(400, 'application/json; charset=utf-8', JSON.stringify({ error: { code: 'DOCUMENT_INPUT_INVALID', message: '资料请求参数无效' } })); return;
      }
      try {
        if (url.pathname.endsWith('/detail')) send(200, 'application/json; charset=utf-8', JSON.stringify(await readCandidateDetail(root, url.searchParams.get('candidate'))));
        else {
          const content = await readCandidateDocument(root, url.searchParams.get('candidate'), url.searchParams.get('document'));
          const type = { markdown: 'text/plain; charset=utf-8', text: 'text/plain; charset=utf-8', pdf: 'application/pdf' }[content.document.kind];
          const disposition = url.searchParams.has('download') ? 'attachment' : 'inline';
          send(200, type, content.bytes, { 'Content-Disposition': `${disposition}; filename="document.${{ markdown: 'md', text: 'txt', pdf: 'pdf' }[content.document.kind]}"; filename*=UTF-8''${encodeURIComponent(path.basename(content.absolutePath))}` });
        }
      } catch (error) { send(error.status ?? 500, 'application/json; charset=utf-8', JSON.stringify(actionError(error))); }
      return;
    }
    if (resource === '/api/snapshot') {
      try {
        const snapshot = await nextSnapshot();
        send(200, 'application/json; charset=utf-8', JSON.stringify({ ...snapshot, workspaceKey }));
      } catch {
        send(500, 'application/json; charset=utf-8', JSON.stringify({ error: { code: 'SNAPSHOT_ERROR', message: '看板读取失败；请保留最后记录并检查工作区' } }));
      }
      return;
    }
    if (url.pathname === '/') {
      try {
        if ([...params.keys()].some(key => !['run', 'preview'].includes(key)) || params.getAll('run').length > 1 || params.getAll('preview').length > 1) throw new Error('invalid query');
        if (params.has('run')) assertRunId(params.get('run'));
        if (params.has('preview') && !['wide', 'narrow'].includes(params.get('preview'))) throw new Error('invalid preview');
      } catch { send(400, 'application/json; charset=utf-8', JSON.stringify({ error: { code: 'RUN_INPUT_INVALID', message: '看板地址仅接受单个安全 run、工作区标识及 wide / narrow 开发预览参数' } })); return; }
    }
    const asset = assets.get(url.pathname === '/' ? '/' : request.url);
    if (!asset) { send(404, 'text/plain; charset=utf-8', '未找到资源'); return; }
    try { send(200, asset[1], await readFile(path.join(publicRoot, asset[0]))); }
    catch { send(500, 'text/plain; charset=utf-8', '看板资源无法读取'); }
  });
  server.requestTimeout = 10_000;
  server.headersTimeout = 10_000;
  return server;
}

export function parseServerArgs(args) {
  const options = { workspace: null, port: 4318 };
  const seen = new Set();
  for (let i = 0; i < args.length; i += 2) {
    const flag = args[i], value = args[i + 1];
    if (!['--workspace', '--port'].includes(flag) || seen.has(flag) || !value || value.startsWith('--')) throw new Error('用法：server.mjs --workspace <已存在目录> [--port <0–65535>]');
    seen.add(flag);
    if (flag === '--workspace') options.workspace = value;
    else {
      if (!/^\d+$/.test(value) || Number(value) < 0 || Number(value) > 65535) throw new Error('端口必须为 0–65535 的整数，0 表示自动分配');
      options.port = Number(value);
    }
  }
  if (!options.workspace) throw new Error('必须显式指定 --workspace');
  return options;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const options = parseServerArgs(process.argv.slice(2));
    const root = await resolveWorkspace(options.workspace);
    const server = await createBoardServer({ ...options, workspace: root });
    server.once('error', error => { process.stderr.write(`招聘看板：${error.message}\n`); process.exitCode = 1; });
    const close = () => { server.close(); server.closeIdleConnections(); };
    process.once('SIGINT', close);
    process.once('SIGTERM', close);
    server.listen(options.port, '127.0.0.1', () => process.stdout.write(`${JSON.stringify({ event: 'ready', service: 'recruiting-board', url: `http://127.0.0.1:${server.address().port}/`, workspaceKey: workspaceKeyForRoot(root) })}\n`));
  } catch (error) { process.stderr.write(`招聘看板：${error.message}\n`); process.exitCode = 1; }
}
