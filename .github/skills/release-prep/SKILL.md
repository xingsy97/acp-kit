---
name: release-prep
description: "Use when: preparing, validating, publishing, or verifying an ACP Kit release; release checklist; changelog, README, package version, tag, npm publish, GitHub Actions release workflow."
---

# ACP Kit Release Prep

Use this skill before shipping a new `@acp-kit/core` or `@acp-kit/spar` release from the `acp-kit` repository.

## Ground Rules

- Run all commands from the repository root.
- Preserve unrelated local changes. Do not reset, checkout, or discard user edits.
- **The release workflow is tag-driven and per-package.** `.github/workflows/release.yml` triggers on two independent tag families, and each publishes exactly one package:
  - `core-vX.Y.Z` publishes only `@acp-kit/core`; GitHub Release notes come from the matching section in root `CHANGELOG.md`.
  - `spar-vX.Y.Z` publishes only `@acp-kit/spar`; GitHub Release notes come from `packages/author-reviewer-loop/CHANGELOG.md`.
- **The two packages version independently.** Only the package you are releasing needs its `package.json` version to equal the tag version. Do not bump or re-publish the other package just to keep the numbers aligned.
- If a spar release needs new core functionality, **publish `core-v...` first**. The workflow refuses a `spar-v...` release whose declared `@acp-kit/core` dependency baseline is not yet on npm.
- The workflow is **idempotent**: if the exact version is already on npm (published from the same commit) it skips `npm publish` and only (re)creates the GitHub Release. If the version exists but was published from a different commit, it fails loudly instead of attaching a release to mismatched code.
- For stable versions, npm publishes with `latest`; prerelease versions (the version string contains `-`) publish with `next`.
- **Releases ride on top of normal development history.** Do not create a dedicated "Release X.Y.Z" commit. Instead, fold the version bump and changelog update into the regular feature/fix commit they belong to (or whatever in-progress commit the work logically lives in), then tag that commit. Tagging a normal commit is what triggers the release.

## 1. Inspect Current State

Run these first:

```bash
git status --short --branch
git log -5 --oneline --decorate
git tag --list 'core-v*' 'spar-v*' | tail -n 10
npm view @acp-kit/core version dist-tags.latest
npm view @acp-kit/spar version dist-tags.latest
```

If the worktree has changes, identify whether they are release changes, user changes, or unrelated generated files. Keep unrelated user changes intact.

## 2. Decide The Package And Version

First decide **which package** you are releasing: `core` or `spar`. Release them with separate tags and separate changelog entries; never bump both just to keep the numbers in lockstep.

Pick the smallest SemVer bump that fits the changes:

- Patch: bug fixes, docs corrections, small compatibility fixes.
- Minor: new features or breaking changes while still in `0.x`.
- Prerelease: use `X.Y.Z-alpha.N`, `X.Y.Z-beta.N`, or similar when the release should go to npm `next`.

Check that the target tag does not already exist locally or remotely (`$pkg` is `core` or `spar`):

```bash
pkg=spar
version=0.10.2
git tag --list "${pkg}-v$version"
git ls-remote --tags origin "${pkg}-v$version"
```

## 3. Update Release Notes And Docs

Update root `CHANGELOG.md` only for `@acp-kit/core`, repository-wide release infrastructure, docs-site, or cross-package changes:

- Keep `## [Unreleased]` at the top.
- Add `## [$version] - YYYY-MM-DD` directly below it.
- Move relevant unreleased bullets into `Added`, `Changed`, `Fixed`, or `Removed` sections.
- Mention package names when useful, especially `@acp-kit/core` vs repository tooling.
- Do **not** duplicate Spar-only changes in root `CHANGELOG.md`. Spar CLI/TUI/runtime/docs/package metadata changes belong in `packages/author-reviewer-loop/CHANGELOG.md` only.

Update `packages/author-reviewer-loop/CHANGELOG.md` when that package behavior, CLI, TUI, docs, or package metadata changed.

Update README/docs only when user-facing behavior changed:

- Root `README.md` for core runtime behavior, install, supported agents, or examples.
- `packages/author-reviewer-loop/README.md` for CLI flags, environment variables, TUI behavior, usage display, exit behavior, or examples.
- `docs/**` when site docs should reflect the same change.

Do not write new README files unless explicitly requested.

## 4. Bump The Released Package Version

Only the package you are releasing changes version. The version in its `package.json` must equal the tag version.

For a **core** release:

```bash
version=0.10.2
npm pkg set "version=$version" -w packages/core
npm install --package-lock-only
```

For a **spar** release:

