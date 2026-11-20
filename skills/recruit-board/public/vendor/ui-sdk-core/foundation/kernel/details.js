// src/foundation/kernel/details.ts
var dismissReasons = [
  "escape-key",
  "outside-press",
  "focus-out",
  "window-blur",
  "back",
  "swipe"
];
function isDismissal(reason) {
  return dismissReasons.includes(reason);
}
var programmaticReasons = /* @__PURE__ */ new Set([
  "image-load",
  "image-error",
  "imperative",
  "item-removed",
  "unmount",
  "reset",
  "restore",
  "timeout",
  "resize",
  "page-hide"
]);
var cause;
function resolveSource(reason, eventSource) {
  if (cause === "agent") {
    return cause;
  }
  if (programmaticReasons.has(reason)) {
    return "programmatic";
  }
  if (eventSource) {
    const source = eventSource();
    return source === "programmatic" && cause ? cause : source;
  }
  return cause ?? "programmatic";
}
function withSource(source, run) {
  const outer = cause;
  cause = source;
  try {
    return run();
  } finally {
    cause = outer;
  }
}
function createDetails(given, source, cancelable = true) {
  if (!cancelable) {
    return { ...given, source };
  }
  let canceled = false;
  return {
    ...given,
    source,
    cancel: () => {
      canceled = true;
    },
    get canceled() {
      return canceled;
    }
  };
}
export {
  createDetails,
  isDismissal,
  resolveSource,
  withSource
};
