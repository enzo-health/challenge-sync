# Local checks as the GitHub merge gate

The full build and test suite runs on the developer machine. GitHub branch protection requires the
`local-checks` commit status, so a pull request cannot merge until that exact pushed commit passes
locally. GitHub Actions does not rerun the suite.

## Sign off a commit

Commit and push the exact revision you want reviewed, then run:

```bash
just signoff
```

The command refuses uncommitted tracked changes or an unpushed commit, runs `just check`, and posts
`local-checks=success` to the current commit through `gh`. Any new commit has a different SHA and
must be signed off again.

## What `just check` runs

`scripts/check.sh` runs in two tiers:

- **Fast tier, always** (about 1.5 seconds warm): the build, typecheck, `cargo test`, syntax checks,
  unit tests, the extension's own sync code against a local server
  (`scripts/test-extension-sync-e2e.mjs`), and every server e2e, all at once. Each server e2e
  starts its own debug server on a free port with a temporary database.
- **Live tier, only when needed** (about 2.5 minutes): the two browser tests that drive the real
  extension against the developer's own LinkedIn account (`scripts/test-extension-e2e.mjs`, then
  `scripts/test-join-flow-e2e.mjs`). They run when anything they depend on has changed since they
  last passed on this machine: any file under `extension/`, the two test scripts, `server/app/join/`
  or `server/components/get-started.tsx`. "Changed" is a content hash, so uncommitted edits count.
  After both pass, the hash is kept in `.check-live-pass` (git-ignored); a later run with the same
  hash reports them as `skip` and still passes. They load `extension/dist/unpacked`, which must
  match the sources (`just extension-dev`), or the run fails before touching LinkedIn.

`scripts/check.sh --live-status` says whether the live tier would run. `CHECK_LIVE=always` forces
it; `CHECK_LIVE=never` skips it, and if it was due, says so loudly, records nothing, and exits 3.

`just signoff` never skips a due live tier: it ignores `CHECK_LIVE=never`. When the live tier was
skipped because nothing it depends on changed, the posted status says so ("LinkedIn browser tests
skipped, extension unchanged since their last pass"); otherwise it says they ran.

## One-time GitHub setup

GitHub must support branch protection for the repository. For a private repository on a personal
Free plan, GitHub returns `403` and requires either GitHub Pro or making the repository public. In
that state, `just signoff` still publishes a visible status on the exact commit, but GitHub cannot
enforce it as a merge blocker.

In the repository settings, add a branch ruleset for `main` that:

1. Requires a pull request before merging.
2. Requires status checks to pass.
3. Selects the `local-checks` status context.
4. Requires branches to be up to date before merging, if that matches the team's merge policy.

Post at least one status with `just signoff` before selecting it in the GitHub settings UI.

This is an attestation by the developer and their authenticated GitHub CLI; it proves that the
repository's local check command reported success for the exact commit. It does not provide the
isolated execution guarantees of hosted CI, so branch protection and write access should remain
limited to trusted contributors.
