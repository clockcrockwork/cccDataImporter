#!/bin/bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"
if [ "$(node --version)" != "v$(cat .nvmrc)" ]; then
  echo "Use the Node version in .nvmrc (nvm install && nvm use) before starting RSS." >&2
  exit 1
fi

# Keep the locked optional Sharp/libvips binaries; never rewrite dependencies at startup.
SHARP_IGNORE_GLOBAL_LIBVIPS=1 corepack yarn install --frozen-lockfile --non-interactive

cd packages/fetchRss
node src/index.js
