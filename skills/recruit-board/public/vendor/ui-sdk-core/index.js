import { applyAttrs } from './foundation/kernel/live.js';
import { attrs, bind, subscribe } from './foundation/kernel/part.js';

export { fuzzyScore, matchRanges, matchSegments } from './foundation/text/text-match.js';
export { createKeySelection, createSelection } from './foundation/selection/selection-model.js';
export { bindLayer } from './foundation/platform/bind-layer.js';
export { keepFocus } from './foundation/focus/keep-focus.js';
export { createRovingFocus } from './foundation/focus/roving-focus.js';
export { createReorder, reorderMessage } from './foundation/drag-and-drop/reorder.js';
export { definePrimitive } from './foundation/kernel/primitive.js';
export { createChange, createCommit, dispatch } from './foundation/kernel/input-source.js';
export { applyAttrs };
export { attrs, bind, subscribe };
export { ariaKeyshortcuts, formatShortcut, matchesShortcut, registerShortcut } from './page/shortcuts/shortcuts.js';

export function bindPart(instance, slot, el, props) {
  const part = instance.part(slot, props);
  const sync = () => applyAttrs(el, attrs(part));
  sync();
  const unbind = bind(part, el);
  const unsub = subscribe(part, sync);
  return () => {
    unsub();
    unbind?.();
  };
}
