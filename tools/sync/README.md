# Sync engine

`sync.mjs` mirrors code from a private upstream repository into this one.

It is deliberately generic: every project-specific rule lives in the upstream
repository under `.github/mallkit/`, so this public repository never contains a
brand name, a phone number, or an environment id — not even as a pattern to
strip out.

## Running it

```sh
node tools/sync/sync.mjs \
  --manifest ../upstream/.github/mallkit/manifest.json \
  --src ../upstream \
  --dest . \
  --no-push
```

`--dry-run` also skips writing `state.json`, which is useful while iterating on
a manifest.

## What a run does

1. Lists upstream files and drops everything matching the manifest `deny` globs.
2. Copies the rest, rewriting text through the manifest `replace` table.
   Binary files are copied byte for byte. Text output is normalized to LF.
3. Overlays `overrides`, which are template files authored in the upstream rules
   directory and copied verbatim.
4. Deletes files that a previous run produced and this one does not, after
   asserting none of them are `targetOwned`.
5. Verifies every promised file exists, then scans the tree for forbidden
   patterns. Any hit rolls the tree back and exits non-zero without committing.
6. Writes `state.json` and commits, if anything actually changed.

The commit message carries only the upstream short sha. Upstream commit
subjects are never copied, because they routinely mention the private brand.

## Pattern files

`forbidden.json` here holds generic shapes: a mainland China mobile number, a
WeChat AppID, a private key header, a JWT, a signed object-storage URL. Concrete
literals belong in the upstream `forbidden.private.json`, which stays private.

Run `node tools/sync/selftest.mjs` after changing either file. It builds
throwaway repositories, exercises the engine end to end, and asserts that every
pattern both catches what it should and allows its documented placeholder.