```bash
version=0.11.0
npm pkg set "version=$version" -w packages/author-reviewer-loop
# Only when this spar release requires a newer @acp-kit/core line (publish core first):
# npm pkg set "dependencies.@acp-kit/core=^<core-version>" -w packages/author-reviewer-loop
npm install --package-lock-only
```

The root `package.json` version is not used by the release workflow. Use the `-w <path>` form (the spar package is named `@acp-kit/spar`, so `-w @acp-kit/author-reviewer-loop` does not resolve).

## 5. Validate Locally

Run the same core checks as CI/release plus docs when documentation changed:

```bash
npm run build
npm test
npm run docs:build
git diff --check
```

For changed `.mjs` files, syntax-check them explicitly:

```bash
node --check packages/author-reviewer-loop/bin/acp-author-reviewer-loop.mjs
node --check packages/author-reviewer-loop/lib/engine.mjs
node --check packages/author-reviewer-loop/lib/runtime/role.mjs
node --check packages/author-reviewer-loop/lib/renderers/plain.mjs
node --check packages/author-reviewer-loop/lib/renderers/tui.mjs
```

Run a version sanity check before committing (`$pkg` is `core` or `spar`):

```bash
node -e "const pkg=process.argv[1], v=process.argv[2]; const dir=pkg==='core'?'packages/core':'packages/author-reviewer-loop'; const m=require('./'+dir+'/package.json'); if(m.version!==v) throw new Error(pkg+' version mismatch: '+m.version+' != '+v); console.log('version ok', pkg, v);" "$pkg" "$version"
```

Optionally, before a release, run the gated real-agent smoke tests against installed agents (skipped by default so normal `npm test` stays fast):

```bash
npm run build
SPAR_REAL_AGENT_E2E=1 SPAR_REAL_AGENT_E2E_AGENTS=codex,claude npm test
```

If validation fails, fix the root cause and rerun the relevant checks.

## 6. Review The Final Diff

Before committing:

```bash
git status --short --branch
git diff --stat
# For a core release:
git diff -- CHANGELOG.md packages/core/package.json package-lock.json
# For a spar release:
git diff -- packages/author-reviewer-loop/CHANGELOG.md packages/author-reviewer-loop/package.json package-lock.json
```

Confirm:

- The relevant changelog (`CHANGELOG.md` for core, `packages/author-reviewer-loop/CHANGELOG.md` for spar) has a section matching the exact tag version.
- The released package version equals `$version`.
- `package-lock.json` reflects the version and dependency changes.
- README/docs were updated if behavior changed.
- No unrelated user changes are being accidentally included.

## 7. Commit, Tag, And Push

Fold the version bump, changelog, README/docs, and `package-lock.json` updates into the regular development commit they belong to &mdash; do **not** create a dedicated "Release X.Y.Z" commit. The tag itself is what marks the release.

Typical flow:

```bash
# Stage everything that belongs in the next commit, including the version bumps.
git add -A
git diff --cached --stat

# Either amend the in-progress commit that the release rides on...
git commit --amend --no-edit

# ...or create a normal commit describing the actual change (not the release).
# Example: a fix-focused message, not "Release 0.10.2".
git commit -m "author-reviewer-loop: pass author reply into reviewer prompt"

# Tag that commit and push. Use the per-package tag: core-v$version or spar-v$version.
git tag "${pkg}-v$version"
git push origin main
git push origin "${pkg}-v$version"
```

If the tag push fails because the tag already exists, stop and inspect. Do not force-push a release tag unless the user explicitly approves.

## 8. Verify GitHub Actions And npm

Do not rely on `gh run watch` if it behaves badly in the local terminal. Prefer status/list commands or the GitHub Actions page.

```bash
gh run list --workflow release.yml --limit 5
gh run list --workflow ci.yml --limit 5
gh run list --workflow docs-pages.yml --limit 5
```

For a specific run id:

```bash
gh run view <run-id> --json status,conclusion,url,headSha,displayTitle,event
```

After the release workflow succeeds, verify npm metadata for the package you released:

```bash
# core release:
npm view @acp-kit/core version dist-tags.latest gitHead
# spar release:
npm view @acp-kit/spar version dist-tags.latest gitHead
```

Expected result:

- The released package version equals `$version`.
- `dist-tags.latest` equals `$version` for stable releases, or `dist-tags.next` equals `$version` for prereleases.
- `gitHead` matches the release commit.
- The GitHub Release workflow completed successfully. Node action deprecation warnings alone are not release blockers.

## 9. Final User Summary

Report concisely:

- Release version, commit, and tag.
- Local validation commands and results.
- GitHub Release workflow status.
- npm package versions and dist-tags.
- Any warnings or follow-up risks.
