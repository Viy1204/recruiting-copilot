// src/foundation/drag-and-drop/draft-move.ts
import { keepFocus } from "../focus/keep-focus.js";
import { focusables } from "../focus/tabbable.js";
import { deriveState } from "../kernel/derive.js";
import { settleDraft } from "../kernel/draft.js";
function createDraftMove({
  store,
  draft: draftKey,
  value: valueKey,
  shown,
  same,
  rebase,
  commit,
  say,
  element
}) {
  const draft = () => store.get()[draftKey];
  const value = () => store.get()[valueKey];
  let held = false;
  let moved = false;
  const focusIn = (key) => {
    const item = element(key);
    const active = item?.ownerDocument.activeElement;
    return item && active && item.contains(active) ? [...item.querySelectorAll(focusables)].indexOf(active) : void 0;
  };
  let grabbedAt;
  const setDraft = (next) => {
    if (next && !draft()) {
      grabbedAt = focusIn(next.key);
    }
    moved = !!next && !!draft();
    held = !!next;
    store.set({ [draftKey]: next });
  };
  const focusLater = (key) => {
    const at = focusIn(key) ?? grabbedAt ?? -1;
    keepFocus(() => {
      const item = element(key);
      return item?.querySelectorAll(focusables)[at] ?? item;
    });
  };
  deriveState({ store }, [draftKey], (state) => {
    const current = state[draftKey];
    if (!current || !held) {
      return;
    }
    const next = rebase(current, state[valueKey], moved);
    if (next && same(shown(next), shown(current))) {
      return;
    }
    return { [draftKey]: next };
  });
  function drop(reason, event) {
    const current = draft();
    if (!current) {
      return;
    }
    held = false;
    const before = value();
    const changed = !same(shown(current), before);
    if (changed && !commit(current, { reason, event })) {
      setDraft(null);
      say("cancel", current, value());
    } else {
      say("drop", current, shown(current));
      if (!changed) {
        setDraft(null);
      } else {
        settleDraft(store, value, before, () => {
          if (draft()?.key === current.key) {
            setDraft(null);
          }
        });
      }
    }
    if (!current.pointer) {
      focusLater(current.key);
    }
  }
  function cancel(refocus = true) {
    const current = draft();
    if (!current) {
      return;
    }
    setDraft(null);
    say("cancel", current, value());
    if (!current.pointer && refocus) {
      focusLater(current.key);
    }
  }
  return { draft, value, setDraft, focusLater, drop, cancel };
}
export {
  createDraftMove
};
