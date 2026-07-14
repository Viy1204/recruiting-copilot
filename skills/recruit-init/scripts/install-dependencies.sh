#!/bin/sh
set -eu

BOSS_CLI_SOURCE=${BOSS_CLI_SOURCE:-git+https://github.com/Viy1204/boss-cli.git#main}
LIEPIN_CLI_SOURCE=${LIEPIN_CLI_SOURCE:-@viyzhu/liepin-cli}
PROFILE_BLOCK_START='# >>> recruiting-copilot npm global bin >>>'
PROFILE_BLOCK_END='# <<< recruiting-copilot npm global bin <<<'
CHECK_ONLY=0

usage() {
  cat <<'EOF'
Usage: install-dependencies.sh [--check-only]

Installs recruiting-copilot's Boss and Liepin CLIs. On macOS and other
Unix-like systems, it also repairs the npm global executable PATH when needed.

Environment overrides:
  BOSS_CLI_SOURCE    npm install source for Boss CLI
  LIEPIN_CLI_SOURCE  npm install source for Liepin CLI
EOF
}

die() {
  printf 'Error: %s\n' "$1" >&2
  exit 1
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --check-only) CHECK_ONLY=1 ;;
    -h|--help) usage; exit 0 ;;
    *) die "unknown option: $1" ;;
  esac
  shift
done

command -v node >/dev/null 2>&1 || die 'Node.js 20 or newer is required.'
command -v npm >/dev/null 2>&1 || die 'npm is required.'

node_major=$(node -p 'process.versions.node.split(".")[0]')
case "$node_major" in
  ''|*[!0-9]*) die "could not parse Node.js version: $node_major" ;;
esac
[ "$node_major" -ge 20 ] || die "Node.js 20 or newer is required (found $node_major)."

npm_prefix=$(npm config get prefix)
[ -n "$npm_prefix" ] || die 'npm global prefix is empty.'

platform=$(uname -s 2>/dev/null || printf 'unknown')
case "$platform" in
  MINGW*|MSYS*|CYGWIN*) npm_bin=$npm_prefix ;;
  *) npm_bin=$npm_prefix/bin ;;
esac

path_contains() {
  case ":${PATH:-}:" in
    *:"$1":*) return 0 ;;
    *) return 1 ;;
  esac
}

profile_path() {
  case "${SHELL:-}" in
    */zsh) printf '%s/.zprofile\n' "$HOME" ;;
    */bash) printf '%s/.bash_profile\n' "$HOME" ;;
    *) printf '%s/.profile\n' "$HOME" ;;
  esac
}

write_managed_path_block() {
  profile=$1
  bin_dir=$2
  mkdir -p "$(dirname "$profile")"
  touch "$profile"

  escaped_bin=$(printf '%s' "$bin_dir" | sed 's/[\\"`$]/\\&/g')
  temp_file=$(mktemp "${TMPDIR:-/tmp}/recruiting-copilot-profile.XXXXXX")
  awk -v start="$PROFILE_BLOCK_START" -v end="$PROFILE_BLOCK_END" '
    $0 == start { skipping = 1; next }
    $0 == end { skipping = 0; next }
    !skipping { print }
  ' "$profile" >"$temp_file"

  if [ -s "$temp_file" ] && [ "$(tail -c 1 "$temp_file" 2>/dev/null || true)" != '' ]; then
    printf '\n' >>"$temp_file"
  fi
  {
    printf '%s\n' "$PROFILE_BLOCK_START"
    printf 'export PATH="%s:$PATH"\n' "$escaped_bin"
    printf '%s\n' "$PROFILE_BLOCK_END"
  } >>"$temp_file"
  mv "$temp_file" "$profile"
}

printf 'Node.js: v%s\n' "$node_major"
printf 'npm global bin: %s\n' "$npm_bin"
printf 'Boss CLI source: %s\n' "$BOSS_CLI_SOURCE"

if ! path_contains "$npm_bin"; then
  if [ "$CHECK_ONLY" -eq 1 ]; then
    printf 'PATH needs update: add %s\n' "$npm_bin"
  else
    profile=$(profile_path)
    write_managed_path_block "$profile" "$npm_bin"
    PATH="$npm_bin:$PATH"
    export PATH
    printf 'Updated shell PATH in %s\n' "$profile"
  fi
fi

if [ "$CHECK_ONLY" -eq 1 ]; then
  printf 'Check only: no packages were installed.\n'
  exit 0
fi

boss_install_source=$BOSS_CLI_SOURCE
boss_build_dir=''
case "$BOSS_CLI_SOURCE" in
  git+*'#'*)
    command -v git >/dev/null 2>&1 || die 'git is required to build the Boss CLI fork.'
    repository_and_ref=${BOSS_CLI_SOURCE#git+}
    boss_repository=${repository_and_ref%#*}
    boss_ref=${repository_and_ref##*#}
    [ -n "$boss_repository" ] || die 'Boss CLI repository is empty.'
    [ -n "$boss_ref" ] || die 'Boss CLI git ref is empty.'

    boss_build_dir=$(mktemp -d "${TMPDIR:-/tmp}/recruiting-copilot-boss.XXXXXX")
    cleanup_boss_build() {
      rm -rf "$boss_build_dir"
    }
    trap cleanup_boss_build 0 HUP INT TERM

    printf 'Cloning Boss CLI fork (%s)...\n' "$boss_ref"
    git clone --depth 1 --branch "$boss_ref" "$boss_repository" "$boss_build_dir/source"
    printf 'Building Boss CLI fork...\n'
    (
      cd "$boss_build_dir/source"
      npm ci
      npm run build
      npm pack --pack-destination "$boss_build_dir"
    )
    set -- "$boss_build_dir"/*.tgz
    [ "$#" -eq 1 ] && [ -f "$1" ] || die 'Boss CLI build did not produce exactly one package archive.'
    boss_install_source=$1
    ;;
esac

printf 'Removing any existing Boss CLI package...\n'
npm uninstall -g @joohw/boss-cli
printf 'Installing Boss CLI from maintained fork...\n'
npm install -g "$boss_install_source"
printf 'Installing Liepin CLI...\n'
npm install -g "$LIEPIN_CLI_SOURCE"

boss_executable=$npm_bin/boss
liepin_executable=$npm_bin/liepin
[ -x "$boss_executable" ] || die "Boss CLI executable not found at $boss_executable"
[ -x "$liepin_executable" ] || die "Liepin CLI executable not found at $liepin_executable"

"$boss_executable" help >/dev/null 2>&1
"$liepin_executable" --version >/dev/null 2>&1

printf 'Boss CLI ready: %s\n' "$boss_executable"
printf 'Liepin CLI ready: %s\n' "$liepin_executable"
printf 'Next: run "boss login" and "liepin login" once in a new terminal.\n'
