// src/foundation/platform/announce.ts
var regions = /* @__PURE__ */ new WeakMap();
var announcer;
var pending = {};
function setAnnouncer(announce2) {
  announcer = announce2;
}
function regionIn(doc, priority) {
  let found = regions.get(doc);
  if (!found) {
    regions.set(doc, found = {});
  }
  const existing = found[priority];
  if (existing?.isConnected) {
    return existing;
  }
  const region = doc.createElement("div");
  region.setAttribute("role", priority === "assertive" ? "alert" : "status");
  region.setAttribute("aria-live", priority);
  region.setAttribute("aria-atomic", "true");
  region.setAttribute(
    "data-ui-sdk-announcer",
    priority === "assertive" ? "assertive" : ""
  );
  region.style.cssText = "position:fixed;width:1px;height:1px;margin:-1px;padding:0;border:0;overflow:hidden;clip-path:inset(50%);white-space:nowrap";
  doc.body.append(region);
  found[priority] = region;
  return region;
}
function prepareAnnouncements(doc) {
  if (announcer || !doc.body) {
    return;
  }
  regionIn(doc, "polite");
  regionIn(doc, "assertive");
}
function announce(text, {
  priority = "polite",
  doc = typeof document === "undefined" ? void 0 : document
} = {}) {
  if (!text) {
    return;
  }
  if (announcer) {
    return announcer(text, priority);
  }
  if (!doc?.body) {
    return;
  }
  const region = regionIn(doc, priority);
  region.textContent = "";
  clearTimeout(pending[priority]);
  pending[priority] = setTimeout(() => {
    region.textContent = text;
  }, 100);
}
export {
  announce,
  prepareAnnouncements,
  setAnnouncer
};
