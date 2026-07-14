#!/bin/sh
set -eu

PROJECT_ROOT=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
INSTALLER="$PROJECT_ROOT/skills/recruit-init/scripts/install-dependencies.sh"

fail() {
  printf 'FAIL: %s\n' "$1" >&2
  exit 1
}

assert_equals() {
  expected=$1
  actual=$2
  message=$3
  [ "$expected" = "$actual" ] || fail "$message (expected $expected, got $actual)"
}

make_fake_tools() {
  sandbox=$1
  mkdir -p "$sandbox/fake-bin" "$sandbox/npm-prefix/bin" "$sandbox/home"

  cat >"$sandbox/fake-bin/node" <<'EOF'
#!/bin/sh
case "${1:-}" in
  --version) printf 'v24.0.0\n' ;;
  -p) printf '24\n' ;;
  *) exit 0 ;;
esac
EOF

  cat >"$sandbox/fake-bin/uname" <<'EOF'
#!/bin/sh
printf '%s\n' "${FAKE_UNAME:-Darwin}"
EOF

  cat >"$sandbox/fake-bin/npm" <<'EOF'
#!/bin/sh
if [ "${1:-}" = config ] && [ "${2:-}" = get ] && [ "${3:-}" = prefix ]; then
  printf '%s\n' "$FAKE_NPM_PREFIX"
  exit 0
fi
if [ "${1:-}" = uninstall ] && [ "${2:-}" = -g ]; then
  printf '%s\n' "$*" >>"$FAKE_NPM_LOG"
  exit 0
fi
if [ "${1:-}" = ci ]; then
  printf '%s\n' "$*" >>"$FAKE_NPM_LOG"
  exit 0
fi
if [ "${1:-}" = run ] && [ "${2:-}" = build ]; then
  printf '%s\n' "$*" >>"$FAKE_NPM_LOG"
  exit 0
fi
if [ "${1:-}" = pack ] && [ "${2:-}" = --pack-destination ]; then
  printf '%s\n' "$*" >>"$FAKE_NPM_LOG"
  touch "$3/joohw-boss-cli-0.6.5.tgz"
  printf 'joohw-boss-cli-0.6.5.tgz\n'
  exit 0
fi
if [ "${1:-}" = install ] && [ "${2:-}" = -g ]; then
  printf '%s\n' "$*" >>"$FAKE_NPM_LOG"
  case "${3:-}" in
    *boss*|*.tgz) executable=boss ;;
    *) executable=liepin ;;
  esac
  cat >"$FAKE_NPM_PREFIX/bin/$executable" <<'INNER'
#!/bin/sh
exit 0
INNER
  chmod +x "$FAKE_NPM_PREFIX/bin/$executable"
  exit 0
fi
printf 'unexpected npm invocation: %s\n' "$*" >&2
exit 2
EOF

  cat >"$sandbox/fake-bin/git" <<'EOF'
#!/bin/sh
printf '%s\n' "$*" >>"$FAKE_GIT_LOG"
destination=''
for argument in "$@"; do
  destination=$argument
done
mkdir -p "$destination"
EOF
  chmod +x "$sandbox/fake-bin/node" "$sandbox/fake-bin/npm" "$sandbox/fake-bin/uname" "$sandbox/fake-bin/git"
}

run_installer() {
  sandbox=$1
  shift
  HOME="$sandbox/home" \
  SHELL=/bin/zsh \
  PATH="$sandbox/fake-bin:/usr/bin:/bin" \
  FAKE_NPM_PREFIX="$sandbox/npm-prefix" \
  FAKE_NPM_LOG="$sandbox/npm.log" \
  FAKE_GIT_LOG="$sandbox/git.log" \
  FAKE_UNAME=Darwin \
    sh "$INSTALLER" "$@"
}

run_installer_with_global_bin_on_path() {
  sandbox=$1
  HOME="$sandbox/home" \
  SHELL=/bin/zsh \
  PATH="$sandbox/fake-bin:$sandbox/npm-prefix/bin:/usr/bin:/bin" \
  FAKE_NPM_PREFIX="$sandbox/npm-prefix" \
  FAKE_NPM_LOG="$sandbox/npm.log" \
  FAKE_GIT_LOG="$sandbox/git.log" \
  FAKE_UNAME=Darwin \
    sh "$INSTALLER"
}

