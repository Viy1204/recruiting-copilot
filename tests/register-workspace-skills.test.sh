#!/bin/sh
set -eu

PROJECT_ROOT=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
REGISTER="$PROJECT_ROOT/skills/recruit-init/scripts/register-workspace-skills.sh"
TEST_ROOT=$(mktemp -d)
trap 'rm -rf "$TEST_ROOT"' EXIT HUP INT TERM

fail() {
  printf 'FAIL: %s\n' "$1" >&2
  exit 1
}

make_workspace() {
  workspace=$1
  mkdir -p "$workspace/skills"
  cp -R "$PROJECT_ROOT/skills/ask-viy" "$workspace/skills/"
  cp -R "$PROJECT_ROOT/skills/resume-review" "$workspace/skills/"
}

assert_registered() {
  workspace=$1
  for adapter in .agents .claude .qoder; do
    for skill in ask-viy resume-review; do
      link=$workspace/$adapter/skills/$skill
      [ -L "$link" ] || fail "missing link: $link"
      [ "$(readlink "$link")" = "../../skills/$skill" ] ||
        fail "wrong relative target: $link"
      [ -f "$link/SKILL.md" ] || fail "link does not resolve to SKILL.md: $link"
    done
  done
}

test_clean_and_idempotent_runs() {
  sandbox=$TEST_ROOT/clean
  make_workspace "$sandbox/workspace"

  first=$(sh "$REGISTER" "$sandbox/workspace")
  second=$(sh "$REGISTER" "$sandbox/workspace")

  assert_registered "$sandbox/workspace"
  case "$first" in *'created=6 unchanged=0 preserved=0'*) ;; *) fail 'wrong first-run counts' ;; esac
  case "$second" in *'created=0 unchanged=6 preserved=0'*) ;; *) fail 'wrong second-run counts' ;; esac
}

test_conflicting_destination_is_preserved() {
  sandbox=$TEST_ROOT/conflict
  make_workspace "$sandbox/workspace"
  mkdir -p "$sandbox/workspace/.agents/skills/ask-viy"

  sh "$REGISTER" "$sandbox/workspace" >/dev/null

  [ -d "$sandbox/workspace/.agents/skills/ask-viy" ] || fail 'conflict directory was replaced'
  [ ! -L "$sandbox/workspace/.agents/skills/ask-viy" ] || fail 'conflict became a link'
}

test_adapter_symlink_cannot_escape_workspace() {
  sandbox=$TEST_ROOT/adapter-symlink
  make_workspace "$sandbox/workspace"
  mkdir -p "$sandbox/outside"
  ln -s "$sandbox/outside" "$sandbox/workspace/.agents"

  sh "$REGISTER" "$sandbox/workspace" >/dev/null

  [ ! -e "$sandbox/outside/skills" ] || fail 'registration followed adapter symlink outside workspace'
  [ -f "$sandbox/workspace/.claude/skills/ask-viy/SKILL.md" ] ||
    fail 'safe adapter roots were not registered'
}

test_all_adapter_symlinks_are_preserved_without_failure() {
  sandbox=$TEST_ROOT/all-adapter-symlinks
  make_workspace "$sandbox/workspace"
  for adapter in .agents .claude .qoder; do
    mkdir -p "$sandbox/outside-$adapter"
    ln -s "$sandbox/outside-$adapter" "$sandbox/workspace/$adapter"
  done

  output=$(sh "$REGISTER" "$sandbox/workspace")

  case "$output" in *'created=0 unchanged=0 preserved=3'*) ;; *) fail 'wrong all-conflict counts' ;; esac
  for adapter in .agents .claude .qoder; do
    [ ! -e "$sandbox/outside-$adapter/skills" ] ||
      fail "registration followed $adapter outside workspace"
  done
}

test_canonical_skills_symlink_is_rejected() {
  sandbox=$TEST_ROOT/skills-symlink
  mkdir -p "$sandbox/outside-skills/ask-viy" "$sandbox/workspace"
  cp "$PROJECT_ROOT/skills/ask-viy/SKILL.md" "$sandbox/outside-skills/ask-viy/"
  ln -s "$sandbox/outside-skills" "$sandbox/workspace/skills"

  if sh "$REGISTER" "$sandbox/workspace" >/dev/null 2>&1; then
    fail 'canonical skills symlink was accepted'
  fi
}

test_clean_and_idempotent_runs
test_conflicting_destination_is_preserved
test_adapter_symlink_cannot_escape_workspace
test_all_adapter_symlinks_are_preserved_without_failure
test_canonical_skills_symlink_is_rejected
printf 'PASS: register-workspace-skills\n'
