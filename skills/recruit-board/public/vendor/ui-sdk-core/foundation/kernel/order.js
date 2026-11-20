// src/foundation/kernel/order.ts
var following = 4;
var isAfter = (node, later) => !!(node.compareDocumentPosition(later) & following);
var documentOrder = (a, b) => isAfter(a, b) ? -1 : 1;
var walkFrom = 16;
var walkPerEntry = 32;
function inDocumentOrder(entries) {
  let container = entries.length < walkFrom ? null : entries[0].el.parentNode;
  while (container && !entries.every(({ el }) => container.contains(el))) {
    container = container.parentNode;
  }
  if (container) {
    const byElement = new Map(
      entries.map((entry) => [entry.el, entry])
    );
    const sorted = [];
    const walker = entries[0].el.ownerDocument.createTreeWalker(container, 1);
    let budget = entries.length * walkPerEntry;
    for (let node = container; node && budget--; node = walker.nextNode()) {
      const entry = byElement.get(node);
      if (entry && sorted.push(entry) === entries.length) {
        return sorted;
      }
    }
  }
  return entries.sort((a, b) => documentOrder(a.el, b.el));
}
function createOrder() {
  const entries = /* @__PURE__ */ new Map();
  let order;
  let joined = [];
  let left = false;
  let moves;
  const watched = /* @__PURE__ */ new Set();
  const current = (entry) => entries.get(entry.key) === entry;
  function watch(added, list) {
    moves ??= new MutationObserver(() => order = void 0);
    const last = list[list.length - 1]?.el;
    for (const { el } of added) {
      for (let node = el.parentNode; node && !watched.has(node); node = node.parentNode) {
        watched.add(node);
        moves.observe(node, { childList: true });
        if (node.contains(last)) {
          break;
        }
      }
    }
  }
  function sorted() {
    const all = [...entries.values()];
    const list = inDocumentOrder(all.filter((entry) => entry.el.isConnected));
    if (list.length < all.length) {
      return list;
    }
    if (typeof MutationObserver !== "undefined") {
      moves?.disconnect();
      watched.clear();
      watch(list, list);
    }
    return order = list;
  }
  function updated(kept) {
    const added = joined.filter(current);
    if (added.some((entry) => !entry.el.isConnected)) {
      return;
    }
    const list = kept.filter(current);
    if (added.length * Math.log2(list.length + 2) > list.length) {
      return;
    }
    for (const entry of added) {
      let low = 0;
      let high = list.length;
      while (low < high) {
        const middle = low + high >> 1;
        if (isAfter(list[middle].el, entry.el)) {
          low = middle + 1;
        } else {
          high = middle;
        }
      }
      list.splice(low, 0, entry);
    }
    if (moves) {
      watch(added, list);
    }
    return list;
  }
  return {
    /** The entries in the page, in document order. Shared until one is added, removed or moved. */
    list() {
      if (moves?.takeRecords().length) {
        order = void 0;
      }
      if (order && (joined.length || left)) {
        order = updated(order);
      }
      joined = [];
      left = false;
      return order ?? sorted();
    },
    /** Adds an entry, or replaces the one with its key. Returns its removal. */
    add(entry) {
      if (order && entries.has(entry.key)) {
        left = true;
      }
      entries.set(entry.key, entry);
      if (order) {
        joined.push(entry);
      }
      return () => {
        if (!current(entry)) {
          return;
        }
        entries.delete(entry.key);
        left = true;
        if (!entries.size) {
          moves?.disconnect();
          watched.clear();
          order = void 0;
        }
      };
    },
    get: (key) => entries.get(key),
    size: () => entries.size
  };
}
export {
  createOrder,
  documentOrder,
  inDocumentOrder,
  isAfter
};
