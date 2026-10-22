---
name: release
description: Release a new version of Ken Markdown Editor to the VS Code Marketplace. Bumps the version, finalizes CHANGELOG.md, and pushes to main so the Release workflow publishes it. Only run when the user explicitly invokes /release.
argument-hint: "[patch|minor|major|<x.y.z>]"
disable-model-invocation: true
---

# Release

Publishing is automated: `.github/workflows/release.yml` runs on every push to `main` that changes the `version` in `package.json` to one with no `v<version>` git tag yet. It packages the extension, publishes it to the VS Code Marketplace (and Open VSX if `OVSX_PAT` is set), then creates the `v<version>` tag and GitHub release with notes from `CHANGELOG.md`.

Your job is to prepare and push the version bump. **Never create or push tags yourself, and never run `vsce publish` locally**: the workflow does both.

The requested bump is: `$ARGUMENTS` (one of `patch`, `minor`, `major`, or an explicit `x.y.z`). If that is empty or shows the literal text `$ARGUMENTS`, take the bump from the user's message instead; if there is none, propose one in step 2.

## 1. Preconditions

Run these and **stop** with a clear explanation if any fails:

```sh
git fetch origin
git branch --show-current          # must be main
git status --porcelain             # must be empty: no uncommitted changes
git status -sb | head -1           # must not be behind origin/main
gh secret list | grep -q VSCE_PAT  # the Marketplace token must be configured
```

If there are uncommitted changes, do not stash, commit or discard them: list them and ask the user to commit or stash first. If `VSCE_PAT` is missing, tell the user to create an Azure DevOps Personal Access Token scoped to one specific organization (not *All accessible organizations*: global PATs stop working on 2026-12-01) with scope *Marketplace → Manage*, and add it with `gh secret set VSCE_PAT`. If `gh` cannot list secrets (HTTP 403: the signed-in account lacks admin access), don't stop: ask the user to confirm `VSCE_PAT` is set under the repository's *Settings → Secrets and variables → Actions*.

## 2. Choose the version

- Current version: `node -p "require('./package.json').version"`. Last release: `git describe --tags --abbrev=0 --match 'v*'` (may not exist yet).
- If a bump was given, apply it to the current version (or use the explicit version).
- If none was given, read the `## [Unreleased]` section of `CHANGELOG.md` and propose one: `major` for breaking changes, `minor` if anything is under *Added* or *Changed*, otherwise `patch`.
- Confirm the final version with the user before changing any files. It must be greater than both the current version and the last released tag.

## 3. Finalize CHANGELOG.md

`CHANGELOG.md` follows Keep a Changelog. The release workflow fails if it has no `## [<version>]` section.

1. Compare `## [Unreleased]` with `git log --oneline <last-tag>..HEAD` (or the whole log if there is no tag). If user-facing changes are missing, add them in the existing style: short, user-focused bullets under *Added*, *Changed*, *Fixed* or *Removed*. Leave out internal-only changes (tests, CI, refactors).
2. If `## [Unreleased]` is still empty, stop: there is nothing to release.
3. Rename `## [Unreleased]` to `## [<version>] - <YYYY-MM-DD>` (today's date) and add a new, empty `## [Unreleased]` section above it.

## 4. Verify

```sh
npm ci
npm run typecheck
npm test
npm run build -- --production
npx vsce package --no-dependencies --skip-license --out /tmp/release-check.vsix && rm /tmp/release-check.vsix
```

Stop and report if any step fails; do not release a broken build.

## 5. Bump, commit and push

```sh
npm version <version> --no-git-tag-version   # updates package.json and package-lock.json
git add package.json package-lock.json CHANGELOG.md
git commit -m "Release v<version>"
```

Show the user `git show --stat HEAD` and the new CHANGELOG section, then push:

```sh
git push origin main
```

If the push is rejected (for example, branch protection), undo nothing; tell the user and suggest opening a pull request with the commit instead. The release runs when it merges.

## 6. Follow the release

```sh
sleep 10
gh run list --workflow release.yml --limit 1
gh run watch <run-id> --exit-status
```

When it succeeds, report:

- Marketplace: https://marketplace.visualstudio.com/items?itemName=ArthurPachachura.ken-markdown-editor (the listing can take a few minutes to update)
- GitHub release: `gh release view v<version> --json url -q .url`

If it fails, show the failing step with `gh run view <run-id> --log-failed`, explain the cause, and suggest the fix. After fixing (with a normal commit to `main`), rerun the release for the same version with `gh workflow run release.yml`; it skips versions that are already tagged and versions already on the Marketplace.
