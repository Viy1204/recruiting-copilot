// src/foundation/drag-and-drop/pointer.ts
import { on } from "../kernel/events.js";
function bindDrag(el, down, options) {
  followed.add(down);
  const view = el.ownerDocument.defaultView ?? window;
  const pointerId = down.pointerId;
  let frame = 0;
  let hasPending = false;
  const pending = {
    x: 0,
    y: 0,
    movementX: 0,
    movementY: 0,
    locked: false,
    event: down
  };
  let lastX = down.clientX;
  let lastY = down.clientY;
  let started = !options.threshold && !options.onStart;
  let dragged = false;
  const capture = () => {
    try {
      el.setPointerCapture(pointerId);
    } catch {
    }
  };
  if (!options.threshold) {
    capture();
  }
  const locked = () => el.ownerDocument.pointerLockElement === el;
  const flush = () => {
    frame = 0;
    if (!hasPending) {
      return;
    }
    hasPending = false;
    options.onMove(pending);
    pending.movementX = 0;
    pending.movementY = 0;
  };
  const onMove = (event) => {
    if (event.pointerId !== pointerId) {
      return;
    }
    if (event.pointerType === "mouse" && event.buttons === 0) {
      return end(event, false);
    }
    if (!started) {
      const threshold = options.threshold ?? 0;
      const dx = Math.abs(event.clientX - down.clientX);
      const dy = Math.abs(event.clientY - down.clientY);
      if (threshold && dx < threshold && dy < threshold) {
        return;
      }
      started = true;
      if (options.onStart?.(event) === false) {
        return stop();
      }
      if (threshold) {
        capture();
      }
      if (options.cancelOnEscape) {
        el.ownerDocument.addEventListener("keydown", onEscape, true);
      }
    }
    if (!dragged && isDrag(event.clientX - down.clientX, event.clientY - down.clientY)) {
      dragged = true;
      if (options.lock && down.pointerType === "mouse") {
        requestLock(el);
      }
    }
    const isLocked = locked();
    pending.movementX += isLocked ? event.movementX : event.clientX - lastX;
    pending.movementY += isLocked ? event.movementY : event.clientY - lastY;
    pending.x = lastX = event.clientX;
    pending.y = lastY = event.clientY;
    pending.locked = isLocked;
    pending.event = event;
    hasPending = true;
    frame ||= view.requestAnimationFrame(flush);
  };
  const onUp = (event) => {
    if (event.pointerId !== pointerId) {
      return;
    }
    if (dragged) {
      swallowNextClick(el.ownerDocument);
    }
    end(event, false);
  };
  const onCancel = (event) => {
    if (event.pointerId === pointerId) {
      end(event, true);
    }
  };
  const onEscape = (event) => {
    if (event.key !== "Escape") {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    if (dragged) {
      swallowNextClick(el.ownerDocument, true, pointerId);
    }
    end(pending.event, true);
  };
  const listeners = [
    ["pointermove", onMove],
    ["pointerup", onUp],
    ["pointercancel", onCancel]
  ];
  for (const [type, listener] of listeners) {
    el.ownerDocument.addEventListener(type, listener);
  }
  if (started && options.cancelOnEscape) {
    el.ownerDocument.addEventListener("keydown", onEscape, true);
  }
  function stop() {
    if (frame) {
      view.cancelAnimationFrame(frame);
    }
    frame = 0;
    for (const [type, listener] of listeners) {
      el.ownerDocument.removeEventListener(type, listener);
    }
    el.ownerDocument.removeEventListener("keydown", onEscape, true);
    if (el.hasPointerCapture?.(pointerId)) {
      el.releasePointerCapture(pointerId);
    }
    if (locked()) {
      el.ownerDocument.exitPointerLock();
    }
  }
  function end(event, canceled) {
    flush();
    stop();
    options.onEnd(event, canceled);
  }
  return stop;
}
var followed = /* @__PURE__ */ new WeakSet();
var isDragPress = (event) => followed.has(event);
var isSecondary = (event) => !event.isPrimary && event.pointerType !== "mouse" && event.pointerType !== "";
function createDragSession(onDestroy) {
  let running;
  onDestroy?.(() => running?.cancel());
  const session = {
    /**
     * Whether a press can start a drag now. Check it first, before the
     * component's own guards: ending a stale drag can change what they read.
     */
    accepts(event) {
      if (event.button !== 0 || isSecondary(event) || event.defaultPrevented) {
        return false;
      }
      if (running && running.down !== event && running.down.pointerType === event.pointerType) {
        running.cancel();
      }
      return !running;
    },
    /** Follows the press, like `bindDrag`, as this component's one drag. */
    start(el, down, options) {
      const finish = () => {
        if (running === drag) {
          running = void 0;
        }
      };
      const onStart = options.onStart;
      const stop = bindDrag(el, down, {
        ...options,
        // A drag that can't start leaves the way clear for the next press.
        onStart: onStart && ((event) => {
          const started = onStart(event);
          if (started === false) {
            finish();
          }
          return started;
        }),
        onEnd(event, canceled) {
          finish();
          options.onEnd(event, canceled);
        }
      });
      const drag = {
        down,
        cancel() {
          finish();
          stop();
          options.onEnd(down, true);
        }
      };
      running = drag;
    },
    /**
     * Waits for the press to move until `pick` decides: `undefined` to keep
     * waiting, `false` to let it go, like a scroll, or `true` to follow it from
     * that move, like `start`. The pointer isn't captured while it waits, so
     * a press that lifts first stays a click, and `onTap` hears it.
     */
    startOnMove(el, down, {
      pick,
      onTap,
      ...options
    }) {
      const doc = el.ownerDocument;
      const ours = (event) => event.pointerId === down.pointerId;
      const stopWaiting = () => {
        offs.forEach((off) => off());
        if (running === waiting) {
          running = void 0;
        }
      };
      const offs = [
        on(doc, "pointermove", (move) => {
          if (!ours(move)) {
            return;
          }
          const picked = pick(move);
          if (picked === void 0) {
            return;
          }
          stopWaiting();
          if (!picked) {
            return;
          }
          session.start(el, move, {
            ...options,
            onEnd(up, canceled) {
              const from = (event) => isDrag(up.clientX - event.clientX, up.clientY - event.clientY);
              if (!canceled && from(down) && !from(move)) {
                swallowNextClick(doc);
              }
              options.onEnd(up, canceled);
            }
          });
        }),
        on(doc, "pointerup", (up) => {
          if (!ours(up)) {
            return;
          }
          stopWaiting();
          onTap?.(up);
        }),
        on(doc, "pointercancel", (cancel) => ours(cancel) && stopWaiting())
      ];
      const waiting = { down, cancel: stopWaiting };
      running = waiting;
    },
    /** Ends the running drag, if any, as canceled. */
    cancel: () => running?.cancel()
  };
  return session;
}
var dragThreshold = 3;
function isDrag(dx, dy) {
  return Math.abs(dx) >= dragThreshold || Math.abs(dy) >= dragThreshold;
}
function requestLock(el) {
  if (typeof el.requestPointerLock !== "function") {
    return;
  }
  try {
    const result = el.requestPointerLock();
    if (result instanceof Promise) {
      result.catch(() => {
      });
    }
  } catch {
  }
}
function swallowNextClick(doc, untilRelease = false, pointerId) {
  const view = doc.defaultView ?? window;
  const ours = (event) => pointerId === void 0 || !("pointerId" in event) || event.pointerId === pointerId;
  const swallow = (event) => {
    if (!ours(event)) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    doc.removeEventListener("click", swallow, true);
  };
  const forget = () => {
    doc.removeEventListener("click", swallow, true);
    doc.removeEventListener("pointerdown", press, true);
    doc.removeEventListener("pointerup", release, true);
    doc.removeEventListener("pointercancel", release, true);
  };
  const press = (event) => ours(event) && forget();
  const release = (event) => ours(event) && view.setTimeout(forget);
  doc.addEventListener("click", swallow, true);
  doc.addEventListener("pointerdown", press, true);
  if (!untilRelease) {
    return view.setTimeout(forget);
  }
  doc.addEventListener("pointerup", release, true);
  doc.addEventListener("pointercancel", release, true);
}
function repeatWhileHeld(step, { delay = 400, interval = 60 } = {}) {
  let timer;
  const tick = (wait) => {
    timer = setTimeout(() => {
      if (step()) {
        tick(interval);
      }
    }, wait);
  };
  if (step()) {
    tick(delay);
  }
  return () => clearTimeout(timer);
}
export {
  bindDrag,
  createDragSession,
  dragThreshold,
  isDrag,
  isDragPress,
  repeatWhileHeld,
  swallowNextClick
};
