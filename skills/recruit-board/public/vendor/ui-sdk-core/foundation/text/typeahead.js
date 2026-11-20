// src/foundation/text/typeahead.ts
import { foldText } from "./match.js";
var normalize = (text) => foldText(text).trim();
function isTypeaheadKey(event) {
  return event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey;
}
function textOf(el) {
  let text = "";
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) {
    const node = walker.currentNode;
    const hidden = node.parentElement?.closest('[aria-hidden="true"], [hidden]');
    if (hidden && el.contains(hidden) && (hidden !== el || hidden.getAttribute("aria-hidden") === "true")) {
      continue;
    }
    text += node.textContent;
  }
  return text;
}
function labelOf(el) {
  const text = textOf(el).replace(/\s+/g, " ").trim();
  return text || (el.getAttribute("aria-label") ?? "");
}
function searchStart(current, query) {
  return query.length === 1 ? current + 1 : Math.max(current, 0);
}
function createTypeahead(timeout = 500) {
  let query = "";
  let lastKey = "";
  let stepping = false;
  let timer;
  function reset() {
    query = "";
    lastKey = "";
    stepping = false;
    clearTimeout(timer);
  }
  function scan(labels, prefix, start) {
    const count = labels.length;
    for (let step = 0; step < count; step++) {
      const index = ((start + step) % count + count) % count;
      if (normalize(labels[index]).startsWith(prefix)) {
        return index;
      }
    }
    return -1;
  }
  function search(key, labels, current) {
    if (key.length !== 1 || key === " " && !query) {
      return -1;
    }
    clearTimeout(timer);
    timer = setTimeout(reset, timeout);
    const char = normalize(key) || key;
    stepping = char === lastKey && (stepping || query.length === 1);
    lastKey = char;
    query += char;
    if (stepping) {
      const whole = scan(labels, query, Math.max(current, 0));
      return whole !== -1 ? whole : scan(labels, char, searchStart(current, char));
    }
    return scan(labels, query, searchStart(current, query));
  }
  return Object.assign(search, { reset, active: () => query.length > 0 });
}
export {
  createTypeahead,
  isTypeaheadKey,
  labelOf,
  normalize,
  textOf
};
