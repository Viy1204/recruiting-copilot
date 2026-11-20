// src/foundation/drag-and-drop/drag-preview.ts
var sides = ["top", "right", "bottom", "left"];
var kept = [
  "color",
  "font-family",
  "font-size",
  "font-style",
  "font-weight",
  "letter-spacing",
  "line-height",
  "text-align",
  "text-transform",
  "direction",
  "background-color",
  ...sides.flatMap((side) => [
    `padding-${side}`,
    `border-${side}-width`,
    `border-${side}-style`,
    `border-${side}-color`
  ]),
  ...["top-left", "top-right", "bottom-right", "bottom-left"].map(
    (corner) => `border-${corner}-radius`
  )
];
function bindDragPreview(el, from) {
  const doc = el.ownerDocument;
  const rect = el.getBoundingClientRect();
  const computed = getComputedStyle(el);
  const copy = el.cloneNode(true);
  for (const node of [copy, ...copy.querySelectorAll("[id]")]) {
    node.removeAttribute("id");
  }
  const grouped = "input[type=radio][name], details[name]";
  for (const node of [copy, ...copy.querySelectorAll(grouped)]) {
    if (node.matches(grouped)) {
      node.removeAttribute("name");
    }
  }
  copy.setAttribute("aria-hidden", "true");
  copy.setAttribute("data-drag-preview", "");
  copy.removeAttribute("tabindex");
  copy.inert = true;
  for (const name of kept) {
    copy.style.setProperty(name, computed.getPropertyValue(name));
  }
  Object.assign(copy.style, {
    position: "fixed",
    inset: "auto",
    left: `${rect.left}px`,
    top: `${rect.top}px`,
    width: `${rect.width}px`,
    height: `${rect.height}px`,
    margin: "0",
    boxSizing: "border-box",
    overflow: "visible",
    pointerEvents: "none",
    zIndex: "2147483647",
    translate: "none"
  });
  doc.body.append(copy);
  if ("showPopover" in copy) {
    copy.popover = "manual";
    try {
      copy.showPopover();
    } catch {
    }
  }
  return {
    /** The copy, for styles a drag sets as it goes. */
    el: copy,
    /** Moves the copy as far as the pointer moved from where the drag started. */
    move(x, y) {
      copy.style.translate = `${x - from.x}px ${y - from.y}px`;
    },
    /** Takes the copy out of the page. */
    remove() {
      copy.remove();
    }
  };
}
export {
  bindDragPreview
};
