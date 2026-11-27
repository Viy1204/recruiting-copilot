import { createHash } from 'node:crypto';
import { lstat, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { readRoles } from '../model.mjs';
import {
  compileEffectiveRules,
  evaluateCandidate,
  extractGlobalPolicyFromContext,
  validateScreeningRules
} from '../screen-gate-domain.mjs';
import { insideWorkspace, MAX_FILE_BYTES, readSource, resolveWorkspace } from './reader.mjs';

const RULES_RELATIVE = '_shared/screening-rules.json';
const REGISTRY_RELATIVE = '_shared/roles.json';
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const failure = (code, message, status = 400) => Object.assign(new Error(message), { code, status });

async function readWorkspaceTextFile(root, relative, missingCode = null) {
  const file = path.join(root, relative);
  let info;
  try { info = await lstat(file); }
  catch (error) {
    if (error.code === 'ENOENT') {
      if (missingCode) throw failure(missingCode, `未找到文件：${relative}`, 404);
      return { status: 'missing', text: null, revision: null, bytes: 0 };
    }
    throw failure('SCREEN_GATE_UNREADABLE', `无法读取文件：${relative}`, 422);
  }
  if (!info.isFile() || info.isSymbolicLink() || !insideWorkspace(root, await realpath(file))) {
    throw failure('SCREEN_GATE_UNSAFE', `文件必须位于工作区内且不能为符号链接：${relative}`, 403);
  }
  if (info.size > MAX_FILE_BYTES) throw failure('SCREEN_GATE_TOO_LARGE', `文件超过读取上限：${relative}`, 422);
  const bytes = await readFile(file);
  if (bytes.length > MAX_FILE_BYTES) throw failure('SCREEN_GATE_TOO_LARGE', `文件超过读取上限：${relative}`, 422);
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return { status: 'ok', text, revision: digest(bytes), bytes: bytes.length };
  } catch {
    throw failure('SCREEN_GATE_ENCODING', `文件不是有效的 UTF-8 文本：${relative}`, 422);
  }
}

async function loadScreeningRules(root) {
  const loaded = await readWorkspaceTextFile(root, RULES_RELATIVE, 'SCREENING_RULES_MISSING');
  let parsed;
  try { parsed = JSON.parse(loaded.text.replace(/^\uFEFF/, '')); }
  catch { throw failure('SCREENING_RULES_INVALID', `${RULES_RELATIVE} 不是有效的 JSON`, 422); }
  return { revision: loaded.revision, config: validateScreeningRules(parsed) };
}

/**
 * Optionally read _shared/roles.json (if present) to resolve roleId <-> name and internalPath
 * without requiring _shared/roles.json to exist.
 */
