// src/foundation/focus/roving-focus.ts
import { afterBind } from "../kernel/after-bind.js";
import { moveIndex, rovingStop, stepFor } from "./collection.js";
import { isRTL } from "../platform/env.js";
import { createOrder } from "../kernel/order.js";
import { onProps } from "../kernel/part.js";
function createClaim() {
  let claimed;
  return (key, eligible) => {
    if (claimed === void 0 && eligible) {
      claimed = key;
    }
    return claimed === key;
  };
}
function createRovingFocus(context, options) {
  const { store } = context;
  const key = options.key;
  const remember = options.remember ?? true;
  const order = createOrder();
  const claim = createClaim();
  let remembered = null;
  let moving = false;
  const setStop = (itemKey) => {
    moving = true;
    store.set({ [key]: itemKey });
    moving = false;
  };
  let pending = null;
  let holder = null;
  const orientation = () => options.orientation?.() ?? "vertical";
  const isDisabled = (item) => options.disabled?.(item) ?? false;
  const isFocusable = (item) => options.focusable?.(item) ?? true;
  const isPreferred = (item) => options.preferred?.(item) ?? false;
  function stopFor(preferred = isPreferred) {
    const list = order.list();
    if (!list.length) {
      return;
    }
    if (pending && !list.some(({ part }) => part.key === pending.key && isFocusable(part))) {
      return;
    }
    const candidates = list.map(({ part }) => ({
      key: part.key,
      disabled: isDisabled(part),
      focusable: isFocusable(part),
      preferred: preferred(part)
    }));
    return rovingStop(candidates, remembered);
  }
  function check() {
    const stop2 = stopFor();
    if (stop2 !== void 0) {
      setStop(stop2);
    }
  }
  let queued = false;
  let joined = false;
  function queue(joinedOrLeft) {
    joined ||= joinedOrLeft;
    if (queued) {
      return;
    }
    queued = true;
    afterBind(() => {
      queued = false;
      check();
      focusPending();
      if (joined) {
        options.onItemsChange?.();
      }
      joined = false;
    });
  }
  function moveTo(itemKey, from) {
    const move = pending = { key: itemKey, from };
    const before = remembered;
    if (remember) {
      remembered = itemKey;
    }
    setStop(itemKey);
    setTimeout(() => {
      focusPending();
      if (pending !== move) {
        return;
      }
      pending = null;
      if (remembered === itemKey) {
        remembered = before;
      }
      queue(false);
    });
  }
  const focusOn = (el) => {
    el.focus();
    return el.ownerDocument.activeElement === el;
  };
  function focusPending() {
    if (!pending) {
      return;
    }
    const item = order.list().find(({ part }) => part.key === pending.key);
    if (!item || !isFocusable(item.part)) {
      return;
    }
    const active = item.el.ownerDocument.activeElement;
    const untouched = active === pending.from || active === null || active === item.el.ownerDocument.body;
    if (!untouched || focusOn(item.el)) {
      pending = null;
    }
  }
  let stop = store.get()[key];
  context.onDestroy(
    store.subscribe(() => {
      const was = stop;
      stop = store.get()[key];
      if (stop === null && was !== null && !moving) {
        remembered = null;
      }
      if (stop === was && order.size()) {
        queue(false);
      }
    })
  );
  function focusables() {
    return order.list().filter(({ part }) => isFocusable(part)).map(({ part, el }) => ({ key: part.key, props: part.props, el }));
  }
  const roving = {
    /** Joins a bound part to the group. Call it from the item slot's `bind` and return its cleanup. */
    bind(el, part) {
      const leave = order.add({ key: part.key, el, part });
      if (pending?.left && pending.from === el) {
        const was = pending.key;
        pending.key = part.key;
        if (remembered === was) {
          remembered = part.key;
        }
        if (store.get()[key] === was) {
          setStop(part.key);
        }
        if (el.ownerDocument.activeElement === el) {
          holder = el;
        }
      }
      const focused = () => {
        holder = el;
        if (remember) {
          roving.remember(part.key);
        }
      };
      const blurred = () => {
        if (holder === el) {
          holder = null;
        }
      };
      el.addEventListener("focus", focused);
      el.addEventListener("blur", blurred);
      let wasDisabled = isDisabled(part);
      let wasPreferred = isPreferred(part);
      const unwatch = onProps(part, () => {
        if (isDisabled(part) === wasDisabled && isPreferred(part) === wasPreferred) {
          return;
        }
        wasDisabled = isDisabled(part);
        wasPreferred = isPreferred(part);
        queue(false);
      });
      queue(true);
      return () => {
        unwatch();
        el.removeEventListener("focus", focused);
        el.removeEventListener("blur", blurred);
        const doc = el.ownerDocument;
        const had = !!doc && (doc.activeElement === el || holder === el && doc.activeElement === doc.body);
        if (holder === el) {
          holder = null;
        }
        leave();
        if (had && !pending && store.get()[key] === part.key) {
          const wait = pending = { key: part.key, from: el, left: true };
          setTimeout(() => {
            if (pending !== wait) {
              return;
            }
            pending = null;
            queue(false);
          });
        }
        queue(true);
      };
    },
    /** The item's `tabindex`: `"0"` for the item with the stop, `"-1"` for the rest. Pure, so `attrs` can call it. */
    tabIndex(state, part) {
      const stop2 = state[key] ?? null;
      if (stop2 !== null) {
        return stop2 === part.key ? "0" : "-1";
      }
      const eligible = options.claims ? options.claims(state, part) : !isDisabled(part) && isFocusable(part);
      return claim(part.key, eligible) ? "0" : "-1";
    },
    /**
     * Moves focus for a key pressed on an item's element. Returns the key it
     * moved to, the key it moved from and whether Shift was held, so the
     * caller can extend a selection, or `undefined` when the key isn't the
     * group's. At either end without `loop`, `key` is `from`.
     */
    keydown(event, el) {
      if (event.defaultPrevented || event.altKey) {
        return;
      }
      const list = focusables();
      const from = list.find((item) => item.el === el);
      if (!from) {
        return;
      }
      const rtl = isRTL(el);
      let to;
      if (options.move) {
        to = options.move(event, { from, items: list, rtl });
      } else if (!event.ctrlKey && !event.metaKey) {
        const step = stepFor(event.key, orientation(), rtl);
        if (step !== void 0) {
          to = list[moveIndex(
            list.indexOf(from),
            step,
            list.length,
            options.loop?.() ?? false
          )]?.key;
        }
      }
      if (to === void 0) {
        return;
      }
      event.preventDefault();
      const next = list.find((item) => item.key === to);
      if (!next || next !== from && !focusOn(next.el)) {
        moveTo(to, el);
      }
      return { key: to, from: from.key, shift: event.shiftKey };
    },
    /** The items that can take focus now, in document order, with their elements. */
    items: focusables,
    /**
     * Focuses an item, or the one with the stop, or the first. An item that
     * isn't rendered or focusable yet takes the stop now and focus once it can.
     */
    focus(itemKey) {
      if (itemKey !== void 0) {
        const item = order.list().find(({ part }) => part.key === itemKey);
        if (item && isFocusable(item.part) && focusOn(item.el)) {
          return;
        }
        moveTo(
          itemKey,
          typeof document === "undefined" ? null : document.activeElement
        );
        return;
      }
      const list = order.list();
      (list.find((item) => item.key === stop) ?? list[0])?.el.focus();
    },
    /**
     * Moves the stop to an item as if focus had landed on it, for an item
     * whose focus went elsewhere, like a menubar trigger whose menu took it.
     * A group that doesn't `remember` ignores it, since its stop follows the
     * preferred item.
     */
    remember(itemKey) {
      if (!remember) {
        return;
      }
      remembered = itemKey;
      setStop(itemKey);
    },
    /** Moves the stop to where the group's rules put it now. It also runs on its own after items join or leave and after state changes. */
    check,
    /**
     * Where the group's rules would put the stop if `preferred` said which
     * items are preferred, like the tab a value from options selects, without
     * moving it. Undefined while the bound items can't decide it, like when
     * none is preferred yet: the item may be about to bind, as when its value
     * changed, and the group decides once it has.
     */
    stopFor: (preferred) => order.list().some(({ part }) => preferred(part)) ? stopFor(preferred) : void 0
  };
  return roving;
}
export {
  createClaim,
  createRovingFocus
};
