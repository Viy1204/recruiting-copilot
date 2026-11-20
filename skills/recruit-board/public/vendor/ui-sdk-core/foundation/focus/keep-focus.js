// src/foundation/focus/keep-focus.ts
var lost = (active, el) => active === el.ownerDocument.body || !active.isConnected || active.matches(":disabled") || active.closest("[inert]") !== null || active.contains(el);
function keepFocus(element) {
  const restore = () => {
    const el = element();
    const active = el?.ownerDocument.activeElement;
    if (el && active !== el && (!active || lost(active, el))) {
      el.focus();
    }
  };
  queueMicrotask(restore);
  setTimeout(restore);
}
export {
  keepFocus
};
