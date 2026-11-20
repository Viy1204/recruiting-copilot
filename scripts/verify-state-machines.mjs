import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const formal = path.join(root, 'verification', 'formal');
const manifest = JSON.parse(await fs.readFile(path.join(formal, 'coverage.json'), 'utf8'));
for (const [name, record] of Object.entries(manifest.subsystems)) {
  if (typeof record === 'string') {
    manifest.subsystems[name] = JSON.parse(await fs.readFile(path.join(formal, record), 'utf8'));
  }
}
const args = process.argv.slice(2);
const mutate = args.includes('--mutations');
const selected = args.filter((arg) => arg !== '--mutations');
const targets = selected.length ? selected : Object.keys(manifest.subsystems);
for (const target of targets) {
  assert.ok(manifest.subsystems[target], `Unknown subsystem: ${target}`);
}

const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const jarHash = '936a262061c914694dfd669a543be24573c45d5aa0ff20a8b96b23d01e050e88';
const jarUrl = 'https://github.com/tlaplus/tlaplus/releases/download/v1.7.4/tla2tools.jar';
const toolCache = path.join(os.tmpdir(), 'recruiting-copilot-formal', 'tlc-1.7.4');
await fs.mkdir(toolCache, { recursive: true });
const jar = process.env.TLA2TOOLS || path.join(toolCache, 'tla2tools.jar');
let jarBytes;
try {
  jarBytes = await fs.readFile(jar);
} catch (error) {
  if (error.code !== 'ENOENT' || process.env.TLA2TOOLS) throw error;
  const download = await fs.mkdtemp(path.join(toolCache, 'download-'));
  try {
    const response = await fetch(jarUrl, { signal: AbortSignal.timeout(120000) });
    assert.ok(response.ok, `TLC download: HTTP ${response.status}`);
    jarBytes = Buffer.from(await response.arrayBuffer());
    assert.equal(digest(jarBytes), jarHash, 'TLC 1.7.4 checksum mismatch');
    const staged = path.join(download, 'tla2tools.jar');
    await fs.writeFile(staged, jarBytes, { flag: 'wx' });
    await fs.rename(staged, jar);
  } finally {
    await fs.rm(download, { recursive: true });
  }
}
assert.equal(digest(jarBytes), jarHash, 'TLC 1.7.4 checksum mismatch');

let java = process.env.JAVA || 'java';
let javaVersion = spawnSync(java, ['-version'], { encoding: 'utf8' });
if (javaVersion.error && !process.env.JAVA) {
  const located = spawnSync('mise', ['which', 'java', '--tool', 'java@temurin-25'], { encoding: 'utf8' });
  assert.equal(located.status, 0, 'Java unavailable: install Java 11+ or run mise install java@temurin-25');
  java = located.stdout.trim();
  javaVersion = spawnSync(java, ['-version'], { encoding: 'utf8' });
}
assert.equal(javaVersion.status, 0, javaVersion.error?.message || javaVersion.stderr);
console.log(`TLC 1.7.4; ${javaVersion.stderr.trim().split('\n')[0]}`);

