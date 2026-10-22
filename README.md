# Ken Markdown Editor

**Write Markdown the way it will look.** A calm, distraction-free WYSIWYG editor for every `.md` file in VS Code: no split preview, no syntax to squint at. Your VS Code theme colours everything, and your files stay plain, GitHub-compatible Markdown.

![A document in Ken Markdown Editor: properties, a table, a checklist, a Mermaid diagram and the toolbar](media/screenshot-dark.png)

![The same document in a light theme](media/screenshot-light.png)

## Why you'll like it

- **Opens straight into the editor.** Every `.md` / `.markdown` file is edited in place. There is no preview pane to keep in sync. Need the raw text? One click opens the source.
- **Your files stay clean.** Saved as plain Markdown that GitHub, Git diffs and every other tool read as usual. Opening a file never rewrites it, and edits change only the lines you touched.
- **Native to VS Code.** Save, auto-save, undo, dirty markers, hot exit, Git and search all behave as they do for any text file.
- **Looks right in any theme.** Text, code, tables, alerts, menus and diagrams follow your colour theme and update live when you switch.
- **Fast to write.** Type `/` for a menu of everything you can insert, or use the keyboard shortcuts and the compact toolbar.

## Get started

1. Install **Ken Markdown Editor** from the Extensions view (<kbd>⇧⌘X</kbd> / <kbd>Ctrl+Shift+X</kbd>), or run:

   ```sh
   code --install-extension ArthurPachachura.ken-markdown-editor
   ```

2. Open any Markdown file. It opens in the editor.
3. Type `/` to insert headings, lists, tables, code blocks, diagrams, alerts and more. Press <kbd>⌘/</kbd> (<kbd>Ctrl+/</kbd>) to see every shortcut.

To view or edit the raw text, use the **Open Markdown Source** button in the editor's title bar. To make the plain text editor the default instead, use *Reopen Editor With…* → *Configure default editor for '*.md'…*.

## Features

### GitHub-flavoured Markdown, rendered as you type

