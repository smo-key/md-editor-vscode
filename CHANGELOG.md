# Changelog

All notable changes to **Ken Markdown Editor** are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added

- Zoom in on images and Mermaid diagrams: clicking one opens it fitted to the window; pinch or scroll to zoom around the pointer (+, − and 0 work too), drag to pan, and click the picture to switch between fitted and 100%. A clear × in the top right corner (or Esc, or a click outside the picture) closes it.

## [0.7.0] - 2026-10-27

### Added

- Table cells can hold several lines, bulleted, numbered and checklist items. Shift+Enter (or Alt+Enter) starts a new line in a cell; the list buttons, slash commands and shortcuts now work in tables, with Enter and Tab working the list. They are saved as `<br>` and inline `<ul>`/`<ol>` HTML, which GitHub renders.
- Tables: **Header row** (toolbar, right-click menu, command) turns the header into an ordinary row and back; a table without a header is saved with the empty header row GFM requires. **Total row** adds a row of column totals, set apart with a double rule.
- Pasting into tables: one value pasted over several selected cells goes into each of them; a block of cells (from this or another table, Excel, Google Sheets, or CSV/TSV text) fills the cells from the caret onward, adding rows and columns as needed. Spreadsheet and CSV data pasted outside a table becomes a new table.
- **Paste as Plain Text** (⇧⌘V / Ctrl+Shift+V): pastes the clipboard's text in the formatting at the caret; further lines become new paragraphs, list items or cell lines like the caret's.
- New commands with keyboard shortcuts: **Move Up/Down** (⌥↑/⌥↓) moves the table row, list item or block at the caret; **Duplicate** (⇧⌥↓/⇧⌥↑); **Clear Formatting** (⌘\\ / Ctrl+\\); **Check or Uncheck Checklist Item** (⌘Enter / Ctrl+Enter). Default keys for inserting a table (⌥⌘T / Ctrl+Alt+T), indenting and outdenting list items (⌘] / ⌘[), and table rows and columns: insert (⌃⌥↑/↓, ⌃⌥⇧←/→), move columns (⌃⌥←/→) and delete (⌃⌥⌫, ⌃⌥⇧⌫). All can be changed in Keyboard Shortcuts. Keys that aren't Cmd/Ctrl+letter shortcuts keep their usual meaning wherever the command has nothing to do (e.g. ⌥↑ in a code block).
- **Open Changes in Ken Markdown**: a Markdown file's changes since the last commit, rendered as in the editor, with added blocks in green, removed ones in red and the changed words inside an edited block highlighted. Combined (one column) or split (side by side, scrolled together); open it from the editor's title bar, Source Control, a text diff or the command palette. Setting `kenMarkdown.diff.layout`.

### Changed

- Lists that end up directly next to each other become one list: a list made between two others (or right after one), or two lists left touching when the text between them is deleted. Bulleted lists and checklists join each other; a numbered list stays apart from a bulleted one. Touching lists already in a file are left as they are.

### Fixed

- A `<br>` line break in a table cell is no longer dropped when the file is edited.

## [0.6.0] - 2026-10-24

### Added

- Right-click a table of contents for **Delete table of contents**, which removes the whole table of contents (one undo brings it back).

### Changed

- Heading numbers now sit inline, in grey, just before the heading text instead of hanging in the left margin. They still can't be selected, edited or copied, and they are never written to the file. The heading text starts after the number.

### Fixed

- Slash menu: Enter runs the item you highlighted with the arrow keys or the mouse. Before, after typing a shortcut word such as `/table` or `/code`, Enter ran that word's block whichever item was highlighted. Divider on an empty line now leaves a new empty line after the rule to type on.
- Undoing every edit puts the file back exactly as it was, instead of rewriting it with normalized syntax (`*` bullets as `-`, underlined headings as `#`, `| --- |` table rules).
- Replying to or resolving a comment changes only the comments block at the end of the file; the rest of the file is no longer rewritten.
- After the properties change outside the editor, one Undo (or Redo) press always undoes something you can see, instead of first skipping a properties edit it can no longer apply.
- A literal dollar pair such as `\$x\$` in a line that starts or ends with a tab no longer turns into math after saving and reopening.
- A bare link followed by `_`, `*` or `~` and a space (as in `https://example.com/a_b_ c`) is no longer rewritten as `<https://…>` when you edit the file.
- Emphasis, bold and strikethrough around a link, inline code, math or other formatting (as in `*see https://example.com now*`) stay one span when you edit the file, instead of being rewritten as `*see* *https://example.com* *now*`.

