# Ken Markdown Editor for VS Code

A calm, WYSIWYG Markdown editor for VS Code, modelled on the Markdown editor in
Ken: the same [Milkdown Crepe](https://milkdown.dev) editor, the same
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

## Install

From this folder, one line builds the latest version and installs it into
VS Code (it pulls the latest source first when the checkout tracks a remote):

```sh
~/git/md-editor-vscode/install.sh
```

Then reload any open VS Code windows (*Developer: Reload Window*). Run the
same line again to update. Re-installing the same version is fine; it's
replaced in place.

Needs Node.js 18+ and VS Code's `code` command on your `PATH` (in VS Code:
*Shell Command: Install 'code' command in PATH*). For another VS Code build
or fork, name its CLI: `CODE=code-insiders ~/git/md-editor-vscode/install.sh`
(likewise `cursor`, `codium`).

On a new machine, clone the repository first, then run the script:

```sh
git clone <repository-url> ~/git/md-editor-vscode && ~/git/md-editor-vscode/install.sh
```

To uninstall: `code --uninstall-extension arthur-pachachura.ken-markdown-editor`.

## GitHub-flavoured Markdown

Everything in the [GFM spec](https://github.github.com/gfm/) plus GitHub's
extensions renders and edits in place, and is written back faithfully:

| Feature | |
| --- | --- |
| Headings, emphasis, links, images, block quotes, rules, hard breaks | ✅ |
| Tables with column alignment (right-click a cell for the table menu) | ✅ |
| Task lists (`- [ ]` / `- [x]`), click to tick | ✅ |
| Strikethrough (`~~text~~`) | ✅ |
| Underline, written as `<ins>text</ins>` (Markdown has no underline syntax; GitHub renders `<ins>` underlined; existing `<u>` is kept as `<u>`) | ✅ |
| Autolinks: `<https://…>`, bare `https://…`, `www.…` and e-mail addresses | ✅ |
| Fenced code blocks with syntax highlighting (backtick and tilde fences, indented code) | ✅ |
| Footnotes (`[^1]`) | ✅ |
| Alerts: `> [!NOTE]`, `[!TIP]`, `[!IMPORTANT]`, `[!WARNING]`, `[!CAUTION]` | ✅ |
| Raw HTML: self-contained blocks render sanitized (e.g. `<p align="center"><img …></p>`); inline pairs like `<kbd>Ctrl</kbd>`, `<sub>`, `<mark>` render as elements; double-click any HTML to edit its source | ✅ |
| Mermaid diagrams in ` ```mermaid ` fences | ✅ |
| YAML frontmatter, as an editable Properties panel (see below) | ✅ |

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
- **Toolbar** with the essentials: undo/redo; the heading control; bold,
  italic, underline, strikethrough, inline code, link; bulleted / numbered
  lists and checklists (each toggles, and converts one list kind to another
  in place) with outdent / indent; quote, code block, table, divider, image
  and properties; and the keyboard shortcut list. Buttons show the state at
  the caret, and hovering one shows its name and shortcut. It sits at the
  bottom by default: `kenMarkdown.toolbar` moves it to the top or hides it.
  There is no formatting bubble over selected text: use the toolbar or the
  shortcuts.
- **Heading control** (a split button): the left half applies a heading
  level. It shows the caret's own level inside a heading, otherwise the
  level you last picked; clicking it on a heading of that level turns it back
  into text. The ▾ half opens a menu of Text and Heading 1–6, each previewed
  at its size with its shortcut; picking a heading also makes it the left
  half's level from then on (remembered across files and sessions).
- **Drag handles only on checklist items**: hover a task to drag it (with its
  sub-items) somewhere else. Other blocks have no handle and there is no `+`
  button.
- Tab / ⇧Tab in a heading make it one level smaller / larger (H2 → H3 / H1).
  Backspace at the start of a heading turns it into a paragraph in one step.
- Ordered lists keep their numbering style (`1.`, `a.`, `i.`, `1)`). Items of
  one list sit close together; separate lists, and loose lists (blank lines
  between items), keep more space.
- Quotes are set in a quote font (the heading serif by default), slightly
  gray and in italics.
- There is always somewhere to type after a final table, diagram, code block,
  image or rule: click below it, or arrow down out of it.
- An empty document shows "Start typing or try slash (/) commands".
- Copy-link buttons on headings; `#anchor` links scroll within the document.
- `[[Wiki links]]` and relative links open the target file in VS Code; web
  links open in your browser.
