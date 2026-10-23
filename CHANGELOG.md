# Changelog

All notable changes to **Ken Markdown Editor** are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added

- A **What's New** page after updating to a new minor or major version, showing the release notes since your previous version. Open it any time with **Ken Markdown: Show What's New**.

### Changed

- Pasting or dropping a file that is already in the workspace (from the Explorer or your file manager) now links to it where it is instead of copying it. Files from outside the workspace and screenshots are still saved. Set `kenMarkdown.workspaceFiles` to `copy` to keep copying.
- Selections that cross images, tables, diagrams and code blocks now highlight those blocks whole, and Backspace, Delete or typing removes them cleanly. Shift+Arrow steps over a whole table or code block instead of getting stuck in its cells, and Shift+click extends the selection by whole blocks.
- Properties: values are colored by YAML type, long keys and values wrap instead of being cut off, the YAML view grows to fit, and frontmatter with nested or multi-line values opens as YAML only (with a tooltip saying why).
- The toolbar now sits at the top of the editor by default (`kenMarkdown.toolbar`: `"bottom"` puts it back).

### Fixed

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
