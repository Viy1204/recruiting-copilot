// src/foundation/platform/scrollbar.ts
function onScrollbar(point, box) {
  const { x, y } = point;
  const { borders } = box;
  const inBorders = x >= borders.left && x < box.width - borders.right && y >= borders.top && y < box.height - borders.bottom;
  const inPadding = x >= box.clientLeft && x < box.clientLeft + box.clientWidth && y >= box.clientTop && y < box.clientTop + box.clientHeight;
  return inBorders && !inPadding;
}
function pressedScrollbar(event, target) {
  if (!(target instanceof Element)) {
    return false;
  }
  const doc = target.ownerDocument;
  if (target === doc.documentElement) {
    return event.clientX >= target.clientWidth || event.clientY >= target.clientHeight;
  }
  if (target.clientWidth === 0 && target.clientHeight === 0) {
    return false;
  }
  const rect = target.getBoundingClientRect();
  const style = getComputedStyle(target);
  return onScrollbar(
    { x: event.clientX - rect.left, y: event.clientY - rect.top },
    {
      width: rect.width,
      height: rect.height,
      clientLeft: target.clientLeft,
      clientTop: target.clientTop,
      clientWidth: target.clientWidth,
      clientHeight: target.clientHeight,
      borders: {
        top: parseFloat(style.borderTopWidth) || 0,
        right: parseFloat(style.borderRightWidth) || 0,
        bottom: parseFloat(style.borderBottomWidth) || 0,
        left: parseFloat(style.borderLeftWidth) || 0
      }
    }
  );
}
export {
  onScrollbar,
  pressedScrollbar
};
