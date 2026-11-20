# Roles and candidates

The roles and candidates view displays role scopes, lets a user search candidates across all active and historical roles by name, opens candidate dossiers and linked resumes, and updates role status in `CONTEXT.md` with automatic backup.

## Sub-features

- `roles-list` reads configured roles and revision metadata from `CONTEXT.md`.
- `candidate-detail` returns private ledger fields, matched archive progress, and safe document handles for a candidate.
- `candidate-document` serves a linked workspace resume (`inline` or `download=1`) while rejecting external or symlink escapes.
- `role-status-save` updates a role's status cell in `CONTEXT.md` via `POST /api/roles/status` and writes a backup under `runtime/recruit-board/roles/`.

## How to get to it (user POV)

- Choose `岗位与人选` (`button[data-nav-target="roles"]`) in the navigation sidebar or top tabs.
- Type a name in `#candidate-query` (`按姓名搜索人选`) from any view.
- Click a candidate row to open `#workspace-drawer`, or click `管理岗位` (`#manage-roles`) to edit role status and aliases.

## Driving it with control-board.mjs

Preconditions:

- `control-board.mjs doctor --state <state-file>` reports `ok: true`.
- The seeded workspace contains roles `后端工程师` (`在招`) and `前端工程师` (`暂停`), plus `合成候选人乙` linked to `03-interview/合成候选人乙.md` and `runtime/resumes/candidate-b.txt`.

- **Read snapshot and roles.** Run `node .claude/skills/verify-recruit-board/scripts/control-board.mjs http --state <state-file> --path /api/roles --out <evidence-dir>/roles-before.json`. Status is `200`, `body.roles` includes `前端工程师` with `status: "暂停"`, and `body.revision` is a non-empty hash string.
- **Read candidate detail.** Run `node .claude/skills/verify-recruit-board/scripts/control-board.mjs http --state <state-file> --path /api/snapshot --out <evidence-dir>/snapshot.json` to get the `id` for `合成候选人乙`, then run `node .claude/skills/verify-recruit-board/scripts/control-board.mjs http --state <state-file> --path "/api/candidates/detail?candidate=<encoded-id>" --out <evidence-dir>/candidate-detail.json`. Status is `200` and `body.documents` includes `candidate-b.txt`.
- **Save role status.** Using `revision` from `roles-before.json`, run `node .claude/skills/verify-recruit-board/scripts/control-board.mjs http --state <state-file> --method POST --path /api/roles/status --csrf --body '{"role":"前端工程师","status":"在招","revision":"<revision>"}' --out <evidence-dir>/role-status-save.json`. Status is `200` and `body.changed` is `true`.
- **Second read-only view.** Run `node .claude/skills/verify-recruit-board/scripts/control-board.mjs http --state <state-file> --path /api/roles --out <evidence-dir>/roles-after.json`. `前端工程师` now reports `status: "在招"` with a new `revision`, and `<work-dir>/runtime/recruit-board/roles/` contains a backup of the prior `CONTEXT.md`.

## Gotchas

- Candidate IDs are JSON-encoded `[name, role]` tuples and must be URL-encoded when passed as `?candidate=...`.
- Passing a stale `revision` to `POST /api/roles/status` returns `409` without modifying `CONTEXT.md`.
- Candidate name search intentionally does not persist the query string into the URL or `localStorage`.
