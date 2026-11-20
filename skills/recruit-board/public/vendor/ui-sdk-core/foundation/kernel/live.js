// src/foundation/kernel/live.ts
import {
  attrs,
  authorOwned,
  liveAttrs,
  madeLabel,
  references,
  subscribe
} from "./part.js";
function live(read) {
  return {
    read,
    /**
     * Writes the attributes to `el` now and on every change the part hears.
     * Returns the cleanup, which removes them again.
     */
    attach(part, el) {
      const channel = `live:${part.id}`;
      const write = () => applyAttrs(el, liveAttrs(part), channel);
      write();
      const unsubscribe = subscribe(part, write);
      return () => {
        unsubscribe();
        applyAttrs(el, {}, channel);
      };
    }
  };
}
function direct(names) {
  const written = /* @__PURE__ */ new WeakMap();
  return {
    names,
    /** Keeps the attributes current on `el` on every change the part hears. Returns the cleanup. */
    attach: (part, el) => {
      let last = attrs(part);
      const own = written.get(el) ?? /* @__PURE__ */ new Map();
      written.set(el, own);
      for (const [name, value] of own) {
        if (last[name] === void 0 && el.getAttribute(name) === value) {
          el.removeAttribute(name);
        }
      }
      own.clear();
      const update = () => {
        const values = attrs(part);
        for (const name of names) {
          const value = values[name];
          if (value === void 0) {
            if (last[name] !== void 0 && el.getAttribute(name) === last[name]) {
              el.removeAttribute(name);
            }
            continue;
          }
          const current = el.getAttribute(name);
          if (current === value) {
            continue;
          }
          if (authorOwned.has(name) && current !== null && current !== last[name]) {
            continue;
          }
          el.setAttribute(name, value);
          own.set(name, value);
        }
        last = values;
      };
      update();
      return subscribe(part, update);
    }
  };
}
var applied = /* @__PURE__ */ new WeakMap();
var found = /* @__PURE__ */ new WeakMap();
var writing;
function applyAttrs(el, attrs2, channel = "render") {
  writeAttrs(el, attrs2, channel, false);
}
function releaseAttrs(el, channel) {
  writeAttrs(el, {}, channel, true);
}
function markAuthored(el, name) {
  if (el === writing) {
    return;
  }
  for (const written of Object.values(applied.get(el) ?? {})) {
    written.delete(name);
  }
  for (const values of Object.values(found.get(el) ?? {})) {
    values.delete(name);
  }
}
function writeAttrs(el, attrs2, channel, release) {
  const outer = writing;
  writing = el;
  try {
    writeChannel(el, attrs2, channel, release);
  } finally {
    writing = outer;
  }
}
function writeChannel(el, attrs2, channel, release) {
  const channels = applied.get(el) ?? {};
  const previous = channels[channel] ?? /* @__PURE__ */ new Map();
  const written = /* @__PURE__ */ new Map();
  const styles = attrs2.style === void 0 ? [] : styleDeclarations(attrs2.style);
  for (const [property, value] of styles) {
    written.set(`style:${property}`, value);
  }
  for (const [name, value] of Object.entries(attrs2)) {
    if (value !== void 0 && name !== "style") {
      written.set(name, value);
    }
  }
  const id = written.has("id") || previous.has("id") ? el.getAttribute("id") : null;
  const keeps = keepsId(id, channels, channel);
  if (keeps) {
    written.delete("id");
  }
  const authors = /* @__PURE__ */ new Set();
  const read = /* @__PURE__ */ new Map();
  for (const name of /* @__PURE__ */ new Set([...written.keys(), ...previous.keys()])) {
    if (!authorOwned.has(name)) {
      continue;
    }
    const current = el.getAttribute(name);
    read.set(name, current);
    if (current === null || current === written.get(name) || name === "aria-labelledby" && madeLabel(current)) {
      continue;
    }
    if (!Object.values(channels).some((wrote) => wrote.get(name) === current)) {
      authors.add(name);
    }
  }
  for (const name of authors) {
    written.delete(name);
  }
  for (const name of previous.keys()) {
    if (written.has(name) || authors.has(name) || name === "id" && keeps) {
      continue;
    }
    if (name.startsWith("style:")) {
      el.style.removeProperty(name.slice(6));
      continue;
    }
    if (!release) {
      el.removeAttribute(name);
      keepFound(el, channel, name, null);
      continue;
    }
    const current = el.getAttribute(name);
    if (current !== previous.get(name)) {
      continue;
    }
    const original = found.get(el)?.[channel]?.get(name);
    if (original === void 0) {
      el.removeAttribute(name);
    } else if (current !== original) {
      el.setAttribute(name, original);
    }
  }
  for (const [property, value] of styles) {
    if (el.style.getPropertyValue(property) !== value) {
      el.style.setProperty(property, value);
    }
  }
  for (const [name, value] of Object.entries(attrs2)) {
    if (value === void 0 || !written.has(name)) {
      continue;
    }
    const current = name === "id" ? id : read.has(name) ? read.get(name) : el.getAttribute(name);
    if (current !== (previous.get(name) ?? null)) {
      keepFound(el, channel, name, current);
    }
    if (current === value) {
      continue;
    }
    if (name === "value" && isTextField(el) && el.value !== value) {
      el.value = value;
    }
    el.setAttribute(name, value);
  }
  channels[channel] = written;
  applied.set(el, channels);
  if (release) {
    delete found.get(el)?.[channel];
  }
}
function keepFound(el, channel, name, value) {
  const kept = value == null || name === "id" ? void 0 : references.includes(name) ? authoredIds(value) : value;
  if (kept === void 0) {
    return void found.get(el)?.[channel]?.delete(name);
  }
  let channels = found.get(el);
  if (!channels) {
    found.set(el, channels = {});
  }
  ;
  (channels[channel] ??= /* @__PURE__ */ new Map()).set(name, kept);
}
var authoredIds = (ids) => ids.split(/\s+/).filter((id) => id && !id.startsWith("ui-sdk-")).join(" ") || void 0;
function keepsId(id, channels, channel) {
  if (id === null || id === channels[channel]?.get("id")) {
    return false;
  }
  return !id.startsWith("ui-sdk-") || Object.values(channels).some((written) => written.get("id") === id);
}
var isTextField = (el) => el.localName === "textarea" || el.localName === "input" && el.type !== "file";
function styleDeclarations(css) {
  const declarations = [];
  for (const declaration of css.split(";")) {
    const index = declaration.indexOf(":");
    if (index > 0) {
      declarations.push([
        declaration.slice(0, index).trim(),
        declaration.slice(index + 1).trim()
      ]);
    }
  }
  return declarations;
}
export {
  applyAttrs,
  direct,
  live,
  markAuthored,
  releaseAttrs
};
