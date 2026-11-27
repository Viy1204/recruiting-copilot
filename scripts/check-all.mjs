import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const requireShell = process.argv.includes('--require-shell');
const skipShell = process.argv.includes('--skip-shell');

function runStep(label, command, args) {
  process.stdout.write(`\n==> ${label}\n`);
  const result = spawnSync(command, args, {
    cwd: root,
    stdio: 'inherit',
    windowsHide: true
  });
  if (result.error) {
    process.stderr.write(`ERROR (${label}): ${result.error.message}\n`);
    process.exit(1);
  }
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

const unitTestFiles = readdirSync(path.join(root, 'tests'))
  .filter(name => name.endsWith('.test.mjs'))
  .sort()
  .map(name => path.join('tests', name));

runStep('1/5 repo guardrails', process.execPath, ['scripts/check-repo-guardrails.mjs']);
runStep('2/5 unit, CLI, UI, and sync tests', process.execPath, ['--test', ...unitTestFiles]);
runStep('3/5 rounds web behavior tests', process.execPath, ['--test', 'verification/rounds-web-behavior.mjs']);
runStep('4/5 deploy UI tests', process.execPath, ['--test', 'verification/deploy-ui.test.mjs']);

if (skipShell) {
  process.stdout.write('\n==> 5/5 shell tests skipped (--skip-shell; enforced on Linux CI)\n');
} else {
  const hasSh = spawnSync('sh', ['-c', 'exit 0'], { windowsHide: true }).status === 0;
  if (hasSh) {
    runStep('5/5 shell installer & skill registration tests', 'sh', ['tests/install-dependencies.test.sh']);
    runStep('5/5 workspace skill registration test', 'sh', ['tests/register-workspace-skills.test.sh']);
  } else if (requireShell) {
    process.stderr.write('ERROR: --require-shell specified, but POSIX `sh` is not available in PATH.\n');
    process.exit(1);
  } else {
    process.stdout.write('\n==> 5/5 shell tests skipped (POSIX `sh` not in PATH; enforced on Linux CI)\n');
  }
}

process.stdout.write('\nPASS: all checks succeeded\n');
