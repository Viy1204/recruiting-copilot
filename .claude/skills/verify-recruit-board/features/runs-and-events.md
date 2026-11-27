# Runs and archive events

The execution history view lists completed and active workflow runs, exposes per-run results and highlights on demand, and reflects interview progress recorded in candidate archive files.

## Sub-features

- `runs-list` exposes seeded and newly recorded runs in `/api/snapshot`.
- `run-results-and-highlights` serves per-run results and highlights via `/api/runs/results?run=<id>` and `/api/runs/highlights?run=<id>`.
- `event-record` appends a structured progress row to a candidate's `03-interview/*.md` file via `events.mjs` and surfaces it in `/api/workspace/overview`.

## How to get to it (user POV)

- Choose `执行记录` (`button[data-nav-target="tasks"]`) in the navigation sidebar or top tabs, or open a deep link with `?workspace=<workspaceKey>&run=<runId>`.
- Run `node skills/recruit-board/scripts/progress.mjs` or `node skills/recruit-board/scripts/events.mjs` in a terminal.

## Driving it with control-board.mjs

Preconditions:

- `control-board.mjs doctor --state <state-file>` reports `ok: true`.
- The seeded workspace contains completed run `verify-run-001` and archive `03-interview/合成候选人乙.md`.

- **Read run results.** Run `node .claude/skills/verify-recruit-board/scripts/control-board.mjs http --state <state-file> --path "/api/runs/results?run=verify-run-001" --out <evidence-dir>/run-results.json`. Status is `200` and `body.run.id` is `verify-run-001`.
- **Read run highlights.** Run `node .claude/skills/verify-recruit-board/scripts/control-board.mjs http --state <state-file> --path "/api/runs/highlights?run=verify-run-001" --out <evidence-dir>/run-highlights.json`. Status is `200` and `body.run.id` is `verify-run-001`.
- **Record a new run via CLI.** Run `node .claude/skills/verify-recruit-board/scripts/control-board.mjs cli --workspace <work-dir> -- progress start --run verify-run-002 --workflow resume-review --trigger manual`. It exits `0` and returns the new run JSON with its `steps`.
- **Second read-only view.** Run `node .claude/skills/verify-recruit-board/scripts/control-board.mjs http --state <state-file> --path /api/snapshot --out <evidence-dir>/snapshot-runs.json`. `body.runs` includes both `verify-run-001` and `verify-run-002`.

## Gotchas

- `progress.mjs complete` requires every step in the run to be completed or explicitly skipped with `--reason` first; calling `complete` on a run with pending steps exits `1`.

- `GET /api/runs/results` and `GET /api/runs/highlights` accept strictly one `run` query parameter; extra parameters fail with `400` `RUN_INPUT_INVALID`.
- Invalid or path-traversal `run` IDs are rejected with `400` and never read outside `runtime/recruit-board/runs/`.
