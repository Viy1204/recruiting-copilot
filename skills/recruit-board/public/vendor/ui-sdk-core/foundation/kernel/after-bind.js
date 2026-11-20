// src/foundation/kernel/after-bind.ts
var pending = /* @__PURE__ */ new Set();
function afterBind(write) {
  pending.add(write);
  queueMicrotask(() => {
    if (pending.delete(write)) {
      write();
    }
  });
}
function runBindWrites() {
  for (const write of pending) {
    pending.delete(write);
    write();
  }
}
export {
  afterBind,
  runBindWrites
};
