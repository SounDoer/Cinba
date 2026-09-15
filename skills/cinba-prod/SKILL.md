---
name: cinba-prod
description: Safely sync completed commits from Cinba's clean local master branch to origin and promote the exact revision to the prod branch. Use when a finished development stage is ready for production; never use it to prepare or commit unfinished work.
---

# Cinba Prod

Publish only work that the user has already committed. Keep judgment, previews, and confirmation
in this skill; keep the production branch mutation in the repository's tested `npm run promote`
command. Finishing means synchronizing the remote Git branches, not observing the VPS or Core.

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

If `origin/master` and `origin/prod` already report the target revision, report that both remote
branches are current and make no remote changes.

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
4. Confirm that both `origin/master` and `origin/prod` resolve to the target revision.

If the `master` push succeeds but promotion fails, report that partial state and stop. Never undo a
successful push automatically. A later invocation may safely resume from the published revision.

Report success as soon as both remote branches match the target. Do not inspect `CINBA_SERVER`,
query deployment or health endpoints, wait for the VPS, or claim that the running Core has changed.