## [0.5.0] - 2026-10-23

### Added

- Heading numbering: `legal-article-full` (Article I, Section 1.01, 1.01(a), 1.01(a)(i)…) and `legal-full` (1.1.1, 1.1.1(a), 1.1.1(a)(i)…) presets. The legal parents mode writes only plain letter and roman parents as digits, so zero-padded and parenthesized parts keep their style.
- Legal heading numbering: presets (`kenMarkdown.headingNumbers.preset`, or `ken-heading-numbering: legal`) for outline, decimal (1.1.1), legal (1.1.1, (a), (i), (A)) and legal-article (Article I, Section 1.01, (a)); new styles 01, (a) and a); per-level parent numbers (full, legal digits, or own only) and prefixes such as "Article ". The Heading numbering dialog has a Preset menu and these fields.
- Heading numbering per document: a `ken-heading-numbering` property (`off`, `on`, or a format such as `"1.a.i"` or `"I-1-a"`) overrides the settings for one file. Set it from the new Heading numbering dialog, via the gear in the Properties panel or by right-clicking a heading (the same menu also has Copy link to heading). Numbers always hang in the margin, so headings stay in line with the text even in narrow panes.
- Heading numbers: turn on `kenMarkdown.headingNumbers.enabled` to show a small, muted number such as 1.a beside each heading and in the table of contents, with a style per level (1, a, A, i, I or none) and a separator. Display only: nothing is written to the file.
- Lucidchart and Lucidspark links on a line of their own show a live preview, with Edit and Open in Lucidchart buttons (they open your browser) and Reload; linked published Lucid images get the same buttons. Set `kenMarkdown.lucidchart.preview` to `onClick` or `off` to load nothing from Lucid until you ask.
- New settings `kenMarkdown.headingSpacingBefore` (in em, default 2.25) and `kenMarkdown.headingSpacingAfter` (default 0.55) set the space above and below headings; larger headings scale them. Headings now have a little more space above them (about a quarter more after a paragraph); the space below and the first heading of a document stay where they were.
- New setting `kenMarkdown.paragraphSpacing` (in em, default 0.65) sets the space between paragraphs, separately from line height and list item spacing. The default is a little roomier than before.
- A **What's New** page after updating to a new minor or major version, showing the release notes since your previous version. Open it any time with **Ken Markdown: Show What's New**.

### Changed

- The bar beside block quotes is now the same gray as the quote's text instead of the theme's (often blue) quote colour. Alerts keep their colours.
- Pasting or dropping a file that is already in the workspace (from the Explorer or your file manager) now links to it where it is instead of copying it. Files from outside the workspace and screenshots are still saved. Set `kenMarkdown.workspaceFiles` to `copy` to keep copying.
- Selections that cross images, tables, diagrams and code blocks now highlight those blocks whole, and Backspace, Delete or typing removes them cleanly. Shift+Arrow steps over a whole table or code block instead of getting stuck in its cells, and Shift+click extends the selection by whole blocks.
- Properties: values are colored by YAML type, long keys and values wrap instead of being cut off, the YAML view grows to fit, and frontmatter with nested or multi-line values opens as YAML only (with a tooltip saying why).
- The toolbar now sits at the top of the editor by default (`kenMarkdown.toolbar`: `"bottom"` puts it back).

### Fixed

