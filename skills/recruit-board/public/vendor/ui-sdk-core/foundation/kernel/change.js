// src/foundation/kernel/change.ts
import {
  checkEvent,
  checkPrevented,
  dev,
  emit,
  expectControlled,
  forgetControlled,
  heardControlled
} from "./dev-stub.js";
import {
  createDetails,
  resolveSource,
  withSource
} from "./details.js";
import { callbackName } from "./option-names.js";
import { sameValue } from "./store.js";
import { watchers } from "./watchers.js";
function debug(context, key, value, reason, source) {
  if (dev && context.options().debug) {
    console.debug(
      `[ui-sdk] ${context.label}#${context.id} ${key}: ${String(value)} (${reason}, ${source})`
    );
  }
}
function changeFrom(context, source) {
  const { store, options } = context;
  const requested = /* @__PURE__ */ new Map();
  const asked = /* @__PURE__ */ new Map();
  const changing = /* @__PURE__ */ new Map();
  context.onOptions((next, synced) => {
    if (dev) {
      heardControlled(requested, next);
    }
    if (!synced) {
      return;
    }
    let source2;
    for (const [key, entry] of requested) {
      if (!(key in synced)) {
        continue;
      }
      if (sameValue(synced[key], entry.value)) {
        source2 = entry.source;
      }
      requested.delete(key);
    }
    return source2;
  });
  if (dev) {
    context.onDestroy(() => forgetControlled(requested));
  }
  return (key, value, details) => {
    if (changing.has(key) && sameValue(changing.get(key), value)) {
      return false;
    }
    const ask = (asked.get(key) ?? 0) + 1;
    asked.set(key, ask);
    const previous = store.get()[key];
    if (sameValue(previous, value)) {
      return false;
    }
    const { reason, event } = details;
    const callbackDetails = createDetails(
      details,
      details.source ?? source(reason, event)
    );
    if (dev) {
      checkEvent(reason, event, { component: context.label, id: context.id });
    }
    debug(context, key, value, reason, callbackDetails.source);
    const current = options();
    const isControlled = current[key] !== void 0;
    const outer = changing.has(key);
    const outerValue = changing.get(key);
    changing.set(key, value);
    try {
      withSource(callbackDetails.source, () => {
        const name = callbackName(key, "Change");
        const callback = current[name];
        if (typeof callback === "function") {
          const prevented = dev && !!event?.defaultPrevented;
          callback(value, callbackDetails);
          if (dev) {
            checkPrevented(name, prevented, callbackDetails, {
              component: context.label,
              id: context.id
            });
          }
        }
        const askedInside = asked.get(key) !== ask;
        if (!callbackDetails.canceled && !isControlled && !askedInside) {
          store.set({ [key]: value });
        }
      });
    } finally {
      if (outer) {
        changing.set(key, outerValue);
      } else {
        changing.delete(key);
      }
    }
    if (dev) {
      emit({
        type: "change",
        component: context.label,
        id: context.id,
        key,
        value,
        reason,
        source: callbackDetails.source,
        canceled: callbackDetails.canceled,
        controlled: isControlled
      });
    }
    if (callbackDetails.canceled) {
      return false;
    }
    watchers.change?.(context.id, key, value, callbackDetails, previous);
    if (isControlled) {
      requested.set(key, { value, source: callbackDetails.source });
      if (dev) {
        expectControlled(
          requested,
          {
            component: context.label,
            id: context.id,
            key,
            value,
            reason,
            source: callbackDetails.source
          },
          () => options()[key]
        );
      }
    }
    return true;
  };
}
function log(context, key, value, details) {
  const source = details.source ?? resolveSource(details.reason);
  if (dev) {
    emit({
      type: "change",
      component: context.label,
      id: context.id,
      key,
      value,
      reason: details.reason,
      source,
      canceled: false,
      controlled: false
    });
  }
  debug(context, key, value, details.reason, source);
}
export {
  changeFrom,
  log
};
