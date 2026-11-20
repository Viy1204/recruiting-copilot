// src/foundation/selection/selection-model.ts
import {
  allToggled,
  rangeSelection,
  isSameKeys,
  toggledKeys
} from "./listbox-range.js";
function createKeySelection(config) {
  const { keys, set, order, selectable } = config;
  let anchor = null;
  return {
    toggle(key, why) {
      if (!selectable(key)) {
        return;
      }
      const next = toggledKeys(keys(), key);
      if (set(next, why)) {
        anchor = { key, base: next };
      }
    },
    replace(key, why) {
      if (!selectable(key)) {
        return;
      }
      if (!isSameKeys(keys(), [key]) && !set([key], why)) {
        return;
      }
      anchor = { key, base: [key] };
    },
    // Selects from the anchor to `to`. Without an anchor, the range starts at
    // `from`, the item focus was on, or at `to` itself.
    extend(to, { from, additive }, why) {
      const list = order();
      if (!anchor || !list.includes(anchor.key)) {
        anchor = { key: from ?? to, base: keys() };
      }
      const next = rangeSelection(list, anchor, to, { additive, selectable });
      if (!isSameKeys(next, keys())) {
        set(next, why);
      }
    },
    toggleAll(why) {
      const next = allToggled(keys(), order().filter(selectable));
      if (!isSameKeys(next, keys())) {
        set(next, why);
      }
    },
    anchor: () => anchor?.key ?? null,
    setAnchor(key) {
      anchor = key === null ? null : { key, base: [...keys()] };
    },
    resetAnchor() {
      anchor = null;
    }
  };
}
function sameMembers(a, b) {
  const members = new Set(b);
  return a.length === b.length && a.every((key) => members.has(key));
}
function createSelection(context, options) {
  const { store } = context;
  const keys = () => store.get()[options.key] ?? [];
  const multiple = () => options.multiple?.() ?? false;
  const selectable = (key) => options.selectable?.(key) ?? true;
  let requested = null;
  const model = createKeySelection({
    keys,
    order: options.order,
    selectable,
    set(next, why) {
      requested = next;
      const done = options.set(next, why);
      if (!done) {
        requested = null;
      }
      return done;
    }
  });
  let previous = keys();
  context.onDestroy(
    store.subscribe(() => {
      const current = keys();
      if (current === previous) {
        return;
      }
      const kept = sameMembers(current, previous);
      previous = current;
      if (kept) {
        return;
      }
      const own = requested !== null && sameMembers(requested, current);
      requested = null;
      if (!own || !current.length) {
        model.resetAnchor();
      }
    })
  );
  return {
    /** Whether an item is selected. */
    isSelected: (key) => keys().includes(key),
    /** Selects only this item, and starts the next range there. */
    choose: (key, why) => model.replace(key, why),
    /** Adds or removes one item, and starts the next range there. In single mode, selects it or clears it. */
    toggle(key, why) {
      if (multiple()) {
        return model.toggle(key, why);
      }
      if (!selectable(key)) {
        return;
      }
      if (isSameKeys(keys(), [key])) {
        model.toggle(key, why);
      } else {
        model.replace(key, why);
      }
    },
    /**
     * Selects the range from the anchor to `key`, keeping what was selected
     * when the anchor was set. Without an anchor, the range starts at `from`,
     * like the item focus was on. `additive: false` drops what was selected
     * before. In single mode, chooses `key`.
     */
    extend(key, why) {
      if (!multiple()) {
        return model.replace(key, why);
      }
      model.extend(
        key,
        { from: why.from ?? null, additive: why.additive ?? true },
        why
      );
    },
    /** Selects every selectable item in `order`, or none once they all are, like Ctrl+A. Only in multiple mode. */
    toggleAll(why) {
      if (multiple()) {
        model.toggleAll(why);
      }
    },
    /** The key ranges start from, or `null`. */
    anchor: model.anchor,
    /**
     * Starts the next range at `key` without changing the selection, like when
     * arrow keys move focus but don't select. The range keeps what's selected now. `null` clears it.
     */
    setAnchor: model.setAnchor
  };
}
export {
  createKeySelection,
  createSelection
};
