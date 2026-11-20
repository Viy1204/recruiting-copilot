// src/foundation/kernel/part.ts
import { afterBind } from "./after-bind.js";
import { checkFocus, checkRole, dev, warn } from "./dev-stub.js";
import { enforceHidden } from "../platform/style.js";
import { isComposing, on } from "./events.js";
import { eachMoved } from "./selects.js";
import {
  renders,
  sameValue,
  subscribeSkipping,
  touch
} from "./store.js";
var ownerOf = (part) => part.owner;
var definitionOf = (part) => ownerOf(part).slots[part.slot];
var view = (part, props) => ({
  id: part.id,
  key: part.key,
  props,
  api: part.api
});
var context = (part, props = part.props) => ({
  el: part.el,
  id: part.id,
  key: part.key,
  props,
  store: part.store,
  api: part.api
});
function lease(part) {
  const { parts } = part.owner;
  const mapKey = `${part.slot}:${part.key}`;
  if (!parts.has(mapKey)) {
    parts.set(mapKey, part);
  }
  part.leases++;
  let held2 = true;
  return () => {
    if (!held2) {
      return;
    }
    held2 = false;
    if (--part.leases) {
      return;
    }
    const { owner } = part;
    if (!owner.released.length) {
      queueMicrotask(() => sweep(owner));
    }
    owner.released.push(part);
  };
}
function provisional(part) {
  const { owner } = part;
  if (!owner.released.length) {
    queueMicrotask(() => sweep(owner));
  }
  owner.released.push(part);
}
function sweep(owner) {
  for (const part of owner.released) {
    const mapKey = `${part.slot}:${part.key}`;
    if (!part.leases && owner.parts.get(mapKey) === part) {
      owner.parts.delete(mapKey);
    }
  }
  owner.released = [];
}
function attrs(part, props = part.props, state = part.store.get()) {
  const definition = definitionOf(part);
  const context2 = view(part, props);
  const own = definition.attrs?.(state, context2);
  const declared = definition.role;
  const role = typeof declared === "function" ? declared(state, context2) : declared;
  if (dev) {
    checkRole(
      definition,
      part.slot,
      own,
      role,
      { component: ownerOf(part).label, id: part.id },
      definition.live?.read(state, context2)
    );
  }
  const { name } = ownerOf(part);
  const result = {
    "data-slot": part.slot === "root" ? name : `${name}-${part.slot}`,
    ...declared === void 0 ? void 0 : { role },
    ...own
  };
  if (declared !== void 0) {
    result.role = role;
  }
  return aliased(part, result);
}
var authorOwned = /* @__PURE__ */ new Set([
  "aria-label",
  "aria-labelledby",
  "aria-description",
  "title",
  "autocomplete",
  "autocapitalize",
  "autocorrect",
  "spellcheck",
  "inputmode",
  "enterkeyhint"
]);
function yieldToAuthor(attrs2, given) {
  let result;
  for (const name in attrs2) {
    if (attrs2[name] !== void 0 && authorOwned.has(name) && given(name)) {
      ;
      (result ??= { ...attrs2 })[name] = void 0;
    }
  }
  return result ?? attrs2;
}
var madeLabel = (value) => typeof value === "string" && value.split(/\s+/).every((id) => id.startsWith("ui-sdk-"));
function partState(part, props = part.props, state = part.store.get()) {
  return definitionOf(part).state?.(state, view(part, props)) ?? {};
}
function present(part, props = part.props, state = part.store.get()) {
  return definitionOf(part).present?.(state, view(part, props)) ?? true;
}
function conditional(part) {
  return definitionOf(part).present !== void 0;
}
var held = (part) => part.leases > 0;
function liveAttrs(part, props = part.props) {
  return aliased(
    part,
    definitionOf(part).live?.read(part.store.get(), view(part, props)) ?? {}
  );
}
var directNames = (part) => definitionOf(part).direct?.names;
var selectedKeys = (part, props = part.props) => definitionOf(part).selects?.selection(part, props) ?? "";
function followed(part, synced, props = part.props) {
  const reads = definitionOf(part).selects?.reading(part, props);
  const names = ["#keys"];
  for (const key in synced) {
    const values = reads?.get(key);
    if (!values) {
      names.push(key);
    } else {
      for (const value of values) {
        names.push(`${key}:${value}`);
      }
    }
  }
  return names;
}
function touched(previous = {}, next = {}, notify) {
  let keys = false;
  for (const key in previous) {
    if (!(key in next)) {
      keys = true;
    }
  }
  for (const key in next) {
    if (!(key in previous)) {
      keys = true;
    } else if (sameValue(previous[key], next[key])) {
      continue;
    }
    notify(key);
    eachMoved(previous[key], next[key], (value) => notify(`${key}:${value}`));
  }
  if (keys) {
    notify("#keys");
  }
}
var skipNone = {};
function subscribe(part, listener, props = part.props) {
  const narrowed = definitionOf(part).selects;
  const cleanups = [
    lease(part),
    narrowed ? narrowed.subscribe(part, listener, props) : subscribeSkipping(part.store, skipNone, listener)
  ];
  return () => cleanups.forEach((cleanup) => cleanup());
}
function handlers(part) {
  const { on: events, press: activate } = definitionOf(part);
  const result = {};
  for (const type in events) {
    const handler = events[type];
    result[type] = (event) => {
      if (event.defaultPrevented || composing(event)) {
        return;
      }
      ownerOf(part).sleeping?.wake();
      handler(event, context(part));
    };
  }
  if (typeof activate === "function" && !result.click) {
    result.click = (event) => {
      if (!event.defaultPrevented) {
        ownerOf(part).sleeping?.wake();
        activate(context(part), event);
      }
    };
  }
  return result;
}
function commit(part, props) {
  if (part.props === props) {
    return;
  }
  part.props = props;
  propsRendered(part);
}
function propsRendered(part) {
  part.propsListeners?.forEach((listener) => listener());
}
function press(part, props = part.props) {
  const handler = definitionOf(part).press;
  return typeof handler === "function" ? () => {
    ownerOf(part).sleeping?.wake();
    handler(context(part, props));
  } : void 0;
}
function onProps(part, listener) {
  const listeners = part.propsListeners ??= /* @__PURE__ */ new Set();
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
var hidingSlots = /* @__PURE__ */ new WeakMap();
function canHide(part) {
  const definition = definitionOf(part);
  let hides = hidingSlots.get(definition);
  if (hides === void 0) {
    hides = !!definition.attrs && "hidden" in definition.attrs(part.store.get(), view(part, part.props));
    hidingSlots.set(definition, hides);
  }
  return hides;
}
function bind(part, el, host = { by: "core" }) {
  const kept = part;
  const { parts } = kept.owner;
  const mapKey = `${part.slot}:${part.key}`;
  if (!part.el && (parts.get(mapKey) ?? kept) === kept) {
    parts.delete(mapKey);
    parts.set(mapKey, kept);
  }
  if (dev) {
    checkShared(part, part.el, el);
    const { focus } = definitionOf(part);
    checkFocus(
      typeof focus === "function" ? focus(part.store.get(), view(part, part.props)) : focus,
      part.slot,
      el,
      {
        component: ownerOf(part).label,
        id: part.id
      }
    );
  }
  const binding = {};
  part.el = el;
  kept.binding = binding;
  const cleanups = [lease(kept)];
  if (canHide(part)) {
    enforceHidden(el.ownerDocument);
  }
  for (const [type, handler] of Object.entries(handlers(part))) {
    if (host.by === "core" || host.attaches !== "all" && !host.attaches.includes(type)) {
      cleanups.push(on(el, type, handler));
    }
  }
  const definition = definitionOf(part);
  if (definition.live) {
    cleanups.push(definition.live.attach(part, el));
  }
  if (host.by === "framework" && definition.direct) {
    cleanups.push(definition.direct.attach(part, el));
  }
  const early = definition.asleep?.(el, part);
  if (early) {
    cleanups.push(early);
  }
  const late = () => {
    const cleanup = definition.bind?.(el, part);
    if (cleanup) {
      cleanups.push(cleanup);
    }
  };
  const { sleeping } = kept.owner;
  if (sleeping && definition.bind) {
    sleeping.binds.add(late);
    cleanups.push(() => sleeping.binds.delete(late));
  } else {
    late();
  }
  if (definition.attrs && typeof MutationObserver !== "undefined") {
    cleanups.push(followId(kept, el));
  }
  return () => {
    cleanups.forEach((cleanup) => cleanup());
    if (kept.binding !== binding) {
      return;
    }
    part.el = kept.binding = void 0;
    if (kept.own !== void 0) {
      readIdLater(kept);
    }
  };
}
function checkShared(part, bound, el) {
  if (!part.key || !bound || bound === el) {
    return;
  }
  queueMicrotask(() => {
    if (part.el !== el || !bound.isConnected || !el.isConnected) {
      return;
    }
    const { parts, label } = ownerOf(part);
    for (const other of parts.values()) {
      if (other.el === bound) {
        return;
      }
    }
    warn(
      `two "${part.slot}" parts share the key "${part.key}". Give each an id or a unique value.`,
      {
        component: label,
        id: part.id
      }
    );
  });
}
function ref(part, host) {
  const kept = part;
  if (kept.ref) {
    return kept.ref;
  }
  let current = null;
  let unbind = () => {
  };
  return kept.ref = (el) => {
    if (el === current) {
      return;
    }
    if (dev && el) {
      checkShared(part, current, el);
    }
    unbind();
    current = el;
    unbind = el ? bind(part, el, host) : () => {
    };
  };
}
var connect = (part, el) => definitionOf(part).connect?.(el) ?? (() => {
});
var references = [
  "aria-activedescendant",
  "aria-controls",
  "aria-describedby",
  "aria-details",
  "aria-errormessage",
  "aria-flowto",
  "aria-labelledby",
  "aria-owns",
  "for",
  "headers"
];
var madeId = (part) => definitionOf(part).attrs?.(
  part.store.get(),
  view(part, { ...part.props, id: void 0 })
).id;
function aliased(part, attrs2) {
  const { owner } = part;
  if (!owner.named?.size || !references.some((name) => attrs2[name])) {
    return attrs2;
  }
  const aliases = aliasesOf(owner, part.store);
  if (!aliases.size) {
    return attrs2;
  }
  const result = { ...attrs2 };
  for (const name of references) {
    const ids = result[name];
    if (ids) {
      result[name] = ids.split(" ").map((id) => aliases.get(id) ?? id).join(" ");
    }
  }
  return result;
}
function aliasReferences(context2, attrs2) {
  for (const part of context2.parts()) {
    return aliased(part, attrs2);
  }
  return attrs2;
}
function aliasesOf(owner, store) {
  const version = renders(store);
  if (owner.aliases?.version === version) {
    return owner.aliases.map;
  }
  const map = /* @__PURE__ */ new Map();
  for (const part of owner.named) {
    const made = madeId(part);
    if (made !== void 0 && made !== part.own) {
      map.set(made, part.own);
    }
  }
  owner.aliases = { version, map };
  return map;
}
function followId(part, el) {
  if (el.hasAttribute("id") || part.own !== void 0) {
    readIdLater(part);
  }
  const observer = new MutationObserver(() => readIdLater(part));
  observer.observe(el, { attributeFilter: ["id"] });
  return () => observer.disconnect();
}
function readIdLater(part) {
  const { owner } = part;
  if (!owner.unread) {
    owner.unread = /* @__PURE__ */ new Set();
    afterBind(() => readIds(owner, part.store));
  }
  owner.unread.add(part);
}
function readIds(owner, store) {
  const parts = owner.unread;
  owner.unread = void 0;
  let renamed = owner.renamed === true;
  owner.renamed = void 0;
  for (const part of parts) {
    renamed = rename(part, part.el && idOf(part.el)) || renamed;
  }
  if (renamed) {
    touch(store);
  }
}
var idOf = (el) => el.localName === "form" ? el.getAttribute("id") : el.id;
function takeOwnId(part, id) {
  if (part.el || typeof id !== "string" || !definitionOf(part).attrs) {
    return;
  }
  if (rename(part, id)) {
    ownerOf(part).renamed = true;
  }
}
function rename(part, id) {
  const made = madeId(part);
  const own = id && id !== made ? id : void 0;
  if (own === part.own) {
    return false;
  }
  const { owner } = part;
  part.own = own;
  owner.named ??= /* @__PURE__ */ new Set();
  if (own === void 0) {
    owner.named.delete(part);
  } else {
    owner.named.add(part);
  }
  owner.aliases = void 0;
  return made !== void 0;
}
function composing(event) {
  return (event.type === "keydown" || event.type === "keyup") && isComposing(event);
}
export {
  aliasReferences,
  attrs,
  authorOwned,
  bind,
  commit,
  conditional,
  connect,
  directNames,
  followed,
  handlers,
  held,
  liveAttrs,
  madeLabel,
  onProps,
  partState,
  present,
  press,
  propsRendered,
  provisional,
  ref,
  references,
  selectedKeys,
  subscribe,
  takeOwnId,
  touched,
  view,
  yieldToAuthor
};
