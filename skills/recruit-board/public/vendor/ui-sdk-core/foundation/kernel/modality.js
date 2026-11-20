// src/foundation/kernel/modality.ts
import { trusted } from "./trusted.js";
var modality = "pointer";
var installed = false;
var scheduled = false;
var restoring = false;
var moving = false;
var windowLeft = false;
var lastPointer = "mouse";
var pointerPressed = false;
var forgetPointerPress = () => pointerPressed = false;
var keyTarget = null;
var forgetKeyTarget = () => keyTarget = null;
function noteKey(event) {
  if (event.key !== "Enter" && event.key !== " ") {
    return;
  }
  keyTarget = event.target;
  setTimeout(forgetKeyTarget);
}
function noteKeydown(event) {
  noteKey(event);
  windowLeft = false;
  const modifierOnly = event.metaKey || event.ctrlKey || event.altKey || /^(Meta|Control|Alt|Shift)$/.test(event.key);
  if (event.key === "Tab" || !modifierOnly) {
    modality = "keyboard";
  }
}
function notePress(event) {
  modality = "pointer";
  windowLeft = false;
  if (!("pointerType" in event)) {
    if (!pointerPressed) {
      lastPointer = "touch";
    }
    return;
  }
  pointerPressed = true;
  setTimeout(forgetPointerPress);
  const type = event.pointerType;
  lastPointer = isSyntheticPointer(event) ? "virtual" : type === "touch" || type === "pen" ? type : "mouse";
}
function install() {
  if (installed || typeof document === "undefined") {
    return;
  }
  installed = true;
  document.addEventListener("keydown", noteKeydown, true);
  document.addEventListener("keyup", noteKey, true);
  document.addEventListener("pointerdown", notePress, true);
  document.addEventListener("touchstart", notePress, {
    capture: true,
    passive: true
  });
  window.addEventListener("blur", (event) => {
    if (event.target === window) {
      windowLeft = true;
    }
  });
}
function trackInput() {
  if (installed || scheduled) {
    return;
  }
  scheduled = true;
  queueMicrotask(install);
}
function isSyntheticPointer(event) {
  if (event.type === "pointermove") {
    return false;
  }
  if (event.width === 0 && event.height === 0 && event.pressure === 0) {
    return true;
  }
  return event.pointerType === "mouse" && event.width === 1 && event.height === 1 && event.pressure === 0 && event.detail === 0;
}
function clickSource(event) {
  if (event.detail > 0) {
    return lastPointer;
  }
  const fromKey = !!keyTarget && keyTarget.contains(event.target);
  return fromKey ? "keyboard" : "virtual";
}
var currentSource = () => modality === "keyboard" ? "keyboard" : lastPointer;
function sourceOf(event) {
  install();
  if (!event) {
    return currentSource();
  }
  if (!trusted(event)) {
    return "programmatic";
  }
  if (event.type.startsWith("key")) {
    return "keyboard";
  }
  if (event.type.startsWith("touch")) {
    return "touch";
  }
  if (event.type === "click") {
    return clickSource(event);
  }
  const pointerType = event.pointerType;
  if (pointerType === "mouse" || pointerType === "touch" || pointerType === "pen") {
    return isSyntheticPointer(event) ? "virtual" : pointerType;
  }
  if ("button" in event) {
    return lastPointer;
  }
  return currentSource();
}
function isFocusFromKeyboard() {
  install();
  return modality === "keyboard" && !restoring && !moving && !windowLeft;
}
function restoreFocus(el) {
  install();
  restoring = true;
  try {
    el.focus({ preventScroll: true });
  } finally {
    restoring = false;
  }
}
function moveFocus(el) {
  install();
  moving = true;
  try {
    el.focus({ preventScroll: true });
  } finally {
    moving = false;
  }
}
var modalityOf = (opener) => opener === "pointer" || opener === "touch" ? "pointer" : "keyboard";
function trackModality(el, initial, keys = () => []) {
  let current = initial;
  let last;
  const write = (next) => {
    current = next;
    if (el.getAttribute("data-modality") !== next) {
      el.setAttribute("data-modality", next);
    }
  };
  write(initial);
  const onKey = (event) => {
    if (event.metaKey || event.ctrlKey || /^(Meta|Control|Alt|Shift)$/.test(event.key)) {
      return;
    }
    write("keyboard");
  };
  const onDown = () => write("pointer");
  const onMove = (event) => {
    const point = { x: event.clientX, y: event.clientY };
    const moved = last && Math.hypot(point.x - last.x, point.y - last.y) > 2;
    last = point;
    if (moved && current !== "pointer") {
      write("pointer");
    }
  };
  const targets = [
    el,
    ...keys().filter((target) => !!target)
  ];
  for (const target of targets) {
    target.addEventListener("keydown", onKey, true);
  }
  el.addEventListener("pointerdown", onDown, true);
  el.addEventListener("pointermove", onMove, true);
  return () => {
    for (const target of targets) {
      target.removeEventListener("keydown", onKey, true);
    }
    el.removeEventListener("pointerdown", onDown, true);
    el.removeEventListener("pointermove", onMove, true);
    el.removeAttribute("data-modality");
  };
}
export {
  isFocusFromKeyboard,
  modalityOf,
  moveFocus,
  restoreFocus,
  sourceOf,
  trackInput,
  trackModality
};
