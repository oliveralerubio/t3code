#!/usr/bin/env bash

# Replay the Claudex patches on top of the latest official T3 Code main.
set -euo pipefail

repo_root="$(git rev-parse --show-toplevel)"
cd "$repo_root"

if [[ "$(git branch --show-current)" != "main" ]]; then
  echo "sync-upstream.sh must be run from the main branch." >&2
  exit 1
fi

if [[ -n "$(git status --porcelain)" ]]; then
  echo "Working tree is not clean. Commit or stash changes before syncing." >&2
  exit 1
fi

git fetch upstream main
git rebase upstream/main

# Keep this focused on the Claudex UI surface that the patches change.
pnpm exec vp test run apps/web/src/hooks/useTheme.test.ts
pnpm exec vp run --filter @t3tools/web typecheck

# A rebase rewrites our patch commits, so update the fork safely.
git push --force-with-lease origin main
