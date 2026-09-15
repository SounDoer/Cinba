---
name: cinba-prod
description: Safely sync completed commits from Cinba's clean local master branch to origin, promote the exact revision to prod, and verify the deployed Core. Use when a finished development stage is ready for production; never use it to prepare or commit unfinished work.
---

# Cinba Prod

Publish only work that the user has already committed. Keep judgment, previews, confirmation, and
verification in this skill; keep the production branch mutation in the repository's tested
`npm run promote` command.

## Preconditions

Work from the Cinba repository root. Before running quality checks or changing a remote:

- Require the current branch to be `master`.
- Require `git status --porcelain=v1 --untracked-files=all` to produce no output. If it reports
  staged, unstaged, or untracked files, show the statuses and stop immediately.
- Never add, commit, amend, stash, clean, discard, or otherwise modify local work.
- Require an `origin` remote and fetch `origin/master` and `origin/prod` before comparing revisions.
- Stop if local `master` is behind or has diverged from `origin/master`; do not pull, merge, rebase,
  force-push, or repair history.
- Stop if `origin/prod` cannot fast-forward to the local `master` target.
- Require `CINBA_SERVER` to identify the remote Core before publishing. Use
  `node scripts/cinba.ts doctor` to confirm that the configured Core is reachable. Do not substitute
  a local Core and do not query Core endpoints outside `packages/core-client`.

If `origin/master`, `origin/prod`, and the healthy remote Core already report the target revision,
report that production is current and make no remote changes.

## Preview and check

Resolve the full target revision from `HEAD`. Show:

- the commits that would be added to `origin/master`;
- the commits that would be added to `origin/prod`;
- the current and target revisions for both remote branches.

Run `npm run check`. If it fails, stop without pushing. After it passes, confirm that the working
tree is still clean and `HEAD` is still the recorded target revision.

Present one concise final preview and obtain explicit user confirmation immediately before the
remote mutations. The confirmation covers pushing the target to `master` and then promoting that
same target to `prod`; it does not authorize any history rewrite or local-work cleanup.

## Publish

After confirmation:

1. If local `master` is ahead, push the exact target to `origin/master` without force.
2. Confirm that `origin/master` resolves to the target.
3. If `origin/prod` is behind the target, run `npm run promote`. Do not reproduce its internal Git
   operations and do not push `prod` directly.

If the `master` push succeeds but promotion fails, report that partial state and stop. Never undo a
successful push automatically. A later invocation may safely resume from the published revision.

## Verify production

After promotion, periodically run `node scripts/cinba.ts doctor` with the existing `CINBA_SERVER`
configuration until the remote Core reports the full target revision. Allow up to 20 minutes for
the VPS timer, checks, draining, and activation. Do not rerun `promote` merely because deployment is
still pending.

Report success only when the remote Core is healthy and its revision matches the target. If the
deadline expires or the Core remains unreachable, state clearly that the Git promotion succeeded
but deployment verification is inconclusive, including the target and last observed revision.
