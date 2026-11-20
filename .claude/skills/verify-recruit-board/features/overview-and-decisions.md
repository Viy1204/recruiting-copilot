# Overview and local decisions

The overview view surfaces cross-round items awaiting human triage and recent verified progress, and lets a user stage local decisions (`decide`, `snooze`, `revise`, `reopen`, `cancel`, `resolve-history`) without triggering external platform actions.

## Sub-features

- `overview-read` loads open decisions and recent highlights without mutating workspace files.
- `decision-stage` records a human decision via `POST /api/decisions` with CSRF protection and optimistic revision checks.
- `decision-replay` returns the prior receipt when the same `requestId` and payload are retried.
- `decision-forbidden-op` rejects non-human operations (`register`, `import`, `action`) over HTTP with `DECISION_OP_FORBIDDEN`.
- `decision-cli-verify` confirms the persisted decision state from `decisions.mjs show --id <decision-id>`.

## How to get to it (user POV)

- Open the board URL (`http://127.0.0.1:<port>/?workspace=<workspaceKey>`), which defaults to the `总览` view (`button[data-nav-target="overview"]`).
- Select a pending item in `#workspace-decision-list` to inspect and triage it in `#triage-inspector`.
- Run `node skills/recruit-board/scripts/decisions.mjs show --workspace <work-dir> --id <decision-id>` in a terminal.

## Driving it with control-board.mjs

Preconditions:

- `control-board.mjs doctor --state <state-file>` reports `ok: true` with `web-decisions` in `capabilities`.
- The seeded workspace contains open decision `<decision-id>` (from `seed` output `seededDecisionId`) at `revision: 1` with `identity.scope: "后端工程师 · 本轮筛选"`.

- **Read overview.** Run `node .claude/skills/verify-recruit-board/scripts/control-board.mjs http --state <state-file> --path /api/workspace/overview --out <evidence-dir>/overview-before.json`. Status is `200` and `body.decisions` contains `<decision-id>` with `state: "open"` and `revision: 1`.
- **Stage a local decision.** Run `node .claude/skills/verify-recruit-board/scripts/control-board.mjs http --state <state-file> --method POST --path /api/decisions --csrf --body '{"operation":"decide","input":{"id":"<decision-id>","expectedRevision":1,"requestId":"verify-req-decide-1","decision":{"text":"约一面","scope":"后端工程师 · 本轮筛选"}}}' --out <evidence-dir>/decision-stage.json`. Status is `200`, `body.item.revision` is `2`, and `body.message` confirms the decision is recorded for the next round.
- **Verify idempotent replay.** Re-run the exact same `POST /api/decisions` command with `requestId: "verify-req-decide-1"` and `--out <evidence-dir>/decision-replay.json`. Status is `200`, `body.replayed` is `true`, and `body.item.revision` stays `2`.
- **Reject forbidden web operation.** Run `node .claude/skills/verify-recruit-board/scripts/control-board.mjs http --state <state-file> --method POST --path /api/decisions --csrf --body '{"operation":"register","input":{"id":"bad"}}' --out <evidence-dir>/decision-forbidden.json`. Status is `400` and `body.error.code` is `DECISION_OP_FORBIDDEN`.
- **Second read-only view.** Run `node .claude/skills/verify-recruit-board/scripts/control-board.mjs cli --workspace <work-dir> -- decisions show --id <decision-id>` and `node .claude/skills/verify-recruit-board/scripts/control-board.mjs http --state <state-file> --path /api/workspace/overview --out <evidence-dir>/overview-after.json`. Both views show `<decision-id>` at `revision: 2` with `decision.text: "约一面"`.

## Gotchas

- `POST /api/decisions` requires both a fresh `X-CSRF-Token` from `GET /api/session` and same-origin headers; omitting `--csrf` returns `403` with `CSRF_REJECTED`.
- `POST /api/decisions` strictly validates top-level keys (`operation` and `input` only); extra keys fail with `400` `DECISION_INPUT_INVALID`.
- Staging a decision never sends messages or schedules interviews; external execution happens only in a subsequent workflow round.
