// src/foundation/kernel/draft.ts
function settleDraft(store, value, before, clear) {
  if (value() !== before) {
    return clear();
  }
  const done = () => {
    unsubscribe();
    clearTimeout(timer);
    clear();
  };
  const unsubscribe = store.subscribe(() => value() !== before && done());
  const timer = setTimeout(done);
}
export {
  settleDraft
};
