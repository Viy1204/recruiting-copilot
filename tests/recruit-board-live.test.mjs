import test from 'node:test';
import assert from 'node:assert/strict';
import { createSnapshotController } from '../skills/recruit-board/public/live.mjs';

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function scheduler() {
  let now = 0, sequence = 0;
  const tasks = new Map();
  return {
    setTimer(callback, delay) {
      const id = ++sequence;
      tasks.set(id, { callback, at: now + delay });
      return id;
    },
    clearTimer(id) { tasks.delete(id); },
    advance(milliseconds) {
      const end = now + milliseconds;
      for (;;) {
        const next = [...tasks].filter(([, task]) => task.at <= end)
          .sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
        if (!next) break;
        const [id, task] = next;
        tasks.delete(id);
        now = task.at;
        task.callback();
      }
      now = end;
    }
  };
}

const settle = () => new Promise(resolve => setImmediate(resolve));

function fixture(t, options = {}) {
  const clock = scheduler(), requests = [], snapshots = [], errors = [];
  let activeLoads = 0, maxLoads = 0;
  const controller = createSnapshotController({
    load(signal) {
      const request = { signal, ...deferred() };
      requests.push(request);
      activeLoads++;
      maxLoads = Math.max(maxLoads, activeLoads);
      request.promise.then(() => { activeLoads--; }, () => { activeLoads--; });
      return request.promise;
    },
    onSnapshot(next) { snapshots.push(next); },
    onError(error) { errors.push(error); },
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    ...options
  });
  t.after(() => controller.suspend());
  return { controller, clock, requests, snapshots, errors, get maxLoads() { return maxLoads; } };
}

test('初始休眠；定时、focus 和手动刷新同刻到达时最多一个读取', async t => {
  const f = fixture(t);
  f.clock.advance(60000);
  assert.equal(f.requests.length, 0);
  const resumed = f.controller.resume();
  const focused = f.controller.resume();
  const refreshed = f.controller.refresh();
  for (const promise of [resumed, focused, refreshed]) assert.equal(typeof promise?.then, 'function');
  await settle();
  assert.equal(f.requests.length, 1);
  const first = { revision: 1 };
  f.requests[0].resolve(first);
  assert.deepEqual(await Promise.all([resumed, focused, refreshed]), [undefined, undefined, undefined]);
  assert.deepEqual(f.snapshots, [first]);
  f.clock.advance(999);
  assert.equal(f.requests.length, 1);
  f.clock.advance(1);
  const nextFocus = f.controller.resume();
  const nextRefresh = f.controller.refresh();
  await settle();
  assert.equal(f.requests.length, 2);
  assert.equal(f.maxLoads, 1);
  assert.equal(f.requests[1].signal.aborted, false);
  const second = { revision: 2 };
  f.requests[1].resolve(second);
  assert.deepEqual(await Promise.all([nextFocus, nextRefresh]), [undefined, undefined]);
  assert.deepEqual(f.snapshots, [first, second]);
  assert.deepEqual(f.errors, []);
});

test('加载中的多次手动刷新合并，完成后不补发额外读取', async t => {
  const f = fixture(t);
  const promises = [f.controller.resume()];
  f.clock.advance(400);
  for (let index = 0; index < 5; index++) promises.push(f.controller.refresh());
  f.clock.advance(400);
  await settle();
  assert.equal(f.requests.length, 1);
  assert.equal(f.requests[0].signal.aborted, false);
  const next = { revision: 1 };
  f.requests[0].resolve(next);
  assert.deepEqual(await Promise.all(promises), Array(6).fill(undefined));
  await settle();
  assert.equal(f.requests.length, 1);
  assert.deepEqual(f.snapshots, [next]);
  f.clock.advance(999);
  assert.equal(f.requests.length, 1);
  f.clock.advance(1);
  assert.equal(f.requests.length, 2);
  assert.equal(f.maxLoads, 1);
});

test('suspend 取消读取和定时，晚回数据不渲染，resume 恢复新快照与轮询', async t => {
  const f = fixture(t);
  const original = f.controller.resume();
  f.controller.suspend();
  assert.equal(f.requests[0].signal.aborted, true);
  f.clock.advance(60000);
  assert.equal(f.requests.length, 1);
  f.requests[0].resolve({ revision: 'obsolete' });
  assert.equal(await original, undefined);
  await settle();
  assert.deepEqual(f.snapshots, []);
  assert.deepEqual(f.errors, []);
  const resumed = f.controller.resume();
  assert.equal(f.requests.length, 2);
  const fresh = { revision: 'fresh' };
  f.requests[1].resolve(fresh);
  assert.equal(await resumed, undefined);
  assert.deepEqual(f.snapshots, [fresh]);
  f.clock.advance(1000);
  assert.equal(f.requests.length, 3);
  f.requests[2].resolve({ revision: 'poll' });
  await settle();
  f.controller.suspend();
  f.clock.advance(60000);
  assert.equal(f.requests.length, 3);
  assert.equal(f.maxLoads, 1);
  assert.deepEqual(f.errors, []);
});

