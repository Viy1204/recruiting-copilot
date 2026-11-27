import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const defaultRepoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Existing scripts frozen prior to workspace-io.mjs (most are SHA-256 locked by verification/formal).
// Any new script under skills/recruit-board/scripts/ or already-migrated script (ledger.mjs,
// role-context.mjs, workspace.mjs) MUST use ./workspace-io.mjs instead of raw fs/TextDecoder IO.
const LEGACY_IO_SCRIPTS = new Set([
  'workspace-io.mjs',
  'actions.mjs',
  'connect.mjs',
  'decisions.mjs',
  'events.mjs',
  'import-history.mjs',
  'materials.mjs',
  'overview.mjs',
  'progress.mjs',
  'reader.mjs',
  'records.mjs',
  'results.mjs',
  'roles.mjs',
  'server.mjs',
  'storage.mjs',
  'vendor-ui-sdk-core.mjs'
]);

const REGISTERED_LOCK_LITERALS = new Set([
  'context.lock',
  'ledger.lock',
  '${id}.lock',
  '${key}.lock'
]);

const EXISTING_ROLE_TABLE_PARSERS = new Set([
  'skills/recruit-board/model.mjs',
  'skills/recruit-board/scripts/roles.mjs',
  'skills/recruit-board/scripts/workspace.mjs'
]);

const FORBIDDEN_ROOT_WORKSPACE_ENTRIES = [
  'CONTEXT.md',
  '01-jd',
  '02-sourcing',
  '03-interview',
  '_shared',
  'runtime'
];

const EXCEPTION_PREFIX_RE = /\/\/\s*guardrail-allow:\s*(.+)$/;
const EXCEPTION_FULL_RE = /^([a-z0-9-]+)\s*\|\s*reason:\s*([^|]+?)\s*\|\s*expires:\s*(\d{4}-\d{2}-\d{2})\s*\|\s*approved:\s*(@[A-Za-z0-9_-]+)\s*$/;

function toPosix(relPath) {
  return relPath.split(path.sep).join('/');
}

function walkFiles(dir, predicate, results = []) {
  if (!existsSync(dir)) return results;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === '.git' || entry.name === 'node_modules') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkFiles(full, predicate, results);
    } else if (entry.isFile() && predicate(full, entry.name)) {
      results.push(full);
    }
  }
  return results;
}

function checkInlineException(line, ruleId, relFile, lineNo, today, violations) {
  const match = EXCEPTION_PREFIX_RE.exec(line);
  if (!match) return false;
  const parsed = EXCEPTION_FULL_RE.exec(match[1].trim());
  if (!parsed) {
    violations.push({
      rule: 'guardrail-exception-malformed',
      file: relFile,
      line: lineNo,
      message: 'Malformed guardrail-allow comment. Expected: // guardrail-allow: <rule> | reason: <why> | expires: YYYY-MM-DD | approved: @<human>'
    });
    return false;
  }
  const [, allowedRule, , expires] = parsed;
  if (allowedRule !== ruleId) return false;
  if (expires < today) {
    violations.push({
      rule: 'guardrail-exception-expired',
      file: relFile,
      line: lineNo,
      message: `Inline exception for ${ruleId} expired on ${expires} (today is ${today}); remove the workaround or renew with human approval.`
    });
    return false;
  }
  return true;
}

function checkRawSymlinkInTests(root, today, violations) {
  const testDir = path.join(root, 'tests');
  const files = walkFiles(testDir, (full, name) => name.endsWith('.mjs'));
  for (const file of files) {
    const rel = toPosix(path.relative(root, file));
    if (rel === 'tests/helpers/symlink.mjs') continue;
    const lines = readFileSync(file, 'utf8').split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const hasImport = /^\s*import\s*\{[^}]*\bsymlink\b[^}]*\}\s*from\s*['"]node:fs(?:\/promises)?['"]/.test(line);
      const hasCall = /\b(?:fs\.)?symlink\s*\(/.test(line) && !/^\s*(?:\/\/|\*)/.test(line) && !/['"`][^'"`]*\bsymlink\s*\(/.test(line);
      if (!hasImport && !hasCall) continue;
      if (checkInlineException(line, 'no-raw-symlink-in-tests', rel, i + 1, today, violations)) continue;
      violations.push({
        rule: 'no-raw-symlink-in-tests',
        file: rel,
        line: i + 1,
        message: 'Raw symlink() in tests breaks Windows without elevated privileges. Import { linkDir, tryLinkFile } from "./helpers/symlink.mjs" instead.'
      });
    }
  }
}

