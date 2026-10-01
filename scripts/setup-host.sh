#!/usr/bin/env bash
# Fetch the Pi host packages that tests and type checks borrow.
#
# The extension lists them as wildcard peers and never ships its own copies.
# Tests and `tsc` read them from `.pi-host/` instead, which is outside the
# project's `node_modules` and is git-ignored.
#
# Override the location with PI_HOST_MODULES (a `node_modules` directory that
# already holds the packages). Override the versions with PI_HOST_VERSION and
# TYPEBOX_VERSION.
set -euo pipefail

cd "$(dirname "$0")/.."

PI_HOST_VERSION="${PI_HOST_VERSION:-0.99.1}"
TYPEBOX_VERSION="${TYPEBOX_VERSION:-1.3.27}"
TARGET=".pi-host"

if [ -n "${PI_HOST_MODULES:-}" ]; then
	mkdir -p "$TARGET"
	ln -sfn "$PI_HOST_MODULES" "$TARGET/node_modules"
	echo "Linked $TARGET/node_modules -> $PI_HOST_MODULES"
	exit 0
fi

if [ -f "$TARGET/.versions" ] && [ "$(cat "$TARGET/.versions")" = "$PI_HOST_VERSION $TYPEBOX_VERSION" ] && [ -d "$TARGET/node_modules/@earendil-works/pi-tui" ]; then
	echo "Host packages already present ($PI_HOST_VERSION, typebox $TYPEBOX_VERSION)."
	exit 0
fi

mkdir -p "$TARGET"
printf '{ "private": true }\n' > "$TARGET/package.json"
npm install --prefix "$TARGET" --no-audit --no-fund --ignore-scripts --no-save \
	"@earendil-works/pi-coding-agent@$PI_HOST_VERSION" \
	"@earendil-works/pi-tui@$PI_HOST_VERSION" \
	"@earendil-works/pi-ai@$PI_HOST_VERSION" \
	"typebox@$TYPEBOX_VERSION"
printf '%s %s' "$PI_HOST_VERSION" "$TYPEBOX_VERSION" > "$TARGET/.versions"
echo "Installed host packages into $TARGET."
