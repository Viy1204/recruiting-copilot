# macOS and Boss CLI fork installer design

## Goal

Make first-time recruiting-copilot setup work on macOS without manual PATH repair, and install the maintained `Viy1204/boss-cli` fork while the upstream npm release is behind Boss's current frontend.

## Dependency installer

Add `skills/recruit-init/scripts/install-dependencies.sh` as the public setup seam. It must:

- require Node.js 20 or newer and npm;
- build Boss CLI from `git+https://github.com/Viy1204/boss-cli.git#main` by default;
- allow `BOSS_CLI_SOURCE` to override that source;
- install `@viyzhu/liepin-cli` from npm;
- locate the npm global executable directory from `npm config get prefix`;
- make the directory available to the running installer immediately;
- on macOS with zsh, add one idempotent managed PATH block to `~/.zprofile` when needed;
- use `~/.zprofile` for other zsh environments and `~/.bash_profile` or `~/.profile` for bash;
- verify the installed executables through absolute paths so a stale parent shell cannot cause a false failure;
- support a check-only mode for safe environment diagnosis.

The managed profile block must be stable and replaceable, with clear start and end comments. Re-running the installer must not append a second block.

## Workflow integration

Update the recruit-init skill and README so agents run the installer instead of duplicating npm commands. Preserve the existing rule that missing platform CLIs do not block workspace creation. Explain that a new terminal inherits the repaired PATH, while the current installer already uses the resolved absolute paths.

## Test seams

Shell tests exercise only public behavior:

1. First macOS/zsh run adds exactly one managed PATH block.
2. A second run keeps exactly one block.
3. An environment whose PATH already contains npm's global bin leaves the profile unchanged.
4. The default Boss package source is the Viy1204 fork and an environment override is honored.
5. Check-only mode does not invoke npm installation.

Tests use temporary HOME directories and fake `node`, `npm`, and `uname` executables; they never change the developer's actual shell profile or global packages.

## Durable fork packaging

Real-machine validation found that npm 11 can install a global Git dependency as a symbolic link into npm's temporary clone directory. A later npm operation may reuse that directory and remove the `boss` executable. The installer therefore shallow-clones the selected fork ref, runs `npm ci` and the TypeScript build, creates a package archive with `npm pack`, and installs that archive globally. It does not preemptively uninstall the previous Boss package; npm receives the completed archive as an in-place upgrade. This keeps the previous executable available through build failures and makes the final global package independent of npm's temporary cache.

## Boss CLI fork publication

Validate `chore/boss-baseline-2026-07-14`, merge it into `Viy1204/boss-cli` `main`, run its TypeScript build, and push the merge. Recruiting-copilot then targets the fork's main branch so new users receive the reviewed `v10718` / `v6230` safety baseline without a private local workaround.
