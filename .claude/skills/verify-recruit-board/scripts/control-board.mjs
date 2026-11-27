#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const boardScripts = path.join(repoRoot, 'skills', 'recruit-board', 'scripts');

function usage() {
  console.error(`Usage:
  control-board.mjs seed --workspace <dir>
  control-board.mjs launch --workspace <dir> --state <file> [--port <port>]
  control-board.mjs doctor --state <file>
  control-board.mjs http --state <file> --path <path> [--method GET|POST] [--body <json>] [--csrf] [--out <file>]
  control-board.mjs cli --workspace <dir> -- <script> [args...]
  control-board.mjs cleanup --state <file> [--remove-workspace]`);
  process.exit(2);
}

function parseFlags(argv) {
  const flags = {};
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--') {
      rest.push(...argv.slice(i + 1));
      break;
    }
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (!next || next.startsWith('--')) {
        flags[key] = true;
      } else {
        flags[key] = next;
        i++;
      }
    } else {
      rest.push(arg);
    }
  }
  return { flags, rest };
}

async function freePort() {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

async function runSeed(workspace) {
  const root = path.resolve(workspace);
  await fs.mkdir(path.join(root, '01-jd', '_internal', 'logs'), { recursive: true });
  await fs.mkdir(path.join(root, '02-sourcing'), { recursive: true });
  await fs.mkdir(path.join(root, '03-interview'), { recursive: true });
  await fs.mkdir(path.join(root, 'docs'), { recursive: true });
  await fs.mkdir(path.join(root, 'runtime', 'resumes'), { recursive: true });
  await fs.mkdir(path.join(root, 'runtime', 'recruit-board', 'runs'), { recursive: true });
  await fs.mkdir(path.join(root, 'runtime', 'recruit-board', 'decisions'), { recursive: true });

  await fs.writeFile(
    path.join(root, 'CONTEXT.md'),
    [
      '# 合成验证工作区',
      '',
      '## 一、招聘纪律',
      '',
      '- 对外发送消息或约面前先经用户确认。',
      '',
      '## 二、在招岗位与优先级',
      '',
      '| role_id | 岗位 | 优先级 | 状态 | 对外 JD | 对内档案 | 最近变更 |',
      '| --- | --- | --- | --- | --- | --- | --- |',
      '| `BE-01` | 后端工程师 | 急岗 | 在招 | `01-jd/be-01.md` | `01-jd/_internal/be-01.md` | 2026-11-20 初始化 |',
      '| `FE-01` | 前端工程师 | 常规 | 暂停 | `01-jd/fe-01.md` | `01-jd/_internal/fe-01.md` | 2026-11-20 初始化 |',
      '',
    ].join('\n'),
    'utf8',
  );

  await fs.writeFile(
    path.join(root, '01-jd', 'be-01.md'),
    '# 后端工程师 JD\n\n负责分布式后端系统设计与高并发稳定性建设。\n',
    'utf8',
  );
  await fs.writeFile(
    path.join(root, '01-jd', '_internal', 'be-01.md'),
    [
      '# 后端工程师 · 对内档案',
      '',
      '## 核心筛选标准',
      '',
      '- 5 年以上分布式后端经验。',
      '',
      '## 轮次校准记录',
      '',
      '### 2026-11-20',
      '- 优先看真实高并发落地方案。',
      '',
    ].join('\n'),
    'utf8',
  );
  await fs.writeFile(
    path.join(root, '01-jd', 'fe-01.md'),
    '# 前端工程师 JD\n\n负责招聘工作台与前端工程体系建设。\n',
    'utf8',
  );
  await fs.writeFile(
    path.join(root, '01-jd', '_internal', 'fe-01.md'),
    '# 前端工程师 · 对内档案\n\n## 核心筛选标准\n\n- 熟悉现代浏览器渲染与交互可访问性。\n',
    'utf8',
  );
  await fs.writeFile(
    path.join(root, 'docs', 'CHANGELOG.md'),
    '# CHANGELOG — 招聘工作区变更日志\n\n- 2026-11-20 | BE-01（后端工程师）| 初始化岗位 | 合成验证种子\n',
    'utf8',
  );

  await fs.writeFile(
    path.join(root, '02-sourcing', 'dedup-ledger.csv'),
    [
      '序号,姓名,应聘岗位,现职/背景,评级,状态,来源轮次,简历路径,备注',
      '1,合成候选人甲,后端工程师,8年分布式后端,A,待确认,verify-run-001,,系统设计扎实',
      '2,合成候选人乙,后端工程师,6年高并发服务,B,已约谈,verify-run-001,runtime/resumes/candidate-b.txt,已发日历邀约',
      '3,合成候选人丙,前端工程师,5年前端架构,A,待初筛,verify-run-001,,旧岗位记录',
      '',
    ].join('\n'),
    'utf8',
  );

  await fs.writeFile(
    path.join(root, '03-interview', '合成候选人乙.md'),
    [
      '# 合成候选人乙 · 后端工程师',
      '',
      '- 姓名：合成候选人乙',
      '- 岗位：后端工程师',
      '- 附件：[原始简历](../runtime/resumes/candidate-b.txt)',
      '',
      '## 进展记录',
      '',
      '| 时间 | 动作 | 摘要 | 来源 |',
      '| --- | --- | --- | --- |',
      '| 2026-11-20 11:30 | 约一面 | 已预约技术一面 | interview-schedule |',
      '',
    ].join('\n'),
    'utf8',
  );

  await fs.writeFile(
    path.join(root, 'runtime', 'resumes', 'candidate-b.txt'),
    '合成候选人乙 简历摘要：8 年分布式后端经验。\n',
    'utf8',
  );

  const runScript = path.join(boardScripts, 'progress.mjs');
  const start = spawnSync(
    process.execPath,
    [runScript, 'start', '--workspace', root, '--run', 'verify-run-001', '--workflow', 'daily', '--trigger', 'manual'],
    { encoding: 'utf8' },
  );
  if (start.status !== 0) throw new Error(`progress start failed: ${start.stderr || start.stdout}`);
  const startedRun = JSON.parse(start.stdout);
  for (const step of startedRun.steps) {
    const skipped = spawnSync(
      process.execPath,
      [runScript, 'skip', '--workspace', root, '--run', 'verify-run-001', '--step', step.id, '--reason', '合成验证种子步骤'],
      { encoding: 'utf8' },
    );
    if (skipped.status !== 0) throw new Error(`progress skip ${step.id} failed: ${skipped.stderr || skipped.stdout}`);
  }

  const done = spawnSync(
    process.execPath,
    [runScript, 'complete', '--workspace', root, '--run', 'verify-run-001'],
    { encoding: 'utf8' },
  );
  if (done.status !== 0) throw new Error(`progress complete failed: ${done.stderr || done.stdout}`);

  const decScript = path.join(boardScripts, 'decisions.mjs');
  const regPayload = JSON.stringify({
    identity: {
      subjectKey: 'candidate:synthetic-a',
      questionKey: 'interview-round-1',
      scope: '后端工程师 · 本轮筛选',
    },
    title: '确认是否向合成候选人甲发起一面',
    source: { runId: 'verify-run-001' },
    expectedRevision: 0,
    requestId: 'seed-req-001',
  });
  const reg = spawnSync(
    process.execPath,
    [decScript, 'register', '--workspace', root, '--input', regPayload],
    { encoding: 'utf8' },
  );
  if (reg.status !== 0) throw new Error(`decisions register failed: ${reg.stderr || reg.stdout}`);
  const seededDecisionId = JSON.parse(reg.stdout).item.id;

  const canonical = await fs.realpath(root);
  const workspaceKey = createHash('sha256').update(canonical).digest('hex');
  console.log(JSON.stringify({ ok: true, workspace: canonical, workspaceKey, seededRunId: 'verify-run-001', seededDecisionId }, null, 2));
}

async function runLaunch(workspace, stateFile, requestedPort) {
  const root = await fs.realpath(path.resolve(workspace));
  const port = requestedPort ? Number(requestedPort) : await freePort();
  const logFile = `${stateFile}.server.log`;
  await fs.mkdir(path.dirname(path.resolve(stateFile)), { recursive: true });
  const logHandle = await fs.open(logFile, 'w');
  const child = spawn(
    process.execPath,
    [path.join(boardScripts, 'server.mjs'), '--workspace', root, '--port', String(port)],
    {
      cwd: repoRoot,
      detached: true,
      stdio: ['ignore', logHandle.fd, logHandle.fd],
    },
  );
  child.unref();
  await logHandle.close();

  const deadline = Date.now() + 10000;
  let health = null;
  while (Date.now() < deadline) {
    if (!pidAlive(child.pid)) {
      const log = await fs.readFile(logFile, 'utf8').catch(() => '');
      throw new Error(`server exited early (pid ${child.pid}): ${log}`);
    }
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (res.ok) {
        health = await res.json();
        break;
      }
    } catch {
      // retry until ready
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  if (!health) {
    try { process.kill(child.pid); } catch { /* ignore */ }
    throw new Error(`server did not become healthy on port ${port} within 10s`);
  }

  const state = {
    pid: child.pid,
    port,
    workspace: root,
    workspaceKey: health.workspaceKey,
    url: `http://127.0.0.1:${port}/?workspace=${health.workspaceKey}`,
    logFile: path.resolve(logFile),
    startedAt: new Date().toISOString(),
  };
  await fs.writeFile(stateFile, JSON.stringify(state, null, 2) + '\n', 'utf8');
  console.log(JSON.stringify({ ok: true, ...state }, null, 2));
}

async function readState(stateFile) {
  return JSON.parse(await fs.readFile(stateFile, 'utf8'));
}

async function runDoctor(stateFile) {
  const state = await readState(stateFile);
  const alive = pidAlive(state.pid);
  if (!alive) {
    console.log(JSON.stringify({ ok: false, reason: 'process-dead', pid: state.pid }));
    process.exit(1);
  }
  const healthRes = await fetch(`http://127.0.0.1:${state.port}/api/health`);
  const health = await healthRes.json();
  const htmlRes = await fetch(state.url);
  const html = await htmlRes.text();
  const ok = healthRes.ok
    && health.service === 'recruiting-board'
    && health.workspaceKey === state.workspaceKey
    && Array.isArray(health.capabilities)
    && health.capabilities.includes('web-decisions')
    && htmlRes.ok
    && html.includes('招聘工作台');
  console.log(JSON.stringify({
    ok,
    pid: state.pid,
    port: state.port,
    workspaceKeyMatch: health.workspaceKey === state.workspaceKey,
    capabilities: health.capabilities,
    htmlStatus: htmlRes.status,
  }, null, 2));
  if (!ok) process.exit(1);
}

async function runHttp(stateFile, reqPath, method = 'GET', bodyText = null, useCsrf = false, outFile = null) {
  const state = await readState(stateFile);
  const origin = `http://127.0.0.1:${state.port}`;
  const headers = { Origin: origin, Referer: state.url };
  if (useCsrf) {
    const sessRes = await fetch(`${origin}/api/session`, { headers });
    if (!sessRes.ok) throw new Error(`GET /api/session failed: ${sessRes.status}`);
    const { csrfToken } = await sessRes.json();
    headers['X-CSRF-Token'] = csrfToken;
  }
  const init = { method: method.toUpperCase(), headers };
  if (bodyText !== null && bodyText !== undefined) {
    headers['Content-Type'] = 'application/json; charset=utf-8';
    init.body = bodyText;
  }
  const target = reqPath.startsWith('http') ? reqPath : `${origin}${reqPath}`;
  const res = await fetch(target, init);
  const text = await res.text();
  let parsed = null;
  try { parsed = JSON.parse(text); } catch { /* plain text */ }
  const result = {
    status: res.status,
    ok: res.ok,
    contentType: res.headers.get('content-type'),
    body: parsed ?? text,
  };
  const formatted = JSON.stringify(result, null, 2) + '\n';
  if (outFile) {
    await fs.mkdir(path.dirname(path.resolve(outFile)), { recursive: true });
    await fs.writeFile(outFile, formatted, 'utf8');
  }
  process.stdout.write(formatted);
}

async function runCli(workspace, scriptName, args) {
  const allowed = new Set([
    'actions',
    'connect',
    'decisions',
    'events',
    'import-history',
    'ledger',
    'materials',
    'progress',
    'role-context',
    'roles',
    'workspace',
  ]);
  const clean = scriptName.replace(/\.mjs$/, '');
  if (!allowed.has(clean)) throw new Error(`Unknown recruit-board CLI script: ${scriptName}`);
  const scriptPath = path.join(boardScripts, `${clean}.mjs`);
  const fullArgs = args.includes('--workspace') ? args : [...args, '--workspace', path.resolve(workspace)];
  const res = spawnSync(process.execPath, [scriptPath, ...fullArgs], { cwd: repoRoot, encoding: 'utf8' });
  console.log(JSON.stringify({
    script: `${clean}.mjs`,
    exitCode: res.status,
    stdout: res.stdout.trim(),
    stderr: res.stderr.trim(),
  }, null, 2));
  process.exit(res.status ?? 1);
}

async function runCleanup(stateFile, removeWorkspace) {
  const state = await readState(stateFile);
  let stopped = false;
  if (pidAlive(state.pid)) {
    try {
      process.kill(state.pid);
      stopped = true;
    } catch { /* ignore */ }
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline && pidAlive(state.pid)) {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  await fs.rm(stateFile, { force: true });
  await fs.rm(state.logFile, { force: true });
  let workspaceRemoved = false;
  if (removeWorkspace && state.workspace) {
    await fs.rm(state.workspace, { recursive: true, force: true });
    workspaceRemoved = true;
  }
  console.log(JSON.stringify({ ok: true, pid: state.pid, stopped, workspaceRemoved }, null, 2));
}

const [cmd, ...argv] = process.argv.slice(2);
if (!cmd) usage();
const { flags, rest } = parseFlags(argv);

try {
  if (cmd === 'seed') {
    if (!flags.workspace) usage();
    await runSeed(flags.workspace);
  } else if (cmd === 'launch') {
    if (!flags.workspace || !flags.state) usage();
    await runLaunch(flags.workspace, flags.state, flags.port);
  } else if (cmd === 'doctor') {
    if (!flags.state) usage();
    await runDoctor(flags.state);
  } else if (cmd === 'http') {
    if (!flags.state || !flags.path) usage();
    await runHttp(flags.state, flags.path, flags.method || 'GET', flags.body ?? null, Boolean(flags.csrf), flags.out ?? null);
  } else if (cmd === 'cli') {
    if (!flags.workspace || rest.length === 0) usage();
    await runCli(flags.workspace, rest[0], rest.slice(1));
  } else if (cmd === 'cleanup') {
    if (!flags.state) usage();
    await runCleanup(flags.state, Boolean(flags['remove-workspace']));
  } else {
    usage();
  }
} catch (error) {
  console.error(error.message || String(error));
  process.exit(1);
}
