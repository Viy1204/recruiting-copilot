# Cross-agent skill registration design

Keep `<workspace>/skills/` as the single canonical copy of every recruiting workflow. Preserve
`AGENTS.md` as the portable routing layer for any agent that can read project instructions.

During initialization, create project-local relative symlinks for verified discovery conventions:

- `.agents/skills/` for Codex and Agent Skills-compatible tools;
- `.claude/skills/` for Claude Code;
- `.qoder/skills/` for Qoder.

The registration script must be safe to rerun. It creates missing links, leaves correct links
unchanged, and never replaces an existing path or a link with a different target. This preserves
user customizations and keeps repair mode non-destructive.

Do not invent adapters for tools without a documented, stable project-level skill directory.
Those tools use `AGENTS.md` to route into the canonical `skills/` tree. ZCode can additionally
import the Codex or Claude source into the current project through its Skills UI.

Validation covers a clean workspace, a second idempotent run, preservation of conflicting paths,
and resolution of every generated link to a folder containing `SKILL.md`.
