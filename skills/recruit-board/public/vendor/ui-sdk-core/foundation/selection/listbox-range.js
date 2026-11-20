// src/foundation/selection/listbox-range.ts
function keysBetween(order, from, to) {
  const start = order.indexOf(from);
  const end = order.indexOf(to);
  if (start === -1 || end === -1) {
    return [];
  }
  return order.slice(Math.min(start, end), Math.max(start, end) + 1);
}
function rangeSelection(order, anchor, to, {
  additive,
  selectable
}) {
  const range = keysBetween(order, anchor.key, to).filter(selectable);
  const base = additive ? anchor.base : [];
  const kept = new Set(base);
  return [...base, ...range.filter((key) => !kept.has(key))];
}
function toggledKeys(selected, key) {
  return selected.includes(key) ? selected.filter((item) => item !== key) : [...selected, key];
}
function allToggled(selected, selectable) {
  const current = new Set(selected);
  if (selectable.length && selectable.every((key) => current.has(key))) {
    const removed = new Set(selectable);
    return selected.filter((key) => !removed.has(key));
  }
  return [...selected, ...selectable.filter((key) => !current.has(key))];
}
function isSameKeys(a, b) {
  return a.length === b.length && a.every((key, index) => key === b[index]);
}
export {
  allToggled,
  isSameKeys,
  keysBetween,
  rangeSelection,
  toggledKeys
};
