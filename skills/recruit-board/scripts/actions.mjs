import { spawn } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { readCandidateDetail, readCandidateDocument } from './records.mjs';
import { readRoleInfo, setRoleStatus } from './roles.mjs';
import { readRunActivity, readRunResults } from './results.mjs';

const commands = {
  candidate: ['workspace', 'candidate'],
  document: ['workspace', 'candidate', 'document'],
  'open-document': ['workspace', 'candidate', 'document'],
  'role-info': ['workspace'],
  'role-set': ['workspace', 'role', 'status', 'revision'],
  'run-results': ['workspace', 'run'],
  'run-activity': ['workspace', 'run']
};
const failure = message => Object.assign(new Error(message), { code: 'ACTION_INPUT_INVALID', status: 400 });

export async function openDocument(file) {
  const command = process.platform === 'win32' ? 'explorer.exe' : process.platform === 'darwin' ? 'open' : 'xdg-open';
  const args = process.platform === 'darwin' ? ['--', file] : [file];
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, { shell: false, detached: true, stdio: 'ignore', windowsHide: true });
    child.once('error', () => reject(Object.assign(new Error('无法启动本机默认应用，请检查系统文件关联'), { code: 'DOCUMENT_OPEN_FAILED' })));
    child.once('spawn', () => { child.unref(); resolve(); });
  });
}

export async function actionsCLI(argv) {
  const [command, ...args] = argv;
  const allowed = Object.hasOwn(commands, command) ? commands[command] : null;
  if (!allowed) throw failure('用法：actions.mjs candidate/document/open-document/role-info/role-set/run-results/run-activity --workspace <目录>；候选使用 --candidate，附件增加 --document，岗位保存使用 --role --status --revision，轮次结果与动态使用 --run');
  const flags = {};
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index], value = args[index + 1];
    const key = flag.replace(/^--/, '');
    if (!flag.startsWith('--') || !allowed.includes(key) || Object.hasOwn(flags, key) || !value || value.startsWith('--')) throw failure('命令包含无效、重复或缺失参数');
    flags[key] = value;
  }
  if (allowed.some(key => !Object.hasOwn(flags, key))) throw failure(`命令必须提供 ${allowed.map(key => `--${key}`).join(' ')} 参数`);
  if (command === 'candidate') return readCandidateDetail(flags.workspace, flags.candidate);
  if (command === 'run-results') return readRunResults(flags.workspace, flags.run);
  if (command === 'run-activity') return readRunActivity(flags.workspace, flags.run);
  if (command === 'role-info') return readRoleInfo(flags.workspace);
  if (command === 'role-set') return setRoleStatus(flags);
  const content = await readCandidateDocument(flags.workspace, flags.candidate, flags.document);
  if (command === 'open-document') {
    await openDocument(content.absolutePath);
    return { opened: true, document: content.document, message: '已请求本机默认应用打开附件' };
  }
  return { document: content.document, text: content.text, absolutePath: content.absolutePath };
}

export function actionError(error) {
  return { error: { code: typeof error.code === 'string' && /^[A-Z_]+$/.test(error.code) ? error.code : 'ACTION_FAILED', message: error.status || error.code?.startsWith('ROLE_') || error.code?.startsWith('CONTEXT_') || error.code?.startsWith('DOCUMENT_') || error.code?.startsWith('CANDIDATE_') || error.code?.startsWith('RUN_') || error.code === 'ACTION_INPUT_INVALID' ? error.message : '本地资料或岗位操作失败，请检查工作区文件和权限' } };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try { process.stdout.write(`${JSON.stringify(await actionsCLI(process.argv.slice(2)))}\n`); }
  catch (error) { process.stderr.write(`${JSON.stringify(actionError(error))}\n`); process.exitCode = 1; }
}
