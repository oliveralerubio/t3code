#!/usr/bin/env bash

# Replay the downstream patches on top of an official T3 Code ref.
set -euo pipefail

repo_root="$(git rev-parse --show-toplevel)"
cd "$repo_root"

upstream_ref=""
push_changes=true

usage() {
  cat <<'EOF'
Usage: scripts/sync-upstream.sh [--upstream-ref REF] [--dry-run|--no-push]

Rebase the fork's custom commits onto upstream REF (default: the pinned ref in
downstream/overlay.json), run the focused downstream checks, and push origin
main with force-with-lease.

--dry-run, --no-push  validate locally without pushing origin main
EOF
}

while (($# > 0)); do
  case "$1" in
    --upstream-ref)
      if (($# < 2)); then
        echo "--upstream-ref requires a ref." >&2
        exit 2
      fi
      upstream_ref="$2"
      shift 2
      ;;
    --upstream-ref=*)
      upstream_ref="${1#*=}"
      if [[ -z "$upstream_ref" ]]; then
        echo "--upstream-ref requires a ref." >&2
        exit 2
      fi
      shift
      ;;
    --dry-run|--no-push)
      push_changes=false
      shift
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

manifest_path="$repo_root/downstream/overlay.json"
readarray -t manifest_metadata < <(node --input-type=module - "$manifest_path" <<'NODE'
import { readFileSync } from "node:fs";

const manifest = JSON.parse(readFileSync(process.argv[2], "utf8"));
console.log(manifest.upstreamRef);
console.log(manifest.upstreamCommit);
NODE
)
manifest_ref="${manifest_metadata[0]}"
manifest_commit="${manifest_metadata[1]}"
if [[ -z "$manifest_ref" || -z "$manifest_commit" ]]; then
  echo "downstream/overlay.json must define upstreamRef and upstreamCommit." >&2
  exit 1
fi
if [[ -z "$upstream_ref" ]]; then
  upstream_ref="$manifest_ref"
fi

if [[ "$(git branch --show-current)" != "main" ]]; then
  echo "sync-upstream.sh must be run from the main branch." >&2
  exit 1
fi

if [[ -n "$(git status --porcelain)" ]]; then
  echo "Working tree is not clean. Commit or stash changes before syncing." >&2
  exit 1
fi

git fetch upstream main --no-tags
current_upstream_tip="$(git rev-parse 'FETCH_HEAD^{commit}')"
git fetch upstream "$upstream_ref"
target_commit="$(git rev-parse 'FETCH_HEAD^{commit}')"
fork_base="$(git merge-base HEAD "$current_upstream_tip")"

if [[ "$manifest_ref" != "$upstream_ref" || "$manifest_commit" != "$target_commit" ]]; then
  echo "The downstream overlay is pinned to $manifest_ref ($manifest_commit), not $upstream_ref ($target_commit)." >&2
  echo "Regenerate downstream/overlay-*.patch and update downstream/overlay.json before syncing or pushing." >&2
  exit 1
fi

if ! git merge-base --is-ancestor "$fork_base" "$target_commit"; then
  echo "The current fork base $fork_base is not an ancestor of upstream $upstream_ref ($target_commit)." >&2
  exit 1
fi

echo "Rebasing custom commits from $fork_base onto upstream $upstream_ref ($target_commit)."
git rebase --onto "$target_commit" "$fork_base" main

# Keep this focused on downstream provider and metadata surfaces.
pnpm exec vp test run \
  apps/server/src/provider/Layers/AntigravityAdapter.test.ts \
  apps/server/src/provider/piRpcProtocol.test.ts \
  apps/server/src/provider/Layers/ProviderAdapterRegistry.test.ts \
  apps/web/src/components/settings/providerDriverMeta.test.ts
pnpm run typecheck

if [[ "$push_changes" == true ]]; then
  # A rebase rewrites our patch commits, so update the fork safely.
  git push --force-with-lease origin main
else
  echo "Dry run complete; origin main was not pushed."
fi
