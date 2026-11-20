// src/foundation/platform/bind-layer.ts
import { pushLayer } from "./layers.js";
import { supportsTopLayer } from "./platform.js";
function bindLayer(el, options) {
  let active = true;
  const layer = {
    contains: (target) => el.contains(target) || !!options.contains?.(target),
    active: () => active,
    modal: options.modal ?? false,
    el,
    component: "layer",
    onEscape: (event) => {
      event.preventDefault();
      options.onDismiss("escape-key", event);
    },
    onOutsidePress: (event) => options.onDismiss("outside-press", event),
    onBlur: (event) => {
      if (options.closeOnBlur) {
        options.onDismiss("window-blur", event);
      }
    }
  };
  const top = !!options.topLayer && supportsTopLayer();
  if (top) {
    el.setAttribute("popover", "manual");
    if (!el.matches(":popover-open")) {
      el.showPopover();
    }
  }
  const pop = pushLayer(layer);
  return () => {
    active = false;
    pop();
    if (top && el.matches(":popover-open")) {
      el.hidePopover();
    }
  };
}
export {
  bindLayer
};
