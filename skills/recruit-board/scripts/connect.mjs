import http from 'node:http';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { assertRunId } from '../model.mjs';
import { resolveWorkspace, workspaceKeyForRoot } from './reader.mjs';

const failure = message => Object.assign(new Error(message), { code: 'CONNECT_INPUT_INVALID' });

/** @param {{workspace:string, url?:string, run?:string|null}} options @returns {Promise<{status:'ready'|'unavailable'|'workspace-mismatch'|'incompatible', url:string|null, runUrl:string|null, workspaceKey:string, message:string}>} */
export async function probeBoard({ workspace, url = 'http://127.0.0.1:4318', run = null } = {}) {
  if (typeof workspace !== 'string' || !path.isAbsolute(workspace)) throw failure('必须使用 --workspace 指定已存在的绝对工作区目录');
  const match = typeof url === 'string' && /^http:\/\/(127\.0\.0\.1|localhost)(?::([1-9]\d{0,4}))?\/?$/.exec(url);
  if (!match || (match[2] && Number(match[2]) > 65535)) throw failure('看板地址必须是 http 的 127.0.0.1 或 localhost 根地址，端口为 1–65535，不能含凭据、路径、查询或片段');
  if (run !== null) {
    try { assertRunId(run); }
    catch { throw failure('runId 仅允许 1–64 位字母、数字、下划线和连字符'); }
  }
  let root;
  try { root = await resolveWorkspace(workspace); }
  catch { throw failure('工作区必须是已存在且可读取的目录'); }
  const workspaceKey = workspaceKeyForRoot(root);
  const endpoint = new URL(url);
  const result = await new Promise(resolve => {
    let settled = false;
    const finish = value => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      request.destroy();
      resolve(value);
    };
    const request = http.get({ hostname: '127.0.0.1', port: endpoint.port || 80, path: '/api/health', agent: false, headers: { Host: endpoint.host, Accept: 'application/json' } }, response => {
      if (response.statusCode !== 200) { finish({ status: 'incompatible' }); return; }
      const chunks = [];
      let size = 0;
      response.on('data', chunk => {
        size += chunk.length;
        if (size > 8192) finish({ status: 'incompatible' });
        else chunks.push(chunk);
      });
      response.once('error', () => finish({ status: 'unavailable' }));
      response.once('end', () => {
        let health;
        try { health = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))); }
        catch { finish({ status: 'incompatible' }); return; }
        if (!health || typeof health !== 'object' || Array.isArray(health) || health.service !== 'recruiting-board' || health.schemaVersion !== 1 || !Array.isArray(health.capabilities) || !['snapshot', 'run-results', 'run-activity'].every(capability => health.capabilities.includes(capability)) || typeof health.workspaceKey !== 'string' || !/^[a-f0-9]{64}$/.test(health.workspaceKey)) {
          finish({ status: 'incompatible' }); return;
        }
        finish({ status: health.workspaceKey === workspaceKey ? 'ready' : 'workspace-mismatch' });
      });
    });
    const timer = setTimeout(() => finish({ status: 'unavailable' }), 2000);
    request.once('error', () => finish({ status: 'unavailable' }));
  });
  const messages = {
    ready: '看板已就绪',
    unavailable: '本机看板服务未连接，请使用宿主服务工具以前台方式启动后重试',
    'workspace-mismatch': '该地址正在服务另一工作区，请为当前工作区启动独立看板',
    incompatible: '该地址未提供兼容的招聘看板服务，请使用当前版本启动后重试'
  };
  const boardURL = new URL(endpoint.origin);
  boardURL.searchParams.set('workspace', workspaceKey);
  const runURL = new URL(boardURL);
  if (run !== null) runURL.searchParams.set('run', run);
  return { status: result.status, url: result.status === 'ready' ? boardURL.href : null, runUrl: result.status === 'ready' ? runURL.href : null, workspaceKey, message: messages[result.status] };
}

export async function connectCLI(args) {
  const options = {};
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index], value = args[index + 1];
    if (!['--workspace', '--url', '--run'].includes(flag) || Object.hasOwn(options, flag.slice(2)) || !value || value.startsWith('--')) throw failure('用法：connect.mjs --workspace <已存在的绝对目录> [--url <本机 HTTP 根地址>] [--run <安全 ID>]');
    options[flag.slice(2)] = value;
  }
  return probeBoard(options);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try { process.stdout.write(`${JSON.stringify(await connectCLI(process.argv.slice(2)))}\n`); }
  catch (error) {
    process.stderr.write(`${JSON.stringify({ error: { code: error.code === 'CONNECT_INPUT_INVALID' ? error.code : 'CONNECT_FAILED', message: error.code === 'CONNECT_INPUT_INVALID' ? error.message : '看板连接探测失败，请检查本机服务与工作区' } })}\n`);
    process.exitCode = 1;
  }
}
