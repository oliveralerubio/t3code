# Downstream releases

This fork maintains only its custom commits. Official T3 Code history remains
owned by upstream; it is disposable build input, not code that this fork edits
or owns.

Run:

```bash
scripts/sync-upstream.sh --upstream-ref v0.0.33 --dry-run
```

The command verifies that the current downstream base is compatible, rebases
the custom commits onto that upstream release, and runs the focused provider
checks plus the repository typecheck. Omit `--dry-run` only when the rebased
result is ready to update `origin/main` with `--force-with-lease`.

The release workflow builds a disposable upstream source tree, applies the
patch recorded in `downstream/overlay.json`, validates that it applies cleanly,
checks the upstream tag's pinned commit, and publishes the resulting Linux
AppImage to this fork. When moving to another upstream release, regenerate the
overlay patch and update both `upstreamRef` and `upstreamCommit` together.
Users install the AppImage; they do not clone or maintain T3 Code source.
