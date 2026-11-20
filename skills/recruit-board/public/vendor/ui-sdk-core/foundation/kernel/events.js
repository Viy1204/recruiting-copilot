// src/foundation/kernel/events.ts
function on(target, type, listener, options) {
  target.addEventListener(type, listener, options);
  return () => target.removeEventListener(type, listener, options);
}
var selectEvent = () => new Event("select", { cancelable: true });
function isComposing(event) {
  const key = "nativeEvent" in event ? event.nativeEvent : event;
  return key.isComposing === true || key.keyCode === 229;
}
export {
  isComposing,
  on,
  selectEvent
};