- Click an image or diagram to zoom.

## Properties (frontmatter)

YAML frontmatter at the top of a file shows as a **Properties** panel above
the text, just above the first heading, collapsed to a one-line preview of
its key-value pairs. Click it to expand and edit: change a name or a value, remove a row, *Add property*
(Enter in a value adds another), switch to editing the raw YAML, or remove
the properties altogether. Values are edited as YAML text, so lists stay lists
(`[a, b]`, or `- ` lines), and only the lines you change are rewritten:
comments and formatting elsewhere are kept as they were.

To add properties to a file without them, use the toolbar's properties
button, `/frontmatter` (or `/properties`) in the slash menu, or the
*Add or Edit Properties* command; a `title` from the file name is filled in.
With `kenMarkdown.alwaysShowProperties` on, every document shows the panel,
and frontmatter is only written once you add a property.

## Comments

Select any span (part of a sentence, several paragraphs, a table, an image,
or all of these together) and click **Add comment** in the toolbar (or
press ⌥⌘M / Ctrl+Alt+M, or `/comment`). Write the comment in the sidebar
(⌘Enter / Ctrl+Enter to post). Each comment is a thread: anyone can reply,
resolve it (its highlight goes away) or reopen it, or delete it. Click
highlighted text to see its thread; the **Comments** toolbar button (with the
number of open comments) shows them all. New comments carry your name
(`kenMarkdown.commentAuthor`, else git's `user.name`).

Markdown has no comments, so they are stored as HTML comments, which GitHub
and other renderers hide. The commented content is wrapped in markers, and the
threads are kept in one block at the end of the file, one thread per line:

```markdown
Revenue grew <!-- ken:comment c1 -->**12%** in Q3.

| Region | Q3 |
| ------ | -- |
| EU     | 4%<!-- /ken:comment c1 --> |

<!-- ken:comments
{"c1":{"resolved":false,"messages":[{"id":"m1","author":"Ana","date":"2026-10-22T15:00:00.000Z","text":"Source?"}]}}
-->
```

The editor keeps this valid through any edit:

- A marker never starts a line (in Markdown that would turn the line into
  HTML): at the start of a paragraph or list item it goes at the end of the
  previous line, or on a line of its own before the block.
- Comments on code blocks and diagrams wrap the whole block.
- Deleting content that holds one end of a comment moves that end to where
  the deletion was, so the comment covers what is left; deleting all of it
  removes the comment's markers (undo brings them back).
- Copying commented text does not copy the comment.
- The caret, Backspace and Delete step over the invisible markers.
- A comment you never wrote anything in is not saved.

## draw.io diagrams

Diagrams are draw.io's editable images, `.drawio.svg` (or `.drawio.png`):
ordinary images that GitHub and every renderer show, with the diagram source
embedded, so the Markdown just links them (`![](_Images/notes-diagram.drawio.svg)`).

- **Insert** one with `/drawio` (slash menu) or *Insert draw.io Diagram*: a new
  diagram file is created in the image folder and opened for editing.
- **Edit** one by hovering it and clicking *Edit diagram*, or double-clicking
  it. The diagrams.net editor opens over the document; *Save* (or *Save &
  Exit*) writes the same file back, picture and source together, and the
  document shows the new version.
- The editor is diagrams.net's embed mode, loaded from
  `https://embed.diagrams.net` (it runs in the frame; diagrams are not
  uploaded). Without a connection, *Open in VS Code* opens the file there,
  where the Draw.io Integration extension, if installed, edits it.

## Pasting and dropping files

- **Images** you paste (e.g. a screenshot) or drop are copied into an
  `_Images` folder next to the document (created when first needed) and
  referenced with a relative path such as `_Images/notes-pasted-20261021-102938.png`.
  Clipboard images are named after the document and the time; dropped files
  keep their name, with `-1`, `-2`… added rather than overwriting. The folder
  is set by `kenMarkdown.imageFolder`.
- **Other files** are copied next to the document and linked inline where
  you paste or drop them, with the file name as the link text.
- **From VS Code's Explorer**, files are linked where they are (relative to
  the document), not copied; images are shown.
- Nothing splits the line you are on: links go in at the caret or drop point,
  images replace an empty line or go below (or above, at the start of) the
  paragraph, and in table cells images go inline.
- To drop into the editor, **hold Shift** while dropping. That's a VS Code rule
  for all editors: without Shift, VS Code opens the dropped file instead.
- An image copied from a web page pastes as a link to the original rather than
  a saved copy.

