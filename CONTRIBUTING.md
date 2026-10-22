# Contributing

## Build and install from source

Needs Node.js 18+ and VS Code's `code` command on your `PATH` (in VS Code: *Shell Command: Install 'code' command in PATH*).

```sh
git clone https://github.com/smo-key/md-editor-vscode.git && cd md-editor-vscode
./install.sh              # builds the latest version and installs it into VS Code
```

Then reload open VS Code windows (*Developer: Reload Window*). Re-running the script updates in place. For another VS Code build or fork, name its CLI: `CODE=code-insiders ./install.sh` (likewise `cursor`, `codium`).

To uninstall: `code --uninstall-extension ArthurPachachura.ken-markdown-editor`.

## Development

```sh
npm install
npm run build             # bundle extension + webview into dist/
npm run typecheck
npm test                  # unit tests (vitest): editor plugins, GFM round-trips, commands, tables, sync
npm run test:integration  # launches VS Code and drives the real editor
KEN_TEST_REAL_CLIPBOARD=1 npm run test:integration  # also pastes a real image via the macOS clipboard
npm run build && npx tsc -p test/integration && node harness/real-keys.mjs  # real key presses over CDP
npm run sync-contributes  # after editing src/shortcuts.json (keybinding defaults)
npm run package           # produces ken-markdown-editor-<version>.vsix
npm run install-extension # package + install into VS Code (same as ./install.sh)
```

Press <kbd>F5</kbd> in VS Code to launch an Extension Development Host with the fixtures in `test/fixtures` open.

`harness/` runs the real webview bundle in Chromium under a theme captured from VS Code: `check-editing.mjs` drives the slash menu, toolbar, checklist handles and tables with real keystrokes and clicks; `screenshot.mjs` renders a document for visual checks.

```sh
KEN_DUMP_THEMES=/tmp/themes npm run test:integration   # captures Light/Dark Modern
node harness/check-editing.mjs /tmp/themes/Default-Dark-Modern.json
node harness/check-comments.mjs /tmp/themes/Default-Light-Modern.json
node harness/check-drawio.mjs /tmp/themes/Default-Light-Modern.json   # uses diagrams.net
node harness/screenshot.mjs /tmp/themes/Default-Dark-Modern.json test/fixtures/gfm.md /tmp/out.png
```

## Layout

- `src/` – extension host: the custom editor provider and document sync.
- `webview/` – the editor: `editorSetup.ts` configures Crepe for this editor; `commands.ts` is the one list of editing commands that `slashMenu.ts`, `toolbar.ts` and the table menu draw from; `taskHandle.ts` and `tableKeys.ts` are the checklist handle and table keys; `markdown/` holds the editor plugins plus `gfmFidelity.ts` and `htmlView.ts`; `styles.css` is the editor stylesheet with every colour mapped to the VS Code theme.

`prosemirror-model` is pinned to 1.25.11 (`overrides` in `package.json`): 1.25.12 validates attribute types and rejects the string-typed `spread` attribute Milkdown's list schemas use.

## Releasing

Releases are published by CI; don't publish by hand.

- **Start a release** by running the `/release` skill in Claude Code or GitHub Copilot (`.claude/skills/release/SKILL.md`; optionally `/release patch|minor|major|x.y.z`). It checks the tree, finalizes the `## [Unreleased]` section of `CHANGELOG.md`, bumps the version, runs the checks and pushes the release commit to `main`.
- **`.github/workflows/release.yml`** runs when a push to `main` changes the `package.json` version (or when run manually). If the version has no `v<version>` tag, it tests, packages and publishes to the VS Code Marketplace (and Open VSX), then creates the tag and a GitHub release with the `.vsix` and the CHANGELOG notes. It fails if `CHANGELOG.md` has no section for the version.
- **Secrets:** `VSCE_PAT` (required) and `OVSX_PAT` (optional, for Open VSX); set them with `gh secret set VSCE_PAT`. `VSCE_PAT` is an Azure DevOps PAT created by an account that can publish for the `ArthurPachachura` publisher, scoped to **one specific organization** (any you belong to; global *All accessible organizations* PATs stop working on 2026-12-01) with scope *Marketplace → Manage*. Check it with `npx vsce verify-pat ArthurPachachura`. PATs expire, so renew the secret before the expiry date.
- **`.github/workflows/ci.yml`** runs typecheck, unit tests and a production build on pull requests and pushes to `main`.

## Storage formats

Markdown has no syntax for some features, so the editor stores them in HTML comments that GitHub and other renderers hide:

- Comments: `<!-- ken:comment c1 -->…<!-- /ken:comment c1 -->` markers around the commented content, with the threads in one `<!-- ken:comments … -->` block at the end of the file. A marker never starts a line; deleting content that holds one end of a comment moves that end to where the deletion was.
- Table column widths: `<!-- ken:table widths=180,60,320 -->` above the table.
- Underline: `<ins>text</ins>`; an existing `<u>` is kept as `<u>`.
