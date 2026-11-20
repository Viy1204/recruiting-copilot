// src/foundation/kernel/option-names.ts
var capitalized = (key) => `${key[0].toUpperCase()}${key.slice(1)}`;
var callbackName = (key, kind) => `on${capitalized(key)}${kind}`;
var defaultName = (key) => `default${capitalized(key)}`;
export {
  callbackName,
  defaultName
};