async function resolveRoleMetadata(root, roleQuery) {
  const fallbackKeys = [];
  let canonicalName = roleQuery;
  let internalPath = null;

  const reg = await readWorkspaceTextFile(root, REGISTRY_RELATIVE);
  if (reg.status === 'ok') {
    try {
      const parsed = JSON.parse(reg.text.replace(/^\uFEFF/, ''));
      if (Array.isArray(parsed?.roles)) {
        const match = parsed.roles.find(item =>
          item?.id === roleQuery ||
          item?.name === roleQuery ||
          (Array.isArray(item?.aliases) && item.aliases.includes(roleQuery))
        );
        if (match) {
          if (typeof match.id === 'string' && match.id !== roleQuery) fallbackKeys.push(match.id);
          if (typeof match.name === 'string') {
            canonicalName = match.name;
            if (match.name !== roleQuery) fallbackKeys.push(match.name);
          }
          if (typeof match.internalPath === 'string' && match.internalPath.trim()) {
            internalPath = match.internalPath.trim();
          }
        }
      }
    } catch {
      // Optional registry enhancement; ignore malformed file here.
    }
  }

  // Fallback: locate single role internalPath from CONTEXT.md table or conventional path 01-jd/_internal/<name>.md
  if (!internalPath) {
    const context = await readSource(root, 'CONTEXT.md');
    if (context.status === 'ok') {
      const lines = context.text.replace(/^\uFEFF/, '').split(/\r?\n/);
      for (const line of lines) {
        if (!line.trim().startsWith('|') || !line.includes(canonicalName)) continue;
        const match = /01-jd\/_internal\/[^|`\s)]+\.md/.exec(line);
        if (match) {
          internalPath = match[0];
          break;
        }
      }
    }
  }
  if (!internalPath && !/[\\/]/.test(canonicalName) && !canonicalName.includes('..')) {
    internalPath = `01-jd/_internal/${canonicalName}.md`;
  }
  return { canonicalName, fallbackKeys, internalPath };
}

export async function validateScreeningRulesWorkspace(workspace) {
  const root = await resolveWorkspace(workspace);
  const { revision, config } = await loadScreeningRules(root);
  const context = await readSource(root, 'CONTEXT.md');
  let contextRoles = [];
  if (context.status === 'ok') {
    try { contextRoles = readRoles(context.text); } catch { contextRoles = []; }
  }
  const roleKeys = Object.keys(config.roles);
  // Validate merged coherence for every role override
  for (const key of roleKeys) {
    compileEffectiveRules(config, key);
  }
  return {
    valid: true,
    revision,
    defaultRuleCount: Object.keys(config.defaults).length,
    roleOverrideCount: roleKeys.length,
    roleOverrides: roleKeys,
    contextRoleCount: contextRoles.length
  };
}

export async function getEffectiveRoleRules(workspace, roleQuery) {
  if (typeof roleQuery !== 'string' || !roleQuery.trim()) {
    throw failure('SCREEN_GATE_INPUT_INVALID', '必须指定 --role');
  }
  const root = await resolveWorkspace(workspace);
  const { revision, config } = await loadScreeningRules(root);
  const meta = await resolveRoleMetadata(root, roleQuery.trim());
  const compiled = compileEffectiveRules(config, roleQuery.trim(), { fallbackKeys: meta.fallbackKeys });
  return {
    revision,
    canonicalName: meta.canonicalName,
    internalPath: meta.internalPath,
    ...compiled
  };
}

/**
 * Script-controlled O(1) single-role context packer:
 * Loads ONLY global policy + ONE role's merged hard-gate rules + ONE role's _internal JD note.
 */
export async function packRoleScreeningContext(workspace, roleQuery) {
  if (typeof roleQuery !== 'string' || !roleQuery.trim()) {
    throw failure('SCREEN_GATE_INPUT_INVALID', '必须指定 --role');
  }
  const root = await resolveWorkspace(workspace);
  const meta = await resolveRoleMetadata(root, roleQuery.trim());

  let rulesRevision = null;
  let compiled = null;
  const rulesLoaded = await readWorkspaceTextFile(root, RULES_RELATIVE);
  if (rulesLoaded.status === 'ok') {
    let parsed;
    try { parsed = JSON.parse(rulesLoaded.text.replace(/^\uFEFF/, '')); }
    catch { throw failure('SCREENING_RULES_INVALID', `${RULES_RELATIVE} 不是有效的 JSON`, 422); }
    const config = validateScreeningRules(parsed);
    rulesRevision = rulesLoaded.revision;
    compiled = compileEffectiveRules(config, roleQuery.trim(), { fallbackKeys: meta.fallbackKeys });
  }

  const contextFile = await readWorkspaceTextFile(root, 'CONTEXT.md');
  const globalPolicy = contextFile.status === 'ok' ? extractGlobalPolicyFromContext(contextFile.text) : '';

  let internalNote = null;
  let internalStatus = 'missing';
  if (meta.internalPath) {
    const loadedNote = await readWorkspaceTextFile(root, meta.internalPath);
    internalStatus = loadedNote.status;
    if (loadedNote.status === 'ok') internalNote = loadedNote.text;
  }

  const markdownParts = [
    `# 单岗初筛上下文包：${meta.canonicalName}`,
    '',
    '> 本上下文包由 `screen-gate.mjs pack` 按单岗编译生成：仅包含全岗位统一规则与本岗差异，不含其他岗位规则与历史决策日志。'
  ];
  if (globalPolicy) {
    markdownParts.push('', '## 一、全局统一政策（摘自 CONTEXT.md）', '', globalPolicy);
  }
  if (compiled) {
    markdownParts.push(
      '',
      '## 二、本岗生效硬门槛（统一规则 + 单岗覆盖）',
      '',
      '```json',
      JSON.stringify({ roleKey: compiled.roleKey, matchedRoleKey: compiled.matchedRoleKey, rules: compiled.rules, provenance: compiled.provenance }, null, 2),
      '```'
    );
  }
  if (internalNote !== null) {
    markdownParts.push('', `## 三、本岗对内笔记（${meta.internalPath}）`, '', internalNote.trim());
  }
  const markdown = `${markdownParts.join('\n')}\n`;
  const packedBytes = Buffer.byteLength(markdown, 'utf8');

  return {
    roleQuery: roleQuery.trim(),
    canonicalName: meta.canonicalName,
    rulesRevision,
    contextRevision: contextFile.revision,
    effectiveRules: compiled,
    globalPolicy,
    internalNote: { path: meta.internalPath, status: internalStatus, text: internalNote },
    markdown,
    stats: {
      loadedRoleCount: 1,
      contextFullBytes: contextFile.bytes,
      packedBytes,
      savedBytes: Math.max(0, contextFile.bytes - packedBytes)
    }
  };
}

export async function evaluateSingleCandidate({ workspace, role, candidate }) {
  const effective = await getEffectiveRoleRules(workspace, role);
  return {
    rulesRevision: effective.revision,
    ...evaluateCandidate(effective, candidate)
  };
}

export async function evaluateCandidateBatch({ workspace, role, candidates }) {
  if (!Array.isArray(candidates)) throw failure('CANDIDATE_INPUT_INVALID', '批量评估输入必须为候选人数组');
  const effective = await getEffectiveRoleRules(workspace, role);
  const results = candidates.map((candidate, index) => ({
    index,
    ...evaluateCandidate(effective, candidate)
  }));
  const summary = {
    total: results.length,
    pass: results.filter(item => item.verdict === 'PASS_HARD_GATES').length,
    reject: results.filter(item => item.verdict === 'REJECT_HARD_GATE').length,
    needDetail: results.filter(item => item.verdict === 'NEED_DETAIL').length
  };
  return {
    rulesRevision: effective.revision,
    roleKey: effective.roleKey,
    canonicalName: effective.canonicalName,
    summary,
    results
  };
}

async function readInputJSON(flags) {
  if (flags.input !== undefined && flags['input-file'] !== undefined) {
    throw failure('SCREEN_GATE_INPUT_INVALID', '--input 与 --input-file 只能提供一个');
  }
  if (flags.input !== undefined) {
    try { return JSON.parse(flags.input); }
    catch { throw failure('SCREEN_GATE_INPUT_INVALID', '--input 不是有效的 JSON'); }
  }
  if (flags['input-file'] !== undefined) {
    const root = await resolveWorkspace(flags.workspace);
    const real = await realpath(path.resolve(flags['input-file'])).catch(() => {
      throw failure('SCREEN_GATE_INPUT_INVALID', '无法读取 --input-file');
    });
    if (!insideWorkspace(root, real)) throw failure('SCREEN_GATE_UNSAFE', '--input-file 必须位于工作区内', 403);
    const bytes = await readFile(real);
    if (bytes.length > MAX_FILE_BYTES) throw failure('SCREEN_GATE_TOO_LARGE', '--input-file 超过读取上限', 422);
    try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
    catch { throw failure('SCREEN_GATE_INPUT_INVALID', '--input-file 不是有效的 UTF-8 JSON'); }
  }
  throw failure('SCREEN_GATE_INPUT_INVALID', '必须提供 --input 或 --input-file 参数');
}

const commandSpecs = {
  validate: { required: ['workspace'], optional: [] },
  'effective-rules': { required: ['workspace', 'role'], optional: [] },
  pack: { required: ['workspace', 'role'], optional: ['format'] },
  evaluate: { required: ['workspace', 'role'], optional: ['input', 'input-file'] },
  'evaluate-batch': { required: ['workspace', 'role'], optional: ['input', 'input-file'] }
};

export async function screenGateCLI(argv) {
  const [command, ...args] = argv;
  const spec = Object.hasOwn(commandSpecs, command) ? commandSpecs[command] : null;
  if (!spec) {
    throw failure('SCREEN_GATE_INPUT_INVALID', '用法：screen-gate.mjs validate/effective-rules/pack/evaluate/evaluate-batch --workspace <目录> [--role <岗位>] ...');
  }
  const allowed = new Set([...spec.required, ...spec.optional]);
  const flags = {};
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index], value = args[index + 1];
    if (!flag?.startsWith('--')) throw failure('SCREEN_GATE_INPUT_INVALID', `无效参数：${flag ?? ''}`);
    const key = flag.slice(2);
    if (!allowed.has(key) || Object.hasOwn(flags, key) || value === undefined || value.startsWith('--')) {
      throw failure('SCREEN_GATE_INPUT_INVALID', `参数无效、重复或缺少值：${flag}`);
    }
    flags[key] = value;
  }
  for (const key of spec.required) {
    if (!Object.hasOwn(flags, key)) throw failure('SCREEN_GATE_INPUT_INVALID', `缺少必填参数：--${key}`);
  }

  if (command === 'validate') return validateScreeningRulesWorkspace(flags.workspace);
  if (command === 'effective-rules') return getEffectiveRoleRules(flags.workspace, flags.role);
  if (command === 'pack') {
    const format = flags.format ?? 'json';
    if (!['json', 'md'].includes(format)) throw failure('SCREEN_GATE_INPUT_INVALID', '--format 仅支持 json 或 md');
    const packed = await packRoleScreeningContext(flags.workspace, flags.role);
    return format === 'md' ? packed.markdown : packed;
  }
  const payload = await readInputJSON(flags);
  if (command === 'evaluate') return evaluateSingleCandidate({ workspace: flags.workspace, role: flags.role, candidate: payload });
  return evaluateCandidateBatch({ workspace: flags.workspace, role: flags.role, candidates: payload });
}

export function screenGateError(error) {
  return {
    error: {
      code: typeof error.code === 'string' && /^[A-Z_]+$/.test(error.code) ? error.code : 'SCREEN_GATE_FAILED',
      message: error.status || error.code?.startsWith('SCREEN') || error.code?.startsWith('CANDIDATE_')
        ? error.message
        : '初筛预筛或单岗打包失败，请检查工作区文件和参数'
    }
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const result = await screenGateCLI(process.argv.slice(2));
    process.stdout.write(typeof result === 'string' ? result : `${JSON.stringify(result)}\n`);
  } catch (error) {
    process.stderr.write(`${JSON.stringify(screenGateError(error))}\n`);
    process.exitCode = 1;
  }
}
