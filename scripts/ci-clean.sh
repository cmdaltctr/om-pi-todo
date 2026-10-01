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
