import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

for (const scenario of [
  { name: '统一入口不受外部 FORMAL_SOURCE_ROOT 影响', externalSource: true },
  { name: '从 node:test 调用统一入口仍执行实现检查和突变', externalSource: false },
]) {
  test(scenario.name, async () => {
    const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'recruit-formal-runner-'));
    try {
      const source = path.join(scratch, 'skills/recruit-board/public/live.mjs');
      await fs.mkdir(path.dirname(source), { recursive: true });
      await fs.writeFile(source, "throw new Error('FORMAL_RUNNER_WRONG_SOURCE_ROOT');\n");
      const env = { ...process.env };
      if (scenario.externalSource) {
        env.FORMAL_SOURCE_ROOT = scratch;
        delete env.NODE_TEST_CONTEXT;
      } else {
        delete env.FORMAL_SOURCE_ROOT;
      }
      const result = spawnSync(process.execPath, ['scripts/verify-state-machines.mjs', 'live', '--mutations'], {
        cwd: repoRoot,
        env,
        encoding: 'utf8',
        timeout: 90000,
      });
      const output = result.stdout + result.stderr;
      assert.ifError(result.error);
      assert.equal(result.status, 0, output);
      assert.match(output, /implementation PASS; model PASS/);
      assert.match(output, /mutation publish-obsolete-response: CAUGHT/);
      assert.match(output, /mutation start-overlapping-read: CAUGHT/);
      assert.doesNotMatch(output, /FORMAL_RUNNER_WRONG_SOURCE_ROOT|being called recursively/);
      const evidence = output.match(/Evidence: (.+)/);
      assert.ok(evidence, output);
      const summary = JSON.parse(await fs.readFile(path.join(evidence[1].trim(), 'summary.json'), 'utf8'));
      assert.ok(summary[0].implementationTests.tests > 0);
      assert.equal(summary[0].implementationTests.pass, summary[0].implementationTests.tests);
    } finally {
      await fs.rm(scratch, { recursive: true });
    }
  });
}
