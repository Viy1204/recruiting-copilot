import { mkdir, open, readFile, realpath, rename, rm, lstat } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { assertRunId, createRun, transitionRun, validateRun, WORKFLOWS } from '../model.mjs';
import { insideWorkspace, MAX_FILE_BYTES, resolveWorkspace } from './reader.mjs';

async function runsDirectory(root) {
  let directory = root;
  for (const name of ['runtime', 'recruit-board', 'runs']) {
    directory = path.join(directory, name);
    await mkdir(directory, { recursive: true });
    directory = await realpath(directory);
    if (!insideWorkspace(root, directory)) throw new Error('进度目录不能指向工作区外');
  }
  return directory;
}

export async function recordProgress({ workspace, id, workflow, role, ownerSessionId, action }, now = () => new Date().toISOString()) {
  const root = await resolveWorkspace(workspace);
  assertRunId(id);
  const directory = await runsDirectory(root);
  const file = path.join(directory, `${id}.json`);
  const lockFile = path.join(directory, `${id}.lock`);
  let lock;
  try { lock = await open(lockFile, 'wx'); }
  catch (error) {
    if (error.code === 'EEXIST') throw new Error(`轮次 ${id} 正在写入或留下了锁；确认没有写入进程后再移除 ${id}.lock`);
    throw error;
  }
  const temporary = path.join(directory, `.${id}-${randomUUID()}.tmp`);
  try {
    let run;
    if (action.type === 'start') {
      // rename 会替换已有文件，所以创建轮次必须在锁内单独拒绝重名。
      try { await lstat(file); throw new Error('runId 已存在，请使用新的 runId'); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      run = createRun({ id, workflow, role, ownerSessionId, now: now() });
    } else {
      const info = await lstat(file);
      if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_FILE_BYTES) throw new Error('进度记录必须是工作区内的普通 JSON 文件');
      const bytes = await readFile(file);
      if (bytes.length > MAX_FILE_BYTES) throw new Error('进度记录超过读取上限');
      const previous = validateRun(JSON.parse(bytes.toString('utf8')), id);
      run = transitionRun(previous, action, now());
      if (action.type === 'result' && JSON.stringify(run) === JSON.stringify(previous)) return run;
    }
    const text = `${JSON.stringify(run, null, 2)}\n`;
    if (Buffer.byteLength(text, 'utf8') > MAX_FILE_BYTES) throw new Error('进度记录超过文件大小上限');
    const output = await open(temporary, 'wx');
    try { await output.writeFile(text, 'utf8'); await output.sync(); }
    finally { await output.close(); }
    await rename(temporary, file);
    return run;
  } finally {
    await rm(temporary, { force: true });
    await lock.close();
    await rm(lockFile);
  }
}

const actionFlags = {
  start: ['workspace', 'run', 'workflow', 'role', 'session'],
  step: ['workspace', 'run', 'step'], wait: ['workspace', 'run', 'reason'],
  complete: ['workspace', 'run', 'step'], skip: ['workspace', 'run', 'step', 'reason'],
  fail: ['workspace', 'run', 'step', 'reason'], cancel: ['workspace', 'run', 'reason'],
  result: ['workspace', 'run', 'result', 'step', 'name', 'role', 'action', 'outcome', 'attention', 'next-action']
};

export async function progressCLI(argv) {
  const [command, ...args] = argv;
  if (command === 'workflows' && args.length === 0) return WORKFLOWS;
  const allowed = Object.hasOwn(actionFlags, command) ? actionFlags[command] : null;
  if (!allowed) throw new Error('用法：progress.mjs workflows | start/step/wait/complete/skip/fail/cancel/result --workspace <目录> --run <id>；步骤列表见 workflows');
  const flags = {};
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i].replace(/^--/, '');
    if (!args[i].startsWith('--') || !allowed.includes(key) || flags[key] !== undefined || !args[i + 1] || args[i + 1].startsWith('--')) throw new Error(`无效或重复参数：${args[i]}`);
    flags[key] = args[i + 1];
  }
  if (!flags.workspace) throw new Error('必须显式指定 --workspace');
  if (command !== 'start' && !flags.run) throw new Error('必须指定 --run');
  if (command === 'start' && !flags.workflow) throw new Error('start 必须指定 --workflow');
  if (['step', 'skip'].includes(command) && !flags.step) throw new Error('必须指定 --step');
  if (['wait', 'skip', 'fail', 'cancel'].includes(command) && !flags.reason) throw new Error('必须指定 --reason');
  let result;
  if (command === 'result') {
    for (const key of ['result', 'step', 'name', 'role', 'action', 'outcome', 'attention']) if (!flags[key]?.trim()) throw new Error(`result 必须指定 --${key}`);
    if (flags.name !== flags.name.trim() || flags.role !== flags.role.trim()) throw new Error('候选姓名和原岗位不得包含首尾空白');
    result = { id: flags.result, stepId: flags.step, candidateId: JSON.stringify([flags.name, flags.role]), action: flags.action, outcome: flags.outcome, attention: flags.attention, nextAction: flags['next-action'] ?? null };
  }
  return recordProgress({
    workspace: flags.workspace, id: flags.run ?? randomUUID(), workflow: flags.workflow, role: flags.role, ownerSessionId: flags.session,
    action: { type: command, step: flags.step, reason: flags.reason, ...(result ? { result } : {}) }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try { process.stdout.write(`${JSON.stringify(await progressCLI(process.argv.slice(2)), null, 2)}\n`); }
  catch (error) { process.stderr.write(`招聘进度：${error.message}\n`); process.exitCode = 1; }
}
