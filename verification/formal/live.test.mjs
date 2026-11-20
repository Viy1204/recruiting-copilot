import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const sourceRoot = process.env.FORMAL_SOURCE_ROOT || repoRoot;
const { createSnapshotController } = await import(pathToFileURL(path.join(sourceRoot, 'skills/recruit-board/public/live.mjs')));
const settle = async () => { for (let index = 0; index < 6; index++) await Promise.resolve(); };
const commands = ['resume', 'suspend', 'refresh', 'invalidate', 'resolve', 'timeout'];
function* schedules(length, prefix = []) {
  if (!length) { yield prefix; return; }
  for (const command of commands) yield* schedules(length - 1, [...prefix, command]);
}

test('所有至多五步的公开事件排列保持单飞，并丢弃暂停、失效、超时后的响应', async () => {
  let checked = 0;
  for (let length = 0; length <= 5; length++) {
    for (const schedule of schedules(length)) {
      const pending = [], timers = new Map(), violations = [];
      let timerId = 0, active = false;
      const controller = createSnapshotController({
        load(signal) {
          let resolve;
          const promise = new Promise(done => { resolve = done; });
          pending.push({ resolve, signal, obsolete: false, timedOut: false });
          if (pending.length > 1) violations.push('FORMAL_LIVE_SINGLE_FLIGHT');
          return promise;
        },
        onSnapshot(snapshot) {
          if (!active || snapshot.obsolete || snapshot.timedOut) violations.push('FORMAL_LIVE_OBSOLETE_PUBLICATION');
        },
        onError() {},
        setTimer(callback, delay) { const id = ++timerId; timers.set(id, { callback, delay }); return id; },
        clearTimer(id) { timers.delete(id); },
      });
      try {
        for (const command of schedule) {
          if (command === 'resume') { active = true; void controller.resume(); }
          if (command === 'suspend') {
            active = false;
            for (const request of pending) request.obsolete = true;
            controller.suspend();
          }
          if (command === 'refresh') void controller.refresh();
          if (command === 'invalidate') {
            if (active) for (const request of pending) request.obsolete = true;
            void controller.refresh({ invalidate: true });
          }
          if (command === 'resolve' && pending.length) {
            const request = pending.shift();
            request.resolve(request);
          }
          if (command === 'timeout') {
            const found = [...timers].find(([, timer]) => timer.delay === 6000);
            if (found) {
              if (active) for (const request of pending) if (!request.obsolete) request.timedOut = true;
              timers.delete(found[0]);
              found[1].callback();
            }
          }
          await settle();
          assert.equal(violations.length, 0, `${violations[0]}: ${schedule.join(' -> ')}`);
        }
        checked++;
      } finally {
        active = false;
        controller.suspend();
        for (const request of pending.splice(0)) request.resolve(request);
        await settle();
      }
    }
  }
  assert.equal(checked, 9331);
});
