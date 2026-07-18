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
[ ! -L "$skills_dir" ] || {
  printf 'Error: canonical skills directory must not be a symbolic link: %s\n' "$skills_dir" >&2
  exit 1
}
[ -d "$skills_dir" ] || {
  printf 'Error: canonical skills directory does not exist: %s\n' "$skills_dir" >&2
  exit 1
}

found=0
for skill_dir in "$skills_dir"/*; do
  [ ! -L "$skill_dir" ] || continue
  [ -d "$skill_dir" ] || continue
  [ -f "$skill_dir/SKILL.md" ] || continue
  found=1
  break
done
[ "$found" -eq 1 ] || {
  printf 'Error: no local skill folders containing SKILL.md found in %s\n' "$skills_dir" >&2
  exit 1
}

created=0
unchanged=0
preserved=0

register_root() {
  adapter_parent=$1
  adapter_root=$adapter_parent/skills

  if [ -L "$adapter_parent" ]; then
    printf 'Preserved symbolic-link adapter root: %s -> %s\n' \
      "$adapter_parent" "$(readlink "$adapter_parent")" >&2
    preserved=$((preserved + 1))
    return
  fi
  if [ -e "$adapter_parent" ] && [ ! -d "$adapter_parent" ]; then
    printf 'Preserved existing adapter path: %s\n' "$adapter_parent" >&2
    preserved=$((preserved + 1))
    return
  fi

  mkdir -p "$adapter_parent"
  if [ -L "$adapter_root" ]; then
    printf 'Preserved symbolic-link skills root: %s -> %s\n' \
      "$adapter_root" "$(readlink "$adapter_root")" >&2
    preserved=$((preserved + 1))
    return
  fi
  if [ -e "$adapter_root" ] && [ ! -d "$adapter_root" ]; then
    printf 'Preserved existing skills path: %s\n' "$adapter_root" >&2
    preserved=$((preserved + 1))
    return
  fi
  mkdir -p "$adapter_root"

  for skill_dir in "$skills_dir"/*; do
    if [ -L "$skill_dir" ]; then
      printf 'Preserved symbolic-link skill source: %s -> %s\n' \
        "$skill_dir" "$(readlink "$skill_dir")" >&2
      preserved=$((preserved + 1))
      continue
    fi
    [ -d "$skill_dir" ] || continue
    [ -f "$skill_dir/SKILL.md" ] || continue
    skill_name=$(basename "$skill_dir")
    destination=$adapter_root/$skill_name
    relative_target=../../skills/$skill_name

    if [ -L "$destination" ]; then
      resolved_destination=$(cd "$destination" 2>/dev/null && pwd -P || true)
      resolved_skill=$(cd "$skill_dir" && pwd -P)
      if [ "$(readlink "$destination")" = "$relative_target" ] && \
        [ "$resolved_destination" = "$resolved_skill" ] && \
        [ -f "$destination/SKILL.md" ]; then
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

register_root "$workspace/.agents"
register_root "$workspace/.claude"
register_root "$workspace/.qoder"

printf 'Skill registration complete: created=%s unchanged=%s preserved=%s\n' \
  "$created" "$unchanged" "$preserved"
printf 'Universal fallback: open the workspace root so the agent can read AGENTS.md.\n'
