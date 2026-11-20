---
name: verify-recruit-board
description: "Live verification skill for the recruit-board local web workbench and its workspace CLIs (decisions, roles, candidates, runs, events, command palette). Use when proving UI or HTTP/CLI behavior end-to-end against a real running server."
---

# Verify recruit-board

Use this skill to launch an isolated `recruit-board` instance against a disposable synthetic workspace, verify it is healthy, drive user-facing web and CLI flows, capture durable proof artifacts, and tear down only what the run started.

Read [the feature map](features/README.md) before driving a feature.

## Surface and isolation

- **Primary surface.** Local web workbench (`http://127.0.0.1:<port>/?workspace=<workspaceKey>`) served by `skills/recruit-board/scripts/server.mjs`, plus workspace CLIs under `skills/recruit-board/scripts/`.
- **Isolation.** Multiple instances run side by side safely as long as each run uses a distinct temporary workspace directory, ephemeral port, and state file. Never point a verification run at a real user recruiting workspace.

## Helpers

All lifecycle, doctor, HTTP, and CLI operations go through the executable Node helper shipped with this skill:

```bash
node .claude/skills/verify-recruit-board/scripts/control-board.mjs <subcommand> [flags]
```

Subcommands: `seed`, `launch`, `doctor`, `http`, `cli`, `cleanup`.

## Launch

1. Pick an isolated run directory (for example under `os.tmpdir()`, such as `/tmp/verify-rb-$RUN_ID`) and a separate evidence directory (such as `/tmp/verify-rb-evidence-$RUN_ID`) that survives cleanup.
2. Seed a clean synthetic workspace (creates `CONTEXT.md`, `02-sourcing/dedup-ledger.csv`, `03-interview/合成候选人乙.md`, `runtime/resumes/candidate-b.txt`, run `verify-run-001`, and an open decision whose deterministic `seededDecisionId` is printed in stdout):

```bash
node .claude/skills/verify-recruit-board/scripts/control-board.mjs seed --workspace <work-dir>
```

3. Start the real `recruit-board` server on a free port and wait until `/api/health` responds with a matching `workspaceKey`:

```bash
node .claude/skills/verify-recruit-board/scripts/control-board.mjs launch --workspace <work-dir> --state <state-file>
```

Launch prints `{ ok, pid, port, workspace, workspaceKey, url, logFile }`.

## Doctor

Run before the first drive and after any unexpected failure:

```bash
node .claude/skills/verify-recruit-board/scripts/control-board.mjs doctor --state <state-file>
```

A healthy instance exits `0` with `ok: true`, `workspaceKeyMatch: true`, `capabilities` containing `web-decisions`, and `htmlStatus: 200`. Never drive an instance that fails `doctor` or was not started by this run.

## Drive

- **HTTP API (real browser wire path with Origin, Referer, and CSRF token).**
  ```bash
  node .claude/skills/verify-recruit-board/scripts/control-board.mjs http \
    --state <state-file> --method POST --path /api/decisions --csrf \
    --body '{"operation":"decide","input":{...}}' --out <evidence-dir>/decide.json
  ```
- **Workspace CLIs.**
  ```bash
  node .claude/skills/verify-recruit-board/scripts/control-board.mjs cli \
    --workspace <work-dir> -- decisions show --id <decision-id>
  ```
- **Live Browser UI.** Open the `url` printed by `launch` in a browser or Playwright/CDP harness and drive via stable ARIA labels and control IDs (`button[data-nav-target="overview|roles|tasks"]`, `#candidate-query`, `#open-command-palette` / `Ctrl+K`, `#workspace-decision-list`, `#triage-inspector`, `#manage-roles`, `#workspace-drawer`).

Exact step-by-step recipes live in [features/README.md](features/README.md).

## Evidence

Store proof artifacts in `<evidence-dir>` outside `<work-dir>` so teardown never deletes them.

- Capture both the user action (command or request) and the resulting state (response JSON, ARIA snapshot/screenshot, or CLI stdout/exit code).
- For any mutation (`POST /api/decisions`, `POST /api/roles/status`, `POST /api/roles/alias`, `POST /api/candidates/materials`), verify the persisted side effect with a second read-only check (e.g. `GET /api/workspace/overview`, `GET /api/roles`, or `cli -- decisions show --id <decision-id>`).
- Never use test-only endpoints or internal setters to prove a user-facing flow.

## Cleanup

Always run cleanup at the end of a run and after any failed iteration. Cleanup kills only the PID recorded in `<state-file>`, removes `<state-file>` and its server log, and optionally removes `<work-dir>`. It never removes `<evidence-dir>`.

```bash
node .claude/skills/verify-recruit-board/scripts/control-board.mjs cleanup --state <state-file> --remove-workspace
```

After cleanup, verify that `<evidence-dir>` still contains all captured proof artifacts.
