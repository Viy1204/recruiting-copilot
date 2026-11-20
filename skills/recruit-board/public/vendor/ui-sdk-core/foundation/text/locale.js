// src/foundation/text/locale.ts
function toLocale(tag) {
  try {
    return Intl.getCanonicalLocales(
      tag ? tag.split(/[.@]/)[0].replaceAll("_", "-") : []
    )[0];
  } catch {
  }
}
function userLocale() {
  if (typeof navigator === "undefined") {
    return void 0;
  }
  return toLocale(navigator.languages?.[0] ?? navigator.language);
}
function pageLocale(el) {
  if (typeof document === "undefined") {
    return void 0;
  }
  const lang = (el ?? document.documentElement).closest("[lang]")?.getAttribute("lang");
  return toLocale(lang) ?? userLocale();
}
function bindPageLocale(el, set) {
  const read = () => set(pageLocale(el) ?? null);
  if (el.isConnected) {
    read();
  } else {
    queueMicrotask(read);
  }
}
var localeOf = (state) => state.locale ?? state.pageLocale ?? "en-US";
export {
  bindPageLocale,
  localeOf,
  pageLocale,
  toLocale,
  userLocale
};
