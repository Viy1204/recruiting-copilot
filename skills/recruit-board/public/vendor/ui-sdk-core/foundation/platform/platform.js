// src/foundation/platform/platform.ts
import { isBrowser } from "./env.js";
function supportsTopLayer() {
  return isBrowser && typeof HTMLElement.prototype.showPopover === "function";
}
function portalTarget(container) {
  if (container) {
    return container;
  }
  if (isBrowser && !supportsTopLayer()) {
    return document.body;
  }
  return null;
}
function activeElement(doc = document) {
  let active = doc.activeElement;
  while (active?.shadowRoot?.activeElement) {
    active = active.shadowRoot.activeElement;
  }
  return active;
}
function composedHops(node) {
  const hops = [node];
  let at = node;
  while (at) {
    const next = at.assignedSlot ?? at.parentNode ?? at.host;
    if (next && next !== at.parentNode) {
      hops.push(next);
    }
    at = next;
  }
  return hops;
}
function composedContains(container, node) {
  return composedHops(node).some((hop) => container.contains(hop));
}
function composedClosest(node, selector) {
  for (const hop of composedHops(node)) {
    const found = hop.closest?.(selector);
    if (found) {
      return found;
    }
  }
  return null;
}
function prefersReducedMotion() {
  return typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
}
var platformOverride;
function setPlatform(platform) {
  platformOverride = platform;
}
var apple;
function isApple() {
  if (platformOverride) {
    return platformOverride === "apple";
  }
  return apple ??= isBrowser && /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent);
}
function initialApple() {
  return platformOverride === "apple";
}
var keyNames = {
  alt: "Alt",
  option: "Alt",
  opt: "Alt",
  shift: "Shift",
  ctrl: "Control",
  control: "Control",
  cmd: "Meta",
  command: "Meta",
  meta: "Meta",
  backspace: "Backspace",
  delete: "Delete",
  del: "Delete",
  enter: "Enter",
  return: "Enter",
  escape: "Escape",
  esc: "Escape",
  tab: "Tab",
  space: "Space",
  up: "ArrowUp",
  down: "ArrowDown",
  left: "ArrowLeft",
  right: "ArrowRight",
  arrowup: "ArrowUp",
  arrowdown: "ArrowDown",
  arrowleft: "ArrowLeft",
  arrowright: "ArrowRight",
  home: "Home",
  end: "End",
  pageup: "PageUp",
  pagedown: "PageDown"
};
function ariaKeyshortcuts(shortcut, apple2 = isApple()) {
  return shortcut.split("+").map((key) => {
    const lower = key.toLowerCase();
    if (lower === "mod") {
      return apple2 ? "Meta" : "Control";
    }
    if (keyNames[lower]) {
      return keyNames[lower];
    }
    return key.length === 1 ? key.toUpperCase() : key[0].toUpperCase() + key.slice(1);
  }).join("+");
}
var appleGlyphs = {
  Meta: "\u2318",
  Control: "\u2303",
  Alt: "\u2325",
  Shift: "\u21E7",
  Backspace: "\u232B",
  Delete: "\u2326",
  Enter: "\u21A9",
  Escape: "\u238B",
  Tab: "\u21E5",
  Space: "\u2423",
  ArrowUp: "\u2191",
  ArrowDown: "\u2193",
  ArrowLeft: "\u2190",
  ArrowRight: "\u2192",
  PageUp: "\u21DE",
  PageDown: "\u21DF",
  Home: "\u2196",
  End: "\u2198"
};
var names = {
  Control: "Ctrl",
  Delete: "Del",
  Escape: "Esc",
  ArrowUp: "Up",
  ArrowDown: "Down",
  ArrowLeft: "Left",
  ArrowRight: "Right"
};
function formatShortcut(shortcut, apple2 = isApple()) {
  const keys = ariaKeyshortcuts(shortcut, apple2).split("+");
  const text = apple2 ? keys.map((key) => appleGlyphs[key] ?? key).join("") : keys.map((key) => names[key] ?? key).join("+");
  return `\u2066${text}\u2069`;
}
function matchesKey(event, key) {
  const typed = event.key.length === 1 ? event.key.toLowerCase() : event.key;
  if (key === "Space") {
    return typed === " ";
  }
  if (!/^[A-Z0-9]$/.test(key)) {
    return typed.toLowerCase() === key.toLowerCase();
  }
  if (typed === key.toLowerCase()) {
    return true;
  }
  if (/^[a-z0-9]$/.test(typed)) {
    return false;
  }
  return event.code === (/\d/.test(key) ? `Digit${key}` : `Key${key}`);
}
var parsed = [/* @__PURE__ */ new Map(), /* @__PURE__ */ new Map()];
function matchesShortcut(event, shortcut, apple2 = isApple()) {
  const cache = parsed[+apple2];
  let keys = cache.get(shortcut);
  if (!keys) {
    cache.set(shortcut, keys = ariaKeyshortcuts(shortcut, apple2).split("+"));
  }
  return matchesKey(event, keys.at(-1)) && event.metaKey === keys.includes("Meta") && event.ctrlKey === keys.includes("Control") && event.altKey === keys.includes("Alt") && event.shiftKey === keys.includes("Shift");
}
function hasCommandModifier(keys) {
  return /(^|\+)(Meta|Control|Alt)(\+|$)/.test(ariaKeyshortcuts(keys, true));
}
export {
  activeElement,
  ariaKeyshortcuts,
  composedClosest,
  composedContains,
  composedHops,
  formatShortcut,
  hasCommandModifier,
  initialApple,
  isApple,
  matchesShortcut,
  portalTarget,
  prefersReducedMotion,
  setPlatform,
  supportsTopLayer
};
