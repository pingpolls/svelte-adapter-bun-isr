#!/usr/bin/env bash
# Publish from a clean staging dir: `bun publish` hangs while packing when it
# walks fixtures/node_modules. Extra args (e.g. --otp 123456) go to bun publish.
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
stage="$(mktemp -d)"
trap 'rm -rf "$stage"' EXIT

cp -r "$root/package.json" "$root/dist" "$root/README.md" "$root/LICENSE" "$stage/"
cd "$stage"
bun publish --access public "$@"
