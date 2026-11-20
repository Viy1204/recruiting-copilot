// src/foundation/shortcuts/shortcuts.ts
import { exposeShortcuts } from "../kernel/dev-stub.js";
import {
  createShortcuts
} from "./create-shortcuts.js";
function registerShortcut(keys, handler, options) {
  return shortcuts.register(keys, handler, options);
}
var shortcuts = globalThis[/* @__PURE__ */ Symbol.for("ui-sdk.shortcuts@1")] ??= createShortcuts();
exposeShortcuts(() => shortcuts.list());
export {
  registerShortcut,
  shortcuts
};
