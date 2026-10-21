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
    45000,
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
  this.timeout(60000);

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

  it("renders GitHub-flavoured Markdown the way Ken does", async () => {
    const uri = fixture("sample.md");
    await openEditor(uri);
    assert.strictEqual(await webview(uri, { kind: "count", selector: ".milkdown h1" }), 1);
    assert.strictEqual(await webview(uri, { kind: "count", selector: ".milkdown .github-alert" }), 1);
    assert.strictEqual(await webview(uri, { kind: "count", selector: ".milkdown table.children" }), 1);
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
      [".milkdown .label.unchecked", 2],
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
    await until(
      "webview shows external edit",
      () => webview(uri, { kind: "getMarkdown" }),
      (t) => String(t).includes("Added from outside."),
    );
    // Applying the host's text is not an edit: nothing is echoed back.
    const before = doc.getText();
    await sleep(500);
    assert.strictEqual(doc.getText(), before);
  });

  it("undoes one step per Cmd/Ctrl+Z", async () => {
    const uri = fixture("sample.md");
    const doc = await openEditor(uri);
    const original = doc.getText();
    const mod = process.platform === "darwin" ? { meta: true } : { ctrl: true };
    await webview(uri, { kind: "insertText", text: " first", at: "end" });
    await until("first edit", () => doc.getText(), (t) => t.includes(" first"));
    await sleep(700);
    await webview(uri, { kind: "insertText", text: " second", at: "end" });
    await until("second edit", () => doc.getText(), (t) => t.includes(" second"));
    await sleep(700);
    await webview(uri, { kind: "key", key: "z", code: "KeyZ", ...mod });
    await until("one undo", () => doc.getText(), (t) => !t.includes(" second"));
    await sleep(1000);
    assert.ok(doc.getText().includes(" first"), `only the last edit is undone: ${JSON.stringify(doc.getText().slice(-60))}`);
    await webview(uri, { kind: "key", key: "z", code: "KeyZ", ...mod, shift: process.platform === "darwin" });
    if (process.platform !== "darwin") await webview(uri, { kind: "key", key: "y", code: "KeyY", ...mod });
    await until("redo", () => doc.getText(), (t) => t.includes(" second"));
    await sleep(1000);
    assert.ok(doc.getText().includes(" first second"), "redo restores exactly one step");
    void original;
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

  it("has a bottom toolbar whose edits reach the document", async () => {
    const uri = fixture("sample.md");
    const doc = await openEditor(uri);
    assert.ok((await webview(uri, { kind: "count", selector: ".ken-toolbar .ken-toolbar-button" })) as number >= 15);
    // No block drag handles or "+" buttons outside checklists.
    assert.strictEqual(await webview(uri, { kind: "count", selector: ".milkdown-block-handle" }), 0);
    assert.ok(await webview(uri, { kind: "caretAfter", text: "A paragraph with" }));
    await webview(uri, { kind: "click", selector: '.ken-toolbar-button[data-id="heading2"]' });
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
