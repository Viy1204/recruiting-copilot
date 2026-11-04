import { lstat, open, readdir } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { applyDecision, decisionId, decisionView, validateCommand, validateDecision } from '../decisions-domain.mjs';
import { boardDirectory, readJSONFile, withItemLock, writeJSONFile } from './storage.mjs';
import { insideWorkspace, resolveWorkspace } from './reader.mjs';
import { readRunRecord } from './results.mjs';

const DECISION_DIRECTORY = 'decisions';
const inputError = message => Object.assign(new Error(message), { code: 'DECISION_INPUT_INVALID', status: 400 });
const diagnostic = (code, source, message, level = 'warning') => ({ code, source, level, message });

export async function decisionsDirectory(root, create = false) {
  return boardDirectory(root, ['runtime', 'recruit-board', DECISION_DIRECTORY], create);
}

export async function initializeDecisions(root) {
  const base = await boardDirectory(root, ['runtime', 'recruit-board'], true);
  try {
    const info = await lstat(path.join(base, '.decisions-known'));
    if (!info.isFile() || info.isSymbolicLink()) throw inputError('事项接入标记无效');
    const directory = await decisionsDirectory(root);
    const initialized = await lstat(path.join(directory, '.initialized'));
    if (!initialized.isFile() || initialized.isSymbolicLink()) throw inputError('事项接入标记无效');
    return directory;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    try {
      await lstat(path.join(base, '.decisions-known'));
      throw Object.assign(new Error('已接入的事项存储缺失，请先恢复记录'), { code: 'DECISION_MISSING', status: 409 });
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  const directory = await decisionsDirectory(root, true);
  for (const file of [path.join(directory, '.initialized'), path.join(base, '.decisions-known')]) {
    try { const handle = await open(file, 'wx'); await handle.close(); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
  }
  return directory;
}

export async function readDecision(root, id) {
  decisionId(id);
  const directory = await decisionsDirectory(root);
  const file = path.join(directory, `${id}.json`);
  const value = await readJSONFile(file, root);
  return validateDecision(value, id);
}

export async function listDecisions(root) {
  const directory = await decisionsDirectory(root);
  const entries = await readdir(directory, { withFileTypes: true });
  const items = [], diagnostics = [];
  const ids = new Set(entries.filter(entry => entry.name.endsWith('.json') || entry.name.endsWith('.known')).map(entry => entry.name.replace(/\.(json|known)$/, '')));
  for (const id of ids) {
    try {
      decisionId(id);
      items.push(validateDecision(await readJSONFile(path.join(directory, `${id}.json`), root), id));
    } catch (error) {
      diagnostics.push(diagnostic(error.code === 'ENOENT' ? 'DECISION_MISSING' : 'DECISION_INVALID', DECISION_DIRECTORY, '一份已登记事项缺失、无法读取或格式无效，事项总数未知', 'error'));
    }
  }
  items.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  return { items, diagnostics };
}

export async function applyDecisionCommand(workspace, operation, input, now = () => new Date().toISOString()) {
  const id = validateCommand(operation, input);
  const root = await resolveWorkspace(workspace);
  const directory = await initializeDecisions(root);
  const file = path.join(directory, `${id}.json`);
  return withItemLock(directory, id, async () => {
    let previous = null;
    try { previous = validateDecision(await readJSONFile(file, root), id); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      try {
        await readJSONFile(path.join(directory, `${id}.known`), root);
        throw Object.assign(new Error('已登记事项文件缺失，请恢复原记录，不得重新登记覆盖历史'), { code: 'DECISION_MISSING', status: 409 });
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    const outcome = applyDecision(previous, operation, input, now());
    if (!outcome.replayed) {
      if (input.source) {
        const run = await readRunRecord(root, input.source.runId);
        if (input.source.resultId && !run.results?.some(result => result.id === input.source.resultId)) throw inputError('来源结果不存在于指定轮次');
        const result = run.results?.find(result => result.id === input.source.resultId);
        if (result?.decisionId && result.decisionId !== id) throw inputError('来源结果已关联其他事项');
      }
      await writeJSONFile(file, outcome.item);
    }
    const marker = path.join(directory, `${id}.known`);
    let handle;
    try {
      handle = await open(marker, 'wx');
      await handle.writeFile(JSON.stringify({ id })); await handle.sync();
    } catch (error) { if (error.code !== 'EEXIST') throw error; }
    finally { if (handle) await handle.close(); }
    return { ...outcome, item: decisionView(outcome.item, now()) };
  });
}

const commandFlags = {
  register: ['workspace', 'input'],
  evidence: ['workspace', 'input'],
  decide: ['workspace', 'input'],
  revise: ['workspace', 'input'],
  reopen: ['workspace', 'input'],
  snooze: ['workspace', 'input'],
  close: ['workspace', 'input'],
  cancel: ['workspace', 'input'],
  invalidate: ['workspace', 'input'],
  'resolve-history': ['workspace', 'input'],
  action: ['workspace', 'input'],
  'import-history': ['workspace', 'run'],
  show: ['workspace', 'id']
};

export async function decisionsCLI(argv) {
  const [command, ...args] = argv;
  const required = Object.hasOwn(commandFlags, command) ? commandFlags[command] : null;
  if (!required) throw inputError('用法：decisions.mjs register/evidence/decide/revise/reopen/snooze/close/cancel/invalidate/resolve-history/action --workspace <目录> --input <JSON> 或 --input-file <工作区内JSON>；import-history --workspace <目录> --run <runId>');
  const allowed = required.includes('input') ? [...required, 'input-file'] : required;
  const flags = {};
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index], value = args[index + 1];
    const key = flag.replace(/^--/, '');
    if (!flag.startsWith('--') || !allowed.includes(key) || Object.hasOwn(flags, key) || !value || value.startsWith('--')) throw inputError('命令包含无效、重复或缺失参数');
    flags[key] = value;
  }
  if (required.some(key => key === 'input' ? !Object.hasOwn(flags, 'input') && !Object.hasOwn(flags, 'input-file') : !Object.hasOwn(flags, key))) throw inputError(`命令必须提供 ${required.map(key => `--${key}`).join(' ')} 参数`);
  if (flags.input !== undefined && flags['input-file'] !== undefined) throw inputError('--input 与 --input-file 只能提供一个');
  if (command === 'show') {
    const root = await resolveWorkspace(flags.workspace);
    return decisionView(await readDecision(root, flags.id));
  }
  if (command === 'import-history') {
    const { importLegacyDecisions } = await import('./import-history.mjs');
    return importLegacyDecisions(flags.workspace, flags.run);
  }
  const root = await resolveWorkspace(flags.workspace);
  const input = flags['input-file'] !== undefined ? await readInputFile(root, flags['input-file']) : parseInput(flags.input);
  return applyDecisionCommand(root, command, input);
}

export async function readInputFile(root, file) {
  const resolved = path.resolve(root, file);
  if (!insideWorkspace(root, resolved)) throw inputError('输入文件必须位于工作区内');
  const value = await readJSONFile(resolved, root);
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw inputError('输入文件必须是 JSON 对象');
  return value;
}

export function parseInput(raw) {
  let value;
  try { value = JSON.parse(raw); }
  catch { throw inputError('命令输入不是有效 JSON'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw inputError('命令输入必须是 JSON 对象');
  return value;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try { process.stdout.write(`${JSON.stringify(await decisionsCLI(process.argv.slice(2)), null, 2)}\n`); }
  catch (error) { process.stderr.write(`招聘事项：${error.message}\n`); process.exitCode = 1; }
}
