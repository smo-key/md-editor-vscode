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

## Editing

- **Slash menu.** Type `/` at the start of a line or after a space (in
  paragraphs, headings, lists, quotes, alerts or table cells) and a compact
  menu opens on that keystroke: text and headings, lists and checklists,
  quote, code block, table, divider, image, Mermaid diagram, table of contents
  and the five alerts. Keep typing to filter; <kbd>↑</kbd>/<kbd>↓</kbd> and
  <kbd>Enter</kbd> or <kbd>Tab</kbd> to pick; <kbd>Esc</kbd> to dismiss.
  Ken's direct shortcuts still work too: `/h1 `…`/h6 `, `/quote `, `/code `,
  `/divider `, `/bullet `, `/number `, `/todo `, `/note `, `/tip `,
  `/important `, `/warning `, `/caution `, `/toc ` (with the trailing space).
- **Bottom toolbar** with the essentials: undo/redo, headings 1–3, bold,
  italic, strikethrough, inline code, link (<kbd>⌘K</kbd>), bulleted /
  numbered lists and checklists (each toggles, and converts one list kind to
  another in place), quote, code block, table, divider and image. Buttons
  show the state at the caret. Hide it with `kenMarkdown.toolbar`.
- **Drag handles only on checklist items**: hover a task to drag it (with its
  sub-items) somewhere else. Other blocks have no handle and there is no `+`
  button.
- Backspace at the start of a heading turns it into a paragraph in one step;
  ordered lists keep their numbering style (`1.`, `a.`, `i.`, `1)`).
- Copy-link buttons on headings; `#anchor` links scroll within the document.
- `[[Wiki links]]` and relative links open the target file in VS Code; web
  links open in your browser.
- Click an image or diagram to zoom.

## Pasting and dropping files

- **Images** you paste (e.g. a screenshot) or drop are copied into an
  `_Images` folder next to the document (created when first needed) and
  referenced with a relative path: `![](_Images/notes-pasted-20261021-102938.png)`.
  Clipboard images are named after the document and the time; dropped files
  keep their name, with `-1`, `-2`… added rather than overwriting. The folder
  is set by `kenMarkdown.imageFolder`.
- **Other files** are copied next to the document and linked inline where
  you paste or drop them: `[Spec Sheet (v2).pdf](Spec%20Sheet%20%28v2%29.pdf)`.
- **From VS Code's Explorer**, files are linked where they are (relative to
  the document), not copied; images are shown.
- Nothing splits the line you are on: links go in at the caret or drop point,
  images replace an empty line or go below (or above, at the start of) the
  paragraph, and in table cells images go inline.
- To drop into the editor, **hold Shift** while dropping. That's a VS Code rule
  for all editors: without Shift, VS Code opens the dropped file instead.
- An image copied from a web page pastes as a link to the original rather than
  a saved copy.

## Tables

With the caret in a table, the bottom toolbar switches to the table's
actions; right-clicking a cell offers the same list:

- insert a row above / below, a column left / right;
- move the row up / down, the column left / right;
- align the column left / center / right (GFM alignment);
- toggle full width (the table fills the pane instead of the text column);
- delete the row, the column or the table.

Keys: <kbd>Tab</kbd> / <kbd>⇧Tab</kbd> move between cells, and <kbd>Tab</kbd>
in the last cell adds a row; <kbd>Enter</kbd> moves to the cell below and,
from the last row, leaves the table; <kbd>⌘Enter</kbd> leaves it from
anywhere. Clicking a cell puts the caret where you clicked. Hovering a table
also shows Crepe's row and column handles for dragging rows and columns
around. Columns size to their content, and empty cells are saved empty.

The header row is GFM's: it stays first and cannot be deleted on its own
(delete the table instead).

## Settings

| Setting | Default | |
| --- | --- | --- |
| `kenMarkdown.fontSize` | `16` | Base font size in px; headings, code and lists scale from it. |
| `kenMarkdown.bodyFontFamily` | `"Hanken Grotesk", system-ui, …` | Body text font stack. |
| `kenMarkdown.headingFontFamily` | `"Newsreader", Georgia, serif` | Heading font stack. |
| `kenMarkdown.codeFontFamily` | `"JetBrains Mono", ui-monospace, …` | Inline code and code block font stack. |
| `kenMarkdown.lineHeight` | `1.85` | Body line height. |
| `kenMarkdown.maxWidth` | `720` | Width of the text column in px. |
| `kenMarkdown.toolbar` | `true` | Show the formatting toolbar at the bottom. |
| `kenMarkdown.imageFolder` | `_Images` | Folder next to the document that pasted and dropped images are copied into; empty for beside the document. |

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
npm test                  # unit tests (vitest): Ken's plugins, GFM round-trips, commands, tables, sync
npm run test:integration  # launches VS Code and drives the real editor
KEN_TEST_REAL_CLIPBOARD=1 npm run test:integration  # also pastes a real image via the macOS clipboard
npm run package           # produces ken-markdown-editor-<version>.vsix
```

Press <kbd>F5</kbd> in VS Code to launch an Extension Development Host with
the fixtures in `test/fixtures` open.

`harness/` runs the real webview bundle in Chromium under a theme captured
from VS Code: `check-editing.mjs` drives the slash menu, toolbar, checklist
handles and tables with real keystrokes and clicks; `screenshot.mjs` renders a
document for visual checks.

```sh
KEN_DUMP_THEMES=/tmp/themes npm run test:integration   # captures Light/Dark Modern
node harness/check-editing.mjs /tmp/themes/Default-Dark-Modern.json
node harness/screenshot.mjs /tmp/themes/Default-Dark-Modern.json test/fixtures/gfm.md /tmp/out.png
```

### Layout

- `src/` – extension host: the custom editor provider and document sync.
- `webview/` – the editor: `editorSetup.ts` configures Crepe as Ken does;
  `commands.ts` is the one list of editing commands that `slashMenu.ts`,
  `toolbar.ts` and the table menu draw from; `taskHandle.ts` and
  `tableKeys.ts` are the checklist handle and table keys;
  `markdown/` holds Ken's editor plugins (ported from
  `ken/src/files/markdown`) plus `gfmFidelity.ts` and `htmlView.ts`;
  `styles.css` is Ken's editor stylesheet with every colour mapped to the VS
  Code theme.

`prosemirror-model` is pinned to 1.25.11 (`overrides` in `package.json`):
1.25.12 validates attribute types and rejects the string-typed `spread`
attribute Milkdown's list schemas use.