function checkAdhocWorkspaceIo(root, today, violations) {
  const scriptsDir = path.join(root, 'skills', 'recruit-board', 'scripts');
  if (!existsSync(scriptsDir)) return;
  for (const entry of readdirSync(scriptsDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.mjs')) continue;
    if (LEGACY_IO_SCRIPTS.has(entry.name)) continue;
    const file = path.join(scriptsDir, entry.name);
    const rel = toPosix(path.relative(root, file));
    const lines = readFileSync(file, 'utf8').split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (/^\s*(?:\/\/|\*)/.test(line)) continue;
      const badFsImport = /import\s*\{[^}]*\b(lstat|realpath|readFile)\b[^}]*\}\s*from\s*['"]node:fs(?:\/promises)?['"]/.test(line);
      const badDecoder = /\bnew\s+TextDecoder\s*\(/.test(line);
      if (!badFsImport && !badDecoder) continue;
      if (checkInlineException(line, 'no-adhoc-workspace-io', rel, i + 1, today, violations)) continue;
      violations.push({
        rule: 'no-adhoc-workspace-io',
        file: rel,
        line: i + 1,
        message: 'Do not hand-roll workspace lstat/realpath/readFile/TextDecoder in recruit-board scripts. Use readSafeWorkspaceFile, ensureSafeDirectory, readWorkspaceInputJSON, or decodeTextWithMeta from "./workspace-io.mjs".'
      });
    }
  }
}

function checkRogueLockFiles(root, today, violations) {
  const boardDir = path.join(root, 'skills', 'recruit-board');
  const files = walkFiles(boardDir, (full, name) => name.endsWith('.mjs'));
  const lockTokenRe = /(?:^|[/\\\s'"`])([A-Za-z0-9_${}.-]+\.lock)(?=$|[\s'"`,;)])/g;
  for (const file of files) {
    const rel = toPosix(path.relative(root, file));
    const lines = readFileSync(file, 'utf8').split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (/^\s*(?:\/\/|\*)/.test(line)) continue;
      for (const match of line.matchAll(lockTokenRe)) {
        const lockName = match[1];
        if (REGISTERED_LOCK_LITERALS.has(lockName)) continue;
        if (checkInlineException(line, 'no-rogue-lock-files', rel, i + 1, today, violations)) continue;
        violations.push({
          rule: 'no-rogue-lock-files',
          file: rel,
          line: i + 1,
          message: `Unregistered lock file "${lockName}". Reuse WORKSPACE_LOCK_FILES (context.lock / ledger.lock) via withWorkspaceLock() in skills/recruit-board/scripts/workspace-io.mjs (ADR 0007).`
        });
      }
    }
  }
}

function checkDuplicateRoleTableParsers(root, today, violations) {
  const boardDir = path.join(root, 'skills', 'recruit-board');
  const files = walkFiles(boardDir, (full, name) => name.endsWith('.mjs'));
  for (const file of files) {
    const rel = toPosix(path.relative(root, file));
    if (EXISTING_ROLE_TABLE_PARSERS.has(rel)) continue;
    const text = readFileSync(file, 'utf8');
    if (!text.includes('在招岗位与优先级')) continue;
    const looksLikeRoleTableColumns =
      (text.includes("'岗位'") || text.includes('"岗位"')) &&
      (text.includes("'优先级'") || text.includes('"优先级"')) &&
      (text.includes("'状态'") || text.includes('"状态"'));
    const looksLikeRoleTableHeader = text.includes('对内笔记') || looksLikeRoleTableColumns;
    if (!looksLikeRoleTableHeader) continue;
    const lines = text.split(/\r?\n/);
    const idx = lines.findIndex(line => line.includes('在招岗位与优先级'));
    if (idx >= 0 && checkInlineException(lines[idx], 'no-duplicate-role-table-parser', rel, idx + 1, today, violations)) {
      continue;
    }
    violations.push({
      rule: 'no-duplicate-role-table-parser',
      file: rel,
      line: idx + 1,
      message: 'Do not write another CONTEXT.md role-table parser. Import readRoleTable / readRoles from skills/recruit-board/model.mjs.'
    });
  }
}

function checkRejectedDualSource(root, today, violations) {
  const skillsDir = path.join(root, 'skills');
  const files = walkFiles(skillsDir, (full, name) => /\.(?:mjs|js|md)$/.test(name));
  for (const file of files) {
    const rel = toPosix(path.relative(root, file));
    const lines = readFileSync(file, 'utf8').split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!line.includes('_shared/roles.json')) continue;
      if (checkInlineException(line, 'no-rejected-dual-source', rel, i + 1, today, violations)) continue;
      violations.push({
        rule: 'no-rejected-dual-source',
        file: rel,
        line: i + 1,
        message: 'ADR 0007 rejected _shared/roles.json to avoid dual sources of truth. Use CONTEXT.md (7-column table) via skills/recruit-board/scripts/roles.mjs and model.mjs.'
      });
    }
  }
}

