// src/foundation/platform/style.ts
function setStyle(el, name, value) {
  const previous = el.style.getPropertyValue(name);
  const priority = el.style.getPropertyPriority(name);
  el.style.setProperty(name, value);
  const ours = el.style.getPropertyValue(name);
  return () => {
    if (el.style.getPropertyValue(name) !== ours) {
      return;
    }
    if (previous) {
      el.style.setProperty(name, previous, priority);
    } else {
      el.style.removeProperty(name);
    }
  };
}
var registered = /* @__PURE__ */ new Set();
function registerUninherited(names) {
  if (typeof CSS === "undefined" || !CSS.registerProperty) {
    return;
  }
  for (const name of names) {
    if (registered.has(name)) {
      continue;
    }
    registered.add(name);
    try {
      CSS.registerProperty({ name, syntax: "*", inherits: false });
    } catch {
    }
  }
}
var adopted = () => globalThis[/* @__PURE__ */ Symbol.for("ui-sdk.styles@1")] ??= /* @__PURE__ */ new WeakMap();
var nonces = /* @__PURE__ */ new WeakMap();
function pageNonce(doc) {
  if (nonces.has(doc)) {
    return nonces.get(doc);
  }
  let meta;
  for (let at = doc; at && !meta; at = at.defaultView?.frameElement?.ownerDocument) {
    meta = at.head?.querySelector('meta[property="csp-nonce"]');
  }
  const nonce = meta ? meta.nonce || meta.getAttribute("nonce") || "" : null;
  nonces.set(doc, nonce);
  return nonce;
}
function writeStyle(doc, id, css) {
  if (!doc.head) {
    return;
  }
  const view = doc.defaultView;
  if (pageNonce(doc) === "" && view && "adoptedStyleSheets" in doc) {
    adoptStyle(doc, view, id, css);
  } else {
    appendStyle(doc, id, css);
  }
}
var styleText = /* @__PURE__ */ new WeakMap();
function appendStyle(doc, id, css) {
  const existing = doc.getElementById(id);
  if (existing) {
    if (styleText.get(existing) === css) {
      return;
    }
    if (existing.textContent !== css) {
      existing.textContent = css;
    }
    styleText.set(existing, css);
    return;
  }
  const style = doc.createElement("style");
  style.id = id;
  const nonce = pageNonce(doc);
  if (nonce) {
    style.nonce = nonce;
  }
  style.textContent = css;
  styleText.set(style, css);
  const ours = doc.head.querySelectorAll(':scope > style[id^="ui-sdk-"]');
  if (ours.length) {
    ours[ours.length - 1].after(style);
  } else {
    doc.head.prepend(style);
  }
}
function adoptStyle(doc, view, id, css) {
  let sheets = adopted().get(doc);
  if (!sheets) {
    adopted().set(doc, sheets = /* @__PURE__ */ new Map());
  }
  let entry = sheets.get(id);
  if (!entry) {
    sheets.set(id, entry = { sheet: new view.CSSStyleSheet(), css: "" });
  }
  if (entry.css !== css) {
    entry.sheet.replaceSync(css);
    entry.css = css;
  }
  if (!doc.adoptedStyleSheets.includes(entry.sheet)) {
    doc.adoptedStyleSheets = [...doc.adoptedStyleSheets, entry.sheet];
  }
}
function enforceHidden(doc) {
  writeStyle(
    doc,
    "ui-sdk-hidden",
    '@layer ui-sdk { :where([data-slot][hidden]:not([hidden="until-found"])) { display: none !important } }'
  );
}
var queued;
function ahead(work) {
  if (typeof window === "undefined") {
    return;
  }
  if (!performance.getEntriesByType("paint").length) {
    work();
  } else if (queued) {
    queued.push(work);
  } else {
    queued = [work];
    (window.requestIdleCallback ?? setTimeout)(() => {
      const jobs = queued;
      queued = void 0;
      jobs.forEach((job) => job());
    });
  }
}
function afterPaint(work) {
  let timer;
  const frame = requestAnimationFrame(() => {
    timer = setTimeout(work);
  });
  return () => {
    cancelAnimationFrame(frame);
    clearTimeout(timer);
  };
}
export {
  afterPaint,
  ahead,
  enforceHidden,
  registerUninherited,
  setStyle,
  writeStyle
};
