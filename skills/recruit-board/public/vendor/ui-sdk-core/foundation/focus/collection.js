// src/foundation/focus/collection.ts
var orientationOf = (value, fallback) => value === "horizontal" || value === "vertical" ? value : fallback;
function stepFor(key, orientation, rtl) {
  if (orientation === "both") {
    return radioStep(key, rtl) ?? (key === "Home" ? "first" : key === "End" ? "last" : void 0);
  }
  const forward = orientation === "vertical" ? "ArrowDown" : rtl ? "ArrowLeft" : "ArrowRight";
  const backward = orientation === "vertical" ? "ArrowUp" : rtl ? "ArrowRight" : "ArrowLeft";
  if (key === forward) {
    return 1;
  }
  if (key === backward) {
    return -1;
  }
  if (key === "Home") {
    return "first";
  }
  if (key === "End") {
    return "last";
  }
}
function radioStep(key, rtl) {
  if (key === "ArrowDown" || key === (rtl ? "ArrowLeft" : "ArrowRight")) {
    return 1;
  }
  if (key === "ArrowUp" || key === (rtl ? "ArrowRight" : "ArrowLeft")) {
    return -1;
  }
}
function rovingStop(items, remembered = null) {
  const focusable = items.filter((item) => item.focusable);
  if (remembered !== null && focusable.some((item) => item.key === remembered)) {
    return remembered;
  }
  const enabled = focusable.filter((item) => !item.disabled);
  return (enabled.find((item) => item.preferred) ?? enabled[0] ?? focusable[0])?.key ?? null;
}
function fieldKeepsKey(key, field) {
  if (key === "Home" || key === "End") {
    return true;
  }
  if (key === "ArrowUp" || key === "ArrowDown") {
    return field.usesUpDown;
  }
  if (key !== "ArrowLeft" && key !== "ArrowRight") {
    return false;
  }
  if (field.start === null || field.end === null) {
    return false;
  }
  if (field.start !== field.end) {
    return true;
  }
  const backward = key === (field.rtl ? "ArrowRight" : "ArrowLeft");
  return backward ? field.start > 0 : field.end < field.length;
}
function moveIndex(index, step, count, loop) {
  if (step === "first") {
    return 0;
  }
  if (step === "last") {
    return count - 1;
  }
  const next = index + step;
  if (loop) {
    return (next % count + count) % count;
  }
  return Math.max(0, Math.min(count - 1, next));
}
function inOrder(values, order) {
  const rank = new Map(order.map((value, index) => [value, index]));
  const at = (value) => rank.get(value) ?? Infinity;
  return [...values].sort((a, b) => at(a) - at(b));
}
function scrollToShow(scroll, viewport, start, size, before = 0, after = 0) {
  if (start - before < scroll) {
    return Math.max(0, start - before);
  }
  if (start + size + after > scroll + viewport) {
    return Math.max(0, start + size + after - viewport);
  }
  return scroll;
}
export {
  fieldKeepsKey,
  inOrder,
  moveIndex,
  orientationOf,
  radioStep,
  rovingStop,
  scrollToShow,
  stepFor
};