- Undo and redo now include Properties edits (including the heading numbering dialog's Apply) in the order you made them, and work while a property field has focus. Editing a property no longer rewrites the rest of the document (e.g. `| --- |` stays as written).
- Tab in a list item indents it, or does nothing when the item can't move (the first item of a level); it no longer inserts spaces. Shift+Tab outdents a nested item one level and turns a top-level item back into a paragraph. Code blocks, tables and headings inside list items keep their own Tab.
- Tab in a plain paragraph now types a real tab character instead of four spaces, drawn as wide as your `editor.tabSize` setting (`[markdown]` overrides included). A tab at the start or end of a line is saved as `&#x9;`, so it doesn't turn the paragraph into a code block or get dropped when the file is reopened.
- Pasting into a code block, math or mermaid block, or inline code now inserts plain text exactly as copied, without backslash escapes or Markdown formatting, including text copied from the editor itself.
- Dragging across table cells makes a cell selection again, and typing, Backspace or Delete over it clear those cells without breaking the table's rows, columns or alignment.
- Links keep the form you wrote them in: bare links (https://…), www. and email links, and [url](url) links are no longer rewritten as <https://…> when you edit elsewhere in the document.
- Embedded pages, such as the draw.io editor, can no longer send the editor messages that change your document; only VS Code can.
- Typing or Backspace over a selection that reaches into a table no longer replaces or selects the image or rule just before it.
- A key pressed straight after a click (such as Backspace next to a comment) could be applied at the old caret and lost.
- Selecting across tables and images no longer flickers. While you drag to select, images show a text cursor and letting go over one doesn't open it.
- Editing a document no longer removes the blank line between its properties (frontmatter) and the body.

## [0.4.0] - 2026-10-22

### Added
- **LaTeX math**, rendered with KaTeX: inline `$…$` and `$$…$$`, and `$$` blocks or ```` ```math ```` fences, as on GitHub. Click a formula to edit it in place with a live preview; a block shows its source while the caret is in it. Type `$x^2$` or `$$ ` and a space, or insert one from the slash menu (*Equation*, *Inline equation*). Prices like `$5 and $10` stay plain text.

### Changed
- Adding properties to a document without any no longer inserts a `title` property: you start with a blank one to name, and nothing is written until it has a name.

## [0.3.2] - 2026-10-22

### Fixed
- Turning a line into a checklist from the toolbar moved the caret to the next line; it now stays in the new checklist item.

## [0.3.1] - 2026-10-22

### Fixed
- **Edit diagram** opened a blank draw.io page instead of the existing diagram (saving it would have erased the diagram). If a diagram can't be read, a message now offers to open it in VS Code instead.

## [0.3.0] - 2026-10-22

### Added
- **Live collaboration (preview)**: edit a document together in real time with no server or account. Start a session, share the invite, and see everyone's edits merge as they type, with named carets, selections and avatars; properties and comment threads are shared too, and undo only takes back your own changes. Works through Live Share, on your network, or on one machine.
- **Comments** with reply threads: select text, a table or an image and add a comment; resolve, reopen or delete threads. Stored as hidden HTML comments so they stay invisible on GitHub.
- **draw.io diagrams**: insert with `/drawio`, edit `.drawio.svg` / `.drawio.png` images in place with the embedded diagrams.net editor.
- **Properties panel** for YAML frontmatter, collapsed to a one-line summary and editable as values or raw YAML (`kenMarkdown.alwaysShowProperties` shows it on every document).
- **Heading control**: a split button with the last-used level and a menu of Text and Heading 1–6, plus Tab / Shift+Tab to change a heading's level and Backspace at the start of a heading to turn it into text.
- List indent and outdent buttons; underline; drag-to-resize table columns (widths saved in a hidden comment); button tooltips showing your current shortcuts; an empty-document placeholder.
- An editor icon and a Marketplace-ready README.

### Changed
- The formatting bubble over selected text is gone; use the toolbar and shortcuts instead.
- Copy-link buttons on headings sit at a constant distance from the heading text.
- Ordered lists keep their numbering style, items of one list sit closer together, and quotes use the quote font in gray italics.
- The caret can always leave a final table, diagram, code block, image or rule.
- The toolbar position is configurable (`kenMarkdown.toolbar`: `bottom`, `top` or `hidden`).

## [0.2.0] - 2026-10-21

### Added
- **Keyboard shortcuts** as VS Code commands that you can rebind in the Keyboard Shortcuts editor, active only while the editor has focus. A shortcut list (<kbd>⌘/</kbd> / <kbd>Ctrl+/</kbd>) shows the current keys, including any you changed.
- One-line installer (`install.sh`).

## [0.1.0] - 2026-10-21

### Added
- Initial release: a WYSIWYG Markdown editor for `.md` and `.markdown` files built as a VS Code custom text editor, themed entirely by your VS Code colour theme.
- GitHub-flavoured Markdown: tables, task lists, strikethrough, footnotes, alerts, autolinks, sanitized HTML, syntax-highlighted code blocks and Mermaid diagrams.
- Instant slash menu, bottom toolbar, checklist drag handles and full table editing.
- Paste and drop of images and files (images saved to `_Images` next to the document).
- Settings for fonts, text size, line height and column width.
