// src/foundation/shortcuts/shortcut-order.ts
function shortcutOrder(layer, find, persistent = () => false, inPopup = () => false) {
  if (!layer) {
    return 0;
  }
  const el = typeof layer === "function" ? layer() : layer;
  if (!el || !el.isConnected) {
    return null;
  }
  if (persistent(el)) {
    return Infinity;
  }
  const open = find(el);
  if (open) {
    return open.order ?? 0;
  }
  return inPopup(el) ? null : 0;
}
function isShortcutAllowed(order, blocking) {
  if (order === null) {
    return false;
  }
  return blocking === void 0 || order >= blocking;
}
function isTypingIn(target) {
  if (!target || !target.tagName) {
    return false;
  }
  const el = target;
  if (el.isContentEditable) {
    return true;
  }
  if (el.tagName === "TEXTAREA" || el.tagName === "SELECT") {
    return true;
  }
  if (el.tagName !== "INPUT") {
    return false;
  }
  const type = el.type;
  return !/^(button|checkbox|radio|submit|reset|range|color|file|image)$/.test(
    type
  );
}
export {
  isShortcutAllowed,
  isTypingIn,
  shortcutOrder
};
