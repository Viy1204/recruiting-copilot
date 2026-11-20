// src/foundation/drag-and-drop/reorder.ts
import { moveIndex, stepFor } from "../focus/collection.js";
import { announce } from "../platform/announce.js";
import { createAutoScroll } from "./auto-scroll.js";
import { bindDragPreview } from "./drag-preview.js";
import { createDraftMove } from "./draft-move.js";
import { isRTL } from "../platform/env.js";
import { createOrder } from "../kernel/order.js";
import { createDragSession, dragThreshold } from "./pointer.js";
import { labelOf } from "../text/typeahead.js";
import { isSameKeys } from "../selection/listbox-range.js";
function reorderMessage({
  type,
  label: name,
  count,
  position,
  total
}) {
  const at = `position ${position} of ${total}`;
  const label = count > 1 ? `${count} items` : name;
  if (type === "grab") {
    return `Picked up ${label}, ${at}.`;
  }
  if (type === "move") {
    return `${label}, ${at}.`;
  }
  if (type === "drop") {
    return `Dropped ${label} at ${at}.`;
  }
  return `Moved ${label} back to ${at}.`;
}
function dropIndex(middles, pointer, { reversed = false } = {}) {
  let index = 0;
  for (const middle of middles) {
    if (reversed ? middle > pointer : middle < pointer) {
      index++;
    }
  }
  return index;
}
function gridDropIndex(rects, point, { reversed = false } = {}) {
  let index = 0;
  for (const rect of rects) {
    const middle = (rect.left + rect.right) / 2;
    const passed = reversed ? point.x < middle : point.x > middle;
    if (point.y > rect.bottom || point.y >= rect.top && passed) {
      index++;
    }
  }
  return index;
}
function columnsOf(tops) {
  let count = 0;
  while (count < tops.length && Math.abs(tops[count] - tops[0]) < 1) {
    count++;
  }
  return Math.max(1, count);
}
function movedTo(order, key, index) {
  const keys = typeof key === "string" ? [key] : order.filter((item) => key.includes(item));
  const rest = order.filter((item) => !keys.includes(item));
  const to = Math.max(0, Math.min(rest.length, index));
  if (keys.every((item, i) => order[to + i] === item)) {
    return order;
  }
  rest.splice(to, 0, ...keys);
  return rest;
}
function gathered(order, key, keys) {
  const before = order.slice(0, order.indexOf(key)).filter((k) => !keys.includes(k)).length;
  return keys.length > 1 ? movedTo(order, keys, before) : [...order];
}
function createReorder(context, options) {
  const { store } = context;
  const items = createOrder();
  const orientation = () => options.orientation?.() ?? "vertical";
  const element = (key) => items.list().find((item) => item.key === key)?.el;
  const { draft, value, setDraft, focusLater, drop, cancel } = createDraftMove({
    store,
    draft: options.draft,
    value: options.key,
    shown: (current) => current.order,
    same: isSameKeys,
    rebase(current, now, moved) {
      if (!now.includes(current.key)) {
        return null;
      }
      const keys = now.filter((key) => current.keys.includes(key));
      const order = gathered(now, current.key, keys);
      if (!moved) {
        return { ...current, keys, order };
      }
      const at = current.order.indexOf(current.keys[0]);
      const index = current.order.slice(0, at).filter((key) => now.includes(key)).length;
      return { ...current, keys, order: movedTo(order, keys, index) };
    },
    commit: (current, details) => options.set(current.order, details),
    say: (type, current, order) => say(type, current.key, order, current.keys.length),
    element
  });
  function say(type, key, order, count = 1) {
    const el = element(key);
    const label = options.label?.(key) ?? (el ? labelOf(el) : key);
    const message = {
      type,
      key,
      label,
      count,
      position: order.indexOf(key) + 1,
      total: order.length
    };
    announce((options.message ?? reorderMessage)(message), {
      priority: "assertive"
    });
  }
  const isDisabled = (key) => {
    const item = items.list().find((entry) => entry.key === key);
    return !!item && !!options.disabled?.(item);
  };
  function grab(key, pointer) {
    const current = value();
    if (draft() || !current.includes(key) || isDisabled(key)) {
      return false;
    }
    const group = new Set(options.group?.(key) ?? []);
    const keys = current.filter(
      (k) => k === key || group.has(k) && !isDisabled(k)
    );
    const order = gathered(current, key, keys);
    setDraft({ key, keys, order, pointer });
    say("grab", key, order, keys.length);
    if (!pointer && keys.length > 1) {
      focusLater(key);
    }
    return true;
  }
  function moveTo(index) {
    const current = draft();
    if (!current) {
      return;
    }
    const order = movedTo(current.order, current.keys, index);
    if (order === current.order) {
      return;
    }
    setDraft({ ...current, order });
    say("move", current.key, order, current.keys.length);
    if (!current.pointer) {
      focusLater(current.key);
    }
  }
  function stepOf(key, rtl) {
    const kind = orientation();
    if (kind !== "grid") {
      return stepFor(key, kind, rtl);
    }
    if (key !== "ArrowUp" && key !== "ArrowDown") {
      return stepFor(key, "horizontal", rtl);
    }
    const columns = columnsOf(
      items.list().map(({ el }) => el.getBoundingClientRect().top)
    );
    return key === "ArrowUp" ? -columns : columns;
  }
  function indexAt(x, y) {
    const moving = draft()?.keys ?? [];
    const others = items.list().filter((item) => !moving.includes(item.key));
    const rects = others.map(({ el }) => el.getBoundingClientRect());
    const kind = orientation();
    const reversed = kind !== "vertical" && !!others[0] && isRTL(others[0].el);
    if (kind === "grid") {
      return gridDropIndex(rects, { x, y }, { reversed });
    }
    const vertical = kind === "vertical";
    const middles = rects.map(
      (rect) => vertical ? rect.top + rect.height / 2 : rect.left + rect.width / 2
    );
    return dropIndex(middles, vertical ? y : x, { reversed });
  }
  const drags = createDragSession(context.onDestroy);
  function follow(key, start) {
    let x = start.x;
    let y = start.y;
    const place = () => {
      const el = element(key);
      if (!el) {
        return;
      }
      el.style.setProperty(
        "--drag-x",
        `${x - start.x - (el.offsetLeft - start.left)}px`
      );
      el.style.setProperty(
        "--drag-y",
        `${y - start.y - (el.offsetTop - start.top)}px`
      );
    };
    const track = (pointerX, pointerY) => {
      x = pointerX;
      y = pointerY;
      reorder.moveTo(indexAt(x, y));
      place();
    };
    const view = element(key)?.ownerDocument.defaultView;
    let frame = 0;
    const unsubscribe = store.subscribe(() => {
      if (view && !frame) {
        frame = view.requestAnimationFrame(() => (frame = 0, place()));
      }
    });
    const stop = () => {
      unsubscribe();
      if (frame) {
        view?.cancelAnimationFrame(frame);
      }
      const el = element(key);
      el?.style.removeProperty("--drag-x");
      el?.style.removeProperty("--drag-y");
    };
    return { track, stop };
  }
  function float(key, el, start) {
    let x = start.x;
    let y = start.y;
    const preview = bindDragPreview(el, start);
    preview.el.removeAttribute("data-moving");
    preview.el.removeAttribute("data-dragging");
    const count = draft()?.keys.length ?? 1;
    if (count > 1) {
      preview.el.setAttribute("data-drag-count", String(count));
      preview.el.style.setProperty("--drag-count", String(count));
    }
    const scroller = options.createAutoScroll === false ? void 0 : createAutoScroll({
      ...options.createAutoScroll,
      ignore: () => element(key),
      onScroll: () => reorder.moveTo(indexAt(x, y))
    });
    const track = (pointerX, pointerY) => {
      x = pointerX;
      y = pointerY;
      preview.move(x, y);
      scroller?.update(x, y);
      reorder.moveTo(indexAt(x, y));
    };
    const stop = () => {
      scroller?.stop();
      preview.remove();
    };
    return { track, stop };
  }
  function pointerdown(event, key) {
    const el = element(key);
    if (!el || !drags.accepts(event) || draft()) {
      return;
    }
    const start = {
      x: event.clientX,
      y: event.clientY,
      left: el.offsetLeft,
      top: el.offsetTop
    };
    let drag;
    let lastMove;
    drags.start(el, event, {
      threshold: dragThreshold,
      cancelOnEscape: true,
      onStart: () => {
        if (!grab(key, true)) {
          return false;
        }
        drag = options.preview ? float(key, el, start) : follow(key, start);
      },
      onMove: ({ x, y, event: moveEvent }) => {
        moveEvent.preventDefault();
        lastMove = moveEvent;
        drag?.track(x, y);
      },
      onEnd: (endEvent, canceled) => {
        if (!drag) {
          return;
        }
        drag.stop();
        drag = void 0;
        if (canceled) {
          cancel();
        } else {
          drop("drag", lastMove ?? endEvent);
        }
      }
    });
  }
  const reorder = {
    /** Joins a bound part to the list. Call it from the item slot's `bind` and return its cleanup. */
    bind(el, part) {
      return items.add({ key: part.key, el, props: part.props });
    },
    /** The order to render: the draft's while an item moves, else the value. Pure, so `state` and `attrs` can call it. */
    order(state) {
      return state[options.draft]?.order ?? state[options.key];
    },
    /** Whether an item is picked up, by itself or with its group. */
    moving(state, key) {
      return !!state[options.draft]?.keys.includes(key);
    },
    /** Whether a pointer is dragging the item, by itself or with its group. */
    dragging(state, key) {
      const current = state[options.draft];
      return !!current?.pointer && current.keys.includes(key);
    },
    /**
     * Handles a key pressed on an item and returns whether it did. Space or
     * Enter picks the item up; while it's up, arrows, Home and End move it,
     * Space or Enter drops it, Escape puts it back and Tab puts it back and
     * moves on. Every other key is swallowed while an item is up, so pass
     * keys on only when this returns `false`.
     */
    keydown(event, key) {
      const current = draft();
      if (event.defaultPrevented || current?.pointer) {
        return !!current;
      }
      const modified = event.altKey || event.ctrlKey || event.metaKey;
      if (!current) {
        if (modified || event.key !== " " && event.key !== "Enter" || !grab(key, false)) {
          return false;
        }
        event.preventDefault();
        return true;
      }
      if (event.key === "Tab") {
        cancel(false);
        return true;
      }
      const target = event.target instanceof HTMLElement ? event.target : void 0;
      const step = modified ? void 0 : stepOf(event.key, !!target && isRTL(target));
      if (step !== void 0) {
        event.preventDefault();
        const index = current.order.indexOf(current.keys[0]);
        const count = current.order.length - current.keys.length + 1;
        const off = typeof step === "number" && Math.abs(step) > 1 && (index + step < 0 || index + step >= count);
        if (!off) {
          moveTo(moveIndex(index, step, count, false));
        }
      } else if (event.key === " " || event.key === "Enter") {
        event.preventDefault();
        drop("move-key", event);
      } else if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        cancel();
      }
      return true;
    },
    /** Starts a pointer drag of an item once the pointer moves a few pixels, so a click stays a click. */
    pointerdown,
    /** Picks an item up, as Space does. Returns whether it did. */
    grab: (key) => grab(key, false),
    /** Moves the picked-up item to `index` in the draft, counting from 0. */
    moveTo,
    /** Drops the picked-up item where it is, committing the draft. */
    drop: (event) => drop("move-key", event),
    /** Puts the picked-up item back where it was. */
    cancel: () => cancel(),
    /** Moves an item to `index` at once, like a "Move to top" menu item. Returns whether it went through. */
    move(key, index) {
      const order = value();
      if (!order.includes(key)) {
        return false;
      }
      const next = movedTo(order, key, index);
      if (next === order) {
        return false;
      }
      if (!options.set(next, { reason: "imperative" })) {
        return false;
      }
      say("drop", key, next);
      return true;
    }
  };
  return reorder;
}
export {
  columnsOf,
  createReorder,
  dropIndex,
  gridDropIndex,
  movedTo,
  reorderMessage
};
