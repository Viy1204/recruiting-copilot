// src/foundation/kernel/dev-stub.ts
var dev = false;
function emit(_event) {
}
function warn(_message, _from, _detail) {
}
function note(_message, _from, _detail) {
}
function warnMissing(slots, _from) {
  return slots;
}
function exposeShortcuts(_list) {
}
function checkRoles(_slots, _from) {
}
function checkRole(_definition, _slot, _own, _role, _from, _live) {
}
function checkFocus(_focus, _slot, _el, _from) {
}
function expectControlled(_instance, _info, _current) {
}
function forgetControlled(_instance) {
}
function heardControlled(_instance, _options) {
}
function measured(read) {
  read();
}
var isMeasuring = () => false;
function checkEvent(_reason, _event, _from) {
}
function checkPrevented(_name, _prevented, _details, _from) {
}
function checkMarks(_elements, _marks) {
}
function checkControlled(_from, _keys, _options) {
}
export {
  checkControlled,
  checkEvent,
  checkFocus,
  checkMarks,
  checkPrevented,
  checkRole,
  checkRoles,
  dev,
  emit,
  expectControlled,
  exposeShortcuts,
  forgetControlled,
  heardControlled,
  isMeasuring,
  measured,
  note,
  warn,
  warnMissing
};