## Keyboard shortcuts

Every editing action is a VS Code command, so its keys live in VS Code's
**Keyboard Shortcuts** editor and can be changed, removed or added there
(search `Ken Markdown`, or click *Customize…* in the shortcut list). They
apply only while a Ken Markdown editor has focus, and there they take
precedence over VS Code's own use of the same keys. ⌘B bolds instead of
toggling the sidebar, and ⌘K opens the link editor instead of starting a
chord. Outside the editor those keys do what they always did.

Press **⌘/** (Ctrl+/) or the keyboard button at the right of the toolbar to
see every shortcut with its current keys, including any you've changed.
Toolbar tooltips and slash-menu hints show your current keys too.

Defaults:

| Command | macOS | Windows / Linux | Command ID |
| --- | --- | --- | --- |
| Bold | ⌘B | Ctrl+B | `kenMarkdown.bold` |
| Italic | ⌘I | Ctrl+I | `kenMarkdown.italic` |
| Underline | ⌘U | Ctrl+U | `kenMarkdown.underline` |
| Strikethrough | ⌥⌘X | Ctrl+Alt+X | `kenMarkdown.strikethrough` |
| Inline Code | ⌘E | Ctrl+E | `kenMarkdown.inlineCode` |
| Link | ⌘K | Ctrl+K | `kenMarkdown.link` |
| Text (Paragraph) | ⌥⌘0 | Ctrl+Alt+0 | `kenMarkdown.paragraph` |
| Heading 1 | ⌥⌘1 | Ctrl+Alt+1 | `kenMarkdown.heading1` |
| Heading 2 | ⌥⌘2 | Ctrl+Alt+2 | `kenMarkdown.heading2` |
| Heading 3 | ⌥⌘3 | Ctrl+Alt+3 | `kenMarkdown.heading3` |
| Heading 4 | ⌥⌘4 | Ctrl+Alt+4 | `kenMarkdown.heading4` |
| Heading 5 | ⌥⌘5 | Ctrl+Alt+5 | `kenMarkdown.heading5` |
| Heading 6 | ⌥⌘6 | Ctrl+Alt+6 | `kenMarkdown.heading6` |
| Numbered List | ⌥⌘7 | Ctrl+Alt+7 | `kenMarkdown.numberedList` |
| Bulleted List | ⌥⌘8 | Ctrl+Alt+8 | `kenMarkdown.bulletedList` |
| Checklist | ⌥⌘9 | Ctrl+Alt+9 | `kenMarkdown.checklist` |
| Outdent List Item | — | — | `kenMarkdown.outdentListItem` |
| Indent List Item | — | — | `kenMarkdown.indentListItem` |
| Quote | ⇧⌘B | Ctrl+Shift+B | `kenMarkdown.quote` |
| Code Block | ⌥⌘C | Ctrl+Alt+C | `kenMarkdown.codeBlock` |
| Insert Table | — | — | `kenMarkdown.insertTable` |
| Insert Divider | — | — | `kenMarkdown.insertDivider` |
| Insert Image | — | — | `kenMarkdown.insertImage` |
| Insert Mermaid Diagram | — | — | `kenMarkdown.insertDiagram` |
| Insert draw.io Diagram | — | — | `kenMarkdown.insertDrawioDiagram` |
| Insert Table of Contents | — | — | `kenMarkdown.insertTableOfContents` |
| Add or Edit Properties (Frontmatter) | — | — | `kenMarkdown.editProperties` |
| Add Comment | ⌥⌘M | Ctrl+Alt+M | `kenMarkdown.addComment` |
| Show or Hide Comments | — | — | `kenMarkdown.toggleComments` |
| Insert Note Alert | — | — | `kenMarkdown.alertNote` |
| Insert Tip Alert | — | — | `kenMarkdown.alertTip` |
| Insert Important Alert | — | — | `kenMarkdown.alertImportant` |
| Insert Warning Alert | — | — | `kenMarkdown.alertWarning` |
| Insert Caution Alert | — | — | `kenMarkdown.alertCaution` |
| Undo | ⌘Z | Ctrl+Z | `kenMarkdown.undo` |
| Redo | ⇧⌘Z | Ctrl+Y, Ctrl+Shift+Z | `kenMarkdown.redo` |
| Table: Insert Row Above | — | — | `kenMarkdown.table.insertRowAbove` |
| Table: Insert Row Below | — | — | `kenMarkdown.table.insertRowBelow` |
| Table: Insert Column Left | — | — | `kenMarkdown.table.insertColumnLeft` |
| Table: Insert Column Right | — | — | `kenMarkdown.table.insertColumnRight` |
| Table: Move Row Up | — | — | `kenMarkdown.table.moveRowUp` |
| Table: Move Row Down | — | — | `kenMarkdown.table.moveRowDown` |
| Table: Move Column Left | — | — | `kenMarkdown.table.moveColumnLeft` |
| Table: Move Column Right | — | — | `kenMarkdown.table.moveColumnRight` |
| Table: Align Column Left | — | — | `kenMarkdown.table.alignLeft` |
| Table: Align Column Center | — | — | `kenMarkdown.table.alignCenter` |
| Table: Align Column Right | — | — | `kenMarkdown.table.alignRight` |
| Table: Toggle Full Width | — | — | `kenMarkdown.table.toggleFullWidth` |
| Table: Delete Row | — | — | `kenMarkdown.table.deleteRow` |
| Table: Delete Column | — | — | `kenMarkdown.table.deleteColumn` |
| Table: Delete Table | — | — | `kenMarkdown.table.deleteTable` |
| Show Keyboard Shortcuts | ⌘/ | Ctrl+/ | `kenMarkdown.showShortcuts` |

Built into the editor (not rebindable): `/` opens the insert menu; Tab /
⇧Tab move between table cells (and indent / outdent list items); Tab in the
last cell adds a row; Enter in a table moves down, leaving the table from the
last row; ⌘Enter leaves a table; Tab / ⇧Tab in a heading change its level
by one; Backspace at the start of a heading makes it text. Markdown typed as you go also converts: `# ` … `###### `, `- `, `1. `,
`[ ] `, `> `, ` ``` `, `---`, `**bold**`, `*italic*`, `~~strike~~`, `` `code` ``.

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

No column is ever narrower than 40px; a table with more columns than fit at
that width scrolls sideways. **Drag a column's border** to resize it (double-
click the border to go back to automatic widths). Markdown has no syntax for
column widths, so they are saved in the comment the editor already keeps
above full-width tables, which GitHub and other renderers hide:

```markdown
<!-- ken:table widths=180,60,320 -->
| Name | Qty | Notes |
| ---- | --- | ----- |
```

Everyone opening the file in this editor sees those widths; on a narrower
pane the columns shrink in proportion. Widths follow their columns when
columns are inserted, moved or deleted.

The header row is GFM's: it stays first and cannot be deleted on its own
(delete the table instead).

## Settings

| Setting | Default | |
| --- | --- | --- |
| `kenMarkdown.fontSize` | `16` | Base font size in px; headings, code and lists scale from it. |
| `kenMarkdown.bodyFontFamily` | `"Hanken Grotesk", system-ui, …` | Body text font stack. |
| `kenMarkdown.headingFontFamily` | `"Newsreader", Georgia, serif` | Heading font stack. |
| `kenMarkdown.quoteFontFamily` | *(empty: the heading font)* | Block quote font stack (set in italics). |
| `kenMarkdown.codeFontFamily` | `"JetBrains Mono", ui-monospace, …` | Inline code and code block font stack. |
| `kenMarkdown.lineHeight` | `1.85` | Body line height. |
| `kenMarkdown.maxWidth` | `720` | Width of the text column in px. |
| `kenMarkdown.toolbar` | `bottom` | Where the formatting toolbar sits: `bottom`, `top` or `hidden`. |
| `kenMarkdown.alwaysShowProperties` | `false` | Show the Properties panel above every document, even without frontmatter (nothing is written until you add one). |
| `kenMarkdown.commentAuthor` | *(git's `user.name`)* | Your name on comments you add. |
| `kenMarkdown.imageFolder` | `_Images` | Folder next to the document that pasted and dropped images are copied into; empty for beside the document. |

Hanken Grotesk, Newsreader and JetBrains Mono (Ken's fonts) are bundled; any
font installed on your machine works too. An empty font setting goes back to
the default. Changes apply immediately.

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
npm run build && npx tsc -p test/integration && node harness/real-keys.mjs  # real key presses over CDP
npm run sync-contributes  # after editing src/shortcuts.json (keybinding defaults)
npm run package           # produces ken-markdown-editor-<version>.vsix
npm run install-extension # package + install into VS Code (same as ./install.sh)
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
node harness/check-comments.mjs /tmp/themes/Default-Light-Modern.json
node harness/check-drawio.mjs /tmp/themes/Default-Light-Modern.json   # uses diagrams.net
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