function checkAdrSequence(root, violations) {
  const adrDir = path.join(root, 'docs', 'adr');
  if (!existsSync(adrDir)) return;
  const files = readdirSync(adrDir)
    .filter(name => name.endsWith('.md'))
    .sort();
  const seen = new Map();
  const numbers = [];
  for (const name of files) {
    const match = /^(\d{4})-[a-z0-9-]+\.md$/.exec(name);
    if (!match) {
      violations.push({
        rule: 'adr-sequence-valid',
        file: `docs/adr/${name}`,
        line: 1,
        message: `ADR filename "${name}" must match NNNN-slug.md (4 digits, lowercase kebab-case).`
      });
      continue;
    }
    const num = Number(match[1]);
    if (seen.has(num)) {
      violations.push({
        rule: 'adr-sequence-valid',
        file: `docs/adr/${name}`,
        line: 1,
        message: `Duplicate ADR number ${match[1]} (already used by docs/adr/${seen.get(num)}).`
      });
    } else {
      seen.set(num, name);
      numbers.push(num);
    }
  }
  numbers.sort((a, b) => a - b);
  for (let i = 0; i < numbers.length; i++) {
    const expected = i + 1;
    if (numbers[i] !== expected) {
      const expectedStr = String(expected).padStart(4, '0');
      const actualStr = String(numbers[i]).padStart(4, '0');
      violations.push({
        rule: 'adr-sequence-valid',
        file: `docs/adr/${seen.get(numbers[i])}`,
        line: 1,
        message: `ADR sequence gap: expected ${expectedStr} before ${actualStr}. Number ADRs contiguously starting at 0001.`
      });
      break;
    }
  }
}

function checkTemplateRepoCleanRoot(root, violations) {
  for (const entry of FORBIDDEN_ROOT_WORKSPACE_ENTRIES) {
    const full = path.join(root, entry);
    if (existsSync(full)) {
      violations.push({
        rule: 'template-repo-clean-root',
        file: entry,
        line: 1,
        message: `User workspace artifact "${entry}" must not be written into the recruiting-copilot template repo (AGENTS.md red line). Keep user workspaces outside this repository.`
      });
    }
  }
}

