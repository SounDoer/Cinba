---
name: cinba-release
description: Prepare, draft, verify, publish, or record a Cinba product release. Use for release readiness, SemVer preparation, bilingual release changes, the Prepare product release workflow, draft review, publication, and post-release checks; do not use for ordinary CI or package publishing.
---

# Cinba Release

Guide a Cinba release from repository state to a verified public release without collapsing preparation, external mutation, and publication into one implicit action.

## Start from current evidence

Before proposing or performing release work, inspect the current repository and GitHub state. At minimum, establish:

- the worktree status, current branch, `HEAD`, and `origin/master`;
- the root product version in `package.json` and its root lockfile entry;
- the latest published stable release and tag;
- any draft release or active/recent `Prepare product release` run;
- the commits and material diff since the latest published tag.

Fetch remote state when an accurate release decision depends on it. Treat code on `master` as authoritative. Use `README.md` and `docs/notes/` as context and historical evidence, not as a reusable checklist when they disagree with current code.

Read the current implementation before relying on release mechanics or wording:

- `.github/workflows/release.yml` owns release identity, native builds, attestations, and draft creation.
- `scripts/release-notes.ts` owns the complete bilingual release body and installation wording.
- `scripts/assemble-release.ts` owns the manifest and checksum set.
- `packages/installer/src/product-release-constants.ts` and the target definitions own compatibility metadata.
- `scripts/acceptance/README.md` describes checks that intentionally remain outside CI.

Do not duplicate changing artifact names, platform baselines, signing claims, or installation commands in this skill.

## Choose the requested stage

Keep these stages distinct. Complete only the stages the user requested or clearly authorized.

### Audit readiness

Report the exact version, candidate revision, comparison range, release workflow state, and blockers. Distinguish automated evidence from manual acceptance. Do not edit files or mutate GitHub when the user asks only for an audit, explanation, or draft copy.

### Prepare a version

Derive the release story from the latest published stable tag through the intended candidate revision. Inspect diffs for user-visible behavior rather than turning commit subjects into release notes.

Recommend a SemVer increment when useful, but let the user decide when compatibility or product intent makes the choice ambiguous. Cinba currently accepts stable `X.Y.Z` versions only.

When authorized to prepare the repository:

1. Update the root `package.json` version and the corresponding root entries in `package-lock.json`. Do not version individual workspace packages unless the product model changes.
2. Draft aligned Chinese and English change bullets using the rules below.
3. Render the notes locally through `scripts/release-notes.ts` with the proposed change inputs. Review the complete result for facts, filenames, links, system requirements, and signing language.
4. Run `npm run check` before treating the candidate as ready or pushing it.
5. If a commit was requested, use `chore(release): prepare X.Y.Z` unless the actual change needs a different conventional scope.

Do not create a branch silently. Do not push merely because preparation was requested.

### Create and review a draft

Creating a draft is an external mutation and requires an explicit request. Before dispatching `.github/workflows/release.yml`, present or confirm all four locked inputs:

- stable version without `v`;
- full lowercase 40-character commit SHA from `master`;
- final Chinese Markdown changes;
- final English Markdown changes.

The candidate SHA may be later than the version-preparation commit when a release-blocking fix was added afterward. Never substitute the current `HEAD` without checking and reporting the exact revision.

Follow the workflow until it either fails or creates the draft. A failed or cancelled run is not permission to retry with another revision, edit code, or dispatch repeatedly. Diagnose the failure, preserve successful evidence where useful, and obtain any new authority the fix or retry requires.

Review the completed draft against current code and the locked inputs. Verify:

- the Windows, macOS, and Linux native jobs passed `npm run check` and built from one revision;
- the draft has exactly the expected platform artifacts plus `install.sh`, `cinba-release.json`, and `SHA256SUMS`;
- version, revision, target, size, and SHA-256 agree across the assets, manifest, and checksum file;
- required artifact attestations exist;
- the published draft body matches a local render of `scripts/release-notes.ts`;
- relevant manual acceptance is complete, or remaining risk is stated explicitly.

Do not publish merely because automation passed.

### Publish and verify

Publishing is a separate, consequential action. Require an explicit request to publish the identified draft after reporting remaining acceptance gaps and known risks. Do not infer publication authority from requests such as “prepare a release,” “run the workflow,” or “fix the draft.”

After publication, verify the observable outcome:

- the release is neither draft nor prerelease and is marked immutable;
- the release tag and target revision match the candidate;
- the release is returned as `latest` when appropriate;
- all expected public assets remain available and their digests still agree;
- the public Linux bootstrap works in a suitable clean environment;
- the installed product/updater discovers the new stable release and ignores drafts and prereleases.

Perform platform-specific destructive acceptance, installation, upgrade, service changes, or purge only when those exact systems and effects are in scope.

### Record the release

When requested, add the release result and meaningful acceptance evidence to the relevant Chinese file under `docs/notes/`. Record facts, risks, failures, and follow-up fixes; do not rewrite old unchecked items as if they were newly verified. Repository code, commit messages, and identifiers remain English.

## Write the change inputs

The workflow accepts only the variable “changes” sections. `scripts/release-notes.ts` supplies the title, installation instructions, update instructions, and bilingual structure.

Use two to four concise bullets in most releases. Align Chinese and English bullet-for-bullet by meaning, while writing naturally in each language.

Prioritize:

1. new user capabilities;
2. fixed user-visible failures or unsafe behavior;
3. compatibility, installation, update, migration, or service-lifecycle changes;
4. material real-environment validation when it changes release confidence.

Exclude ordinary refactors, test counts, documentation housekeeping, version-bump mechanics, and raw commit lists unless they materially affect users or release risk. Describe outcomes before implementation details. Do not claim support, signing, notarization, acceptance, or compatibility that the candidate evidence does not prove.

For a patch release, keep the copy proportional to the fix. For a larger release, group related commits into product outcomes instead of writing one bullet per commit.

Present the proposed input independently before any workflow dispatch:

```markdown
Chinese changes

- ...

English changes

- ...
```

## Report decisions clearly

At each stopping point, state:

- what stage is complete;
- the exact version and candidate SHA;
- what was verified and what remains manual;
- whether any repository, remote Git, workflow, draft, or public release state changed;
- the next action that would require explicit authorization.

