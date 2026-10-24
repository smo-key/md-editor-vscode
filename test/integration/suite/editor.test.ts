import * as assert from "assert";
import * as vscode from "vscode";
import type { TestAction } from "../../../src/protocol";

const VIEW_TYPE = "kenMarkdown.editor";

function fixture(name: string): vscode.Uri {
  return vscode.Uri.joinPath(vscode.workspace.workspaceFolders![0].uri, name);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until<T>(what: string, fn: () => Thenable<T> | T, ok: (v: T) => boolean, timeout = 15000): Promise<T> {
  const end = Date.now() + timeout;
  let last: T;
  do {
    try {
      last = await fn();
      if (ok(last)) return last;
    } catch {
      // Not ready yet (e.g. the extension is still activating).
    }
    await sleep(100);
  } while (Date.now() < end);
  throw new Error(`timed out waiting for ${what}; last value: ${JSON.stringify(last!)}`);
}

function webview(uri: vscode.Uri, action: TestAction): Thenable<unknown> {
  return vscode.commands.executeCommand("kenMarkdown._test", uri.toString(), action);
}

async function openEditor(uri: vscode.Uri): Promise<vscode.TextDocument> {
  await vscode.commands.executeCommand("vscode.open", uri);
  // Generous: the first open also activates the extension and boots the webview.
  await until(
    "webview ready",
    () => vscode.commands.executeCommand<boolean>("kenMarkdown._test", uri.toString()),
    Boolean,
    90000,
  );
  // The editor mounts asynchronously after the webview reports ready.
  await until("editor mounted", () => webview(uri, { kind: "count", selector: ".milkdown .ProseMirror" }), (n) => n === 1);
  return vscode.workspace.openTextDocument(uri);
}

/** `#rrggbb[aa]` → the `rgb(...)` form getComputedStyle reports. */
function hexToRgb(hex: string): string {
  const h = hex.trim().replace("#", "");
  const n = (i: number) => parseInt(h.slice(i, i + 2), 16);
  return h.length === 8 && h.slice(6) !== "ff"
    ? `rgba(${n(0)}, ${n(2)}, ${n(4)}, ${+(n(6) / 255).toFixed(3)})`
    : `rgb(${n(0)}, ${n(2)}, ${n(4)})`;
}

async function themeColors(uri: vscode.Uri) {
  const [bg, fg, bodyBg, textColor] = await Promise.all([
    webview(uri, { kind: "getStyle", selector: "html", property: "--vscode-editor-background" }),
    webview(uri, { kind: "getStyle", selector: "html", property: "--vscode-editor-foreground" }),
    webview(uri, { kind: "getStyle", selector: "body", property: "background-color" }),
    webview(uri, { kind: "getStyle", selector: ".milkdown .ProseMirror p", property: "color" }),
  ]);
  return { bg: String(bg), fg: String(fg), bodyBg: String(bodyBg), textColor: String(textColor) };
}

describe("Ken Markdown Editor", function () {
  this.timeout(120000);

  afterEach(async () => {
    await vscode.commands.executeCommand("workbench.action.revertAndCloseActiveEditor");
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
  });

  it("opens .md files in the custom editor by default", async () => {
    const uri = fixture("sample.md");
    const doc = await openEditor(uri);
    const tab = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
    assert.ok(tab instanceof vscode.TabInputCustom, "active tab should be a custom editor");
    assert.strictEqual((tab as vscode.TabInputCustom).viewType, VIEW_TYPE);
    // Opening is not an edit.
    await sleep(500);
    assert.strictEqual(doc.isDirty, false);
  });

  it("renders GitHub-flavoured Markdown the way GitHub does", async () => {
    const uri = fixture("sample.md");
    await openEditor(uri);
    assert.strictEqual(await webview(uri, { kind: "count", selector: ".milkdown h1" }), 1, "h1");
    assert.strictEqual(await webview(uri, { kind: "count", selector: ".milkdown .github-alert" }), 1, "alert");
    assert.strictEqual(await webview(uri, { kind: "count", selector: ".milkdown table.children" }), 1, "table");
    // Frontmatter is set aside, not rendered as a rule and a heading.
    assert.strictEqual(await webview(uri, { kind: "count", selector: ".milkdown hr" }), 0);
    // No view-only mode: the document is editable.
    assert.strictEqual(
      await webview(uri, { kind: "count", selector: '.milkdown .ProseMirror[contenteditable="true"]' }),
      1,
    );
  });

  it("renders every GFM construct", async () => {
    const uri = fixture("gfm.md");
    const doc = await openEditor(uri);
    const count = (selector: string) => webview(uri, { kind: "count", selector });
    const expectations: [string, number][] = [
      [".milkdown h1", 1],
      [".milkdown h2", 8],
      [".milkdown .ProseMirror strong", 3],
      [".milkdown .ProseMirror em", 2],
      [".milkdown .ProseMirror del", 2],
      [".milkdown .ProseMirror a[href='https://github.com']", 1],
      [".milkdown .ProseMirror a[href='http://www.example.com']", 1],
      [".milkdown .ProseMirror a[href='mailto:mail@example.com']", 1],
      [".milkdown .milkdown-image-block", 1],
      [".milkdown .label.checked", 1],
      [".milkdown .label.unchecked", 3],
      [".milkdown table.children", 1],
      [".milkdown table.children th", 3],
      [".milkdown .milkdown-code-block", 3],
      [".milkdown .github-alert[data-kind='tip']", 1],
      [".milkdown .github-alert[data-kind='warning']", 1],
      [".milkdown blockquote blockquote", 1],
      [".milkdown sup", 2],
      [".milkdown dl[data-type='footnote_definition']", 2],
      [".milkdown .ken-html-raw", 6],
      [".milkdown hr", 1],
    ];
    const actual: Record<string, unknown> = {};
    for (const [selector] of expectations) actual[selector] = await count(selector);
    assert.deepStrictEqual(actual, Object.fromEntries(expectations));
    await sleep(400);
    assert.strictEqual(doc.isDirty, false, "opening must not rewrite the file");
  });

  it("renders raw HTML blocks sanitized", async () => {
    const uri = fixture("html.md");
    await openEditor(uri);
    assert.strictEqual(await webview(uri, { kind: "count", selector: ".ken-html-rendered img[alt='logo']" }), 1);
    assert.strictEqual(await webview(uri, { kind: "count", selector: ".ken-html-rendered img[onerror]" }), 0);
    assert.strictEqual(await webview(uri, { kind: "count", selector: ".ken-html-rendered script" }), 0);
    // A relative image src is resolved to a webview resource URL.
    const src = await until(
      "logo src resolved",
      () => webview(uri, { kind: "getAttr", selector: ".ken-html-rendered img[alt='logo']", name: "src" }),
      (v) => String(v).startsWith("https://"),
    );
    assert.match(String(src), /logo\.svg$/);
  });

  it("keeps GFM faithful when saving an edit", async () => {
    const uri = fixture("gfm.md");
    const doc = await openEditor(uri);
    await webview(uri, { kind: "insertText", text: "!", at: "start" });
    await until("document updated", () => doc.getText(), (t) => t.startsWith("# !GFM"));
    const text = doc.getText();
    assert.ok(text.includes("- Bullet one\n- Bullet two\n  - Nested bullet\n    1. Nested ordered"), "tight lists stay tight");
    assert.ok(text.includes("- [ ] Open task\n- [x] Done task\n  - [ ] Nested task"), "task list stays tight");
    assert.ok(text.includes("![Alt text](https://example.com/image.png \"Image title\")"), "alt text kept");
    assert.match(text, /\| :-+ +\| :-+: \| -+: \|/, "alignment kept");
    assert.ok(text.includes("[^1]: The first footnote."), "footnotes kept");
    assert.ok(text.includes("> [!TIP]\n> Helpful advice."), "alerts kept");
    assert.ok(text.includes("<details>\n<summary>Click to expand</summary>"), "html kept");
    assert.ok(text.includes("~~strikethrough~~"), "strikethrough kept");
  });

  it("writes edits into the TextDocument and VS Code saves them", async () => {
    const uri = fixture("sample.md");
    const doc = await openEditor(uri);
    await webview(uri, { kind: "insertText", text: " Typed in the webview.", at: "end" });
    await until("document updated", () => doc.getText(), (t) => t.includes("Typed in the webview."));
    assert.ok(doc.isDirty, "edit should dirty the document");
    assert.ok(doc.getText().startsWith("---\ntitle: Sample\naliases: [demo]\n---\n"), "frontmatter is kept");
    assert.ok(await doc.save());
    const disk = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString("utf8");
    assert.ok(disk.includes("Typed in the webview."));
    assert.strictEqual(doc.isDirty, false);
  });

  it("flushes the last keystroke when saving immediately", async () => {
    const uri = fixture("sample.md");
    const doc = await openEditor(uri);
    await webview(uri, { kind: "insertText", text: "Z", at: "start" });
    // Save straight away, before the webview's debounce has reported the edit.
    await vscode.commands.executeCommand("workbench.action.files.save");
    await until("saved", () => doc.isDirty, (d) => d === false);
    const disk = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString("utf8");
    assert.ok(disk.includes("# ZSample document"), disk);
  });

  it("shows changes made outside the editor", async () => {
    const uri = fixture("sample.md");
    const doc = await openEditor(uri);
    const edit = new vscode.WorkspaceEdit();
    edit.insert(uri, doc.positionAt(doc.getText().length), "\nAdded from outside.\n");
    assert.ok(await vscode.workspace.applyEdit(edit));
    // The rendered document, not just the text the webview was sent.
    await until(
      "webview shows external edit",
      () => webview(uri, { kind: "getText", selector: ".milkdown .ProseMirror" }),
      (t) => String(t).includes("Added from outside."),
    );
    // Applying the host's text is not an edit: nothing is echoed back.
    const before = doc.getText();
    await sleep(500);
    assert.strictEqual(doc.getText(), before);
  });

  it("shows a change written to the file on disk", async function () {
    this.timeout(180000);
    const fs = await import("fs");
    // Its own fixture: earlier tests edit and save sample.md.
    const uri = fixture("reload.md");
    const doc = await openEditor(uri);
    await webview(uri, { kind: "insertText", text: "Saved first. ", at: "end" });
    await until("edit applied", () => doc.getText(), (t) => t.includes("Saved first."));
    assert.ok(await doc.save());
    // VS Code drops a file change that arrives while it is still saving.
    await sleep(2000);
    // Whether VS Code hears about the write at all: on a busy macOS machine
    // FSEvents can deliver it minutes late or never, and then no editor
    // (plain text ones included) reloads.
    let heard = false;
    const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.workspace.workspaceFolders![0], "**/reload.md"));
    watcher.onDidChange(() => (heard = true));
    watcher.onDidCreate(() => (heard = true));
    await sleep(500);
    // Another program rewrites the file: VS Code reloads the clean document,
    // and the editor follows it.
    const text = doc.getText().replace("# Reload document\n", "# Reload document\n\nWritten on disk.\n");
    assert.notStrictEqual(text, doc.getText());
    fs.writeFileSync(uri.fsPath, text);
    try {
      await until(
        "webview shows the file's new text",
        () => webview(uri, { kind: "getText", selector: ".milkdown .ProseMirror" }),
        (t) => String(t).includes("Written on disk."),
        60000,
      );
    } catch (err) {
      if (heard || doc.getText() === text) throw err;
      console.warn("skipped: VS Code's file watcher never reported the write");
      this.skip();
    } finally {
      watcher.dispose();
    }
    assert.strictEqual(doc.getText(), text);
    // Nothing is echoed back: the document stays as the disk has it.
    await sleep(500);
    assert.strictEqual(doc.getText(), text);
    assert.strictEqual(doc.isDirty, false);
  });

  it("undoes one step per Cmd/Ctrl+Z", async () => {
    // Its own fixture, so earlier tests' saved edits can't change what it sees.
    const uri = fixture("undo.md");
    const doc = await openEditor(uri);
    const mac = process.platform === "darwin";
    const mod = mac ? { meta: true } : { ctrl: true };
    assert.ok(await webview(uri, { kind: "caretAfter", text: "Undo me." }));
    await webview(uri, { kind: "insertText", text: " first", at: "caret" });
    await until("first edit", () => doc.getText(), (t) => t.includes("Undo me. first\n"));
    await sleep(700);
    await webview(uri, { kind: "insertText", text: " second", at: "caret" });
    await until("second edit", () => doc.getText(), (t) => t.includes("Undo me. first second\n"));
    await sleep(700);
    // VS Code ignores synthetic (untrusted) key events forwarded from a
    // webview, so a test can't press Cmd/Ctrl+Z itself (the real key press is
    // covered by "routes real key presses", KEN_TEST_REAL_KEYS=1). What it can
    // check is each half of the route: the page leaves the key to VS Code
    // without undoing anything itself, the key is bound to kenMarkdown.undo,
    // and that command undoes exactly one step.
    for (const key of [{ key: "z", code: "KeyZ", ...mod }, { key: "z", code: "KeyZ", ...mod, shift: true }]) {
      const r = (await webview(uri, { kind: "key", ...key })) as { leftToVsCode: boolean; editorChanged: boolean };
      assert.deepStrictEqual(r, { leftToVsCode: true, editorChanged: false }, `${JSON.stringify(key)} is left to VS Code`);
    }
    const bindings = vscode.extensions.getExtension("ArthurPachachura.ken-markdown-editor")!.packageJSON.contributes.keybindings as { command: string; key: string; mac?: string; when?: string }[];
    const bound = (command: string, keys: string) =>
      bindings.some((b) => b.command === command && (mac ? b.mac ?? b.key : b.key) === keys && /kenMarkdown\.editorFocused/.test(b.when ?? ""));
    assert.ok(bound("kenMarkdown.undo", mac ? "cmd+z" : "ctrl+z"), "Cmd/Ctrl+Z runs kenMarkdown.undo");
    assert.ok(bound("kenMarkdown.redo", mac ? "cmd+shift+z" : "ctrl+y"), "Cmd+Shift+Z / Ctrl+Y runs kenMarkdown.redo");
    assert.ok(doc.getText().includes("Undo me. first second\n"), "the keys alone changed nothing");
    await vscode.commands.executeCommand("kenMarkdown.undo");
    await until("one undo", () => doc.getText(), (t) => !t.includes(" second"));
    await sleep(1000);
    assert.ok(doc.getText().includes("Undo me. first\n"), `only the last edit is undone: ${JSON.stringify(doc.getText())}`);
    await vscode.commands.executeCommand("kenMarkdown.redo");
    await until("redo", () => doc.getText(), (t) => t.includes(" second"));
    await sleep(1000);
    assert.ok(doc.getText().includes("Undo me. first second\n"), "redo restores exactly one step");
  });

  it("writes the file's own bytes back once every edit is undone", async () => {
    // Syntax the serializer would normalize: `=====`, `| --- |`, `*` bullets.
    const uri = fixture("undo-bytes.md");
    const doc = await openEditor(uri);
    const original = doc.getText();
    assert.ok(await webview(uri, { kind: "caretAfter", text: "Type here." }));
    await webview(uri, { kind: "insertText", text: " Typed.", at: "caret" });
    await until("edit", () => doc.getText(), (t) => t.includes("Type here. Typed."));
    assert.notStrictEqual(doc.getText(), original);
    await vscode.commands.executeCommand("kenMarkdown.undo");
    await until("undone", () => doc.getText(), (t) => !t.includes("Typed."));
    await sleep(700);
    assert.strictEqual(doc.getText(), original, "the original bytes, not a normalized rewrite");
  });

  it("opens the slash menu on / and runs the chosen command", async () => {
    const uri = fixture("sample.md");
    const doc = await openEditor(uri);
    assert.ok(await webview(uri, { kind: "caretAfter", text: "Alerts render as banners." }));
    await webview(uri, { kind: "insertText", text: " /", at: "caret" });
    assert.strictEqual(await webview(uri, { kind: "count", selector: ".ken-slash-menu:not([hidden])" }), 1);
    await webview(uri, { kind: "insertText", text: "div", at: "caret" });
    assert.ok(await webview(uri, { kind: "click", selector: '.ken-slash-item[data-id="divider"]' }));
    await until("divider written", () => doc.getText(), (t) => /Alerts render as banners\. ?\n>\n> \*\*\*\n/.test(t));
    assert.ok(!doc.getText().includes("/div"), "the slash text is removed");
  });

  it("has a toolbar whose edits reach the document", async () => {
    const uri = fixture("sample.md");
    const doc = await openEditor(uri);
    assert.ok((await webview(uri, { kind: "count", selector: ".ken-toolbar .ken-toolbar-button" })) as number >= 15);
    // No block drag handles or "+" buttons outside checklists.
    assert.strictEqual(await webview(uri, { kind: "count", selector: ".milkdown-block-handle" }), 0);
    assert.ok(await webview(uri, { kind: "caretAfter", text: "A paragraph with" }));
    await webview(uri, { kind: "click", selector: '[data-id="heading-menu"]' });
    await webview(uri, { kind: "click", selector: '.ken-heading-item[data-id="heading2"]' });
    await until("heading written", () => doc.getText(), (t) => t.includes("## A paragraph with"));
    // In a table the toolbar offers the table actions.
    assert.ok(await webview(uri, { kind: "caretAfter", text: "1" }));
    await until(
      "table toolbar",
      () => webview(uri, { kind: "getAttr", selector: ".ken-toolbar", name: "data-mode" }),
      (m) => m === "table",
    );
    await webview(uri, { kind: "click", selector: '.ken-toolbar-button[data-id="row-below"]' });
    await until("row added", () => doc.getText(), (t) => /\| a +\| 1 +\|\n\| +\| +\|/.test(t));
  });

  describe("keyboard shortcuts", () => {
    it("runs editor commands from VS Code commands (what keybindings invoke)", async () => {
      const uri = fixture("attach.md");
      const doc = await openEditor(uri);
      assert.ok(await webview(uri, { kind: "selectText", text: "target" }));
      await vscode.commands.executeCommand("kenMarkdown.bold");
      await until("bold", () => doc.getText(), (t) => t.includes("Paste **target** paragraph"));
      await vscode.commands.executeCommand("kenMarkdown.italic");
      await until("bold italic", () => doc.getText(), (t) => /Paste (\*\*\*target\*\*\*|\*\*\*target\*\*\*|_\*\*target\*\*_|\*\*\*target\*\*\*)/.test(t) || t.includes("***target***"));
      await vscode.commands.executeCommand("kenMarkdown.undo");
      await vscode.commands.executeCommand("kenMarkdown.undo");
      await until("undone", () => doc.getText(), (t) => t.includes("Paste target paragraph"));
      assert.ok(await webview(uri, { kind: "caretAfter", text: "Second" }));
      await vscode.commands.executeCommand("kenMarkdown.heading2");
      await until("heading", () => doc.getText(), (t) => t.includes("## Second line."));
      await vscode.commands.executeCommand("kenMarkdown.checklist");
      // A heading cannot open a list item: it becomes the item's text.
      await until("checklist", () => doc.getText(), (t) => t.includes("- [ ] Second line."));
    });

    it("leaves Cmd/Ctrl+letter keys to VS Code instead of handling them twice", async () => {
      const uri = fixture("attach.md");
      const doc = await openEditor(uri);
      assert.ok(await webview(uri, { kind: "selectText", text: "target" }));
      const mod = process.platform === "darwin" ? { meta: true } : { ctrl: true };
      for (const [key, code] of [["b", "KeyB"], ["i", "KeyI"], ["2", "Digit2"]]) {
        const r = (await webview(uri, { kind: "key", key, code, ...mod })) as { leftToVsCode: boolean; editorChanged: boolean };
        assert.deepStrictEqual(r, { leftToVsCode: true, editorChanged: false }, `${key}: the editor leaves it to VS Code`);
      }
      // Clipboard and select-all stay native.
      const copy = (await webview(uri, { kind: "key", key: "c", code: "KeyC", ...mod })) as { leftToVsCode: boolean };
      assert.strictEqual(copy.leftToVsCode, false);
      void doc;
    });

    it("lists every shortcut, with the current keys", async () => {
      const uri = fixture("attach.md");
      await openEditor(uri);
      await vscode.commands.executeCommand("kenMarkdown.showShortcuts");
      await until("panel", () => webview(uri, { kind: "count", selector: ".ken-shortcuts" }), (n) => n === 1);
      const rows = (await webview(uri, { kind: "count", selector: ".ken-shortcuts-row" })) as number;
      assert.ok(rows >= 50, `${rows} rows`);
      const boldKey = process.platform === "darwin" ? "⌘B" : "Ctrl+B";
      assert.strictEqual(
        await webview(uri, { kind: "count", selector: ".ken-shortcuts-row kbd:not(.unbound)" }) as number > 20,
        true,
      );
      const first = await webview(uri, { kind: "getStyle", selector: ".ken-shortcuts", property: "display" });
      assert.strictEqual(first, "flex");
      // The toolbar's tooltips show the keys too.
      const label = await webview(uri, { kind: "getAttr", selector: '.ken-toolbar-button[data-id="bold"]', name: "data-tooltip" });
      const keyLabel = await webview(uri, { kind: "getAttr", selector: '.ken-toolbar-button[data-id="bold"]', name: "data-tooltip-key" });
      assert.strictEqual(label, "Bold");
      assert.strictEqual(keyLabel, boldKey);
      await vscode.commands.executeCommand("kenMarkdown.showShortcuts");
      await until("closed", () => webview(uri, { kind: "count", selector: ".ken-shortcuts" }), (n) => n === 0);
    });

    // Interactive (KEN_TEST_REAL_KEYS=1): VS Code only acts on genuine key
    // presses forwarded from a webview, so harness/real-keys.mjs (or a
    // person) presses the keys; progress goes to $KEN_TEST_REAL_KEYS_LOG.
    const realKeys = process.env.KEN_TEST_REAL_KEYS === "1";
    (realKeys ? it : it.skip)("routes real key presses to the editor's commands", async function () {
      this.timeout(600000);
      const fs = await import("fs");
      const log = (step: string) => fs.writeFileSync(process.env.KEN_TEST_REAL_KEYS_LOG ?? "/tmp/ken-keys.log", step);
      const uri = fixture("keys.md");
      const doc = await openEditor(uri);
      const wait = (what: string, ok: (t: string) => boolean) => until(what, () => doc.getText(), ok, 240000);
      assert.ok(await webview(uri, { kind: "selectText", text: "me" }));
      log("1 press cmd+b");
      await wait("cmd+b bolds", (t) => t.startsWith("Select **me** please."));
      log("2 press cmd+alt+2");
      await wait("cmd+alt+2 makes a heading", (t) => t.startsWith("## Select **me** please."));
      log("3 press cmd+z");
      await wait("cmd+z undoes once", (t) => t.startsWith("Select **me** please."));
      await sleep(1500);
      assert.ok(doc.getText().startsWith("Select **me** please."), "one undo per key press");
      log("4 press cmd+/");
      await until("cmd+/ lists shortcuts", () => webview(uri, { kind: "count", selector: ".ken-shortcuts" }), (n) => n === 1, 240000);
      log("5 press Escape");
      await until("Escape closes it", () => webview(uri, { kind: "count", selector: ".ken-shortcuts" }), (n) => n === 0, 240000);
      assert.ok(await webview(uri, { kind: "caretAfter", text: "Second paragraph." }));
      log("6 press cmd+alt+9");
      await wait("cmd+alt+9 makes a checklist", (t) => t.includes("- [ ] Second paragraph."));
      assert.ok(await webview(uri, { kind: "selectText", text: "please" }));
      log("7 press cmd+k");
      await until(
        "cmd+k opens the link editor (not a VS Code chord)",
        () => webview(uri, { kind: "count", selector: ".milkdown-link-edit[data-show='true']" }),
        (n) => n === 1,
        240000,
      );
      const textBefore = doc.getText();
      log("8 focus the Explorer and press cmd+b");
      const flag = `${process.env.KEN_TEST_REAL_KEYS_LOG ?? "/tmp/ken-keys.log"}.finished`;
      await until("driver finished", () => fs.existsSync(flag), Boolean, 240000);
      fs.rmSync(flag, { force: true });
      assert.strictEqual(doc.getText(), textBefore, "Cmd+B outside the editor is VS Code's, not ours");
      log("done");
    });

    it("shows the user's own bindings once they customize them", async () => {
      const fs = await import("fs");
      const pathMod = await import("path");
      const ext = vscode.extensions.all.find((e) => e.id.toLowerCase() === "arthurpachachura.ken-markdown-editor")!;
      const uri = fixture("attach.md");
      await openEditor(uri);
      // The file Keyboard Shortcuts writes, as the extension locates it.
      const file = await vscode.commands.executeCommand<string>("kenMarkdown._testKeybindingsFile");
      const userDir = pathMod.dirname(file);
      console.log("keybindings file:", file);
      const original = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null;
      const mac = process.platform === "darwin";
      fs.mkdirSync(userDir, { recursive: true });
      fs.writeFileSync(
        file,
        `// test\n[{ "key": "${mac ? "cmd+shift+8" : "ctrl+shift+8"}", "command": "kenMarkdown.bold" },
          { "key": "${mac ? "cmd+b" : "ctrl+b"}", "command": "-kenMarkdown.bold" },]`,
      );
      try {
        const expected = mac ? "⇧⌘8" : "Ctrl+Shift+8";
        await until(
          "tooltip follows the new key",
          () => webview(uri, { kind: "getAttr", selector: '.ken-toolbar-button[data-id="bold"]', name: "data-tooltip-key" }),
          (t) => t === expected,
          10000,
        );
      } finally {
        if (original === null) fs.rmSync(file, { force: true });
        else fs.writeFileSync(file, original);
      }
    });

    it("contributes keybindings VS Code can show and customize", async () => {
      const ext = vscode.extensions.all.find((e) => e.id.toLowerCase() === "arthurpachachura.ken-markdown-editor")!;
      const keybindings = ext.packageJSON.contributes.keybindings as { command: string; mac: string; key: string; when: string }[];
      const bold = keybindings.find((k) => k.command === "kenMarkdown.bold")!;
      assert.strictEqual(bold.mac, "cmd+b");
      assert.strictEqual(bold.key, "ctrl+b");
      const all = await vscode.commands.getCommands(true);
      for (const k of keybindings) assert.ok(all.includes(k.command), k.command);
    });
  });

  describe("pasting and dropping files", () => {
    const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAQAAAADCAIAAAA7ljmRAAAAD0lEQVR4nGNgaGhAIJwcAOQnDAFPds4oAAAAAElFTkSuQmCC";
    const b64 = (text: string) => Buffer.from(text).toString("base64");
    type Img = { src: string; loaded: boolean };

    async function exists(uri: vscode.Uri): Promise<boolean> {
      try {
        await vscode.workspace.fs.stat(uri);
        return true;
      } catch {
        return false;
      }
    }

    async function imagesLoaded(uri: vscode.Uri, count: number): Promise<Img[]> {
      return until(
        `${count} images loaded`,
        () => webview(uri, { kind: "images" }) as Thenable<Img[]>,
        (imgs) => imgs.length === count && imgs.every((i) => i.loaded),
      );
    }

    it("pastes a screenshot into _Images, on its own line, and shows it", async () => {
      const uri = fixture("attach.md");
      const doc = await openEditor(uri);
      assert.ok(await webview(uri, { kind: "caretAfter", text: "Paste target" }));
      await webview(uri, { kind: "transfer", event: "paste", files: [{ name: "image.png", type: "image/png", base64: PNG }] });
      const text = await until("image linked", () => doc.getText(), (t) => t.includes("](_Images/"));
      const m = /^Paste target paragraph here\.\n\n!\[\]\((_Images\/attach-pasted-\d{8}-\d{6}\.png)\)\n\nSecond line\.\n$/.exec(text);
      assert.ok(m, JSON.stringify(text));
      const saved = vscode.Uri.joinPath(uri, "..", m[1]);
      assert.ok(await exists(saved), `${saved} written`);
      assert.deepStrictEqual(Buffer.from(await vscode.workspace.fs.readFile(saved)).toString("base64"), PNG);
      // Shown from the workspace through a webview resource URL.
      const [img] = await imagesLoaded(uri, 1);
      assert.match(img.src, /^https:\/\/.*_Images\/attach-pasted-.*\.png$/);
    });

    it("pastes a file as an inline link, saved beside the document", async () => {
      const uri = fixture("attach.md");
      const doc = await openEditor(uri);
      assert.ok(await webview(uri, { kind: "caretAfter", text: "Second" }));
      await webview(uri, { kind: "transfer", event: "paste", files: [{ name: "Spec Sheet (v2).pdf", type: "application/pdf", base64: b64("%PDF-1.4") }] });
      await until("link inline", () => doc.getText(), (t) => t.includes("Second [Spec Sheet (v2).pdf](Spec%20Sheet%20%28v2%29.pdf) line."));
      assert.ok(await exists(vscode.Uri.joinPath(uri, "..", "Spec Sheet (v2).pdf")));
      assert.ok(!(await exists(vscode.Uri.joinPath(uri, "..", "_Images", "Spec Sheet (v2).pdf"))));
    });

    it("drops images and files from the OS: images to _Images, files linked beside", async () => {
      const uri = fixture("attach.md");
      const doc = await openEditor(uri);
      assert.ok(await webview(uri, { kind: "caretAfter", text: "Paste" }));
      await webview(uri, {
        kind: "transfer",
        event: "drop",
        files: [
          { name: "diagram.png", type: "image/png", base64: PNG },
          { name: "notes.txt", type: "text/plain", base64: b64("hello") },
        ],
      });
      const text = await until("dropped", () => doc.getText(), (t) => t.includes("notes.txt"));
      assert.ok(text.includes("![](_Images/diagram.png)"), text);
      assert.ok(text.includes("[notes.txt](notes.txt)"), text);
      assert.ok(!text.includes("<br"), text);
      assert.ok(text.startsWith("Paste target paragraph here.\n\n"), "the paragraph is not split");
      assert.ok(await exists(vscode.Uri.joinPath(uri, "..", "_Images", "diagram.png")));
      assert.ok(await exists(vscode.Uri.joinPath(uri, "..", "notes.txt")));
      await imagesLoaded(uri, 1);

      // A second drop of the same name (different bytes) is not overwritten.
      const OTHER = b64("not the same image");
      await webview(uri, { kind: "transfer", event: "drop", margin: true, files: [{ name: "diagram.png", type: "image/png", base64: OTHER }] });
      await until("deduped", () => doc.getText(), (t) => t.includes("![](_Images/diagram-1.png)"));
      assert.ok(await exists(vscode.Uri.joinPath(uri, "..", "_Images", "diagram-1.png")));

      // The same file again (same name and bytes) is already in the workspace: linked, not copied.
      await webview(uri, { kind: "transfer", event: "drop", margin: true, files: [{ name: "notes.txt", type: "text/plain", base64: b64("hello") }] });
      await until("relinked", () => doc.getText(), (t) => t.split("[notes.txt](notes.txt)").length === 3);
      assert.ok(!(await exists(vscode.Uri.joinPath(uri, "..", "notes-1.txt"))), "not copied again");
    });

    it("puts _Images next to a nested document and links relative to it", async () => {
      const uri = fixture("docs/nested.md");
      const doc = await openEditor(uri);
      assert.ok(await webview(uri, { kind: "caretAfter", text: "A nested page." }));
      await webview(uri, { kind: "transfer", event: "paste", files: [{ name: "image.png", type: "image/png", base64: PNG }] });
      const text = await until("linked", () => doc.getText(), (t) => t.includes("](_Images/"));
      const m = /!\[\]\((_Images\/nested-pasted-[^)]+\.png)\)/.exec(text);
      assert.ok(m, text);
      assert.ok(await exists(vscode.Uri.joinPath(uri, "..", m[1])), "saved in docs/_Images");
      await imagesLoaded(uri, 1);
    });

    it("links files dropped from the Explorer where they are, without copying", async () => {
      const uri = fixture("docs/nested.md");
      const doc = await openEditor(uri);
      assert.ok(await webview(uri, { kind: "caretAfter", text: "A nested" }));
      const logo = fixture("logo.svg");
      const sample = fixture("sample.md");
      await webview(uri, { kind: "transfer", event: "drop", uris: [sample.toString()] });
      await until("explorer link", () => doc.getText(), (t) => t.includes("A nested [sample.md](../sample.md) page."));
      await webview(uri, { kind: "transfer", event: "drop", margin: true, uris: [logo.toString()] });
      await until("explorer image", () => doc.getText(), (t) => t.includes("![](../logo.svg)"));
      await imagesLoaded(uri, 1);
      assert.ok(!(await exists(vscode.Uri.joinPath(uri, "..", "_Images", "logo.svg"))), "not copied");
    });

    // Opt-in (it uses the real system clipboard, restoring text afterwards):
    // KEN_TEST_REAL_CLIPBOARD=1 npm run test:integration. Proves VS Code's own
    // paste path (Electron paste into the webview) delivers the image.
    const realClipboard = process.env.KEN_TEST_REAL_CLIPBOARD === "1" && process.platform === "darwin";
    (realClipboard ? it : it.skip)("pastes an image from the real clipboard with VS Code's Paste", async () => {
      const cp = await import("child_process");
      const fs = await import("fs");
      const os = await import("os");
      const pathMod = await import("path");
      const saved = cp.execFileSync("pbpaste").toString();
      const file = pathMod.join(os.tmpdir(), "ken-clipboard.png");
      fs.writeFileSync(file, Buffer.from(PNG, "base64"));
      cp.execFileSync("osascript", ["-e", `set the clipboard to (read (POSIX file "${file}") as «class PNGf»)`]);
      try {
        const uri = fixture("attach.md");
        const doc = await openEditor(uri);
        assert.ok(await webview(uri, { kind: "caretAfter", text: "Second line." }));
        await vscode.commands.executeCommand("editor.action.clipboardPasteAction");
        const text = await until("pasted from clipboard", () => doc.getText(), (t) => /!\[\]\(_Images\/attach-pasted-[^)]+\.png\)/.test(t));
        const rel = /\((_Images\/[^)]+)\)/.exec(text)![1];
        assert.ok(await exists(vscode.Uri.joinPath(uri, "..", rel)));
        await imagesLoaded(uri, 1);
      } finally {
        cp.execFileSync("pbcopy", { input: saved });
      }
    });

    it("copies files dropped from outside the workspace that VS Code has open", async () => {
      const os = await import("os");
      const fs = await import("fs");
      const pathMod = await import("path");
      const outside = pathMod.join(fs.mkdtempSync(pathMod.join(os.tmpdir(), "ken-outside-")), "outside notes.txt");
      fs.writeFileSync(outside, "outside\n");
      // As when its editor tab is dragged in.
      await vscode.workspace.openTextDocument(vscode.Uri.file(outside));
      const uri = fixture("docs/nested.md");
      const doc = await openEditor(uri);
      assert.ok(await webview(uri, { kind: "caretAfter", text: "A nested page." }));
      await webview(uri, { kind: "transfer", event: "drop", uris: [vscode.Uri.file(outside).toString()] });
      await until("outside copied", () => doc.getText(), (t) => t.includes("[outside notes.txt](outside%20notes.txt)"));
      assert.ok(await exists(vscode.Uri.joinPath(uri, "..", "outside notes.txt")));
    });

    it("never copies an outside file VS Code does not have open (only links it)", async () => {
      const os = await import("os");
      const fs = await import("fs");
      const pathMod = await import("path");
      const secret = pathMod.join(fs.mkdtempSync(pathMod.join(os.tmpdir(), "ken-secret-")), "id_test");
      fs.writeFileSync(secret, "secret\n");
      const uri = fixture("docs/nested.md");
      const doc = await openEditor(uri);
      assert.ok(await webview(uri, { kind: "caretAfter", text: "A nested page." }));
      await webview(uri, { kind: "transfer", event: "drop", uris: [vscode.Uri.file(secret).toString()] });
      await until("linked as is", () => doc.getText(), (t) => t.includes("[id_test]("));
      assert.ok(!(await exists(vscode.Uri.joinPath(uri, "..", "id_test"))), "not copied");
    });

    it("copies workspace files too with kenMarkdown.workspaceFiles = copy", async () => {
      const config = vscode.workspace.getConfiguration("kenMarkdown");
      await config.update("workspaceFiles", "copy", vscode.ConfigurationTarget.Global);
      try {
        const uri = fixture("docs/nested.md");
        const doc = await openEditor(uri);
        assert.ok(await webview(uri, { kind: "caretAfter", text: "A nested page." }));
        await webview(uri, { kind: "transfer", event: "drop", margin: true, uris: [fixture("flow.drawio.svg").toString()] });
        await until("explorer copy", () => doc.getText(), (t) => t.includes("![](_Images/flow.drawio.svg)"));
        assert.ok(await exists(vscode.Uri.joinPath(uri, "..", "_Images", "flow.drawio.svg")), "copied");
      } finally {
        await config.update("workspaceFiles", undefined, vscode.ConfigurationTarget.Global);
      }
    });

    it("honours kenMarkdown.imageFolder", async () => {
      const config = vscode.workspace.getConfiguration("kenMarkdown");
      await config.update("imageFolder", "assets/img", vscode.ConfigurationTarget.Global);
      try {
        const uri = fixture("attach.md");
        const doc = await openEditor(uri);
        assert.ok(await webview(uri, { kind: "caretAfter", text: "Second line." }));
        await webview(uri, { kind: "transfer", event: "paste", files: [{ name: "pic.png", type: "image/png", base64: PNG }] });
        await until("custom folder", () => doc.getText(), (t) => t.includes("![](assets/img/pic.png)"));
        assert.ok(await exists(vscode.Uri.joinPath(uri, "..", "assets", "img", "pic.png")));
      } finally {
        await config.update("imageFolder", undefined, vscode.ConfigurationTarget.Global);
      }
    });
  });

  it("has a heading control that remembers the last level picked, across editors", async () => {
    const uri = fixture("attach.md");
    const doc = await openEditor(uri);
    assert.ok(await webview(uri, { kind: "caretAfter", text: "Second line." }));
    await webview(uri, { kind: "click", selector: '[data-id="heading-menu"]' });
    assert.strictEqual(await webview(uri, { kind: "count", selector: ".ken-heading-item" }), 7, "Text + H1–H6");
    await webview(uri, { kind: "click", selector: '.ken-heading-item[data-id="heading5"]' });
    await until("h5", () => doc.getText(), (t) => t.includes("##### Second line."));
    // In a plain paragraph the button now offers H5.
    assert.ok(await webview(uri, { kind: "caretAfter", text: "Paste target" }));
    assert.strictEqual(await webview(uri, { kind: "getAttr", selector: '[data-id="heading"]', name: "data-level" }), "5");
    await webview(uri, { kind: "click", selector: '[data-id="heading"]' });
    await until("button applies h5", () => doc.getText(), (t) => t.startsWith("##### Paste target"));
    // No formatting bubble over selected text.
    assert.ok(await webview(uri, { kind: "selectText", text: "target" }));
    await sleep(300);
    assert.strictEqual(await webview(uri, { kind: "count", selector: ".milkdown-toolbar" }), 0);
    await vscode.commands.executeCommand("workbench.action.revertAndCloseActiveEditor");
    // Another editor starts with the remembered level.
    const other = fixture("docs/nested.md");
    await openEditor(other);
    assert.ok(await webview(other, { kind: "caretAfter", text: "A nested page." }));
    assert.strictEqual(await webview(other, { kind: "getAttr", selector: '[data-id="heading"]', name: "data-level" }), "5");
  });

  it("puts the toolbar where kenMarkdown.toolbar says (and reads the old true/false)", async () => {
    const uri = fixture("attach.md");
    await openEditor(uri);
    const config = vscode.workspace.getConfiguration("kenMarkdown");
    const position = () => webview(uri, { kind: "getAttr", selector: "body", name: "data-toolbar" });
    try {
      assert.strictEqual(await position(), "top");
      assert.strictEqual(await webview(uri, { kind: "getStyle", selector: ".ken-toolbar-host", property: "order" }), "-1");
      await config.update("toolbar", "bottom", vscode.ConfigurationTarget.Global);
      await until("bottom", position, (v) => v === "bottom");
      await config.update("toolbar", "hidden", vscode.ConfigurationTarget.Global);
      await until("hidden", position, (v) => v === "hidden");
      assert.strictEqual(await webview(uri, { kind: "getStyle", selector: ".ken-toolbar-host", property: "display" }), "none");
      await config.update("toolbar", false, vscode.ConfigurationTarget.Global);
      await until("legacy false = hidden", position, (v) => v === "hidden");
      await config.update("toolbar", true, vscode.ConfigurationTarget.Global);
      await until("legacy true = bottom", position, (v) => v === "bottom");
    } finally {
      await config.update("toolbar", undefined, vscode.ConfigurationTarget.Global);
    }
  });

  it("sets quotes in the quote font (the heading font by default), gray and italic", async () => {
    const uri = fixture("sample.md");
    await openEditor(uri);
    const config = vscode.workspace.getConfiguration("kenMarkdown");
    // sample.md's quote is a GitHub alert; add a plain one.
    const doc = await vscode.workspace.openTextDocument(uri);
    const edit = new vscode.WorkspaceEdit();
    edit.insert(uri, doc.positionAt(doc.getText().length), "\n> A plain quote.\n");
    await vscode.workspace.applyEdit(edit);
    await until("quote", () => webview(uri, { kind: "count", selector: ".ProseMirror blockquote" }), (n) => Number(n) >= 1);
    const style = (p: string) => webview(uri, { kind: "getStyle", selector: ".ProseMirror blockquote", property: p });
    assert.strictEqual(await style("font-style"), "italic");
    assert.match(String(await style("font-family")), /Newsreader/);
    assert.strictEqual(await style("padding-left"), "18px");
    try {
      await config.update("quoteFontFamily", "Courier New, monospace", vscode.ConfigurationTarget.Global);
      await until("quote font", () => style("font-family"), (v) => /Courier New/.test(String(v)));
      await config.update("quoteFontFamily", undefined, vscode.ConfigurationTarget.Global);
      await until("back to the heading font", () => style("font-family"), (v) => /Newsreader/.test(String(v)));
    } finally {
      await config.update("quoteFontFamily", undefined, vscode.ConfigurationTarget.Global);
    }
  });

  it("underlines with <ins>", async () => {
    const uri = fixture("attach.md");
    const doc = await openEditor(uri);
    assert.ok(await webview(uri, { kind: "selectText", text: "target" }));
    await vscode.commands.executeCommand("kenMarkdown.underline");
    await until("underline", () => doc.getText(), (t) => t.includes("Paste <ins>target</ins> paragraph"));
  });

  it("lays tables out at the column widths stored in the file, without rewriting it", async () => {
    const uri = fixture("widths.md");
    const doc = await openEditor(uri);
    const widths = () =>
      webview(uri, { kind: "getStyle", selector: ".ken-table-cols col:first-child", property: "width" });
    await until("stored width applied", widths, (w) => w === "200px");
    assert.strictEqual(await webview(uri, { kind: "getStyle", selector: ".ken-table-cols col:nth-child(2)", property: "width" }), "60px");
    await sleep(500);
    assert.strictEqual(doc.isDirty, false);
  });

  it("shows frontmatter as properties, editable, saved to the file", async () => {
    const uri = fixture("sample.md");
    const doc = await openEditor(uri);
    const count = (selector: string) => webview(uri, { kind: "count", selector });
    assert.strictEqual(await count(".ken-frontmatter:not([hidden])"), 1);
    assert.strictEqual(await count(".ken-fm-chip"), 2, "collapsed preview of title and aliases");
    assert.strictEqual(await count(".ken-fm-row"), 0, "collapsed initially");
    await webview(uri, { kind: "click", selector: ".ken-fm-toggle" });
    assert.strictEqual(await count(".ken-fm-row"), 2);
    await webview(uri, { kind: "fill", selector: ".ken-fm-row:first-child .ken-fm-value", value: "Renamed" });
    await until("title saved", () => doc.getText(), (t) => t.startsWith("---\ntitle: Renamed\naliases: [demo]\n---\n\n#"));
  });

  it("adds frontmatter with the Properties command, without a default title", async () => {
    const uri = fixture("attach.md");
    const doc = await openEditor(uri);
    assert.strictEqual(await webview(uri, { kind: "count", selector: ".ken-frontmatter:not([hidden])" }), 0);
    assert.ok(await webview(uri, { kind: "caretAfter", text: "Second line." }));
    await vscode.commands.executeCommand("kenMarkdown.editProperties");
    await until("opened for editing", () => webview(uri, { kind: "count", selector: ".ken-fm-row" }), (n) => n === 1);
    await sleep(400);
    assert.strictEqual(doc.isDirty, false, "a blank property writes nothing");
    await webview(uri, { kind: "fill", selector: ".ken-fm-key", value: "status" });
    await webview(uri, { kind: "fill", selector: ".ken-fm-value", value: "draft" });
    await until("frontmatter added", () => doc.getText(), (t) => t.startsWith("---\nstatus: draft\n---\nPaste target"));
  });

  it("can always show Properties, writing nothing until one is added", async () => {
    const config = vscode.workspace.getConfiguration("kenMarkdown");
    const uri = fixture("attach.md");
    const doc = await openEditor(uri);
    const shown = () => webview(uri, { kind: "count", selector: ".ken-frontmatter:not([hidden])" });
    assert.strictEqual(await shown(), 0, "off by default");
    try {
      await config.update("alwaysShowProperties", true, vscode.ConfigurationTarget.Global);
      await until("shown", shown, (n) => n === 1);
      await webview(uri, { kind: "click", selector: ".ken-fm-toggle" });
      await sleep(400);
      assert.strictEqual(doc.isDirty, false, "expanding an empty panel writes nothing");
    } finally {
      await config.update("alwaysShowProperties", undefined, vscode.ConfigurationTarget.Global);
    }
    await until("hidden again", shown, (n) => n === 0);
  });

  it("shows the placeholder only in a completely empty document", async () => {
    const uri = fixture("empty.md");
    const doc = await openEditor(uri);
    const placeholder = () =>
      webview(uri, { kind: "getAttr", selector: ".crepe-placeholder", name: "data-placeholder" });
    assert.ok(await webview(uri, { kind: "caretAfter", text: "" }) !== undefined);
    await until("placeholder", placeholder, (v) => v === "Start typing or try slash (/) commands");
    await webview(uri, { kind: "insertText", text: "Hello", at: "caret" });
    await until("typed", () => doc.getText(), (t) => t.includes("Hello"));
    await webview(uri, { kind: "insertText", text: "", at: "end" });
    assert.strictEqual(await webview(uri, { kind: "count", selector: ".crepe-placeholder" }), 0);
  });

  it("opens a commented file without rewriting it, and shows the thread", async () => {
    const uri = fixture("commented.md");
    const doc = await openEditor(uri);
    assert.ok((await webview(uri, { kind: "count", selector: ".ProseMirror .ken-comment" })) as number >= 1);
    assert.strictEqual(await webview(uri, { kind: "getAttr", selector: '[data-id="comments"]', name: "data-badge" }), "1");
    await sleep(500);
    assert.strictEqual(doc.isDirty, false);
    await vscode.commands.executeCommand("kenMarkdown.toggleComments");
    await until("thread shown", () => webview(uri, { kind: "count", selector: ".ken-comment-card" }), (n) => n === 1);
    await webview(uri, { kind: "fill", selector: ".ken-comment-card textarea", value: "The one in the deck." });
    await webview(uri, { kind: "click", selector: ".ken-comment-card .ken-comment-send" });
    await until("reply saved", () => doc.getText(), (t) => t.includes('"text":"The one in the deck."') && t.includes('"text":"Which date?"'));
  });

  it("adds a comment with the Add Comment command", async () => {
    const uri = fixture("attach.md");
    const doc = await openEditor(uri);
    assert.ok(await webview(uri, { kind: "selectText", text: "target" }));
    await vscode.commands.executeCommand("kenMarkdown.addComment");
    await until("card", () => webview(uri, { kind: "count", selector: ".ken-comment-card" }), (n) => n === 1);
    await sleep(300);
    assert.ok(!doc.getText().includes("ken:comment"), "nothing written while the comment is empty");
    await webview(uri, { kind: "fill", selector: ".ken-comment-card textarea", value: "Check this." });
    await webview(uri, { kind: "click", selector: ".ken-comment-card .ken-comment-send" });
    await until(
      "comment written",
      () => doc.getText(),
      (t) => /Paste <!-- ken:comment (\w+) -->target<!-- \/ken:comment \1 --> paragraph/.test(t) && /<!-- ken:comments\n\{"\w+":\{"resolved":false,"messages":\[\{[^}]*"text":"Check this\."\}\]\}\}\n-->\n$/.test(t),
    );
  });

  it("shows draw.io diagrams and opens the diagrams.net editor on them", async function () {
    const uri = fixture("diagram.md");
    const doc = await openEditor(uri);
    await until(
      "diagram shown",
      () => webview(uri, { kind: "images" }) as Thenable<{ loaded: boolean }[]>,
      (imgs) => imgs.length === 1 && imgs[0]!.loaded,
    );
    await sleep(300);
    assert.strictEqual(doc.isDirty, false);
    await until("edit button", () => webview(uri, { kind: "count", selector: ".ken-drawio-edit" }), (n) => n === 1);
    await webview(uri, { kind: "click", selector: ".ken-drawio-edit" });
    // The real editor, in VS Code's webview (CSP frame-src, network).
    await until("draw.io ready", () => webview(uri, { kind: "count", selector: ".ken-drawio[data-ready='true']" }), (n) => n === 1, 60000);
  });

  it("renders LaTeX with KaTeX, without touching the file", async () => {
    const uri = fixture("math.md");
    const doc = await openEditor(uri);
    // KaTeX is a lazily loaded chunk, styled by bundled fonts (webview CSP).
    await until("inline math", () => webview(uri, { kind: "count", selector: ".ken-math .katex" }), (n) => n === 1);
    await until("block math", () => webview(uri, { kind: "count", selector: ".milkdown-code-block[data-math] .katex-display" }), (n) => n === 1);
    await sleep(300);
    assert.strictEqual(doc.isDirty, false);
    await webview(uri, { kind: "insertText", text: "Literal $y_9$", at: "end" });
    await until("edit synced", () => doc.getText(), (t) => t.includes("y_9"));
    assert.match(doc.getText(), /Literal \\\$y_9\$\n$/);
    // Inserted as text, so its dollars are escaped; the prices are left alone.
    assert.match(doc.getText(), /prices like \$5 and \$10 stay text\./);
  });

  it("inserts a new draw.io diagram file in the image folder", async () => {
    const uri = fixture("attach.md");
    const doc = await openEditor(uri);
    assert.ok(await webview(uri, { kind: "caretAfter", text: "Second line." }));
    await vscode.commands.executeCommand("kenMarkdown.insertDrawioDiagram");
    await until("linked", () => doc.getText(), (t) => t.includes("![](_Images/attach-diagram.drawio.svg)"));
    const file = vscode.Uri.joinPath(uri, "..", "_Images", "attach-diagram.drawio.svg");
    const svg = Buffer.from(await vscode.workspace.fs.readFile(file)).toString("utf8");
    assert.match(svg, /content="&lt;mxfile/);
  });

  it("keeps CRLF line endings", async () => {
    const uri = fixture("crlf.md");
    const doc = await openEditor(uri);
    await webview(uri, { kind: "insertText", text: " more", at: "end" });
    await until("document updated", () => doc.getText(), (t) => t.includes("more"));
    assert.ok(!/[^\r]\n/.test(doc.getText()), JSON.stringify(doc.getText()));
  });

  it("applies font settings live", async () => {
    const uri = fixture("sample.md");
    await openEditor(uri);
    const config = vscode.workspace.getConfiguration("kenMarkdown");
    try {
      await config.update("fontSize", 21, vscode.ConfigurationTarget.Global);
      await config.update("bodyFontFamily", "Courier New, monospace", vscode.ConfigurationTarget.Global);
      await config.update("headingFontFamily", "Georgia, serif", vscode.ConfigurationTarget.Global);
      await until(
        "font size",
        () => webview(uri, { kind: "getStyle", selector: ".milkdown .ProseMirror p", property: "font-size" }),
        (v) => v === "21px",
      );
      const body = await webview(uri, { kind: "getStyle", selector: ".milkdown .ProseMirror p", property: "font-family" });
      assert.match(String(body), /Courier New/);
      const heading = await webview(uri, { kind: "getStyle", selector: ".milkdown h1", property: "font-family" });
      assert.match(String(heading), /Georgia/);
      // Headings scale from the base size.
      const h1 = await webview(uri, { kind: "getStyle", selector: ".milkdown h1", property: "font-size" });
      assert.ok(parseFloat(String(h1)) > 21 * 1.8, `h1 font-size ${h1}`);
    } finally {
      await config.update("fontSize", undefined, vscode.ConfigurationTarget.Global);
      await config.update("bodyFontFamily", undefined, vscode.ConfigurationTarget.Global);
      await config.update("headingFontFamily", undefined, vscode.ConfigurationTarget.Global);
    }
  });

  it("draws tabs editor.tabSize wide, [markdown] overrides included, live", async () => {
    const uri = fixture("sample.md");
    await openEditor(uri);
    const tabSize = () => webview(uri, { kind: "getStyle", selector: ".milkdown .ProseMirror", property: "tab-size" });
    const editor = vscode.workspace.getConfiguration("editor", { languageId: "markdown" });
    try {
      await editor.update("tabSize", 3, vscode.ConfigurationTarget.Global, true);
      await until("markdown tab size", tabSize, (v) => v === "3");
      await editor.update("tabSize", 7, vscode.ConfigurationTarget.Global, true);
      await until("markdown tab size changed", tabSize, (v) => v === "7");
    } finally {
      await editor.update("tabSize", undefined, vscode.ConfigurationTarget.Global, true);
    }
  });

  it("applies paragraph spacing live, leaving list items alone", async () => {
    const uri = fixture("sample.md");
    await openEditor(uri);
    const config = vscode.workspace.getConfiguration("kenMarkdown");
    const style = (selector: string, property: string) => webview(uri, { kind: "getStyle", selector, property });
    // Default 0.65em at 16px: 5.2px above and below each paragraph.
    assert.strictEqual(await style(".milkdown .ProseMirror > p", "padding-top"), "5.2px");
    const listLineHeight = await style(".milkdown li p", "line-height");
    try {
      await config.update("paragraphSpacing", 2, vscode.ConfigurationTarget.Global);
      await until("paragraph spacing", () => style(".milkdown .ProseMirror > p", "padding-top"), (v) => v === "16px");
      assert.strictEqual(await style(".milkdown li p", "padding-top"), "1px");
      assert.strictEqual(await style(".milkdown li p", "line-height"), listLineHeight);
      assert.strictEqual(await style(".milkdown .ProseMirror > p", "line-height"), "29.6px");
    } finally {
      await config.update("paragraphSpacing", undefined, vscode.ConfigurationTarget.Global);
    }
  });

  it("follows the active VS Code color theme", async () => {
    const uri = fixture("sample.md");
    await openEditor(uri);
    const workbench = vscode.workspace.getConfiguration("workbench");
    try {
      for (const theme of ["Default Light Modern", "Default Dark Modern", "Solarized Light"]) {
        await workbench.update("colorTheme", theme, vscode.ConfigurationTarget.Global);
        const colors = await until(
          `${theme} applied`,
          () => themeColors(uri),
          (c) => c.bodyBg === hexToRgb(c.bg),
        );
        assert.strictEqual(colors.bodyBg, hexToRgb(colors.bg), `${theme} background`);
        assert.strictEqual(colors.textColor, hexToRgb(colors.fg), `${theme} text colour`);
      }
      const light = await themeColors(uri);
      await workbench.update("colorTheme", "Default Dark Modern", vscode.ConfigurationTarget.Global);
      const dark = await until("dark theme", () => themeColors(uri), (c) => c.bg !== light.bg);
      assert.notStrictEqual(dark.bodyBg, light.bodyBg);
      // For visual checks (harness/screenshot.mjs): the theme as VS Code injects it.
      const dumpDir = process.env.KEN_DUMP_THEMES;
      if (dumpDir) {
        const fs = await import("fs");
        fs.mkdirSync(dumpDir, { recursive: true });
        for (const theme of ["Default Light Modern", "Default Dark Modern"]) {
          await workbench.update("colorTheme", theme, vscode.ConfigurationTarget.Global);
          await sleep(800);
          const style = await webview(uri, { kind: "getAttr", selector: "html", name: "style" });
          const bodyClass = await webview(uri, { kind: "getAttr", selector: "body", name: "class" });
          fs.writeFileSync(`${dumpDir}/${theme.replace(/ /g, "-")}.json`, JSON.stringify({ style, bodyClass }));
        }
      }
    } finally {
      await workbench.update("colorTheme", undefined, vscode.ConfigurationTarget.Global);
    }
  });

  it("shares a document live: two editors and a guest over the network", async () => {
    const Y = await import("yjs");
    const { Awareness, encodeAwarenessUpdate } = await import("y-protocols/awareness");
    const { WebSocket } = await import("ws");
    const fs = await import("fs");
    const uri = fixture("collab-scratch.md");
    fs.writeFileSync(uri.fsPath, "# Shared\n\nFirst line.\n");
    let socket: InstanceType<typeof WebSocket> | undefined;
    const at = (index: number, action: TestAction) =>
      vscode.commands.executeCommand("kenMarkdown._testAt", uri.toString(), index, action);
    type CollabState = { active: boolean; writer: boolean; people: string[] };
    try {
      await vscode.commands.executeCommand("kenMarkdown.collaboration.start");
      const stats = await vscode.commands.executeCommand<{ role: string; invite: string }>("kenMarkdown._testCollab");
      assert.strictEqual(stats.role, "host");
      assert.match(stats.invite, /^ws:\/\/localhost:\d+\/\?token=/);

      // Two editors on one file: both join, one of them writes it.
      const doc = await openEditor(uri);
      await vscode.commands.executeCommand("vscode.openWith", uri, VIEW_TYPE, vscode.ViewColumn.Two);
      await until("second editor", () => vscode.commands.executeCommand<number>("kenMarkdown._testEditors", uri.toString()), (n) => n === 2);
      await until("second editor mounted", () => at(1, { kind: "count", selector: ".milkdown .ProseMirror" }), (n) => n === 1, 90000);
      const states = await until(
        "both shared",
        async () => [(await at(0, { kind: "collab" })) as CollabState, (await at(1, { kind: "collab" })) as CollabState],
        (s) => s.every((x) => x.active) && s.filter((x) => x.writer).length === 1,
      );
      assert.strictEqual(states[0].writer, true, "the first editor writes");

      // Typing in the second editor reaches the first, and the file.
      await at(1, { kind: "insertText", text: " From two.", at: "end" });
      await until("first editor has it", () => at(0, { kind: "getMarkdown" }), (t) => String(t).includes("First line. From two."));
      await until("file has it", () => doc.getText(), (t) => t.includes("First line. From two."));

      // A guest elsewhere joins with the invite and types.
      socket = new WebSocket(stats.invite);
      const ws = socket;
      const ydoc = new Y.Doc();
      const awareness = new Awareness(ydoc);
      const peer = "guest-1";
      const room = "collab-scratch.md";
      const send = (m: unknown) => ws.send(JSON.stringify(m));
      const welcomed = new Promise<void>((resolve) => {
        ws.on("message", (raw) => {
          const m = JSON.parse(String(raw));
          if (m.to !== peer) return;
          if (m.t === "welcome" || m.t === "update") Y.applyUpdate(ydoc, Buffer.from(m.t === "welcome" ? m.state : m.data, "base64"), "hub");
          if (m.t === "welcome") resolve();
        });
      });
      await new Promise<void>((resolve, reject) => {
        ws.once("open", () => resolve());
        ws.once("error", reject);
      });
      send({ t: "join", room, peer, name: "Remote Rita", store: "elsewhere" });
      await welcomed;
      ydoc.on("update", (u: Uint8Array, origin: unknown) => {
        if (origin !== "hub") send({ t: "update", room, peer, data: Buffer.from(u).toString("base64") });
      });
      awareness.on("update", ({ added, updated }: { added: number[]; updated: number[] }) =>
        send({ t: "awareness", room, peer, data: Buffer.from(encodeAwarenessUpdate(awareness, [...added, ...updated])).toString("base64") }),
      );
      awareness.setLocalStateField("user", { name: "Remote Rita", hue: "green" });
      const paragraph = ydoc
        .getXmlFragment("prosemirror")
        .toArray()
        .find((n) => n instanceof Y.XmlElement && n.nodeName === "paragraph") as InstanceType<typeof Y.XmlElement>;
      (paragraph.get(0) as InstanceType<typeof Y.XmlText>).insert(0, "Rita: ");
      await until("file has the guest's edit", () => doc.getText(), (t) => t.includes("Rita: First line. From two."));
      await until("the guest is shown", () => at(1, { kind: "count", selector: '.ken-avatar[title="Remote Rita"]' }), (n) => n === 1);

      // The host ends the session: everyone works alone again, nothing lost.
      await vscode.commands.executeCommand("kenMarkdown.collaboration.leave");
      await until("left", () => at(0, { kind: "collab" }), (s) => !(s as CollabState).active);
      assert.strictEqual(((await at(1, { kind: "collab" })) as CollabState).active, false);
      await until("guest disconnected", () => ws.readyState, (r) => r === WebSocket.CLOSED);
      await at(0, { kind: "insertText", text: "Solo ", at: "start" });
      await until("solo edit saved through the file", () => doc.getText(), (t) => t.startsWith("# Solo Shared"));
      await until("and seen by the other editor the usual way", () => at(1, { kind: "getMarkdown" }), (t) => String(t).startsWith("# Solo Shared"));
      assert.match(doc.getText(), /Rita: First line\. From two\./);
    } finally {
      socket?.close();
      await vscode.commands.executeCommand("kenMarkdown.collaboration.leave");
      await vscode.commands.executeCommand("workbench.action.files.revert");
      await vscode.commands.executeCommand("workbench.action.closeAllEditors");
      fs.rmSync(uri.fsPath, { force: true });
    }
  });

  describe("Lucidchart previews", () => {
    // test/fixtures/lucid.md: six previewable links, a linked published image,
    // and Lucid links that must stay plain links (in a sentence, in a table).
    // Only the DOM and URLs are checked, never what Lucid renders.
    const id = (prefix: string) => `${prefix}-1111-4222-8333-444455556666`;
    const embed = (prefix: string, query = "") => `https://lucid.app/documents/embedded/${id(prefix)}${query}`;
    const FRAMES = [
      embed("3f2a1b4c", "?invitationId=inv_x"),
      embed("4a2a1b4c"),
      embed("5a2a1b4c"),
      embed("6a2a1b4c"),
      embed("7a2a1b4c"),
      embed("8a2a1b4c"),
    ];
    const opened = () => vscode.commands.executeCommand<string[]>("kenMarkdown._testExternalOpened");

    it("previews Lucid links alone in their paragraph, without writing the file", async () => {
      const uri = fixture("lucid.md");
      const doc = await openEditor(uri);
      const count = (selector: string) => webview(uri, { kind: "count", selector });
      await until("cards", () => count(".ken-lucid-card"), (n) => n === FRAMES.length);
      assert.strictEqual(await count(".ken-lucid-toolbar"), 1, "the published image gets a toolbar");
      assert.strictEqual(await count(".ken-lucid-toolbar iframe"), 0);
      for (const url of FRAMES) assert.strictEqual(await count(`iframe.ken-lucid-frame[data-src="${url}"]`), 1, url);
      assert.strictEqual(await count('iframe.ken-lucid-frame[sandbox="allow-scripts allow-same-origin"]'), FRAMES.length);
      assert.strictEqual(await count('.ken-lucid-card[aria-label="Lucidchart diagram: Payments architecture"]'), 1);
      // No preview for the link in a sentence or in the table.
      assert.strictEqual(await count("table .ken-lucid-card, p:not(.ken-lucid-source) + .ken-lucid-card"), 0);
      // The first card is in view: its frame loads the embed URL.
      await until(
        "first frame src",
        () => webview(uri, { kind: "getAttr", selector: "iframe.ken-lucid-frame", name: "src" }),
        (src) => src === FRAMES[0],
      );
      const csp = String(await webview(uri, { kind: "getAttr", selector: 'meta[http-equiv="Content-Security-Policy"]', name: "content" }));
      assert.match(csp, /frame-src https:\/\/embed\.diagrams\.net https:\/\/lucid\.app(;|$)/);
      await sleep(500);
      assert.strictEqual(doc.isDirty, false, "opening must not rewrite the file");
    });

    it("keeps Lucid lines byte-identical when editing elsewhere", async () => {
      const uri = fixture("lucid.md");
      const doc = await openEditor(uri);
      const before = doc.getText();
      await until("cards", () => webview(uri, { kind: "count", selector: ".ken-lucid-card" }), (n) => n === FRAMES.length);
      assert.ok(await webview(uri, { kind: "caretAfter", text: "Last paragraph." }));
      await webview(uri, { kind: "insertText", text: " Edited.", at: "caret" });
      await until("edit", () => doc.getText(), (t) => t.includes("Last paragraph. Edited."));
      assert.strictEqual(doc.getText(), before.replace("Last paragraph.", "Last paragraph. Edited."));
    });

    it("turns previews off and to onClick without touching the file", async () => {
      const uri = fixture("lucid.md");
      const doc = await openEditor(uri);
      const count = (selector: string) => webview(uri, { kind: "count", selector });
      const config = vscode.workspace.getConfiguration("kenMarkdown");
      await until("cards", () => count(".ken-lucid-card"), (n) => n === FRAMES.length);
      try {
        await config.update("lucidchart.preview", "off", vscode.ConfigurationTarget.Global);
        await until("off", () => count(".ken-lucid-card, .ken-lucid-toolbar"), (n) => n === 0);
        assert.strictEqual(await count(".ken-lucid-source"), 0);
        await config.update("lucidchart.preview", "onClick", vscode.ConfigurationTarget.Global);
        await until("onClick", () => count('.ken-lucid-card[data-state="click"]'), (n) => n === FRAMES.length);
        assert.strictEqual(await count("iframe.ken-lucid-frame[src]"), 0, "nothing loads before a click");
        assert.ok(await webview(uri, { kind: "click", selector: ".ken-lucid-card .ken-lucid-state button" }));
        await until("loaded on click", () => count("iframe.ken-lucid-frame[src]"), (n) => n === 1);
        await sleep(500);
        assert.strictEqual(doc.isDirty, false, "settings never write the file");
      } finally {
        await config.update("lucidchart.preview", undefined, vscode.ConfigurationTarget.Global);
      }
    });

    it("opens Edit and Open in the browser through the host", async () => {
      const uri = fixture("lucid.md");
      await openEditor(uri);
      await until("cards", () => webview(uri, { kind: "count", selector: ".ken-lucid-card" }), (n) => n === FRAMES.length);
      const card = (prefix: string) => `.ken-lucid-card:has(iframe[data-src^="${embed(prefix)}"])`;
      const expectations: [string, string][] = [
        // A lucid.app edit link is used as written, invitation included.
        [`${card("3f2a1b4c")} .ken-lucid-edit`, `https://lucid.app/lucidchart/${id("3f2a1b4c")}/edit?invitationId=inv_x`],
        [`${card("3f2a1b4c")} .ken-lucid-open`, `https://lucid.app/lucidchart/${id("3f2a1b4c")}/edit?invitationId=inv_x`],
        // A view link edits as /edit, and opens as written.
        [`${card("4a2a1b4c")} .ken-lucid-edit`, `https://lucid.app/lucidchart/${id("4a2a1b4c")}/edit`],
        [`${card("4a2a1b4c")} .ken-lucid-open`, `https://lucid.app/lucidchart/${id("4a2a1b4c")}/view`],
        // A legacy host goes to the canonical lucid.app link.
        [`${card("7a2a1b4c")} .ken-lucid-open`, `https://lucid.app/lucidchart/${id("7a2a1b4c")}/edit`],
        [`${card("8a2a1b4c")} .ken-lucid-edit`, `https://lucid.app/lucidspark/${id("8a2a1b4c")}/edit`],
        // The published image edits the document it links to.
        [".ken-lucid-toolbar .ken-lucid-edit", `https://lucid.app/lucidchart/${id("9a2a1b4c")}/edit`],
      ];
      for (const [selector, url] of expectations) {
        const n = (await opened()).length;
        assert.ok(await webview(uri, { kind: "click", selector }), selector);
        const list = await until(`opened ${url}`, opened, (l) => l.length === n + 1);
        assert.strictEqual(list[n], url, selector);
      }
    });
  });

  it("can switch to the Markdown source and back", async () => {
    const uri = fixture("sample.md");
    await openEditor(uri);
    await vscode.commands.executeCommand("kenMarkdown.openSource", uri);
    await until("text editor", () => vscode.window.activeTextEditor?.document.uri.toString(), (u) => u === uri.toString());
    await vscode.commands.executeCommand("kenMarkdown.openEditor", uri);
    await until(
      "custom editor",
      () => {
        const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
        return input instanceof vscode.TabInputCustom ? input.viewType : "";
      },
      (v) => v === VIEW_TYPE,
    );
  });
});
