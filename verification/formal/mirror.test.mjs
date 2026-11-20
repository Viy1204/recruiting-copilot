import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const sourceRoot = process.env.FORMAL_SOURCE_ROOT || repoRoot;
const { BrowserMirror } = await import(pathToFileURL(path.join(sourceRoot, 'lib/index.js')));
const urls = {
  verification: 'https://www.zhipin.com/web/passport/zp/verify.html',
  restriction: 'https://www.zhipin.com/web/common/403.html',
};
const commands = ['verification', 'restriction', 'clear', 'maintenance'];
function* schedules(length, prefix = []) {
  if (!length) { yield prefix; return; }
  for (const command of commands) yield* schedules(length - 1, [...prefix, command]);
}

test('所有至多四步的风险、人工解除和维护事件保持熔断及首次依据', async () => {
  let checked = 0;
  for (let length = 0; length <= 4; length++) {
    for (const schedule of schedules(length)) {
      const mirror = new BrowserMirror({ name: '__formal_mirror__', port: 1, match: /fictional/ });
      let first = null, launches = 0;
      const commandsSent = [];
      mirror._ensureConnected = async () => false;
      mirror.launch = async () => { launches++; return { ok: true }; };
      mirror._command = async (method) => {
        commandsSent.push(method);
        return { result: { result: { value: JSON.stringify({ w: 960, h: 800 }) } } };
      };
      mirror.state.viewport = { width: 960, height: 800 };
      try {
        for (const command of schedule) {
          if (urls[command]) {
            first ??= urls[command];
            mirror._checkRiskUrl(urls[command]);
          }
          if (command === 'clear') { first = null; mirror.clearRisk(); }
          if (command === 'maintenance') {
            mirror.setWatch(true);
            mirror._everConnected = true;
            mirror._relaunchAt = 0;
            mirror.state.launching = false;
            launches = 0;
            await mirror.tick();
            assert.equal(launches, first ? 0 : 1, `FORMAL_MIRROR_NO_RECOVERY: ${schedule.join(' -> ')}`);
            mirror.requestFit(960, 800, 1);
            mirror._appliedFit = null;
            commandsSent.length = 0;
            await mirror._applyFit();
            const overrides = commandsSent.filter(method => method === 'Emulation.setDeviceMetricsOverride');
            assert.equal(overrides.length, first ? 0 : 1, `FORMAL_MIRROR_NO_FIT: ${schedule.join(' -> ')}`);
          }
          assert.equal(mirror.state.risk?.url || null, first, `FORMAL_MIRROR_FIRST_RISK: ${schedule.join(' -> ')}`);
        }
        checked++;
      } finally {
        mirror.dispose();
      }
    }
  }
  assert.equal(checked, 341);
});

test('风险在首条视口命令等待期间置位后，不应再派发新的还原写入', async () => {
  const mirror = new BrowserMirror({ name: '__formal_async_risk__', port: 1, match: /fictional/ });
  let release;
  const firstReply = new Promise(done => { release = done; });
  const writes = [];
  mirror._command = (method) => {
    writes.push({ method, riskAtDispatch: mirror.state.risk !== null });
    return writes.length === 1 ? firstReply : Promise.resolve({ result: {} });
  };
  const restoring = mirror._applyFit();
  mirror._checkRiskUrl(urls.verification);
  release({ result: {} });
  await restoring;
  assert.deepEqual(writes.filter(write => write.riskAtDispatch), [], 'FORMAL_MIRROR_ASYNC_RISK');
});

test('熔断中断的还原在人工解除后可重试，成功后不重复还原', async () => {
  const mirror = new BrowserMirror({ name: '__formal_restore_retry__', port: 1, match: /fictional/ });
  let release;
  const firstReply = new Promise(done => { release = done; });
  const writes = [];
  mirror._command = (method) => {
    writes.push(method);
    return writes.length === 1 ? firstReply : Promise.resolve({ result: {} });
  };
  const restoring = mirror._applyFit();
  mirror._checkRiskUrl(urls.verification);
  release({ result: {} });
  await restoring;
  assert.deepEqual(writes, ['Emulation.setDeviceMetricsOverride'], 'FORMAL_MIRROR_RESTORE_RETRY');
  mirror.clearRisk();
  await mirror._applyFit();
  assert.deepEqual(writes, [
    'Emulation.setDeviceMetricsOverride',
    'Emulation.setDeviceMetricsOverride',
    'Emulation.clearDeviceMetricsOverride',
  ], 'FORMAL_MIRROR_RESTORE_RETRY');
  await mirror._applyFit();
  assert.equal(writes.length, 3, 'FORMAL_MIRROR_RESTORE_ONCE');
});

test('还原等待期间重新请求相同贴合，中断后不会复用失效的旧覆盖', async () => {
  const mirror = new BrowserMirror({ name: '__formal_refit_after_abort__', port: 1, match: /fictional/ });
  let release;
  const restoreReply = new Promise(done => { release = done; });
  const widths = [];
  mirror._command = (method, params) => {
    if (method === 'Emulation.setDeviceMetricsOverride') {
      widths.push(params.width);
      if (params.width === 0) return restoreReply;
    }
    return Promise.resolve({ result: { result: { value: JSON.stringify({ w: 960, h: 800 }) } } });
  };
  mirror.requestFit(960, 800, 1);
  await mirror._applyFit();
  assert.equal(mirror.state.fitted, true);
  mirror.requestFit(0, 0);
  const restoring = mirror._applyFit();
  mirror._checkRiskUrl(urls.verification);
  mirror.requestFit(960, 800, 1);
  release({ result: {} });
  await restoring;
  assert.equal(mirror.state.fitted, false, 'FORMAL_MIRROR_REFIT_AFTER_ABORT');
  mirror.clearRisk();
  await mirror._applyFit();
  assert.deepEqual(widths, [960, 0, 960], 'FORMAL_MIRROR_REFIT_AFTER_ABORT');
  assert.equal(mirror.state.fitted, true, 'FORMAL_MIRROR_REFIT_AFTER_ABORT');
});
