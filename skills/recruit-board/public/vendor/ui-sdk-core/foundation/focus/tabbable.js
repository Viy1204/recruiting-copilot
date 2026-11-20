// src/foundation/focus/tabbable.ts
import { isAfter } from "../kernel/order.js";
var candidates = [
  "a[href]",
  "area[href]",
  "button",
  "input:not([type='hidden'])",
  "select",
  "textarea",
  "iframe",
  "summary",
  "audio[controls]",
  "video[controls]",
  "[contenteditable]:not([contenteditable='false'])",
  "[tabindex]"
].join(",");
function isTabbable(el) {
  if (!(el instanceof HTMLElement) || el.tabIndex < 0) {
    return false;
  }
  if (el.matches(":disabled") || el.closest("[inert]")) {
    return false;
  }
  const group = el.checked ? [] : radioGroup(el);
  if (group.some((radio) => radio.checked && isTabbable(radio))) {
    return false;
  }
  if (typeof el.checkVisibility === "function") {
    return el.checkVisibility({ visibilityProperty: true });
  }
  return el.getClientRects().length > 0 && getComputedStyle(el).visibility !== "hidden";
}
function radioGroup(el) {
  if (!(el instanceof HTMLInputElement) || el.type !== "radio" || !el.name) {
    return [];
  }
  const scope = el.form ? Array.from(el.form.elements) : Array.from(
    el.getRootNode().querySelectorAll(
      `input[name="${CSS.escape(el.name)}"]`
    )
  );
  return scope.filter(
    (radio) => radio instanceof HTMLInputElement && radio.type === "radio" && radio.name === el.name && radio.form === el.form
  );
}
function tabbables(root) {
  return Array.from(root.querySelectorAll(candidates)).filter(isTabbable);
}
function composedTabbables(root) {
  const ordered = (scope) => [
    ...scope.filter((entry) => entry.index > 0).sort((a, b) => a.index - b.index),
    ...scope.filter((entry) => entry.index <= 0)
  ].flatMap((entry) => entry.stops);
  const walk = (nodes, scope) => {
    for (const el of nodes) {
      const index = el.hasAttribute("tabindex") ? el.tabIndex : 0;
      if (el.hasAttribute("inert") || el.shadowRoot && index < 0) {
        continue;
      }
      const stops = el.matches(candidates) && !el.shadowRoot?.delegatesFocus && isTabbable(el) ? [el] : [];
      const slotted = el instanceof HTMLSlotElement ? el.assignedElements() : [];
      if (el.shadowRoot || slotted.length) {
        const inner = [];
        walk(el.shadowRoot?.children ?? slotted, inner);
        scope.push({ index, stops: [...stops, ...ordered(inner)] });
      } else {
        scope.push({ index, stops });
        walk(el.children, scope);
      }
    }
  };
  const top = [];
  walk(root.children, top);
  return top.flatMap((entry) => entry.stops);
}
function positiveTabStops(stops, root) {
  const slotted = (el) => {
    for (let node = el; node && node !== root; node = node.parentElement) {
      if (node.assignedSlot) {
        return true;
      }
    }
    return false;
  };
  return stops.filter((el) => el.tabIndex > 0 && !slotted(el)).sort((a, b) => a.tabIndex - b.tabIndex);
}
function nextTabbable(node, skip) {
  const doc = node.ownerDocument ?? document;
  return tabbables(doc.body).find(
    (el) => !el.contains(node) && !skip?.contains(el) && isAfter(node, el)
  );
}
var focusables = 'a[href],button,input:not([type="hidden"]),select,textarea,iframe,summary,[contenteditable]:not([contenteditable="false"]),[tabindex]';
var ownTabStops = /* @__PURE__ */ new WeakSet();
function takesFocus(node, root) {
  const inert = node.closest("[inert]");
  return node.tabIndex >= 0 && !node.matches(":disabled") && !(inert !== root && root.contains(inert));
}
function holdsFocusableNode(node, root) {
  if (!(node instanceof Element)) {
    return false;
  }
  return node.matches(focusables) && takesFocus(node, root) || holdsFocusable(node, root);
}
function holdsFocusable(el, root = el) {
  return Array.from(el.querySelectorAll(focusables)).some(
    (node) => takesFocus(node, root)
  );
}
function bindTabStop(el, wanted, {
  skipWhenHolding = false
} = {}) {
  const authored = el.hasAttribute("tabindex") && !ownTabStops.has(el);
  let holds = holdsFocusable(el);
  const check = () => {
    if (authored) {
      return;
    }
    const stop = wanted() && !holds ? "0" : skipWhenHolding ? "-1" : null;
    if (el.getAttribute("tabindex") === stop) {
      return;
    }
    if (stop === null) {
      el.removeAttribute("tabindex");
      ownTabStops.delete(el);
    } else {
      el.setAttribute("tabindex", stop);
      ownTabStops.add(el);
    }
  };
  check();
  if (typeof MutationObserver === "undefined") {
    return { check, stop: () => {
    } };
  }
  const observer = new MutationObserver((records) => {
    for (const record of records) {
      if (record.target === el && record.type === "attributes") {
        continue;
      }
      if (record.type === "attributes" || holds && record.removedNodes.length) {
        holds = holdsFocusable(el);
        break;
      }
      if (!holds) {
        holds = Array.from(record.addedNodes).some(
          (node) => holdsFocusableNode(node, el)
        );
      }
    }
    check();
  });
  observer.observe(el, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: [
      "tabindex",
      "disabled",
      "href",
      "contenteditable",
      "inert"
    ]
  });
  return { check, stop: () => observer.disconnect() };
}
export {
  bindTabStop,
  composedTabbables,
  focusables,
  isTabbable,
  nextTabbable,
  positiveTabStops,
  radioGroup,
  tabbables
};
