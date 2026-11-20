// src/foundation/kernel/derive.ts
var derivations = /* @__PURE__ */ new WeakMap();
function register(store, derivation) {
  let list = derivations.get(store);
  if (!list) {
    derivations.set(store, list = []);
  }
  list.push(derivation);
}
function deriveFromOptions(context, keys, derive) {
  register(context.store, {
    from: "options",
    keys,
    derive
  });
}
function deriveState(context, keys, derive, { live = true } = {}) {
  const { store } = context;
  register(store, {
    from: "state",
    keys,
    derive
  });
  store.subscribe((liveOnly) => {
    if (liveOnly && !live) {
      return;
    }
    const patch = derive(store.get());
    if (patch) {
      store.set(patch);
    }
  });
}
function withDerived(store, options, synced, state) {
  const list = derivations.get(store);
  if (!list) {
    return synced;
  }
  let result = synced ?? {};
  for (const derivation of list) {
    if (!synced && derivation.from === "state") {
      continue;
    }
    const next = { ...state, ...result };
    const derived = derivation.from === "state" ? store.view(next, () => derivation.derive(next)) : derivation.derive(result, state, options);
    result = { ...result };
    for (const key of derivation.keys) {
      if (derived && key in derived) {
        result[key] = derived[key];
      } else if (derivation.from === "state") {
        result[key] = next[key];
      }
    }
  }
  return synced || Object.keys(result).length ? result : void 0;
}
export {
  deriveFromOptions,
  deriveState,
  withDerived
};