function stripInlineCode(line) {
  return line.replace(/`[^`]*`/g, '');
}

function checkMarkdownRelativeLinks(root, violations) {
  const strictDocs = [];
  for (const top of ['README.md', 'AGENTS.md']) {
    const full = path.join(root, top);
    if (existsSync(full)) strictDocs.push(full);
  }
  walkFiles(path.join(root, 'docs'), (full, name) => name.endsWith('.md'), strictDocs);

  const skillDocs = walkFiles(path.join(root, 'skills'), (full, name) => {
    if (!name.endsWith('.md')) return false;
    const rel = toPosix(path.relative(root, full));
    return !rel.includes('/templates/');
  });

  const validateFile = (file, skillScopedOnly) => {
    const relFile = toPosix(path.relative(root, file));
    const lines = readFileSync(file, 'utf8').split(/\r?\n/);
    let inFence = false;
    for (let i = 0; i < lines.length; i++) {
      const rawLine = lines[i];
      if (/^\s*(?:```|~~~)/.test(rawLine)) {
        inFence = !inFence;
        continue;
      }
      if (inFence) continue;
      const line = stripInlineCode(rawLine);
      for (const match of line.matchAll(/!?\[[^\]]*\]\(([^)]+)\)/g)) {
        let target = match[1].trim();
        if (target.startsWith('<') && target.endsWith('>')) target = target.slice(1, -1).trim();
        target = target.split(/\s+/)[0];
        if (!target || target.startsWith('#') || /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(target)) continue;
        const cleanTarget = target.split('#')[0].split('?')[0];
        if (!cleanTarget || /[<>]/.test(cleanTarget)) continue;
        if (skillScopedOnly && !/^(?:references|scripts|templates|\.\.)\//.test(cleanTarget)) continue;
        const resolved = path.resolve(path.dirname(file), cleanTarget);
        if (!existsSync(resolved)) {
          violations.push({
            rule: 'markdown-local-links-exist',
            file: relFile,
            line: i + 1,
            message: `Broken relative Markdown link target "${cleanTarget}" (resolved to missing path).`
          });
        }
      }
    }
  };

  for (const file of strictDocs) validateFile(file, false);
  for (const file of skillDocs) validateFile(file, true);
}

function checkFormalCoverageSha256(root, violations) {
  const formalDir = path.join(root, 'verification', 'formal');
  const manifestPath = path.join(formalDir, 'coverage.json');
  if (!existsSync(manifestPath)) return;
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  for (const [subsystem, record] of Object.entries(manifest.subsystems ?? {})) {
    const area = typeof record === 'string'
      ? JSON.parse(readFileSync(path.join(formalDir, record), 'utf8'))
      : record;
    for (const source of area.sources ?? []) {
      const full = path.join(root, source.path);
      if (!existsSync(full) || !statSync(full).isFile()) {
        violations.push({
          rule: 'formal-coverage-sha256-sync',
          file: source.path,
          line: 1,
          message: `Formal verification tracked source missing for subsystem "${subsystem}".`
        });
        continue;
      }
      const text = readFileSync(full, 'utf8').replaceAll('\r\n', '\n');
      const actual = createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex');
      if (actual !== source.sha256) {
        violations.push({
          rule: 'formal-coverage-sha256-sync',
          file: source.path,
          line: 1,
          message: `Formal verification coverage drift in subsystem "${subsystem}" (expected ${source.sha256.slice(0, 12)}, actual ${actual.slice(0, 12)}). Do NOT mechanically refresh hashes; review .claude/skills/verify-recruit-${subsystem}/SKILL.md and run "node scripts/verify-state-machines.mjs --mutations ${subsystem}".`
        });
      }
    }
  }
}

/**
 * Runs all deterministic repo guardrail checks against `root`.
 * @param {string} [root]
 * @param {{ today?: string }} [options]
 */
export function checkRepoGuardrails(root = defaultRepoRoot, { today = new Date().toISOString().slice(0, 10) } = {}) {
  const violations = [];
  checkRawSymlinkInTests(root, today, violations);
  checkAdhocWorkspaceIo(root, today, violations);
  checkRogueLockFiles(root, today, violations);
  checkDuplicateRoleTableParsers(root, today, violations);
  checkRejectedDualSource(root, today, violations);
  checkAdrSequence(root, violations);
  checkTemplateRepoCleanRoot(root, violations);
  checkMarkdownRelativeLinks(root, violations);
  checkFormalCoverageSha256(root, violations);
  return { ok: violations.length === 0, violations };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const result = checkRepoGuardrails(defaultRepoRoot);
  if (result.ok) {
    process.stdout.write('PASS: repo guardrails (0 violations)\n');
  } else {
    for (const v of result.violations) {
      process.stderr.write(`[${v.rule}] ${v.file}:${v.line}: ${v.message}\n`);
    }
    process.stderr.write(`FAIL: repo guardrails (${result.violations.length} violation(s))\n`);
    process.exitCode = 1;
  }
}
