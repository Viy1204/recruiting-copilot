import { mkdir, open, readFile, realpath, rename, rm, lstat } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { assertRunId, createRun, transitionRun, validateRun, WORKFLOWS } from '../model.mjs';
import { insideWorkspace, MAX_FILE_BYTES, resolveWorkspace } from './reader.mjs';
import { initializeDecisions, readDecision } from './decisions.mjs';
import { readArchiveEvents } from './events.mjs';

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

export async function recordProgress({ workspace, id, workflow, role, ownerSessionId, trigger, action }, now = () => new Date().toISOString()) {
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
      run = createRun({ id, workflow, role, ownerSessionId, trigger, now: now() });
      await initializeDecisions(root);
    } else {
      const info = await lstat(file);
      if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_FILE_BYTES) throw new Error('进度记录必须是工作区内的普通 JSON 文件');
      const bytes = await readFile(file);
      if (bytes.length > MAX_FILE_BYTES) throw new Error('进度记录超过读取上限');
      const previous = validateRun(JSON.parse(bytes.toString('utf8')), id);
      let base = previous;
      if (['running', 'waiting'].includes(previous.status) && previous.workflow === 'interview-schedule' && ['summary', 'complete'].includes(action.type) && !action.step && previous.results?.some(result => result.stepId === 'calendar')) {
        const events = await readArchiveEvents(root);
        const linked = events.highlights.filter(event => event.sourceRunIds.includes(id));
        const candidates = [...new Set(previous.results.filter(result => result.stepId === 'calendar').map(result => result.candidateId))];
        if (candidates.some(candidateId => events.diagnostics.some(item => item.candidateId === candidateId && ['PROGRESS_EVENT_INVALID', 'PROGRESS_SOURCE_UNAVAILABLE'].includes(item.code)) || !linked.some(event => event.context.candidateId === candidateId))) throw new Error('约面任务缺少已关联档案中的进展事件，请用 events.mjs 记录真实结果并关联来源任务后再完成');
        for (const event of linked) {
          if (base.highlights?.some(item => item.eventKey === event.eventKey)) continue;
          const highlight = { eventKey: event.eventKey, text: event.text, evidence: event.evidence, occurredAt: event.occurredAt, context: event.context, details: event.details, subjectKey: event.context.candidateId };
          base = transitionRun(base, { type: 'highlight', highlight }, now());
        }
      }
      run = transitionRun(base, action, now());
      if (JSON.stringify(run) === JSON.stringify(previous)) return run;
      const decisionId = action.result?.decisionId ?? action.highlight?.decisionId;
      if (decisionId) {
        const decision = await readDecision(root, decisionId);
        if (!decision.sources.some(source => source.runId === id)) throw new Error('关联事项尚未记录此轮来源，请先登记或追加依据');
      }
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
  start: ['workspace', 'run', 'workflow', 'role', 'session', 'trigger'],
  step: ['workspace', 'run', 'step'], wait: ['workspace', 'run', 'reason'],
  complete: ['workspace', 'run', 'step'], skip: ['workspace', 'run', 'step', 'reason'],
  fail: ['workspace', 'run', 'step', 'reason'], cancel: ['workspace', 'run', 'reason'],
  result: ['workspace', 'run', 'result', 'step', 'name', 'role', 'action', 'outcome', 'attention', 'next-action', 'decision'],
  highlight: ['workspace', 'run', 'event', 'text', 'evidence', 'decision', 'subject', 'occurred-at', 'correction', 'expected-revision', 'request', 'context', 'details'],
  summary: ['workspace', 'run', 'state', 'text']
};

export async function progressCLI(argv) {
  const [command, ...args] = argv;
  if (command === 'workflows' && args.length === 0) return WORKFLOWS;
  const allowed = Object.hasOwn(actionFlags, command) ? actionFlags[command] : null;
  if (!allowed) throw new Error('用法：progress.mjs workflows | start/step/wait/complete/skip/fail/cancel/result/highlight/summary --workspace <目录> --run <id>；步骤列表见 workflows');
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
    result = { id: flags.result, stepId: flags.step, candidateId: JSON.stringify([flags.name, flags.role]), action: flags.action, outcome: flags.outcome, attention: flags.attention, nextAction: flags['next-action'] ?? null, ...(flags.decision ? { decisionId: flags.decision } : {}) };
  }
  let highlight;
  if (command === 'highlight') {
    for (const key of ['event', 'text']) if (!flags[key]) throw new Error(`highlight 必须指定 --${key}`);
    highlight = { eventKey: flags.event, text: flags.text, evidence: flags.evidence, decisionId: flags.decision, subjectKey: flags.subject, occurredAt: flags['occurred-at'], correction: flags.correction };
    for (const key of ['context', 'details']) if (flags[key] !== undefined) {
      try { highlight[key] = JSON.parse(flags[key]); }
      catch { throw new Error(`highlight --${key} 必须为有效 JSON`); }
    }
    if (flags['expected-revision'] !== undefined && (!/^(0|[1-9]\d*)$/.test(flags['expected-revision']) || !Number.isSafeInteger(Number(flags['expected-revision'])))) throw new Error('expected-revision 必须为非负安全整数');
  }
  if (command === 'summary' && (!flags.state || !flags.text)) throw new Error('summary 必须指定 --state 与 --text');
  return recordProgress({
    workspace: flags.workspace, id: flags.run ?? randomUUID(), workflow: flags.workflow, role: flags.role, ownerSessionId: flags.session, trigger: flags.trigger,
    action: { type: command, step: flags.step, reason: flags.reason, ...(result ? { result } : {}), ...(highlight ? { highlight, expectedRevision: flags['expected-revision'] === undefined ? undefined : Number(flags['expected-revision']), requestId: flags.request } : {}), ...(command === 'summary' ? { summaryState: flags.state, closingSummary: flags.text } : {}) }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try { process.stdout.write(`${JSON.stringify(await progressCLI(process.argv.slice(2)), null, 2)}\n`); }
  catch (error) { process.stderr.write(`招聘进度：${error.message}\n`); process.exitCode = 1; }
}
