#!/usr/bin/env bash
# Run the CI gate on a fresh clone of the committed code.
#
# CI starts from a clean clone. Your working folder does not: it can hold a
# hand-made node_modules, files you forgot to commit, or settings CI lacks.
# This script removes that gap. It checks what `git push` would publish.
#
# Uncommitted changes are NOT tested. Commit first.
set -euo pipefail

root="$(git rev-parse --show-toplevel)"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

if [ -n "$(git -C "$root" status --porcelain --untracked-files=no)" ]; then
	echo "ci-clean: note: you have uncommitted changes. Only committed code is tested."
fi

echo "ci-clean: cloning $(git -C "$root" rev-parse --short HEAD) into a temporary folder"
git clone --quiet --no-hardlinks "$root" "$tmp/repo"
cd "$tmp/repo"

# CI pins a Node version. A different major here has passed locally and failed in CI before.
ci_node="$(sed -n 's/^ *node-version: *\([0-9][0-9]*\).*/\1/p' .github/workflows/ci.yml | head -1)"
local_node="$(node -p 'process.versions.node.split(".")[0]')"
if [ -n "$ci_node" ] && [ "$ci_node" != "$local_node" ]; then
	echo "ci-clean: warning: you run Node $local_node but CI runs Node $ci_node. A pass here does not prove CI passes."
	echo "ci-clean: warning: use a Node $ci_node install (for example with fnm, nvm or mise) to remove this gap."
fi

# Same as CI: no Husky hook, install from the lockfile.
export HUSKY=0
bun install --frozen-lockfile

# Reuse the host packages you already downloaded instead of fetching 500 MB again.
if [ -d "$root/.pi-host/node_modules" ]; then
	PI_HOST_MODULES="$root/.pi-host/node_modules" ./scripts/setup-host.sh
else
	./scripts/setup-host.sh
fi

bun run ci
echo "ci-clean: passed"
