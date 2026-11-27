# Workspace CLIs

The v0.9.0 workspace CLIs provide deterministic validation, migration, role upsert, ledger deduplication and terminal-stage guards, and sliced per-role context assembly without hand-editing `CONTEXT.md` or `02-sourcing/dedup-ledger.csv`.

## Sub-features

- `workspace-validate` checks `CONTEXT.md` role table integrity, context hygiene, 9-column ledger validity, and required paths via `workspace.mjs validate`.
- `roles-upsert-cli` adds or updates a role row in `CONTEXT.md` with backup and appends `docs/CHANGELOG.md` when `--reason` is supplied.
- `ledger-upsert-and-guard` inserts or updates a candidate row in `02-sourcing/dedup-ledger.csv` and blocks overwriting a terminal-stage candidate unless `--force-update` is passed.
- `role-context-slice` bundles global `CONTEXT.md` rules, target role metadata, and sliced `_internal` notes via `role-context.mjs`.

## How to get to it (user POV)

- Run `node skills/recruit-board/scripts/workspace.mjs validate --workspace <work-dir>` or `migrate --workspace <work-dir> [--dry-run]`.
- Run `node skills/recruit-board/scripts/roles.mjs list|set-status|upsert --workspace <work-dir> ...`.
- Run `node skills/recruit-board/scripts/ledger.mjs statuses|lookup|upsert --workspace <work-dir> ...`.
- Run `node skills/recruit-board/scripts/role-context.mjs --workspace <work-dir> --role <role-or-id> [--format json|markdown]`.

## Driving it with control-board.mjs

Preconditions:

- `control-board.mjs seed --workspace <work-dir>` has created a v0.9.0 synthetic workspace with `BE-01` (`后端工程师`) and `FE-01` (`前端工程师`).

- **Validate seeded workspace.** Run `node .claude/skills/verify-recruit-board/scripts/control-board.mjs cli --workspace <work-dir> -- workspace validate`. Exit code is `0`, `ok` is `true`, and `errors` is empty.
- **Upsert a role and check changelog.** Run `node .claude/skills/verify-recruit-board/scripts/control-board.mjs cli --workspace <work-dir> -- roles upsert --role-id DATA-01 --name 数据工程师 --priority 常规 --status 在招 --reason 合成验证新增`. Exit code is `0`, `action` is `"insert"`, `changelogUpdated` is `true`, and `cli -- roles list` shows `DATA-01`.
- **Upsert candidate and verify terminal guard.** Run `node .claude/skills/verify-recruit-board/scripts/control-board.mjs cli --workspace <work-dir> -- ledger upsert --role BE-01 --name 合成候选人丁 --bg 7年分布式后端 --rating B --status 已排除 --round verify-run-001 --note 终态测试`, then re-run `ledger upsert` for `合成候选人丁` with `--status 待确认`. The first call exits `0` with `action: "insert"`; the second exits `3` with `error.code: "LEDGER_TERMINAL_BLOCKED"`.
- **Assemble role context.** Run `node .claude/skills/verify-recruit-board/scripts/control-board.mjs cli --workspace <work-dir> -- role-context --role BE-01 --format json`. Exit code is `0` and output includes `role.roleId: "BE-01"` and `globalContext`.
- **Second read-only view.** If a board server is running on `<work-dir>`, run `GET /api/snapshot` via `control-board.mjs http` and verify `数据工程师` appears in `body.roles` and `合成候选人丁` appears in `body.candidates`.

## Gotchas

- `workspace.mjs validate` exits `1` whenever `ok` is `false` (any error), while warnings alone keep exit code `0`.
- `ledger.mjs upsert` rejects non-canonical status values with `LEDGER_STATUS_INVALID` and exits `3` on terminal-stage overwrites (`LEDGER_TERMINAL_BLOCKED`).
- `roles.mjs upsert` reads the current revision inside `context.lock` and does not accept a caller `--revision` flag.