test_first_macos_run_adds_profile_block() {
  sandbox=$(mktemp -d)
  trap 'rm -rf "$sandbox"' EXIT HUP INT TERM
  make_fake_tools "$sandbox"

  run_installer "$sandbox"

  profile="$sandbox/home/.zprofile"
  [ -f "$profile" ] || fail 'macOS zsh setup did not create ~/.zprofile'
  block_count=$(grep -c '^# >>> recruiting-copilot npm global bin >>>$' "$profile")
  assert_equals 1 "$block_count" 'managed PATH block count after first run'
  grep -F "export PATH=\"$sandbox/npm-prefix/bin:\$PATH\"" "$profile" >/dev/null ||
    fail 'managed PATH block does not contain npm global bin'
}

test_second_run_keeps_one_profile_block() {
  sandbox=$(mktemp -d)
  trap 'rm -rf "$sandbox"' EXIT HUP INT TERM
  make_fake_tools "$sandbox"

  run_installer "$sandbox" >/dev/null
  run_installer "$sandbox" >/dev/null

  block_count=$(grep -c '^# >>> recruiting-copilot npm global bin >>>$' "$sandbox/home/.zprofile")
  assert_equals 1 "$block_count" 'managed PATH block count after second run'
}

test_existing_path_leaves_profile_unchanged() {
  sandbox=$(mktemp -d)
  trap 'rm -rf "$sandbox"' EXIT HUP INT TERM
  make_fake_tools "$sandbox"
  printf 'export EXISTING_SETTING=1\n' >"$sandbox/home/.zprofile"

  run_installer_with_global_bin_on_path "$sandbox" >/dev/null

  actual=$(cat "$sandbox/home/.zprofile")
  assert_equals 'export EXISTING_SETTING=1' "$actual" 'profile changed even though npm bin was already on PATH'
}

test_boss_source_defaults_to_fork_and_can_be_overridden() {
  default_sandbox=$(mktemp -d)
  override_sandbox=$(mktemp -d)
  trap 'rm -rf "$default_sandbox" "$override_sandbox"' EXIT HUP INT TERM
  make_fake_tools "$default_sandbox"
  make_fake_tools "$override_sandbox"

  run_installer "$default_sandbox" >/dev/null
  BOSS_CLI_SOURCE='custom-boss-package@1.0.0' \
    run_installer "$override_sandbox" >/dev/null

  default_clone=$(sed -n '1p' "$default_sandbox/git.log")
  override_install=$(grep '^install -g ' "$override_sandbox/npm.log" | sed -n '1p')
  case "$default_clone" in
    'clone --depth 1 --branch main https://github.com/Viy1204/boss-cli.git '*) ;;
    *) fail "default Boss CLI clone source (got $default_clone)" ;;
  esac
  assert_equals \
    'install -g custom-boss-package@1.0.0' \
    "$override_install" \
    'overridden Boss CLI source'
}

test_existing_boss_package_is_removed_before_fork_install() {
  sandbox=$(mktemp -d)
  trap 'rm -rf "$sandbox"' EXIT HUP INT TERM
  make_fake_tools "$sandbox"

  run_installer "$sandbox" >/dev/null

  first_operation=$(grep -E '^(uninstall|install) -g ' "$sandbox/npm.log" | sed -n '1p')
  second_operation=$(grep -E '^(uninstall|install) -g ' "$sandbox/npm.log" | sed -n '2p')
  assert_equals 'uninstall -g @joohw/boss-cli' "$first_operation" 'existing Boss package removal order'
  case "$second_operation" in
    'install -g '*'/joohw-boss-cli-0.6.5.tgz') ;;
    *) fail "packed fork install order after removal (got $second_operation)" ;;
  esac
}

test_check_only_does_not_install_or_edit_profile() {
  sandbox=$(mktemp -d)
  trap 'rm -rf "$sandbox"' EXIT HUP INT TERM
  make_fake_tools "$sandbox"

  run_installer "$sandbox" --check-only >/dev/null

  [ ! -e "$sandbox/npm.log" ] || fail 'check-only invoked npm install'
  [ ! -e "$sandbox/home/.zprofile" ] || fail 'check-only edited the shell profile'
}

test_first_macos_run_adds_profile_block
test_second_run_keeps_one_profile_block
test_existing_path_leaves_profile_unchanged
test_boss_source_defaults_to_fork_and_can_be_overridden
test_existing_boss_package_is_removed_before_fork_install
test_check_only_does_not_install_or_edit_profile
printf 'PASS: install-dependencies\n'
