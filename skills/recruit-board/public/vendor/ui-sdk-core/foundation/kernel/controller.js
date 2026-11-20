// src/foundation/kernel/controller.ts
import { dev, warn } from "./dev-stub.js";
import { whenKept } from "./keep.js";
var attach = /* @__PURE__ */ Symbol.for("ui-sdk.controller.attach");
var detach = /* @__PURE__ */ Symbol.for("ui-sdk.controller.detach");
var attached = /* @__PURE__ */ Symbol.for("ui-sdk.controller.attached");
function isControllerAttached(controller) {
  return !!controller?.[attached];
}
function attachController(controller, api) {
  ;
  controller?.[attach]?.(api);
}
function detachController(controller, api) {
  ;
  controller?.[detach]?.(api);
}
var methodName = (key) => typeof key === "string" && /^[a-z]/.test(key) && !/^(internal|then|toJSON)$/.test(key) && !(key in {});
var isRead = (key) => typeof key === "string" && /^(is|get|has|can)[A-Z]/.test(key);
function createController() {
  let current;
  let hasAttached = false;
  const methods = /* @__PURE__ */ new Map();
  const read = (key) => key === "internal" ? void 0 : current?.[key];
  const forward = (key) => {
    let method = methods.get(key);
    if (method) {
      return method;
    }
    let warned = false;
    method = (...args) => {
      const value = read(key);
      if (typeof value === "function") {
        return value.apply(current, args);
      }
      if (dev && !hasAttached && !warned && !isRead(key)) {
        warned = true;
        warn(
          `${String(key)}() was called before its component attached and did nothing.`
        );
      }
    };
    methods.set(key, method);
    return method;
  };
  const valueOf = (key) => {
    if (!current) {
      return methodName(key) ? forward(key) : void 0;
    }
    const value = read(key);
    return typeof value === "function" ? forward(key) : value;
  };
  const isMember = (key) => key !== "internal" && !!current && Object.hasOwn(current, key);
  return new Proxy(/* @__PURE__ */ Object.create(null), {
    get(_, key) {
      if (key === attach) {
        return (api) => {
          current = api;
          if (dev) {
            hasAttached = true;
          }
        };
      }
      if (key === attached) {
        return current !== void 0;
      }
      if (key === detach) {
        return (api) => {
          if (current === api) {
            current = void 0;
          }
        };
      }
      return valueOf(key);
    },
    has: (_, key) => isMember(key),
    ownKeys: () => current ? Reflect.ownKeys(current).filter(isMember) : [],
    getOwnPropertyDescriptor: (_, key) => isMember(key) ? { value: valueOf(key), enumerable: true, configurable: true } : void 0
  });
}
function connectController(context, api) {
  let current = context.options().controller;
  let kept = false;
  whenKept(() => {
    kept = true;
    attachController(current, api);
    return () => {
      kept = false;
      detachController(current, api);
    };
  });
  context.onOptions(({ controller }) => {
    if (controller === current) {
      return;
    }
    detachController(current, api);
    current = controller;
    if (kept) {
      attachController(controller, api);
    }
  });
}
export {
  attachController,
  connectController,
  createController,
  isControllerAttached
};
