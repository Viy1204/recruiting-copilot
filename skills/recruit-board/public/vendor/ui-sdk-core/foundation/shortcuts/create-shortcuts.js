// src/foundation/shortcuts/create-shortcuts.ts
import { dev, warn } from "../kernel/dev-stub.js";
import {
  activeLayers,
  findLayer,
  inPersistentLayer
} from "../platform/layers.js";
import { isBrowser } from "../platform/env.js";
import {
  ariaKeyshortcuts,
  formatShortcut,
  hasCommandModifier,
  isApple,
  matchesShortcut
} from "../platform/platform.js";
import { inPopupElement } from "../popups/popup-elements.js";
import { isComposing, on } from "../kernel/events.js";
import { isShortcutAllowed, isTypingIn, shortcutOrder } from "./shortcut-order.js";
var keysOf = (entry) => (typeof entry.keys === "function" ? entry.keys() : entry.keys) || void 0;
function normalize(keys) {
  return ariaKeyshortcuts(keys, true).split("+").sort().join("+");
}
function createShortcuts() {
  const entries = [];
  const scopes = /* @__PURE__ */ new Set();
  let next = 0;
  let off;
  function topBlocking() {
    return activeLayers().filter((layer) => layer.blocking).at(-1)?.order;
  }
  function runnable(entry, blocking) {
    const { scope, when, layer } = entry.options;
    if (scope !== void 0 && !scopes.has(scope)) {
      return null;
    }
    if (when && !when()) {
      return null;
    }
    const order = shortcutOrder(
      layer,
      findLayer,
      inPersistentLayer,
      inPopupElement
    );
    return isShortcutAllowed(order, blocking) ? order : null;
  }
  function onKeydown(event) {
    if (event.defaultPrevented || isComposing(event)) {
      return;
    }
    let context;
    let best;
    const apple = isApple();
    for (const entry of entries) {
      const keys = keysOf(entry);
      if (!keys || event.repeat && !entry.options.repeat || !matchesShortcut(event, keys, apple)) {
        continue;
      }
      context ??= {
        typing: isTypingIn(event.composedPath()[0]),
        blocking: topBlocking()
      };
      if (context.typing && !entry.options.allowInInput && !hasCommandModifier(keys)) {
        continue;
      }
      const order = runnable(entry, context.blocking);
      if (order === null) {
        continue;
      }
      if (!best || order > best.order || order === best.order && entry.id > best.entry.id) {
        best = { entry, order };
      }
    }
    if (!best) {
      return;
    }
    event.preventDefault();
    best.entry.handler(event);
  }
  function listen() {
    if (off || !isBrowser) {
      return;
    }
    off = on(document, "keydown", onKeydown);
  }
  return {
    /**
     * Registers a shortcut, like `register("mod+k", openSearch)`. Keys are
     * `+`-separated: `mod` is Command on Apple platforms and Control elsewhere.
     * Returns a function that unregisters it.
     */
    register(keys, handler, options = {}) {
      const key = typeof keys === "string" ? normalize(keys) : void 0;
      const clash = dev && key !== void 0 && !options.when && entries.some(
        (entry2) => typeof entry2.keys === "string" && normalize(entry2.keys) === key && entry2.options.scope === options.scope && entry2.options.layer === options.layer && !entry2.options.when
      );
      if (clash) {
        warn(
          `The shortcut "${keys}" is registered twice in the same scope. The newest one wins.`
        );
      }
      const entry = { keys, handler, options, id: next++ };
      entries.push(entry);
      listen();
      return () => {
        const index = entries.indexOf(entry);
        if (index !== -1) {
          entries.splice(index, 1);
        }
        if (!entries.length) {
          off?.();
          off = void 0;
        }
      };
    },
    /** The shortcuts that would run now, oldest first, formatted for this platform. For a help screen. */
    list() {
      const blocking = isBrowser ? topBlocking() : void 0;
      const apple = isApple();
      return entries.filter(
        (entry) => !!keysOf(entry) && runnable(entry, blocking) !== null
      ).map((entry) => ({
        keys: keysOf(entry),
        hint: formatShortcut(keysOf(entry), apple),
        ariaKeyshortcuts: ariaKeyshortcuts(keysOf(entry), apple),
        description: entry.options.description,
        scope: entry.options.scope
      }));
    },
    /** Turns a named scope on or off. Shortcuts registered with that `scope` run only while it's on. */
    setScope(name, active) {
      if (active) {
        scopes.add(name);
      } else {
        scopes.delete(name);
      }
    },
    /** Whether a named scope is on. */
    isScopeActive: (name) => scopes.has(name),
    /** Unregisters every shortcut and stops listening. */
    destroy() {
      entries.length = 0;
      scopes.clear();
      off?.();
      off = void 0;
    }
  };
}
export {
  createShortcuts
};
