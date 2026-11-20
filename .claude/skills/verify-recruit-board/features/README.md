# recruit-board verification map

This directory is the maintained source for verifying the user-facing behavior of `recruit-board`. Read the index before driving the app, then follow the matching feature file as the recipe.

## Baseline preconditions

- Create a disposable workspace `<work-dir>` and separate `<evidence-dir>` under the OS temp directory so concurrent runs do not share state.
- Seed synthetic data with `node .claude/skills/verify-recruit-board/scripts/control-board.mjs seed --workspace <work-dir>`.
- Launch an isolated server with `node .claude/skills/verify-recruit-board/scripts/control-board.mjs launch --workspace <work-dir> --state <state-file>`.
- Run `node .claude/skills/verify-recruit-board/scripts/control-board.mjs doctor --state <state-file>` and require `ok: true`, `workspaceKeyMatch: true`, `web-decisions` in `capabilities`, and `htmlStatus: 200`.
- Never drive an instance that was not started by this verification run, and never point a run at a real recruiting workspace.

## Driving conventions

- Start every recipe from the baseline seeded state unless its preconditions say otherwise.
- Prefer stable ARIA labels, `data-nav-target`, and element IDs over coordinates or DOM order.
- Drive HTTP mutations through `control-board.mjs http --csrf` so real `Origin`, `Referer`, and `X-CSRF-Token` checks are exercised.
- Drive workspace CLIs through `control-board.mjs cli --workspace <work-dir> -- <script> [args...]`.
- Do not remove `<evidence-dir>` during cleanup.

## Proof and skip reporting

- Capture both the user action and the resulting state, not only the final screen.
- HTTP mutation proof includes the mutation response and a second read-only view (`GET /api/workspace/overview`, `GET /api/roles`, or `cli -- decisions show --id <decision-id>`).
- Browser UI proof includes an ARIA snapshot or screenshot showing the workspace heading, active view, and target state.
- CLI proof includes the command, stdout, stderr, and exit code.
- Report an unreachable path with the attempted command and the unmet precondition.
- Do not report a skipped entry point as verified through a different path.

## Feature entry contract

Each feature file starts with an H1 title and one paragraph describing the user-visible behavior. It then uses exactly four H2 sections in this order.

1. `Sub-features` lists short IDs with one line for each behavior.
2. `How to get to it (user POV)` lists every user entry point.
3. `Driving it with control-board.mjs` starts with `Preconditions:` and uses labeled bullets that pair each user action with an exact command and observable result.
4. `Gotchas` lists traps that can waste or invalidate a verification run.

## Features

- [Overview and local decisions](./overview-and-decisions.md) covers the triage workbench, two-phase local decisions (`POST /api/decisions`), forbidden operation guards, and CLI inspection.
- [Roles and candidates](./roles-and-candidates.md) covers role scopes, candidate name search, candidate dossier and document preview, and role status saving with backup.
- [Runs and archive events](./runs-and-events.md) covers execution history, run results and highlights, and interview archive progress logging.
- [Command palette and layout](./command-palette-and-layout.md) covers `Ctrl+K` / `Mod+K` quick jump, candidate table roving focus, layout reordering, and theme switching.
