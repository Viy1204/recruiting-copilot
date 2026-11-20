// src/foundation/kernel/input-source.ts
import { dev, emit } from "./dev-stub.js";
import { sourceOf, trackInput } from "./modality.js";
import { changeFrom } from "./change.js";
import {
  createDetails,
  resolveSource,
  withSource
} from "./details.js";
import { isDestroying } from "./keep.js";
import { callbackName } from "./option-names.js";
import { watchers } from "./watchers.js";
var changeSource = (reason, event) => resolveSource(reason, event && (() => sourceOf(event)));
function inputSource() {
  trackInput();
  return changeSource;
}
function createChange(context, source = inputSource()) {
  return changeFrom(context, source);
}
function createCommit(context, source = inputSource()) {
  return (key, value, details) => {
    if (isDestroying()) {
      return;
    }
    const commitDetails = createDetails(
      details,
      source(details.reason, details.event),
      false
    );
    const callbacks = context.options();
    const callback = callbacks[callbackName(key, "Commit")];
    if (callback) {
      withSource(commitDetails.source, () => callback(value, commitDetails));
    }
    if (dev) {
      emit({
        type: "commit",
        component: context.label,
        id: context.id,
        key,
        value,
        reason: details.reason,
        source: commitDetails.source
      });
    }
    watchers.commit?.(context.id, key, value, commitDetails);
  };
}
function dispatch(context, name, value, details) {
  const callbackDetails = createDetails(
    details,
    details.source ?? changeSource(details.reason, details.event)
  );
  const callback = context.options()[name];
  if (typeof callback === "function") {
    withSource(
      callbackDetails.source,
      () => callback(
        value,
        callbackDetails
      )
    );
  }
  return callbackDetails.canceled;
}
export {
  changeSource,
  createChange,
  createCommit,
  dispatch,
  inputSource
};
