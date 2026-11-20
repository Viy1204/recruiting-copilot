// src/foundation/kernel/primitive.ts
import {
  checkControlled,
  checkRoles,
  dev,
  emit,
  isMeasuring,
  warn,
  warnMissing
} from "./dev-stub.js";
import { connectController } from "./controller.js";
import { withDerived } from "./derive.js";
import { withSource } from "./details.js";
import {
  discard,
  extendLifecycle,
  whileDestroying,
  withLifecycle
} from "./keep.js";
import {
  propsRendered,
  provisional
} from "./part.js";
import { createStore, heldState, renders, sameValue, standFor } from "./store.js";
import { watchWhileKept } from "./watchers.js";
function definePrimitive(definition) {
  const slots = definition.slots((slot) => slot);
  const name = definition.name;
  const label = definition.label ?? name;
  if (dev) {
    checkRoles(slots, { component: label });
  }
  const make = (initialOptions) => {
    let options = initialOptions;
    const id = initialOptions.id;
    const store = createStore(
      { ...definition.state(options), ...definition.sync?.(options) },
      definition.live ?? []
    );
    const destroys = [];
    const optionsListeners = [];
    const from = { component: label, id };
    const controlled = dev ? (definition.controlled ?? ["open", "value", "checked"]).filter(
      (key) => key in store.get()
    ) : [];
    if (dev) {
      checkControlled(from, controlled, options);
    }
    const own = Object.create(
      dev ? warnMissing(slots, from) : slots
    );
    const used = /* @__PURE__ */ new Set();
    function use(feature) {
      if (used.has(feature)) {
        return;
      }
      used.add(feature);
      Object.assign(own, feature.slots);
      wake();
      feature.extend?.(api);
    }
    const owner = {
      name,
      label,
      slots: own,
      parts: /* @__PURE__ */ new Map(),
      released: []
    };
    const { parts } = owner;
    function keyOf(props = {}) {
      return props.id ?? (props.value == null ? "" : String(props.value));
    }
    let viewedParts;
    function part(slot, props = {}, rendering = false) {
      const key = keyOf(props);
      const mapKey = `${slot}:${key}`;
      let found = parts.get(mapKey);
      if (!found) {
        parts.set(
          mapKey,
          found = {
            slot,
            key,
            id,
            // Read when used, since an asleep instance builds its api later.
            get api() {
              return api;
            },
            store,
            props,
            el: void 0,
            owner,
            leases: 0
          }
        );
        if (rendering) {
          provisional(found);
        }
      } else if (rendering) {
        return found;
      }
      found.props = props;
      propsRendered(found);
      return found;
    }
    function element(slot, key) {
      if (key === void 0) {
        for (const part2 of parts.values()) {
          if (part2.slot === slot && part2.el?.isConnected) {
            return part2.el;
          }
        }
        return;
      }
      const el = parts.get(`${slot}:${key}`)?.el;
      return el?.isConnected ? el : void 0;
    }
    const context = {
      id,
      label,
      store,
      options: () => options,
      onOptions: (listener) => optionsListeners.push(listener),
      onDestroy: (cleanup) => destroys.push(cleanup),
      parts: () => parts.values(),
      element,
      props: (slot, key = "") => {
        const shown = viewedParts?.[slot];
        return shown && keyOf(shown) === key ? shown : parts.get(`${slot}:${key}`)?.props;
      }
    };
    let api = void 0;
    function build() {
      api = definition.api(context);
      connectController(context, api);
      if (dev) {
        for (const action of definition.agent?.actions ?? []) {
          if (typeof api[action] !== "function") {
            warn(
              `lists \`${action}\` in \`agent.actions\`, but its api has no such method.`,
              from
            );
          }
        }
      }
    }
    function wake() {
      const { sleeping } = owner;
      if (!sleeping) {
        return;
      }
      owner.sleeping = void 0;
      extendLifecycle(instance, build);
      for (const bind of [...sleeping.binds]) {
        bind();
      }
    }
    if (definition.asleep?.(options)) {
      owner.sleeping = { wake, binds: /* @__PURE__ */ new Set() };
    } else {
      build();
    }
    let handing = false;
    let following = false;
    let destroyed = false;
    const syncFrom = (options2, state) => withDerived(store, options2, definition.sync?.(options2), state);
    const instance = {
      // Type-only. Lets adapters read slot props, state and api types.
      types: void 0,
      name,
      id,
      get: store.get,
      subscribe: store.subscribe,
      get api() {
        wake();
        return api;
      },
      part,
      use,
      // The state `next` would make, or undefined when it makes none new, so
      // a framework can render a controlled value before it commits it.
      preview(next) {
        const synced = syncFrom({ ...next, id }, store.get());
        const current = store.get();
        for (const key in synced) {
          if (!sameValue(current[key], synced[key])) {
            return { ...current, ...synced };
          }
        }
      },
      // Runs `read` with `get()` returning `state`, and the api reading the
      // parts in `around` with the props given there, so a framework that
      // renders a preview reads the api, like a list's items or a radio
      // group's value, from it too.
      view(state, read, around) {
        const outer = viewedParts;
        viewedParts = around;
        try {
          return store.view(state, read);
        } finally {
          viewedParts = outer;
        }
      },
      setOptions(next) {
        const held = heldState(store);
        const arriving = next.id === id ? next : { ...next, id };
        const shown = dev && following ? syncFrom(arriving, held) : void 0;
        options = arriving;
        if (dev) {
          checkControlled(from, controlled, options);
        }
        if (owner.sleeping && !definition.asleep(options)) {
          wake();
        }
        const synced = syncFrom(options, held);
        if (dev && shown) {
          const torn = tornKeys(shown, synced);
          if (torn.length) {
            emit({ type: "relay", ...from, keys: torn });
          }
        }
        let source;
        handing = true;
        try {
          for (const listener of optionsListeners) {
            source = listener(options, synced) ?? source;
          }
          const landing = heldState(store) === held ? synced : syncFrom(options, heldState(store));
          if (landing) {
            withSource(source, () => store.set(landing, true));
          }
        } finally {
          handing = false;
        }
      },
      // The state a new instance with `next` would start at. The web adapter
      // reads a form reset's defaults from it when properties set before
      // connecting started an element elsewhere.
      startState: (next) => definition.state({ ...next, id }),
      // Reads the keys `sync` makes from `current`, a framework's props, from
      // now on: state has them the moment the props change, before
      // `setOptions` hands them over from an effect, and parts the framework
      // renders read them through it rather than hear the store. Pass the same
      // object while the props stay the same. Returns a read of what `sync`
      // makes of them. Given the options an earlier read had as `before`, it
      // reads what those make of the same state, so a framework tells what
      // the props changed from what state did.
      follow(current) {
        following = true;
        let last;
        let synced;
        const read = (state = heldState(store), before) => {
          if (before) {
            return syncFrom({ ...before, id }, state);
          }
          if (destroyed) {
            return synced;
          }
          const options2 = current();
          if (last?.options !== options2 || last.state !== state) {
            last = { options: options2, state };
            synced = syncFrom({ ...options2, id }, state);
          }
          return synced;
        };
        store.follow(read);
        if (dev) {
          store.subscribe((_, delivered, keys) => {
            if (handing && !delivered && !isMeasuring()) {
              emit({ type: "relay", ...from, keys: [...keys] });
            }
          });
        }
        return read;
      },
      // The instance left the page. Stops what it started outside itself for
      // good, then runs its `onDestroy` callbacks, which settle what waits on
      // it, like a popup's pending `open()`. Adapters call it once the
      // component unmounts, and a second call does nothing.
      destroy() {
        if (destroyed) {
          return;
        }
        destroyed = true;
        discard(instance);
        whileDestroying(() => destroys.forEach((cleanup) => cleanup()));
        if (dev) {
          emit({ type: "instance", action: "destroy", ...from, controlled });
        }
      }
    };
    standFor(instance, store);
    watchWhileKept(instance, parts, definition);
    if (dev) {
      emit({ type: "instance", action: "create", ...from, controlled });
    }
    return instance;
  };
  const create = (initialOptions) => withLifecycle(() => make(initialOptions));
  Object.defineProperty(create, "name", { value: name });
  return Object.assign(create, {
    options: definition.options,
    slots
  });
}
function tornKeys(shown, landed) {
  const before = shown;
  const after = landed ?? {};
  const keys = /* @__PURE__ */ new Set([...Object.keys(before), ...Object.keys(after)]);
  return [...keys].filter((key) => !sameValue(before[key], after[key]));
}
var schemas = /* @__PURE__ */ new WeakMap();
function schemaOf(primitive) {
  let schema = schemas.get(primitive);
  if (!schema) {
    const { options, slots = {} } = primitive;
    schema = {
      options: { debug: "boolean", ...options },
      slots: Object.fromEntries(
        Object.entries(slots).map(([slot, def]) => [
          slot,
          def.props ?? {}
        ])
      )
    };
    schemas.set(primitive, schema);
  }
  return schema;
}
var renderVersion = (instance) => renders(instance);
export {
  definePrimitive,
  renderVersion,
  schemaOf
};
