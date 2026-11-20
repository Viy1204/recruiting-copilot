// src/foundation/popups/popup-elements.ts
var registry = () => globalThis[/* @__PURE__ */ Symbol.for("ui-sdk.popup-elements@1")] ??= /* @__PURE__ */ new WeakMap();
function registerPopupElement(el) {
  const elements = registry();
  elements.set(el, (elements.get(el) ?? 0) + 1);
  let done = false;
  return () => {
    if (done) {
      return;
    }
    done = true;
    const count = (elements.get(el) ?? 1) - 1;
    if (count > 0) {
      elements.set(el, count);
    } else {
      elements.delete(el);
    }
  };
}
function inPopupElement(target) {
  const elements = registry();
  for (let node = target; node; node = node.parentNode ?? node.host ?? null) {
    if (elements.has(node)) {
      return true;
    }
  }
  return false;
}
function ownsEvent(el, event, same = `[data-slot="${el.getAttribute("data-slot")}"]`) {
  return event.target.closest(same) === el;
}
export {
  inPopupElement,
  ownsEvent,
  registerPopupElement
};
