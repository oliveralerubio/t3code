#!/usr/bin/env bash

# Verify or apply the custom source layer on top of an upstream T3 Code tree.
# The upstream tree is disposable build input; only the patch and manifest are
# maintained by this fork.
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
repo_root="$(cd "$script_dir/.." && pwd -P)"
manifest="$repo_root/downstream/overlay.json"
source_dir=""
apply_patch_flag=0

usage() {
  cat >&2 <<'EOF'
Usage: scripts/apply-downstream-overlay.sh --source-dir DIR [--manifest FILE] [--apply]

Without --apply, verifies the patch checksum and that it applies cleanly.
EOF
}

while (($# > 0)); do
  case "$1" in
    --manifest)
      (($# >= 2)) || { usage; exit 2; }
      manifest="$2"
      shift 2
      ;;
    --source-dir)
      (($# >= 2)) || { usage; exit 2; }
      source_dir="$2"
      shift 2
      ;;
    --apply)
      apply_patch_flag=1
      shift
      ;;
    --help|-h)
      usage >&1
      exit 0
      ;;
    *)
      usage
      exit 2
      ;;
  esac
done

[[ -n "$source_dir" && -d "$source_dir" ]] || {
  echo "--source-dir must point to an existing directory." >&2
  exit 2
}
[[ -f "$manifest" ]] || {
  echo "Overlay manifest not found: $manifest" >&2
  exit 1
}

manifest_dir="$(cd "$(dirname "$manifest")" && pwd -P)"
readarray -t metadata < <(node --input-type=module - "$manifest" <<'NODE'
import { readFileSync } from "node:fs";

const manifest = JSON.parse(readFileSync(process.argv[2], "utf8"));
for (const key of ["upstreamRepository", "upstreamRef", "upstreamCommit", "patch", "patchSha256"]) {
  if (typeof manifest[key] !== "string" || manifest[key].length === 0) {
    throw new Error(`Overlay manifest field '${key}' must be a non-empty string.`);
  }
  console.log(`${key}=${manifest[key]}`);
}
NODE
)

for entry in "${metadata[@]}"; do
  case "$entry" in
    upstreamRepository=*) upstream_repository="${entry#*=}" ;;
    upstreamRef=*) upstream_ref="${entry#*=}" ;;
    upstreamCommit=*) upstream_commit="${entry#*=}" ;;
    patch=*) patch_name="${entry#*=}" ;;
    patchSha256=*) expected_sha256="${entry#*=}" ;;
  esac
done

normalize_repository_slug() {
  local remote_url="$1"
  remote_url="${remote_url%.git}"
  remote_url="${remote_url#https://github.com/}"
  remote_url="${remote_url#http://github.com/}"
  remote_url="${remote_url#ssh://git@github.com/}"
  remote_url="${remote_url#git@github.com:}"
  printf '%s' "$remote_url"
}

actual_commit="$(git -C "$source_dir" rev-parse HEAD^{commit} 2>/dev/null || true)"
if [[ -z "$actual_commit" ]]; then
  echo "Overlay source must be a Git checkout with a resolvable HEAD commit." >&2
  exit 1
fi
if [[ "$actual_commit" != "$upstream_commit" ]]; then
  echo "Overlay source commit '$actual_commit' does not match manifest upstreamCommit '$upstream_commit'." >&2
  exit 1
fi

matching_remote=0
while IFS= read -r remote_name; do
  remote_url="$(git -C "$source_dir" remote get-url "$remote_name" 2>/dev/null || true)"
  if [[ "$(normalize_repository_slug "$remote_url")" == "$upstream_repository" ]]; then
    matching_remote=1
    break
  fi
done < <(git -C "$source_dir" remote 2>/dev/null || true)
if ((matching_remote == 0)); then
  echo "Overlay source has no remote matching upstreamRepository '$upstream_repository'." >&2
  exit 1
fi

patch_path="$(realpath -m "$manifest_dir/$patch_name")"
case "$patch_path" in
  "$manifest_dir"/*) ;;
  *)
    echo "Overlay patch must remain inside the manifest directory: $patch_name" >&2
    exit 1
    ;;
esac
[[ -f "$patch_path" ]] || {
  echo "Overlay patch not found: $patch_path" >&2
  exit 1
}

actual_sha256="$(sha256sum "$patch_path" | awk '{print $1}')"
if [[ "$actual_sha256" != "$expected_sha256" ]]; then
  echo "Overlay patch checksum mismatch for upstream $upstream_repository@$upstream_ref." >&2
  echo "Expected: $expected_sha256" >&2
  echo "Actual:   $actual_sha256" >&2
  exit 1
fi

git -C "$source_dir" apply --check --binary "$patch_path"
if ((apply_patch_flag)); then
  git -C "$source_dir" apply --binary "$patch_path"
  echo "Applied downstream overlay on $upstream_repository@$upstream_ref ($upstream_commit)."
else
  echo "Verified downstream overlay for $upstream_repository@$upstream_ref ($upstream_commit)."
fi
