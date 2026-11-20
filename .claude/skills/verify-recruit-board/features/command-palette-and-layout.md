# Command palette and layout

The workbench provides a `Ctrl+K` / `Mod+K` fuzzy command palette for jumping across views, roles, and candidates, keyboard roving focus in the candidate table, a layout editor, and light/dark theme switching.

## Sub-features

- `palette-open` opens `#command-palette` from `#open-command-palette` or `Ctrl+K` / `Cmd+K`.
- `palette-jump` filters roles, views, and candidates by fuzzy query and switches the active view or opens the target dossier.
- `layout-edit` opens `#layout-editor` via `#edit-layout`, allows reordering or restoring defaults (`#reset-layout`), and exits cleanly via `#finish-layout`.
- `theme-toggle` toggles light and dark themes via `#theme` without losing active navigation or drawer state.

## How to get to it (user POV)

- Click `快速跳转` (`#open-command-palette`) in the header or press `Ctrl+K` (macOS `Cmd+K`) outside an active modal.
- Click `调整布局` (`#edit-layout`) or `切换深色主题` (`#theme`) in the header toolbar.

## Driving it with control-board.mjs

Preconditions:

- `control-board.mjs doctor --state <state-file>` reports `ok: true`.
- A live browser or Playwright/CDP harness is pointed at the `url` returned by `control-board.mjs launch`.

- **Verify initial HTML and vendor assets.** Run `node .claude/skills/verify-recruit-board/scripts/control-board.mjs http --state <state-file> --path / --out <evidence-dir>/index-html.json` and `node .claude/skills/verify-recruit-board/scripts/control-board.mjs http --state <state-file> --path /vendor/ui-sdk-core/index.js --out <evidence-dir>/vendor-sdk.json`. Both return status `200`, and `/` contains `#open-command-palette`, `#edit-layout`, and `#theme`.
- **Drive palette in browser.** Open `state.url`, click `#open-command-palette` (or press `Control+k` / `Meta+k`), verify `#command-palette` opens with focus in its search input, type `后端`, press `Enter`, and confirm the active view switches to `岗位与人选` (`#breadcrumb-view`).
- **Drive theme and layout in browser.** Click `#theme` and verify `aria-pressed` flips; click `#edit-layout`, verify `#layout-editor` becomes visible, then click `#finish-layout` and confirm `#layout-editor` hides again.
- **Proof.** Capture an ARIA snapshot and screenshot into `<evidence-dir>/palette-and-layout.png` showing the workspace header and active view.

## Gotchas

- Browser-only interactions (`Ctrl+K`, roving focus, drag-and-drop reorder, theme CSS) cannot be proved by HTTP calls alone; if no browser harness is available, report those sub-features as `verified-unreachable` with the missing browser prerequisite rather than marking them passed.
- `/vendor/ui-sdk-core/*` rejects query parameters and symlinks with `404`.