test('suspend 后立即 resume 等旧读取结束；主动取消的晚回错误不报失败', async t => {
  const f = fixture(t);
  f.controller.resume();
  f.controller.suspend();
  const resumed = f.controller.resume();
  let completed = false;
  resumed.then(() => { completed = true; });
  f.controller.resume();
  f.controller.refresh();
  f.clock.advance(6000);
  await settle();
  assert.equal(f.requests.length, 1);
  assert.equal(completed, false);
  assert.deepEqual(f.errors, []);
  f.requests[0].reject(new Error('已取消的旧读取晚回错误'));
  await settle();
  assert.equal(f.requests.length, 2);
  assert.equal(completed, false);
  assert.deepEqual(f.snapshots, []);
  assert.deepEqual(f.errors, []);
  const fresh = { revision: 'resumed' };
  f.requests[1].resolve(fresh);
  assert.equal(await resumed, undefined);
  assert.equal(completed, true);
  assert.deepEqual(f.snapshots, [fresh]);
  assert.equal(f.maxLoads, 1);
});

test('resume 排队的新读取立即成功时仍只读一次', async t => {
  const original = deferred(), signals = [];
  const fresh = { revision: 'fast-resume' };
  const f = fixture(t, {
    load(signal) {
      signals.push(signal);
      return signals.length === 1 ? original.promise : Promise.resolve(fresh);
    }
  });
  f.controller.resume();
  f.controller.suspend();
  const resumed = f.controller.resume();
  assert.equal(signals.length, 1);
  assert.equal(signals[0].aborted, true);
  original.resolve({ revision: 'obsolete' });
  assert.equal(await resumed, undefined);
  await settle();
  assert.equal(signals.length, 2, '恢复排队的一轮成功后应等待下一次轮询');
  assert.deepEqual(f.snapshots, [fresh]);
  assert.deepEqual(f.errors, []);
});

test('保存后 invalidate 丢弃旧响应，多次失效只排队一次，Promise 等新轮完成', async t => {
  const f = fixture(t);
  f.controller.resume();
  const saved = f.controller.refresh({ invalidate: true });
  const savedAgain = f.controller.refresh({ invalidate: true });
  let completed = false;
  saved.then(() => { completed = true; });
  f.controller.refresh();
  assert.equal(f.requests[0].signal.aborted, true);
  assert.equal(f.requests.length, 1);
  f.requests[0].resolve({ revision: 'before-save' });
  await settle();
  assert.equal(f.requests.length, 2);
  assert.equal(completed, false);
  assert.deepEqual(f.snapshots, []);
  assert.deepEqual(f.errors, []);
  f.controller.resume();
  f.controller.refresh();
  assert.equal(f.requests.length, 2);
  const fresh = { revision: 'after-save' };
  f.requests[1].resolve(fresh);
  assert.deepEqual(await Promise.all([saved, savedAgain]), [undefined, undefined]);
  assert.equal(completed, true);
  assert.deepEqual(f.snapshots, [fresh]);
  f.clock.advance(999);
  assert.equal(f.requests.length, 2);
  f.clock.advance(1);
  assert.equal(f.requests.length, 3);
  assert.equal(f.maxLoads, 1);
});

test('invalidate 排队的新读取立即成功时不会再发第三次请求', async t => {
  const original = deferred(), signals = [];
  const fresh = { revision: 'fast-save' };
  const f = fixture(t, {
    load(signal) {
      signals.push(signal);
      return signals.length === 1 ? original.promise : Promise.resolve(fresh);
    }
  });
  f.controller.resume();
  const saved = f.controller.refresh({ invalidate: true });
  const savedAgain = f.controller.refresh({ invalidate: true });
  assert.equal(signals.length, 1);
  assert.equal(signals[0].aborted, true);
  original.resolve({ revision: 'before-save' });
  assert.deepEqual(await Promise.all([saved, savedAgain]), [undefined, undefined]);
  await settle();
  assert.equal(signals.length, 2, '保存后的排队刷新只能启动一轮');
  assert.deepEqual(f.snapshots, [fresh]);
  assert.deepEqual(f.errors, []);
});

test('超时 abort 并只报一次错误，调用方历史快照保留，下一轮恢复', async t => {
  let current = null;
  const f = fixture(t, { onSnapshot(next) { current = next; } });
  const initial = f.controller.resume();
  const previous = { revision: 'previous' };
  f.requests[0].resolve(previous);
  assert.equal(await initial, undefined);
  f.clock.advance(1000);
  const timedOut = f.controller.refresh();
  const request = f.requests[1];
  request.signal.addEventListener('abort', () => request.reject(new DOMException('Aborted', 'AbortError')));
  f.clock.advance(5999);
  assert.equal(request.signal.aborted, false);
  assert.deepEqual(f.errors, []);
  f.clock.advance(1);
  await settle();
  assert.equal(request.signal.aborted, true);
  assert.equal(f.errors.length, 1);
  assert.ok(f.errors[0] instanceof Error);
  assert.equal(current, previous);
  await timedOut.catch(() => {});
  f.clock.advance(999);
  assert.equal(f.requests.length, 2);
  f.clock.advance(1);
  assert.equal(f.requests.length, 3);
  const fresh = { revision: 'recovered' };
  f.requests[2].resolve(fresh);
  await settle();
  assert.equal(current, fresh);
  assert.equal(f.errors.length, 1);
  assert.equal(f.maxLoads, 1);
});

