// src/foundation/kernel/keep.ts
import { dev, warn } from "./dev-stub.js";
var lifecycles = /* @__PURE__ */ new WeakMap();
var making;
var deferring = false;
var destroying = 0;
function whileDestroying(run) {
  destroying++;
  try {
    run();
  } finally {
    destroying--;
  }
}
var isDestroying = () => destroying > 0;
function withLifecycle(make) {
  const outer = making;
  const lifecycle = { starts: [] };
  making = lifecycle;
  let instance;
  try {
    instance = make();
  } finally {
    making = outer;
  }
  lifecycles.set(instance, lifecycle);
  if (outer) {
    outer.starts.push(() => {
      keep(instance);
      return () => release(instance);
    });
  } else if (!deferring && typeof document !== "undefined") {
    keep(instance);
  }
  return instance;
}
function unwatched(make) {
  const outer = deferring;
  deferring = true;
  try {
    return make();
  } finally {
    deferring = outer;
  }
}
function whenKept(start) {
  if (making) {
    making.starts.push(start);
  } else if (dev) {
    warn(
      "`whenKept` runs only while an instance is made, so this work never starts."
    );
  }
}
function extendLifecycle(instance, run) {
  const outer = making;
  const added = { starts: [] };
  making = added;
  try {
    run();
  } finally {
    making = outer;
  }
  const lifecycle = lifecycles.get(instance);
  if (!lifecycle) {
    return;
  }
  lifecycle.starts.push(...added.starts);
  for (const start of lifecycle.stops ? added.starts : []) {
    const stop = start();
    if (stop) {
      lifecycle.stops.push(stop);
    }
  }
}
function keep(instance) {
  const lifecycle = lifecycles.get(instance);
  if (!lifecycle || lifecycle.stops) {
    return;
  }
  const stops = lifecycle.stops = [];
  for (const start of lifecycle.starts) {
    const stop = start();
    if (stop) {
      stops.push(stop);
    }
  }
}
function release(instance) {
  const lifecycle = lifecycles.get(instance);
  const stops = lifecycle?.stops;
  if (!stops) {
    return;
  }
  lifecycle.stops = void 0;
  stops.forEach((stop) => stop());
}
function discard(instance) {
  release(instance);
  lifecycles.delete(instance);
}
export {
  discard,
  extendLifecycle,
  isDestroying,
  keep,
  release,
  unwatched,
  whenKept,
  whileDestroying,
  withLifecycle
};