const env = { ...process.env, FORMAL_SOURCE_ROOT: root };
delete env.NODE_TEST_CONTEXT;
const run = (command, argv, options = {}) => {
  const result = spawnSync(command, argv, {
    cwd: root,
    env,
    encoding: 'utf8',
    timeout: 90000,
    maxBuffer: 8 * 1024 * 1024,
    ...options,
  });
  if (result.error) throw result.error;
  return result;
};
const implementationResult = (result) => {
  const counts = Object.fromEntries([...result.stdout.matchAll(/^# (tests|pass|fail|cancelled|skipped|todo) (\d+)\r?$/gm)]
    .map(([, name, count]) => [name, Number(count)]));
  const passed = result.status === 0 && counts.tests > 0 && counts.pass === counts.tests
    && counts.fail === 0 && counts.cancelled === 0 && counts.skipped === 0 && counts.todo === 0;
  return { counts, passed };
};
const logs = await fs.mkdtemp(path.join(os.tmpdir(), 'recruit-formal-run-'));
let failed = false;
const summary = [];

for (const target of targets) {
  const area = manifest.subsystems[target];
  console.log(`\n${target}`);
  let drift = false;
  for (const source of area.sources) {
    const text = (await fs.readFile(path.join(root, source.path), 'utf8')).replaceAll('\r\n', '\n');
    const actual = digest(Buffer.from(text, 'utf8'));
    if (actual !== source.sha256) {
      drift = true;
      console.warn(`COVERAGE DRIFT: ${source.path}; review model against sync commit ${manifest.syncCommit}`);
    }
  }
  failed ||= drift;
  const tests = run(process.execPath, ['--test', '--test-reporter=tap', path.join(formal, area.contract)]);
  await fs.writeFile(path.join(logs, `${target}-implementation.out`), tests.stdout + tests.stderr);
  const model = path.join(formal, 'models', area.model);
  const tlc = run(java, [
    '-XX:+UseParallelGC', '-cp', jar, 'tlc2.TLC',
    '-workers', '1', '-fp', '0', '-lncheck', 'final',
    '-metadir', path.join(logs, `${target}-states`),
    '-config', model.replace(/\.tla$/, '.cfg'), model,
  ]);
  await fs.writeFile(path.join(logs, `${target}-tlc.out`), tlc.stdout + tlc.stderr);
  const stateCount = tlc.stdout.match(/([\d,]+) states generated, ([\d,]+) distinct states found/);
  const implementation = implementationResult(tests);
  const passed = implementation.passed && tlc.status === 0;
  console.log(`implementation ${implementation.passed ? 'PASS' : 'FAIL'}; model ${tlc.status === 0 ? 'PASS' : 'FAIL'}${stateCount ? `; ${stateCount[2]} distinct states` : ''}`);
  if (!implementation.passed) {
    process.stderr.write(tests.stdout + tests.stderr);
    console.error(`Implementation check incomplete: ${JSON.stringify(implementation.counts)}`);
  }
  if (tlc.status !== 0) process.stderr.write(tlc.stdout + tlc.stderr);
  failed ||= !passed;
  const caught = [];
  if (mutate && passed && !drift) {
    for (const mutation of area.mutations) {
      const scratch = await fs.mkdtemp(path.join(os.tmpdir(), `recruit-formal-${target}-`));
      try {
        for (const relative of manifest.scratchCopies) {
          await fs.cp(path.join(root, relative), path.join(scratch, relative), { recursive: true });
        }
        const sourceFile = path.join(scratch, mutation.file);
        const before = await fs.readFile(sourceFile, 'utf8');
        const canonical = before.replaceAll('\r\n', '\n');
        assert.equal(canonical.split(mutation.before).length - 1, 1, `Mutation no longer matches exactly once: ${mutation.name}`);
        const altered = canonical.replace(mutation.before, mutation.after);
        await fs.writeFile(sourceFile, before.includes('\r\n') ? altered.replaceAll('\n', '\r\n') : altered);
        const result = run(process.execPath, ['--test', '--test-reporter=tap', path.join(formal, area.contract)], {
          env: { ...env, FORMAL_SOURCE_ROOT: scratch },
        });
        await fs.writeFile(path.join(logs, `${target}-${mutation.name}.out`), result.stdout + result.stderr);
        const output = result.stdout + result.stderr;
        const baselineOutput = tests.stdout + tests.stderr;
        const detected = result.status === 1 && output.includes('ERR_ASSERTION')
          && output.includes(mutation.expect) && !baselineOutput.includes(mutation.expect);
        console.log(`mutation ${mutation.name}: ${detected ? 'CAUGHT' : 'MISSED'}`);
        failed ||= !detected;
        caught.push({ name: mutation.name, detected });
        if (!detected) process.stderr.write(result.stdout + result.stderr);
      } finally {
        await fs.rm(scratch, { recursive: true });
      }
    }
    const restored = run(process.execPath, ['--test', '--test-reporter=tap', path.join(formal, area.contract)]);
    await fs.writeFile(path.join(logs, `${target}-restored-implementation.out`), restored.stdout + restored.stderr);
    assert.ok(implementationResult(restored).passed, 'Baseline failed after scratch mutation');
  } else if (mutate) {
    console.log('mutation self-check skipped: resolve baseline failure or coverage drift first');
  }
  summary.push({ subsystem: target, coverageDrift: drift, implementation: tests.status, implementationTests: implementation.counts, implementationPassed: implementation.passed, tlc: tlc.status, states: stateCount?.[2], mutations: caught, knownFindings: area.knownFindings || [] });
}
await fs.writeFile(path.join(logs, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
console.log(`\nEvidence: ${logs}`);
process.exitCode = failed ? 1 : 0;
