# Copilot instructions

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

No linter is configured. `harness/` (Playwright/Chromium against `dist/webview` with a captured VS Code theme) is for visual/real-keystroke checks: `KEN_DUMP_THEMES=/tmp/themes npm run test:integration`, then `node harness/check-editing.mjs <theme.json>` or `node harness/screenshot.mjs <theme.json> <md> <out.png>`.

## Architecture

Two bundles built by `esbuild.mjs`:

- **Extension host** (`src/`, node/cjs, `vscode` external): `provider.ts` is the `CustomTextEditorProvider`; it syncs the webview with the `TextDocument`, handles attachments (pasted/dropped images saved next to the doc), link resolution and config. `extension.ts` registers commands.
- **Webview** (`webview/`, browser/esm, Mermaid code-split and lazy-loaded): `editorSetup.ts` (`buildEditor`) assembles Crepe + the editor plugins; `main.ts` wires messaging. Feature plugins live in `webview/markdown/*` (anchors, GFM fidelity, alerts, wiki links, table layout/menu, TOC, mermaid, LaTeX math, underline as `<ins>`, etc.).
- **Protocol**: all host↔webview messages are typed in `src/protocol.ts` (`HostMessage` / webview messages, plus `TestAction` used by integration tests). Change both sides together.
- **Edit sync**: the webview serializes Markdown; `src/sync.ts` (pure, no `vscode` import so vitest covers it) computes `minimalChange` so only the changed span is applied to the `TextDocument`, keeping undo/dirty state/Git clean. Files must not be rewritten merely by opening them.
- **Commands**: `webview/commands.ts` is the single list of editing commands; slash menu, toolbar and table context menu all draw from it.
- **Shortcuts**: `src/shortcuts.json` is the source of truth. `scripts/sync-contributes.mjs` generates `contributes.commands`, `keybindings` and command-palette `when` clauses in `package.json` from it; don't hand-edit those entries. `src/keybindings.ts` resolves effective keys (defaults + user `keybindings.json`) for tooltips and the shortcut panel.

## Conventions

- Keep `src/sync.ts`-style logic free of `vscode` imports so it is unit-testable.
- Colors/fonts must come from `--vscode-*` variables, never hard-coded, so themes update live.
- Unit tests mount the real editor headlessly via `test/unit/editorEnv.ts` (`stubLayout()` stubs layout APIs missing from happy-dom, plus `buildEditor`); reuse it for new plugin tests. Fixtures are in `test/fixtures`; integration tests in `test/integration/suite`.
- Saved Markdown intentionally normalizes syntax (setext→`#`, `*`/`+`→`-`, reference links inlined, etc.) while preserving rendered meaning; GFM round-trips are covered in `test/unit/gfm.test.ts`. Math (`webview/markdown/math.ts`, syntax in `mathSyntax.ts`) uses GitHub/Pandoc `$` rules so prices stay text, and escapes a literal `$` only where it would read back as math; Crepe's own LaTeX feature stays disabled.
- Underline is serialized as `<ins>`; existing `<u>` is preserved.
