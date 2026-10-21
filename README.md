# Ken Markdown Editor for VS Code

A calm, WYSIWYG Markdown editor for VS Code, modelled on the Markdown editor in
[Ken](../ken): the same [Milkdown Crepe](https://milkdown.dev) editor, the same
typography and layout, and Ken's editing extras, coloured by **your active VS
Code theme**.

- **Edit-only.** There is no read-only preview mode: every `.md`/`.markdown`
  file opens straight into the editor.
- **VS Code owns the file.** The editor is a
  [custom text editor](https://code.visualstudio.com/api/extension-guides/custom-editors#custom-text-editor):
  edits go into the normal `TextDocument`, so save, auto-save, dirty markers,
  hot exit / backups, undo history, Git and the source view all behave as they
  do for any text file.
- **Themed by VS Code.** Every colour (text, links, code, quotes, tables,
  alerts, menus, scrollbars, syntax highlighting, Mermaid) comes from the
  `--vscode-*` theme variables, and updates live when you change theme.

## GitHub-flavoured Markdown

Everything in the [GFM spec](https://github.github.com/gfm/) plus GitHub's
extensions renders and edits in place, and is written back faithfully:

| Feature | |
| --- | --- |
| Headings, emphasis, links, images, block quotes, rules, hard breaks | ✅ |
| Tables with column alignment (right-click a cell for the table menu) | ✅ |
| Task lists (`- [ ]` / `- [x]`), click to tick | ✅ |
| Strikethrough (`~~text~~`) | ✅ |
| Autolinks: `<https://…>`, bare `https://…`, `www.…` and e-mail addresses | ✅ |
| Fenced code blocks with syntax highlighting (backtick and tilde fences, indented code) | ✅ |
| Footnotes (`[^1]`) | ✅ |
| Alerts: `> [!NOTE]`, `[!TIP]`, `[!IMPORTANT]`, `[!WARNING]`, `[!CAUTION]` | ✅ |
| Raw HTML: self-contained blocks render sanitized (e.g. `<p align="center"><img …></p>`); inline pairs like `<kbd>Ctrl</kbd>`, `<sub>`, `<mark>` render as elements; double-click any HTML to edit its source | ✅ |
| Mermaid diagrams in ` ```mermaid ` fences | ✅ |
| YAML frontmatter (kept verbatim, not rendered) | ✅ |

Saving normalises some *syntax* without changing what GitHub shows: setext
headings become `#` headings, `*`/`+` bullets become `-`, tilde and indented
code become backtick fences, reference-style links are written inline, and
bare URLs are written as `<https://…>` autolinks. Files are only rewritten when
you edit them; opening a file never changes it.

Math (`$…$`) is intentionally left as plain text, as in Ken, so prices like
`$5 and $10` stay literal.

## Ken's editing extras

- Slash shortcuts: type `/h1 `…`/h6 `, `/quote `, `/code `, `/divider `,
  `/bullet `, `/number `, `/todo `, `/note `, `/tip `, `/important `,
  `/warning `, `/caution ` or `/toc ` at the start of an empty line.
- The block handle (`+` and drag) and slash menu, including a generated table
  of contents and alert blocks.
- Backspace at the start of a heading turns it into a paragraph in one step.
- Ordered lists keep their numbering style (`1.`, `a.`, `i.`, `1)`).
- Tables size their columns to their content; toggle full-width per table.
- Copy-link buttons on headings; `#anchor` links scroll within the document.
- `[[Wiki links]]` and relative links open the target file in VS Code; web
  links open in your browser.
- Paste or drop images and files: they are saved next to the document and
  linked with a relative path.
- Click an image or diagram to zoom.

## Settings

| Setting | Default | |
| --- | --- | --- |
| `kenMarkdown.fontSize` | `16` | Base font size in px; headings, code and lists scale from it. |
| `kenMarkdown.bodyFontFamily` | `"Hanken Grotesk", system-ui, …` | Body text font stack. |
| `kenMarkdown.headingFontFamily` | `"Newsreader", Georgia, serif` | Heading font stack. |
| `kenMarkdown.codeFontFamily` | `"JetBrains Mono", ui-monospace, …` | Inline code and code block font stack. |
| `kenMarkdown.lineHeight` | `1.85` | Body line height. |
| `kenMarkdown.maxWidth` | `720` | Width of the text column in px. |

Hanken Grotesk, Newsreader and JetBrains Mono (Ken's fonts) are bundled; any
font installed on your machine works too. Changes apply immediately.

## Commands

- **Open Markdown Source** (`kenMarkdown.openSource`, editor title bar): view
  the same file in VS Code's text editor.
- **Open in Ken Markdown Editor** (`kenMarkdown.openEditor`): back again.

To make the plain text editor the default for Markdown instead, use
*Reopen Editor With…* → *Configure default editor for '*.md'…*.

## Development

```sh
npm install
npm run build             # bundle extension + webview into dist/
npm run typecheck
npm test                  # unit tests (vitest): Ken's editor plugins, GFM round-trips, sync
npm run test:integration  # launches VS Code and drives the real editor
npm run package           # produces ken-markdown-editor-<version>.vsix
```

Press <kbd>F5</kbd> in VS Code to launch an Extension Development Host with
the fixtures in `test/fixtures` open.

`harness/screenshot.mjs` renders a document with the real webview bundle in
Chromium under a theme captured from VS Code, for visual checks:

```sh
KEN_DUMP_THEMES=/tmp/themes npm run test:integration   # captures Light/Dark Modern
node harness/screenshot.mjs /tmp/themes/Default-Dark-Modern.json test/fixtures/gfm.md /tmp/out.png
```

### Layout

- `src/` – extension host: the custom editor provider and document sync.
- `webview/` – the editor: `editorSetup.ts` configures Crepe as Ken does;
  `markdown/` holds Ken's editor plugins (ported from
  `ken/src/files/markdown`) plus `gfmFidelity.ts` and `htmlView.ts`;
  `styles.css` is Ken's editor stylesheet with every colour mapped to the VS
  Code theme.

`prosemirror-model` is pinned to 1.25.11 (`overrides` in `package.json`):
1.25.12 validates attribute types and rejects the string-typed `spread`
attribute Milkdown's list schemas use.
