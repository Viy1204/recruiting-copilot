// src/foundation/platform/layers.ts
import { dev, emit } from "../kernel/dev-stub.js";
import { isComposing, on } from "../kernel/events.js";
import { composedContains, composedHops } from "./platform.js";
import { pressedScrollbar } from "./scrollbar.js";
var realm = globalThis[/* @__PURE__ */ Symbol.for("ui-sdk.layers@2")] ??= {
  stack: [],
  listening: /* @__PURE__ */ new Map()
};
function persistent() {
  return realm.persistent ??= /* @__PURE__ */ new Set();
}
function bindPersistentLayer(el) {
  persistent().add(el);
  const releases = active().flatMap(
    (layer) => layer.keep && el instanceof HTMLElement ? [layer.keep(el)] : []
  );
  const stopRaising = raiseAbovePopups(el.ownerDocument);
  return () => {
    persistent().delete(el);
    releases.forEach((release) => release());
    stopRaising();
  };
}
function inPersistentLayer(target) {
  for (const el of persistent()) {
    if (composedContains(el, target)) {
      return true;
    }
  }
  return false;
}
var raising = /* @__PURE__ */ new WeakMap();
function raiseAbovePopups(doc) {
  let entry = raising.get(doc);
  if (!entry) {
    const onToggle = (event) => {
      const opened = event.target;
      if (event.newState !== "open" || !(opened instanceof Element)) {
        return;
      }
      if (inPersistentLayer(opened)) {
        return;
      }
      for (const el of persistentLayers()) {
        if (el instanceof HTMLElement) {
          showAgain(el);
        }
      }
    };
    doc.addEventListener("toggle", onToggle, true);
    entry = {
      count: 0,
      off: () => doc.removeEventListener("toggle", onToggle, true)
    };
    raising.set(doc, entry);
  }
  const current = entry;
  current.count++;
  let done = false;
  return () => {
    if (done) {
      return;
    }
    done = true;
    if (--current.count > 0) {
      return;
    }
    current.off();
    raising.delete(doc);
  };
}
function showAgain(el) {
  if (!el.isConnected || !el.matches(":popover-open")) {
    return;
  }
  const focused = el.ownerDocument.activeElement;
  try {
    el.hidePopover();
    el.showPopover();
  } catch {
  }
  if (focused && focused !== el.ownerDocument.activeElement) {
    focused.focus({ preventScroll: true });
  }
}
function persistentLayers() {
  return [...persistent()].filter((el) => el.isConnected);
}
function layerCount() {
  return realm.pushed ?? 0;
}
function openedSince(order) {
  return active().some((layer) => (layer.order ?? 0) > order);
}
function active() {
  return realm.stack.filter((layer) => layer.active());
}
function activeLayers() {
  return active();
}
function lastEscape() {
  return realm.escapeAt ?? -Infinity;
}
function insideTree(layer, target, event) {
  return insideTreeAt(layer, composedHops(target), event);
}
function insideTreeAt(layer, hops, event) {
  if (hops.some((hop) => layer.contains(hop, event))) {
    return true;
  }
  return active().some(
    (other) => other.parent === layer && insideTreeAt(other, hops, event)
  );
}
function listen(doc, win) {
  let swallowClick = false;
  let touch;
  let pending;
  function plan(event, target, point) {
    const dismissed = [];
    let consume = false;
    if (inPersistentLayer(target)) {
      return { dismissed, consume };
    }
    for (const layer of [...realm.stack].reverse()) {
      if (layer.active()) {
        if (insideTree(layer, target, event)) {
          break;
        }
        if (layer.modal !== false) {
          consume = true;
        }
        dismissed.push(layer);
        if (layer.shield) {
          break;
        }
      } else if (layer.exiting?.()) {
        if (insideTree(layer, target, event)) {
          break;
        }
        if (layer.modal === false) {
          continue;
        }
        if (layer.overBackdrop?.(point.x, point.y)) {
          consume = true;
        }
        break;
      }
    }
    return { dismissed, consume };
  }
  function dismiss(event, target, point) {
    const { dismissed, consume } = plan(event, target, point);
    for (const layer of dismissed) {
      layer.onOutsidePress?.(event);
    }
    return consume;
  }
  const offPointerDown = on(
    win,
    "pointerdown",
    (event) => {
      swallowClick = false;
      const target = event.composedPath()[0];
      if (event.pointerType === "touch") {
        touch = { x: event.clientX, y: event.clientY, target };
        return;
      }
      touch = void 0;
      pending = void 0;
      if (pressedScrollbar(event, target)) {
        return;
      }
      const point = { x: event.clientX, y: event.clientY };
      const { dismissed, consume } = plan(event, target, point);
      if (dismissed[0]?.outsidePress === "click") {
        if (event.button !== 0) {
          return;
        }
        pending = { layer: dismissed[0], target, point };
        if (consume) {
          event.preventDefault();
          swallowClick = true;
        }
        return;
      }
      if (consume) {
        event.preventDefault();
        swallowClick = true;
      }
      for (const layer of dismissed) {
        layer.onOutsidePress?.(event);
      }
    },
    { capture: true }
  );
  const offPointerUp = on(
    win,
    "pointerup",
    (event) => {
      const press = pending;
      pending = void 0;
      if (!press || !press.layer.active()) {
        return;
      }
      if (insideTree(press.layer, event.composedPath()[0], event)) {
        return;
      }
      dismiss(event, press.target, press.point);
    },
    { capture: true }
  );
  const offClick = on(
    win,
    "click",
    (event) => {
      if (swallowClick && event.detail) {
        swallowClick = false;
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      swallowClick = false;
      if (!touch) {
        return;
      }
      const press = touch;
      touch = void 0;
      if (Math.hypot(event.clientX - press.x, event.clientY - press.y) > 10) {
        return;
      }
      if (dismiss(event, press.target, { x: press.x, y: press.y })) {
        event.preventDefault();
        event.stopPropagation();
      }
    },
    { capture: true }
  );
  const offKey = on(doc, "keydown", (event) => escapeTop(doc, event));
  const offBlur = on(win, "blur", (event) => {
    for (const layer of active().reverse()) {
      layer.onBlur?.(event);
    }
  });
  return () => {
    offPointerDown();
    offPointerUp();
    offKey();
    offBlur();
    if (!swallowClick) {
      return offClick();
    }
    const off = () => (offClick(), offNext(), offSwallowed());
    const offNext = on(win, "pointerdown", off, { capture: true });
    const offSwallowed = on(win, "click", off, { capture: true });
  };
}
function layerContains(layer, target) {
  return insideTree(layer, target);
}
function findLayer(target) {
  const hops = composedHops(target);
  return active().reverse().find((layer) => hops.some((hop) => layer.contains(hop)));
}
function markClosed(target) {
  realm.closed = target;
  setTimeout(() => {
    if (realm.closed === target) {
      realm.closed = void 0;
    }
  });
}
function lastClosed() {
  return realm.closed;
}
function report() {
  if (!dev) {
    return;
  }
  emit({
    type: "layers",
    stack: realm.stack.map((layer) => ({
      component: layer.component ?? "popup",
      id: layer.id ?? "",
      modal: layer.modal,
      blocking: !!layer.blocking,
      el: layer.el
    }))
  });
}
function listenIn(doc) {
  const win = doc.defaultView;
  if (!win) {
    return () => {
    };
  }
  let entry = realm.listening.get(doc);
  if (!entry) {
    realm.listening.set(doc, entry = { layers: 0, stop: listen(doc, win) });
  }
  const current = entry;
  current.layers++;
  return () => {
    if (--current.layers > 0) {
      return;
    }
    realm.listening.delete(doc);
    current.stop();
  };
}
function documentOf(layer) {
  return layer.el?.ownerDocument ?? document;
}
function escapeTop(doc, event, from) {
  if (event.key !== "Escape" || event.defaultPrevented || isComposing(event)) {
    return;
  }
  const top = active().filter((layer) => documentOf(layer) === doc).at(-1);
  if (!top?.onEscape || from && top !== from) {
    return;
  }
  realm.escapeAt = performance.now();
  top.onEscape(event);
}
function escapeLayer(layer, event) {
  escapeTop(documentOf(layer), event, layer);
}
function pushLayer(layer) {
  realm.pushed = (realm.pushed ?? 0) + 1;
  layer.order = realm.pushed;
  realm.stack.push(layer);
  const stopListening = listenIn(documentOf(layer));
  report();
  let popped = false;
  return () => {
    if (popped) {
      return;
    }
    popped = true;
    const index = realm.stack.indexOf(layer);
    if (index !== -1) {
      realm.stack.splice(index, 1);
    }
    stopListening();
    report();
  };
}
export {
  activeLayers,
  bindPersistentLayer,
  escapeLayer,
  findLayer,
  inPersistentLayer,
  lastClosed,
  lastEscape,
  layerContains,
  layerCount,
  markClosed,
  openedSince,
  persistentLayers,
  pushLayer
};
