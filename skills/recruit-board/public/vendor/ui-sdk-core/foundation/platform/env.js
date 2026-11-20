// src/foundation/platform/env.ts
var isBrowser = typeof window !== "undefined" && typeof document !== "undefined";
function isIOS() {
  return isBrowser && (/iP(hone|ad|od)/.test(navigator.platform) || navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
}
function isRTL(el) {
  return !!el && isBrowser && getComputedStyle(el).direction === "rtl";
}
export {
  isBrowser,
  isIOS,
  isRTL
};
