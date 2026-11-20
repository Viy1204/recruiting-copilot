// src/foundation/kernel/selects.ts
import { view } from "./part.js";
import { join, subscribeSkipping } from "./store.js";
var isReader = (values) => typeof values === "object" && values !== null && !Array.isArray(values);
var narrowedStores = /* @__PURE__ */ new WeakMap();
function narrowedOf(store) {
  const found = narrowedStores.get(store);
  if (found) {
    return found;
  }
  const narrowed = {
    selectors: /* @__PURE__ */ new Map(),
    selecting: /* @__PURE__ */ new Map()
  };
  narrowedStores.set(store, narrowed);
  store.setFanout((changed, previous, run) => {
    const state = store.get();
    for (const key of changed) {
      const movers = narrowed.selecting.get(key);
      if (!movers) {
        continue;
      }
      const notify = (value) => narrowed.selectors.get(`${String(key)}:${value}`)?.forEach(run);
      const before = previous[key];
      for (const [moved, naming] of movers) {
        if (moved(before, state[key], notify) === true) {
          naming.forEach(run);
        }
      }
    }
  });
  return narrowed;
}
function selects(reads) {
  const narrowing = Object.entries(reads).filter(
    ([, values]) => isReader(values) || typeof values === "function" || values.length > 0
  );
  const valuesOf = (values, partView) => isReader(values) ? values.values(partView) : typeof values === "function" ? values(partView) : values;
  const selected = (part, props) => {
    const partView = view(part, props);
    return narrowing.map(
      ([key, values]) => [key, valuesOf(values, partView)]
    );
  };
  return {
    /**
     * The values a part reads each key it lists by, an empty list for a key it
     * never reads. A key it doesn't list, it reads whole.
     */
    reading(part, props) {
      const partView = view(part, props);
      return new Map(
        Object.entries(reads).flatMap(
          ([key, values]) => isReader(values) ? [] : [[key, valuesOf(values, partView)]]
        )
      );
    },
    /** The values a part selects on, which it subscribes again for when they change. */
    selection(part, props) {
      const values = selected(part, props);
      return values.length ? JSON.stringify(values) : "";
    },
    /**
     * Runs `listener` when a change can affect the part: a key it selects on
     * took or left one of its values, or any other key changed. Every part of
     * the slot skips the listed keys as one group.
     */
    subscribe(part, listener, props) {
      const cleanups = [subscribeSkipping(part.store, reads, listener)];
      for (const [key, values] of selected(part, props)) {
        const reader = reads[key];
        const moved = isReader(reader) ? reader.moved : eachMoved;
        cleanups.push(
          ...values.map(
            (value) => select(part.store, key, value, listener, moved)
          )
        );
        if (moved !== eachMoved) {
          cleanups.push(joinMover(part.store, key, moved, listener));
        }
      }
      return () => cleanups.forEach((cleanup) => cleanup());
    }
  };
}
function select(store, key, value, listener, moved = eachMoved) {
  const leaveMover = joinMover(store, key, moved, () => {
  });
  const leave = join(
    narrowedOf(store).selectors,
    `${String(key)}:${value}`,
    listener
  );
  return () => {
    leave();
    leaveMover();
  };
}
function joinMover(store, key, moved, listener) {
  const { selecting } = narrowedOf(store);
  let movers = selecting.get(key);
  if (!movers) {
    selecting.set(key, movers = /* @__PURE__ */ new Map());
  }
  const leave = join(movers, moved, listener);
  return () => {
    leave();
    if (!movers.size && selecting.get(key) === movers) {
      selecting.delete(key);
    }
  };
}
function eachMoved(before, after, notify) {
  if (before == null) {
    before = emptyLike(after, before);
  } else if (after == null) {
    after = emptyLike(before, after);
  }
  if (isRecord(before) && isRecord(after)) {
    for (const name in before) {
      if (!Object.hasOwn(after, name) || !Object.is(before[name], after[name])) {
        notify(name);
      }
    }
    for (const name in after) {
      if (!Object.hasOwn(before, name)) {
        notify(name);
      }
    }
    return;
  }
  if (!Array.isArray(before) || !Array.isArray(after)) {
    return [before, after].forEach(notify);
  }
  let start = 0;
  let end = 0;
  while (start < before.length && before[start] === after[start]) {
    start++;
  }
  while (end < before.length - start && end < after.length - start && before[before.length - 1 - end] === after[after.length - 1 - end]) {
    end++;
  }
  for (const values of [before, after]) {
    for (let index = start; index < values.length - end; index++) {
      notify(values[index]);
    }
  }
}
var isRecord = (value) => !!value && Object.getPrototypeOf(value) === Object.prototype;
var noItems = [];
var noEntries = {};
var emptyLike = (other, missing) => Array.isArray(other) ? noItems : isRecord(other) ? noEntries : missing;
export {
  eachMoved,
  select,
  selects
};