Everything in the [GFM spec](https://github.github.com/gfm/) plus GitHub's extensions renders and edits in place and is written back faithfully:

- Headings, emphasis, links, images, quotes, rules and hard breaks
- **Tables** with column alignment, drag-to-resize columns and a full table menu
- **Task lists** you can tick with a click, with drag handles to reorder them
- Strikethrough, autolinks, footnotes and nested lists that keep their numbering style (`1.`, `a.`, `i.`, `1)`)
- **Code blocks** with syntax highlighting
- **GitHub alerts**: `> [!NOTE]`, `[!TIP]`, `[!IMPORTANT]`, `[!WARNING]`, `[!CAUTION]`
- **LaTeX math**, rendered with KaTeX: inline `$e^{i\pi} + 1 = 0$` (or `$$…$$` within a line) and `$$` blocks or ```` ```math ```` fences, as GitHub writes them. Click a formula to edit its source with a live preview
- Underline (written as `<ins>`, which GitHub renders underlined) and sanitized inline or block HTML (`<kbd>`, `<sub>`, `<mark>`, centered images…); double-click any HTML to edit its source
- `[[Wiki links]]` and relative links that open the target file; `#anchor` links that scroll within the document; copy-link buttons on headings

Saving normalises some syntax without changing what GitHub shows (setext headings become `#` headings, `*`/`+` bullets become `-`, reference-style links are written inline). Math follows GitHub's rules: the opening `$` must be followed and the closing `$` preceded by a non-space, and the closing `$` must not be followed by a digit, so prices like `$5 and $10` stay text. A literal `$` is escaped (`\$`) only where it would otherwise start math.

### Slash menu and toolbar

Type `/` at the start of a line or after a space and a compact menu opens instantly: text and headings, lists and checklists, quote, code block, table, divider, image, diagrams, equations, table of contents and the five alerts. Keep typing to filter. Direct shortcuts such as `/h2 `, `/todo `, `/quote ` and `/toc ` work too.

A slim toolbar (bottom by default; move it to the top or hide it with `kenMarkdown.toolbar`) covers undo/redo, a heading control, bold, italic, underline, strikethrough, inline code, links, lists, quote, code block, table, divider and image. Buttons show the state at the caret, and hovering shows each name and shortcut.

Typing Markdown works as you'd expect: `# `, `- `, `1. `, `[ ] `, `> `, `` ``` ``, `---`, `**bold**`, `*italic*`, `~~strike~~`, `` `code` ``, `$x^2$` and `$$ ` (an equation block) convert as you type.

### Tables

With the caret in a table the toolbar switches to table actions, and right-clicking a cell offers the same list: insert, move and delete rows and columns, align columns, and toggle full width. <kbd>Tab</kbd> moves between cells and adds a row from the last one. Drag a column's border to resize it; widths are saved in a comment that GitHub and other renderers hide.

### Diagrams

- **Mermaid** diagrams render live from ` ```mermaid ` fences, themed to match your editor. Click one to zoom.
- **draw.io** diagrams: insert with `/drawio`, then double-click to edit in diagrams.net's embedded editor. They are saved as `.drawio.svg` or `.drawio.png`, ordinary images that GitHub shows, with the diagram source embedded.

### Comments

Select any text, table or image and click **Add comment** (<kbd>⌥⌘M</kbd> / <kbd>Ctrl+Alt+M</kbd>). Comments are threads: reply, resolve, reopen or delete. They're stored as hidden HTML comments, so they travel with the file and stay invisible on GitHub:

```markdown
Revenue grew <!-- ken:comment c1 -->**12%**<!-- /ken:comment c1 --> in Q3.
```

### Properties (frontmatter)

YAML frontmatter shows as an editable **Properties** panel above your text. Collapse it to a one-line summary, expand it to edit values, add or remove rows, or switch to raw YAML. Only the lines you change are rewritten, so comments and formatting are kept.

### Paste and drop images and files

- Paste a screenshot or drop an image and it's saved to an `_Images` folder next to the document and linked with a relative path. Change the folder with `kenMarkdown.imageFolder`.
- Other files are copied next to the document and linked inline.
- Files dragged from VS Code's Explorer are linked where they are.
- To drop files into the editor, hold <kbd>Shift</kbd> while dropping (a VS Code rule for all editors).

### Live collaboration (preview)

Edit a document together in real time, with no server or account: whoever starts the session hosts it from their own VS Code.

1. Run **Ken Markdown: Start Collaboration Session**. An invite (`ws://…/?token=…`) is copied to your clipboard.
2. Send it to your collaborators. They run **Ken Markdown: Join Collaboration Session…** and paste it.
3. Everyone opens the same file (by its path in the workspace). Edits merge as you type. Each person's caret and selection show in their colour with their name, and avatars in the top-right corner show who's there. Properties and comment threads are shared too.

How guests reach you:

- **Live Share**: start a Live Share session first and guests can join with the invite as is (the session's port is shared with them automatically).
- **Same network or VPN**: turn on `kenMarkdown.collaboration.allowNetwork`; the invite then uses your network address.
- **Same machine**: works as is.

Your own VS Code writes the file. One editor per copy of the file saves the shared text, so Live Share guests editing your files don't write them twice, and people in their own checkout keep their own copy up to date. <kbd>⌘Z</kbd> undoes only your own changes. **Ken Markdown: Leave Collaboration Session** (or the *Collaborating* status bar item) ends it, and everyone keeps editing on their own.

### Looks the way you want

Typography is set for long-form reading, with Hanken Grotesk, Newsreader and JetBrains Mono bundled. Every font, the text size, line height and column width are adjustable in settings.

## Keyboard shortcuts

Every editing action is a VS Code command, so you can change, remove or add keys in VS Code's **Keyboard Shortcuts** editor (search for `Ken Markdown`). They apply only while this editor has focus. A selection of the defaults:

| Action | macOS | Windows / Linux |
| --- | --- | --- |
| Bold / Italic / Underline | ⌘B / ⌘I / ⌘U | Ctrl+B / Ctrl+I / Ctrl+U |
| Inline code | ⌘E | Ctrl+E |
| Link | ⌘K | Ctrl+K |
| Heading 1–6, Text | ⌥⌘1–6, ⌥⌘0 | Ctrl+Alt+1–6, Ctrl+Alt+0 |
| Numbered / Bulleted list / Checklist | ⌥⌘7 / ⌥⌘8 / ⌥⌘9 | Ctrl+Alt+7 / 8 / 9 |
| Quote | ⇧⌘B | Ctrl+Shift+B |
| Code block | ⌥⌘C | Ctrl+Alt+C |
| Add comment | ⌥⌘M | Ctrl+Alt+M |
| Show all shortcuts | ⌘/ | Ctrl+/ |

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `kenMarkdown.fontSize` | `16` | Base font size in px; headings, code and lists scale from it. |
| `kenMarkdown.bodyFontFamily` | Hanken Grotesk | Body text font stack. |
| `kenMarkdown.headingFontFamily` | Newsreader | Heading font stack. |
| `kenMarkdown.quoteFontFamily` | *(heading font)* | Block quote font stack (set in italics). |
| `kenMarkdown.codeFontFamily` | JetBrains Mono | Inline code and code block font stack. |
| `kenMarkdown.lineHeight` | `1.85` | Body line height. |
| `kenMarkdown.maxWidth` | `720` | Width of the text column in px. |
| `kenMarkdown.toolbar` | `bottom` | `bottom`, `top` or `hidden`. |
| `kenMarkdown.alwaysShowProperties` | `false` | Show the Properties panel on every document. |
| `kenMarkdown.commentAuthor` | *(git's `user.name`)* | Your name on comments you add. |
| `kenMarkdown.imageFolder` | `_Images` | Where pasted and dropped images are saved; empty for beside the document. |
| `kenMarkdown.collaboration.port` | `0` | Port for collaboration sessions you start; `0` picks a free one. |
| `kenMarkdown.collaboration.allowNetwork` | `false` | Let people on your network join sessions you start (invites still need their secret token). |

## FAQ

**Will it change my Markdown files?** Only when you edit them, and only the changed lines are rewritten. Opening a file never modifies it.

**Does it need an internet connection?** No. The one exception is editing draw.io diagrams, which loads diagrams.net's embedded editor (nothing is uploaded).

**Is live collaboration secure?** The session runs only while you host it, and only people with the invite's secret token can join. By default it listens on your machine only. Traffic isn't encrypted on a network, so prefer Live Share or a VPN outside trusted networks. Concurrent edits to the same Property or the same comment thread keep the last one saved.

**Does it work with other VS Code builds?** It works in VS Code 1.90 and newer, and in compatible forks that support custom editors.

## Feedback

Found a bug or have an idea? Please [open an issue](https://github.com/smo-key/md-editor-vscode/issues). To work on the extension itself, see [CONTRIBUTING.md](CONTRIBUTING.md).
