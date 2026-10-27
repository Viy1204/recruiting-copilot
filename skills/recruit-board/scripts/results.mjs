import { constants } from 'node:fs';
import { lstat, open, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { assertRunId, validateRun } from '../model.mjs';
import { insideWorkspace, MAX_FILE_BYTES, resolveWorkspace } from './reader.mjs';

const failure = (code, message, status) => Object.assign(new Error(message), { code, status });

/** @returns {Promise<import('../types/index.d.ts').RunResults>} */
export async function readRunResults(workspace, runId) {
  try { assertRunId(runId); }
  catch { throw failure('RUN_INPUT_INVALID', 'runId 仅允许 1–64 位字母、数字、下划线和连字符', 400); }
  if (typeof workspace !== 'string' || !workspace.trim()) throw failure('RUN_WORKSPACE_INVALID', '必须显式指定工作区目录', 400);
  let root;
  try { root = await resolveWorkspace(workspace); }
  catch { throw failure('RUN_WORKSPACE_INVALID', '工作区不存在或无法读取', 404); }
  let handle;
  try {
    let directory = root;
    for (const name of ['runtime', 'recruit-board', 'runs']) {
      directory = await realpath(path.join(directory, name));
      if (!insideWorkspace(root, directory) || !(await stat(directory)).isDirectory()) throw failure('RUN_PATH_UNSAFE', '进度目录必须位于工作区内', 422);
    }
    const file = path.join(directory, `${runId}.json`);
    const info = await lstat(file);
    if (!info.isFile() || info.isSymbolicLink() || !insideWorkspace(root, await realpath(file))) throw failure('RUN_PATH_UNSAFE', '进度记录必须是工作区内的普通 JSON 文件', 422);
    if (info.size > MAX_FILE_BYTES) throw failure('RUN_TOO_LARGE', '进度记录超过读取上限', 422);
    handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const opened = await handle.stat();
    if (!opened.isFile()) throw failure('RUN_PATH_UNSAFE', '进度记录必须是工作区内的普通 JSON 文件', 422);
    if (opened.size > MAX_FILE_BYTES) throw failure('RUN_TOO_LARGE', '进度记录超过读取上限', 422);
    const bytes = await handle.readFile();
    if (bytes.length > MAX_FILE_BYTES) throw failure('RUN_TOO_LARGE', '进度记录超过读取上限', 422);
    let value;
    try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
    catch { throw failure('RUN_INVALID', '进度记录不是有效的 UTF-8 JSON', 422); }
    let run;
    try { run = validateRun(value, runId); }
    catch (error) { throw failure('RUN_INVALID', `进度记录无效：${error.message}`, 422); }
    return { runId: run.id, updatedAt: run.updatedAt, results: run.results, revision: run.resultsRevision };
  } catch (error) {
    if (error.code?.startsWith('RUN_')) throw error;
    if (error.code === 'ENOENT') throw failure('RUN_NOT_FOUND', '未找到该轮次的进度记录', 404);
    throw failure('RUN_UNREADABLE', '进度记录无法安全读取，请检查工作区文件和权限', 422);
  } finally { if (handle) await handle.close(); }
}

/** @returns {Promise<import('../types/index.d.ts').RunActivity>} */
export async function readRunActivity(workspace, runId) {
  const { runId: id, revision, updatedAt, results } = await readRunResults(workspace, runId);
  const items = results === null ? null : results.map((result, index) => ({ result, index }))
    .sort((a, b) => b.result.updatedAt.localeCompare(a.result.updatedAt) || b.index - a.index)
    .slice(0, 3).map(({ result }) => result);
  return { runId: id, revision, updatedAt, items };
}
