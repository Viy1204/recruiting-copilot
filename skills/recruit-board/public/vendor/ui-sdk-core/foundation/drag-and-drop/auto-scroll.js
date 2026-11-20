// src/foundation/drag-and-drop/auto-scroll.ts
var scrollable = (el, axis) => {
  const style = getComputedStyle(el);
  const overflow = axis === "x" ? style.overflowX : style.overflowY;
  return /auto|scroll|overlay/.test(overflow) && (axis === "x" ? el.scrollWidth > el.clientWidth : el.scrollHeight > el.clientHeight);
};
function velocity(at, start, end, edge, speed) {
  const band = Math.min(edge, (end - start) / 3);
  if (at < start + band) {
    return -speed * Math.min(1, (start + band - at) / band);
  }
  if (at > end - band) {
    return speed * Math.min(1, (at - (end - band)) / band);
  }
  return 0;
}
function createAutoScroll(options = {}) {
  let point = null;
  let frame = 0;
  function tick() {
    frame = 0;
    if (!point || typeof document === "undefined") {
      return;
    }
    const edge = options.edge ?? 48;
    const speed = options.speed ?? 18;
    let moved = false;
    const ignored = options.ignore?.();
    let el = document.elementsFromPoint(point.x, point.y).find((hit) => !ignored?.contains(hit)) ?? null;
    const done = { x: false, y: false };
    while (el && !(done.x && done.y)) {
      const rect = el.getBoundingClientRect();
      for (const axis of ["x", "y"]) {
        if (done[axis] || !scrollable(el, axis)) {
          continue;
        }
        const v = axis === "x" ? velocity(point.x, rect.left, rect.right, edge, speed) : velocity(point.y, rect.top, rect.bottom, edge, speed);
        if (!v) {
          continue;
        }
        const before = axis === "x" ? el.scrollLeft : el.scrollTop;
        if (axis === "x") {
          el.scrollLeft += v;
        } else {
          el.scrollTop += v;
        }
        if ((axis === "x" ? el.scrollLeft : el.scrollTop) !== before) {
          done[axis] = moved = true;
        }
      }
      el = el.parentElement;
    }
    const view = document.defaultView;
    if (view && !done.y) {
      const v = velocity(point.y, 0, view.innerHeight, edge, speed);
      const before = view.scrollY;
      if (v) {
        view.scrollBy(0, v);
      }
      if (view.scrollY !== before) {
        moved = true;
      }
    }
    if (moved) {
      options.onScroll?.();
      frame = requestAnimationFrame(tick);
    }
  }
  return {
    /** The pointer moved to `x`, `y` in viewport pixels. Starts scrolling if it's near an edge. */
    update(x, y) {
      point = { x, y };
      if (!frame) {
        frame = requestAnimationFrame(tick);
      }
    },
    /** Stops scrolling, like when the drag ends. */
    stop() {
      point = null;
      if (frame) {
        cancelAnimationFrame(frame);
      }
      frame = 0;
    }
  };
}
export {
  createAutoScroll
};
