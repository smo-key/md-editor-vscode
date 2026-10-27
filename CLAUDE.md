# CLAUDE.md

Guidance for AI coding agents (Claude Code, GitHub Copilot and others) working in this repository. `.github/copilot-instructions.md` points here; keep this file the single source of truth.

Ken Markdown Editor: a VS Code **custom text editor** (`kenMarkdown.editor`) that opens `.md`/`.markdown` files in a WYSIWYG [Milkdown Crepe](https://milkdown.dev) editor, themed entirely by `--vscode-*` variables. Edit-only; VS Code owns the file (the `TextDocument`).

## Commands

```sh
npm run build               # esbuild: extension + webview -> dist/ (use -- --production to minify)
npm run watch
npm run typecheck           # tsc for root AND webview/ (two tsconfigs)
npm test                    # vitest unit tests (happy-dom)
npx vitest run test/unit/toc.test.ts            # single file
npx vitest run -t "name of test"                # single test by name
npm run test:integration    # builds, then launches real VS Code and drives the editor
npm run sync-contributes    # REQUIRED after editing src/shortcuts.json
npm run package             # .vsix;  ./install.sh builds + installs into local VS Code
```

Releases are automated: `.github/workflows/release.yml` publishes to the Marketplace when a push to `main` changes the `package.json` version to one without a `v<version>` tag. Start one with the `/release` skill (`.claude/skills/release/SKILL.md`), which bumps the version and moves `## [Unreleased]` in `CHANGELOG.md` to a dated version section (the workflow fails without it). Never tag or `vsce publish` manually. Add user-facing changes to `## [Unreleased]` as you make them.

No linter is configured. `harness/` (Playwright/Chromium against `dist/webview` with a captured VS Code theme) is for visual/real-keystroke checks (`check-editing`, `check-list-tab`, `check-comments`, `check-collab`, `check-drawio`, `check-lucid`, `check-heading-numbers`, `real-keys`, `screenshot`): `KEN_DUMP_THEMES=/tmp/themes npm run test:integration`, then `node harness/check-editing.mjs <theme.json>` or `node harness/screenshot.mjs <theme.json> <md> <out.png>`.

## Workflow: test, then commit; never push

When a piece of work is complete:

1. **Test it.** Run `npm run typecheck` and `npm test` (what CI runs, in `.github/workflows/ci.yml`), plus `npm run build` if you touched the bundles or `esbuild.mjs`. Add or update unit tests for behavior you changed. Run `npm run test:integration` when you changed the host↔webview protocol, `provider.ts`, or anything that only shows up in real VS Code.
2. **Fix failures before committing.** Never commit with failing typecheck or tests. If a failure is unrelated to your change, stop and report it with the output instead of committing around it.
3. **Commit.** Stage only the files you changed (no stray fixture edits, `dist/`, `out/` or `.vsix`), with a [Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/) message: `type(scope): description` (e.g. `feat(properties): color values by YAML type`, `fix(toc): …`, `docs: …`; `!` or a `BREAKING CHANGE:` footer for breaking changes). Release commits made by `/release` keep `Release v<version>`. User-facing changes also get a line under `## [Unreleased]` in `CHANGELOG.md`, in the same commit.
4. **Don't push.** Pushing is left to the user. The only exception is the `/release` skill, which pushes when the user explicitly invokes it.

## Architecture

Two bundles built by `esbuild.mjs`:

- **Extension host** (`src/`, node/cjs, `vscode` external): `provider.ts` is the `CustomTextEditorProvider`; it syncs the webview with the `TextDocument`, handles attachments, link resolution and config. `extension.ts` registers commands and calls `checkWhatsNew` on activation.
- **Webview** (`webview/`, browser/esm, Mermaid code-split and lazy-loaded): `editorSetup.ts` (`buildEditor`) assembles Crepe + the editor plugins; `main.ts` wires messaging. Feature plugins live in `webview/markdown/*` (anchors, GFM fidelity, alerts, wiki links, table layout/menu, TOC, mermaid, LaTeX math, underline as `<ins>`, etc.).
- **Protocol**: all host↔webview messages are typed in `src/protocol.ts` (`HostMessage` / webview messages, plus `TestAction` used by integration tests). Change both sides together.
- **Edit sync**: the webview serializes Markdown; `src/sync.ts` (pure, no `vscode` import so vitest covers it) computes `minimalChange` so only the changed span is applied to the `TextDocument`, keeping undo/dirty state/Git clean. Files must not be rewritten merely by opening them.
- **Commands**: `webview/commands.ts` is the single list of editing commands; slash menu, toolbar and table context menu all draw from it.
- **Frontmatter and comments** live outside the ProseMirror document (`webview/main.ts` splits them off and reattaches them when serializing). Frontmatter is the Properties panel (`webview/frontmatter.ts`, line-preserving edits in `frontmatterModel.ts`). Comments (`webview/comments/`) are stored in the Markdown itself: inline/block `<!-- ken:comment id -->` markers around the range, and one `<!-- ken:comments … -->` JSON block at the end of the file, one thread per line.
- **Collaboration**: serverless real-time editing over Y.js. `src/collab/` is the hub (pure logic, `hub.ts`), the wire protocol (`wire.ts`) and VS Code transports (`manager.ts`: in-window, local WebSocket, Live Share, network). `webview/collab.ts` binds ProseMirror via y-prosemirror; `presence.ts` shows avatars. Plugins that normalize the document on change must skip remote transactions (`webview/remoteChange.ts`) or fixes get applied twice.
- **Attachments**: pasted/dropped files already in the document's workspace folder are linked in place (`kenMarkdown.workspaceFiles`: `link` default, `copy`); others, and raw image bytes, are saved to the image folder. Path, exclude-glob and scheme logic is in `src/workspaceFiles.ts` (pure). Matching skips `files.exclude`/`search.exclude`, `node_modules` and git-ignored copies; URIs are only read and copied when they are `file:` (or the document's scheme), in the workspace or open in VS Code, and under 50 MB.
- **What's New**: `src/whatsNew.ts` (pure: version rule, CHANGELOG parsing, safe HTML) and `src/whatsNewPanel.ts` (globalState `kenMarkdown.lastVersion`, webview panel). It shows only when major.minor goes up, never on first install or a patch, and only when the extension activates (opening a Markdown file), by design.
- **Block selection**: `webview/markdown/blockSelection.ts` highlights every image/table/code/math/rule block a selection reaches, widens delete/typing to whole blocks, and steps Shift+Arrow/Shift+click over atoms. Its keys sit on the view's `handleKeyDown`, ahead of every plugin (including prosemirror-tables). It also registers a `StableTableView` (Crepe's table view otherwise rebuilds on every decoration change) and a drag-select guard (`body.ken-drag-selecting`). After a delete the caret must be a TextSelection, never a NodeSelection on a neighbour.
- **Key/selection sync**: `webview/keySelectionSync.ts` flushes ProseMirror's DOM observer before key handlers, so a key pressed right after a click acts at the new caret. It uses the internal `view.domObserver`; recheck it on ProseMirror upgrades.
- **draw.io**: `webview/drawio.ts` edits `.drawio.svg`/`.drawio.png` images in the diagrams.net embed; the file is the image and the source.
- **Lucidchart**: `src/lucidUrl.ts` is the shared, pure URL parser (host allowlist, UUID ids, embed/edit/open URLs), used by both bundles. `webview/markdown/lucid.ts` previews a Lucid link alone in its paragraph with decorations only (a stable-keyed widget, so frames survive typing): no schema change, no transactions, never mutates the doc. Frames are sandboxed and lazily loaded from `https://lucid.app/documents/embedded/<id>`, the only Lucid host in the CSP `frame-src` (`provider.ts`). Edit/Open post `openLucid`; the host re-parses the URL and opens only a URL it rebuilt (`openExternal`, recorded in `externalOpened` in test mode). Setting `kenMarkdown.lucidchart.preview`. Harness: `harness/check-lucid.mjs`.
- **Host-message guard**: `webview/hostMessage.ts` (`isHostMessage`) is checked first in `main.ts`'s `message` listener, so embedded frames (draw.io, Lucid) can't post host messages such as `update`; `isFrameMessage` checks a frame's own messages. Covered by `harness/check-lucid.mjs` (forged frames).
- **Diff view**: `src/diffPanel.ts` (command `kenMarkdown.openDiff`) opens a webview with its own bundle, `webview/diff.ts` (esbuild entry `diff`): read-only Crepe editors showing HEAD (via the Git extension API) against the document's current text. `webview/diffModel.ts` (pure) matches top-level blocks by content (LCS), pairs edited blocks and marks changed words with Milkdown's `computeDocDiff`. Messages are `DiffHostMessage`/`DiffWebviewMessage` in `src/protocol.ts`. Harness: `harness/screenshot-diff.mjs`.
- **Table cells and paste**: cells hold paragraphs and lists (`webview/markdown/tableCellBlocks.ts`, written as `<br>` and inline `<ul>`/`<ol>`); `webview/markdown/tablePaste.ts` pastes cell blocks, spreadsheet and CSV data.
- **Shortcuts**: `src/shortcuts.json` is the source of truth. `scripts/sync-contributes.mjs` generates `contributes.commands`, `keybindings` and command-palette `when` clauses in `package.json` from it; don't hand-edit those entries. `src/keybindings.ts` resolves effective keys (defaults + user `keybindings.json`) for tooltips, the shortcut panel and `webview/keys.ts`, which claims non-Cmd/Ctrl+letter bound keys (Alt+↑…) only while their command is enabled and the caret is in the editor's text.

## Conventions

- Keep `src/sync.ts`-style logic free of `vscode` imports so it is unit-testable.
- Colors/fonts must come from `--vscode-*` variables, never hard-coded, so themes update live.
- Unit tests mount the real editor headlessly via `test/unit/editorEnv.ts` (`stubLayout()` stubs layout APIs missing from happy-dom, plus `buildEditor`); reuse it for new plugin tests. Fixtures are in `test/fixtures`; integration tests in `test/integration/suite`.
- Saved Markdown intentionally normalizes syntax (setext→`#`, `*`/`+`→`-`, reference links inlined, etc.) while preserving rendered meaning; GFM round-trips are covered in `test/unit/gfm.test.ts`. Math (`webview/markdown/math.ts`, syntax in `mathSyntax.ts`) uses GitHub/Pandoc `$` rules so prices stay text, and escapes a literal `$` only where it would read back as math; Crepe's own LaTeX feature stays disabled.
- Underline is serialized as `<ins>`; existing `<u>` is preserved.
