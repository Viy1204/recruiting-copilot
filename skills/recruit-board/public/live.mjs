export function createSnapshotController({ load, onSnapshot, onError, isVisible = () => true, setTimer = setTimeout, clearTimer = clearTimeout, foregroundMs = 1000, hiddenMs = 10000, timeoutMs = 6000, maxBackoffMs = 10000 }) {
  let active = false, timer = null, flight = null, queued = null, generation = 0, failures = 0;

  function queueRead() {
    if (!queued) {
      let resolve;
      const promise = new Promise(done => { resolve = done; });
      queued = { promise, resolve };
    }
    return queued.promise;
  }

  function clearScheduled() {
    if (timer !== null) clearTimer(timer);
    timer = null;
  }

  function schedule() {
    const backoff = failures ? Math.min(maxBackoffMs, foregroundMs * 2 ** Math.min(failures - 1, 10)) : foregroundMs;
    timer = setTimer(() => { timer = null; void refresh(); }, isVisible() ? backoff : Math.max(hiddenMs, backoff));
  }

  function start() {
    const request = { generation, controller: new AbortController(), timedOut: false, promise: null };
    flight = request;
    const current = () => active && request.generation === generation;
    const timeout = setTimer(() => {
      if (!current()) return;
      request.timedOut = true;
      failures++;
      request.controller.abort();
      onError(new Error('看板读取超时，请重新连接'));
    }, timeoutMs);
    request.promise = (async () => {
      try {
        const next = await load(request.controller.signal);
        if (!current() || request.timedOut) return;
        failures = 0;
        onSnapshot(next);
      } catch (error) {
        if (!current() || request.timedOut) return;
        failures++;
        onError(error);
      } finally {
        clearTimer(timeout);
        if (flight === request) flight = null;
        if (active) {
          if (queued) { const waiting = queued; queued = null; start().then(waiting.resolve, waiting.resolve); }
          else schedule();
        }
      }
    })();
    return request.promise;
  }

  function refresh({ invalidate = false } = {}) {
    clearScheduled();
    if (!active) return Promise.resolve();
    if (flight) {
      if (!invalidate) return flight.promise;
      generation++;
      const waiting = queueRead();
      flight.controller.abort();
      return waiting;
    }
    return start();
  }

  function suspend() {
    active = false;
    generation++;
    queued?.resolve(); queued = null;
    clearScheduled();
    flight?.controller.abort();
  }

  function resume() {
    if (active) return refresh();
    active = true;
    if (flight) {
      return queueRead();
    }
    return refresh();
  }

  return { refresh, suspend, resume };
}
