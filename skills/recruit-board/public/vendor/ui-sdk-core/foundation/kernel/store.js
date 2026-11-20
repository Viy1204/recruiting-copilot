// src/foundation/kernel/store.ts
var changedInPlace = /* @__PURE__ */ new WeakSet();
function markChangedInPlace(list) {
  changedInPlace.add(list);
  return list;
}
function sameValue(a, b) {
  if (Object.is(a, b)) {
    return true;
  }
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) {
    return false;
  }
  if (changedInPlace.has(a) || changedInPlace.has(b)) {
    return false;
  }
  return a.every((item, index) => Object.is(item, b[index]));
}
var isPlainObject = (value) => {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};
function sameSlotState(a, b) {
  return sameWithin(a, b, void 0);
}
function sameWithin(a, b, open) {
  if (Object.is(a, b)) {
    return true;
  }
  const arrays = Array.isArray(a) && Array.isArray(b);
  if (!arrays && !(isPlainObject(a) && isPlainObject(b))) {
    return false;
  }
  if (open) {
    for (let index = 0; index < open.length; index += 2) {
      if (open[index] === a && open[index + 1] === b) {
        return true;
      }
    }
  }
  const within = open ?? [];
  within.push(a, b);
  try {
    if (arrays) {
      const left2 = a;
      const right2 = b;
      if (left2.length !== right2.length || changedInPlace.has(left2) || changedInPlace.has(right2)) {
        return false;
      }
      for (let index = 0; index < left2.length; index++) {
        if (!sameWithin(left2[index], right2[index], within)) {
          return false;
        }
      }
      return true;
    }
    const left = a;
    const right = b;
    const keys = Object.keys(left);
    if (keys.length !== Object.keys(right).length) {
      return false;
    }
    for (const key of keys) {
      if (!(key in right) || !sameWithin(left[key], right[key], within)) {
        return false;
      }
    }
    return true;
  } finally {
    within.length -= 2;
  }
}
function createStore(initial, live) {
  let state = initial;
  let renders2 = 0;
  let writes2 = 0;
  let followed;
  let merged;
  let reading = false;
  let viewed;
  const listeners = /* @__PURE__ */ new Set();
  const skipping = /* @__PURE__ */ new Map();
  let fanout;
  const store = {
    get() {
      return viewed ?? withFollowed();
    },
    // `delivered` marks keys `follow` already delivers, which parts that read
    // them through the framework skip.
    set(patch, delivered = false) {
      if (followed && !delivered && !reading) {
        const over = withFollowed();
        if (over !== state) {
          const rest = { ...over };
          for (const key in patch) {
            delete rest[key];
          }
          store.set(rest, true);
        }
      }
      const changed = [];
      for (const key in patch) {
        if (!sameValue(state[key], patch[key])) {
          changed.push(key);
        }
      }
      if (!changed.length) {
        return;
      }
      const previous = state;
      state = { ...state, ...patch };
      const liveOnly = changed.every((key) => live.includes(key));
      notify(changed, previous, liveOnly, delivered);
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    // The listeners of parts that select values, which `kernel/selects.ts` installs once.
    setFanout(next) {
      fanout = next;
    },
    // Keys `get()` reads from `read` from now on, ahead of `set`, like a
    // framework's props it hands over from an effect. `read` gets the state
    // the store holds.
    follow(read) {
      followed = read;
    },
    // Runs `read` with `get()` returning `next`, for state derived from state
    // the store doesn't hold yet, like what the framework is rendering.
    view(next, read) {
      const before = viewed;
      viewed = next;
      try {
        return read();
      } finally {
        viewed = before;
      }
    }
  };
  function withFollowed() {
    if (!followed || reading) {
      return state;
    }
    reading = true;
    let over;
    try {
      over = followed(state);
    } finally {
      reading = false;
    }
    if (!over) {
      return state;
    }
    if (merged?.state === state && merged.over === over) {
      return merged.result;
    }
    let result = state;
    for (const key in over) {
      if (!sameValue(state[key], over[key])) {
        result = { ...state, ...over };
        break;
      }
    }
    merged = { state, over, result };
    return result;
  }
  function notify(changed, previous, liveOnly, delivered) {
    if (!liveOnly) {
      renders2++;
    }
    if (!delivered) {
      writes2++;
    }
    const run = (listener) => listener(liveOnly, delivered, changed);
    listeners.forEach(run);
    for (const [skip, group] of skipping) {
      if (!changed.length || changed.some((key) => !Object.hasOwn(skip, key))) {
        group.forEach(run);
      }
    }
    fanout?.(changed, previous, run);
  }
  held.set(store, {
    state: () => state,
    renders: () => renders2,
    writes: () => writes2,
    touch: () => notify([], state, false, false),
    skipping
  });
  return store;
}
var held = /* @__PURE__ */ new WeakMap();
function subscribeSkipping(store, skip, listener) {
  return join(held.get(store).skipping, skip, listener);
}
function join(groups, group, listener) {
  let members = groups.get(group);
  if (!members) {
    groups.set(group, members = /* @__PURE__ */ new Set());
  }
  members.add(listener);
  return () => {
    members.delete(listener);
    if (!members.size && groups.get(group) === members) {
      groups.delete(group);
    }
  };
}
var heldState = (store) => held.get(store).state();
var writes = (store) => held.get(store).writes();
var renders = (store) => held.get(store).renders();
var standFor = (owner, store) => {
  held.set(owner, held.get(store));
};
var touch = (store) => held.get(store).touch();
export {
  createStore,
  heldState,
  isPlainObject,
  join,
  markChangedInPlace,
  renders,
  sameSlotState,
  sameValue,
  standFor,
  subscribeSkipping,
  touch,
  writes
};