test('超时的读取不配合 abort 时保持单飞，晚回成功不覆盖快照', async t => {
  const f = fixture(t);
  const original = f.controller.resume();
  f.clock.advance(6000);
  await settle();
  assert.equal(f.requests[0].signal.aborted, true);
  assert.equal(f.errors.length, 1);
  f.controller.refresh();
  f.controller.resume();
  f.clock.advance(20000);
  assert.equal(f.requests.length, 1);
  assert.equal(f.errors.length, 1);
  f.requests[0].resolve({ revision: 'timed-out' });
  await original.catch(() => {});
  await settle();
  assert.deepEqual(f.snapshots, []);
  f.clock.advance(1000);
  assert.equal(f.requests.length, 2);
  const fresh = { revision: 'retry' };
  f.requests[1].resolve(fresh);
  await settle();
  assert.deepEqual(f.snapshots, [fresh]);
  assert.equal(f.maxLoads, 1);
});

test('连续失败按 1/2/4/8/10 秒有界退避，成功后恢复频率并重置失败计数', async t => {
  const f = fixture(t);
  f.controller.resume();
  const delays = [1000, 2000, 4000, 8000, 10000, 10000];
  for (const [index, delay] of delays.entries()) {
    const error = new Error(`合成读取失败 ${index + 1}`);
    f.requests[index].reject(error);
    await settle();
    assert.equal(f.errors[index], error);
    f.clock.advance(delay - 1);
    assert.equal(f.requests.length, index + 1, `第 ${index + 1} 次失败不能提前重试`);
    f.clock.advance(1);
    assert.equal(f.requests.length, index + 2, `第 ${index + 1} 次失败后应在 ${delay}ms 重试`);
  }
  const fresh = { revision: 'successful' };
  f.requests[6].resolve(fresh);
  await settle();
  assert.deepEqual(f.snapshots, [fresh]);
  f.clock.advance(999);
  assert.equal(f.requests.length, 7);
  f.clock.advance(1);
  assert.equal(f.requests.length, 8);
  f.requests[7].reject(new Error('恢复后的首次失败'));
  await settle();
  f.clock.advance(999);
  assert.equal(f.requests.length, 8);
  f.clock.advance(1);
  assert.equal(f.requests.length, 9);
  assert.equal(f.errors.length, 7);
  assert.equal(f.maxLoads, 1);
});

test('hidden 使用低频读取，恢复 focus 立即刷新并回到前台频率', async t => {
  let visible = false;
  const f = fixture(t, { isVisible: () => visible });
  const initial = f.controller.resume();
  f.requests[0].resolve({ revision: 1 });
  await initial;
  f.clock.advance(9999);
  assert.equal(f.requests.length, 1);
  f.clock.advance(1);
  assert.equal(f.requests.length, 2);
  f.requests[1].resolve({ revision: 2 });
  await settle();
  f.clock.advance(100);
  visible = true;
  const focused = f.controller.resume();
  const repeated = f.controller.resume();
  assert.equal(f.requests.length, 3);
  f.requests[2].resolve({ revision: 3 });
  assert.deepEqual(await Promise.all([focused, repeated]), [undefined, undefined]);
  f.clock.advance(999);
  assert.equal(f.requests.length, 3);
  f.clock.advance(1);
  assert.equal(f.requests.length, 4);
  assert.deepEqual(f.snapshots.map(snapshot => snapshot.revision), [1, 2, 3]);
  assert.equal(f.maxLoads, 1);
  assert.deepEqual(f.errors, []);
});

test('同步 onSnapshot 抛错后能继续轮询并交付下一次快照', async t => {
  const delivered = [];
  let calls = 0;
  const f = fixture(t, {
    onSnapshot(next) {
      if (++calls === 1) throw new Error('合成渲染回调失败');
      delivered.push(next);
    }
  });
  const initial = f.controller.resume().catch(() => {});
  f.requests[0].resolve({ revision: 1 });
  await initial;
  await settle();
  f.clock.advance(1000);
  assert.equal(f.requests.length, 2);
  const next = { revision: 2 };
  f.requests[1].resolve(next);
  await settle();
  assert.deepEqual(delivered, [next]);
  assert.equal(f.maxLoads, 1);
});

test('同步 onError 抛错后不永久停住，后续轮询仍能成功', async t => {
  let reported = 0;
  const f = fixture(t, {
    onError() {
      reported++;
      throw new Error('合成错误回调失败');
    }
  });
  const initial = f.controller.resume().catch(() => {});
  f.requests[0].reject(new Error('合成读取失败'));
  await initial;
  await settle();
  assert.equal(reported, 1);
  f.clock.advance(1000);
  assert.equal(f.requests.length, 2);
  const next = { revision: 'recovered' };
  f.requests[1].resolve(next);
  await settle();
  assert.deepEqual(f.snapshots, [next]);
  assert.equal(f.maxLoads, 1);
});
