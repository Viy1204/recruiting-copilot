// src/foundation/kernel/trusted.ts
var trusted = (event) => event.isTrusted;
function trustSent(sent) {
  trusted = (event) => event.isTrusted || sent.has(event);
}
export {
  trustSent,
  trusted
};
