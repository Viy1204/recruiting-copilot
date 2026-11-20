// src/foundation/kernel/watchers.ts
import { whenKept } from "./keep.js";
var watchers = {};
var earlier = /* @__PURE__ */ new Set();
var watchLater = /* @__PURE__ */ new WeakMap();
function watchWhileKept(instance, parts, definition) {
  let unwatch;
  let waiting;
  const untrack = () => {
    unwatch?.();
    unwatch = void 0;
    if (waiting) {
      earlier.delete(waiting);
    }
    waiting = void 0;
  };
  whenKept(() => {
    if (watchers.add) {
      unwatch = watchers.add(instance, parts, definition);
    } else if (typeof document !== "undefined") {
      earlier.add(waiting = new WeakRef(instance));
      watchLater.set(
        instance,
        () => unwatch = watchers.add?.(instance, parts, definition)
      );
      if (earlier.size % 1e3 === 0) {
        for (const old of earlier) {
          if (!old.deref()) {
            earlier.delete(old);
          }
        }
      }
    }
    return untrack;
  });
}
function watchEarlier() {
  for (const ref of earlier) {
    earlier.delete(ref);
    const instance = ref.deref();
    if (instance) {
      watchLater.get(instance)?.();
    }
  }
}
export {
  watchEarlier,
  watchWhileKept,
  watchers
};
