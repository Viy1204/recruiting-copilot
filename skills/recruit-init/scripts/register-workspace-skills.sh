#!/bin/sh
set -eu

usage() {
  cat <<'EOF'
Usage: register-workspace-skills.sh <workspace>

Registers the workspace's canonical skills/ directory in project-local skill
discovery locations used by Codex, Claude Code, and Qoder. Existing files,
directories, and non-matching links are preserved.
EOF
}

if [ "$#" -ne 1 ]; then
  usage >&2
  exit 2
fi

workspace=$1
[ -d "$workspace" ] || {
  printf 'Error: workspace does not exist: %s\n' "$workspace" >&2
  exit 1
}

workspace=$(cd "$workspace" && pwd -P)
skills_dir=$workspace/skills
[ -d "$skills_dir" ] || {
  printf 'Error: canonical skills directory does not exist: %s\n' "$skills_dir" >&2
  exit 1
}

created=0
unchanged=0
preserved=0
found=0

register_root() {
  adapter_root=$1
  mkdir -p "$adapter_root"

  for skill_dir in "$skills_dir"/*; do
    [ -d "$skill_dir" ] || continue
    [ -f "$skill_dir/SKILL.md" ] || continue
    found=1

    skill_name=$(basename "$skill_dir")
    destination=$adapter_root/$skill_name
    relative_target=../../skills/$skill_name

    if [ -L "$destination" ]; then
      if [ "$(readlink "$destination")" = "$relative_target" ]; then
        unchanged=$((unchanged + 1))
      else
        printf 'Preserved existing link: %s -> %s\n' \
          "$destination" "$(readlink "$destination")" >&2
        preserved=$((preserved + 1))
      fi
      continue
    fi

    if [ -e "$destination" ]; then
      printf 'Preserved existing path: %s\n' "$destination" >&2
      preserved=$((preserved + 1))
      continue
    fi

    ln -s "$relative_target" "$destination"
    printf 'Registered: %s -> %s\n' "$destination" "$relative_target"
    created=$((created + 1))
  done
}

register_root "$workspace/.agents/skills"
register_root "$workspace/.claude/skills"
register_root "$workspace/.qoder/skills"

[ "$found" -eq 1 ] || {
  printf 'Error: no skill folders containing SKILL.md found in %s\n' "$skills_dir" >&2
  exit 1
}

printf 'Skill registration complete: created=%s unchanged=%s preserved=%s\n' \
  "$created" "$unchanged" "$preserved"
printf 'Universal fallback: open the workspace root so the agent can read AGENTS.md.\n'
