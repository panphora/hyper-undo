#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

if [ -n "$(git status --porcelain)" ]; then
  echo "✗ working tree dirty. commit or stash first." >&2
  exit 1
fi

npm test
npm version "${1:-patch}"
npm publish
git push --follow-tags
echo "✓ released $(node -p "require('./package.json').version")"
