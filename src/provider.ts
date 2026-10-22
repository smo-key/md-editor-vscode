import * as vscode from "vscode";
import * as path from "path";
import type {
  EditorConfig,
  EditorPrefs,
  HostMessage,
  LinkedUri,
  ShortcutLabels,
  TestAction,
  ToolbarPosition,
  WebviewMessage,
} from "./protocol";
import { classifyHref, imageFolder, minimalChange, toEOL, toLF, uniqueName } from "./sync";

export const VIEW_TYPE = "kenMarkdown.editor";

let gitAuthor: string | undefined;
/** Your name for comments: git's user.name, else the OS account name. */
function defaultAuthor(): string {
  if (gitAuthor === undefined) {
    try {
      gitAuthor = require("child_process").execFileSync("git", ["config", "user.name"], { encoding: "utf8", timeout: 2000 }).trim();
    } catch {
      gitAuthor = "";
    }
  }
  if (gitAuthor) return gitAuthor;
  try {
    return require("os").userInfo().username;
  } catch {
    return "Me";
  }
}

/** The toolbar setting; `true`/`false` from versions before it had positions. */
export function toolbarPosition(value: unknown): ToolbarPosition {
  if (value === false || value === "hidden") return "hidden";
  if (value === "top") return "top";
  return "bottom";
}

function readImageFolder(scope: vscode.Uri): string {
  return vscode.workspace.getConfiguration("kenMarkdown", scope).get<string>("imageFolder", "_Images");
}

export function readConfig(scope?: vscode.Uri): EditorConfig {
  const c = vscode.workspace.getConfiguration("kenMarkdown", scope);
  return {
    fontSize: c.get<number>("fontSize", 16),
    bodyFontFamily: c.get<string>("bodyFontFamily", ""),
    headingFontFamily: c.get<string>("headingFontFamily", ""),
    codeFontFamily: c.get<string>("codeFontFamily", ""),
    quoteFontFamily: c.get<string>("quoteFontFamily", ""),
    lineHeight: c.get<number>("lineHeight", 1.85),
    maxWidth: c.get<number>("maxWidth", 720),
    toolbar: toolbarPosition(c.get<unknown>("toolbar", "bottom")),
    alwaysShowProperties: c.get<boolean>("alwaysShowProperties", false),
    commentAuthor: c.get<string>("commentAuthor", "").trim() || defaultAuthor(),
  };
}

/** One open editor: a webview bound to a TextDocument. */
class EditorSession {
  /** The `\n` text the webview last showed or produced. */
  private webviewText: string;
  private ready = false;
  private testSeq = 0;
  private readonly pendingTests = new Map<number, (result: unknown) => void>();
  private readonly pendingFlushes = new Map<number, (text: string | null) => void>();
  private readonly disposables: vscode.Disposable[] = [];
  /** Serialises edits so each diff is computed against the latest text. */
  private editChain: Promise<unknown> = Promise.resolve();
  /** Webview edits not yet applied; echoes are suppressed while any are. */
  private pendingEdits = 0;

  /** Whether the webview has keyboard focus (drives `kenMarkdown.editorFocused`). */
  focused = false;

  constructor(
    private readonly document: vscode.TextDocument,
    readonly panel: vscode.WebviewPanel,
    private readonly extensionUri: vscode.Uri,
    private readonly host: SessionHost,
  ) {
    this.webviewText = toLF(document.getText());
  }

  /** Folder that document-relative paths in the webview are measured from. */
  private get root(): vscode.Uri {
    return (
      vscode.workspace.getWorkspaceFolder(this.document.uri)?.uri ??
      vscode.Uri.joinPath(this.document.uri, "..")
    );
  }

  /** The document's path relative to `root`, `/`-separated. */
  private get docPath(): string {
    const root = this.root.path.replace(/\/$/, "");
    const p = this.document.uri.path;
    return p.startsWith(root + "/") ? p.slice(root.length + 1) : p.slice(p.lastIndexOf("/") + 1);
  }

  start(): void {
    const webview = this.panel.webview;
    const roots = [vscode.Uri.joinPath(this.extensionUri, "dist"), this.root];
    for (const f of vscode.workspace.workspaceFolders ?? []) roots.push(f.uri);
    webview.options = { enableScripts: true, localResourceRoots: roots };
    webview.html = this.html(webview);

    this.disposables.push(
      webview.onDidReceiveMessage((m: WebviewMessage) => this.onMessage(m)),
      vscode.workspace.onDidChangeTextDocument((e) => {
        if (e.document.uri.toString() !== this.document.uri.toString()) return;
        if (e.contentChanges.length === 0) return;
        this.pushIfChanged();
      }),
      vscode.workspace.onWillSaveTextDocument((e) => {
        if (e.document.uri.toString() !== this.document.uri.toString()) return;
        e.waitUntil(this.flush());
      }),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration("kenMarkdown", this.document.uri)) {
          this.post({ type: "config", config: readConfig(this.document.uri) });
        }
      }),
      this.panel.onDidChangeViewState(() => {
        if (!this.panel.active) this.setFocused(false);
        // A hidden webview may have missed nothing (retainContextWhenHidden),
        // but re-check in case the document moved on meanwhile.
        if (this.panel.visible) this.pushIfChanged();
      }),
    );
    this.panel.onDidDispose(() => this.dispose());
  }

  /** Send the document to the webview unless it already shows that text. */
  private pushIfChanged(): void {
    const text = toLF(this.document.getText());
    if (this.pendingEdits > 0 || text === this.webviewText || !this.ready) return;
    this.webviewText = text;
    this.post({ type: "update", text });
  }

  private post(message: HostMessage): void {
    void this.panel.webview.postMessage(message);
  }

  private async onMessage(m: WebviewMessage): Promise<void> {
    switch (m.type) {
      case "ready":
        this.ready = true;
        this.webviewText = toLF(this.document.getText());
        this.post({
          type: "init",
          text: this.webviewText,
          config: readConfig(this.document.uri),
          docPath: this.docPath,
          shortcuts: this.host.shortcutLabels(),
          prefs: this.host.prefs(),
        });
        return;
      case "setPrefs":
        this.host.setPrefs(m.prefs);
        return;
      case "focus":
        this.setFocused(m.focused);
        return;
      case "openKeybindings":
        await vscode.commands.executeCommand("workbench.action.openGlobalKeybindings", "@ext:arthur-pachachura.ken-markdown-editor");
        return;
      case "edit":
        this.webviewText = m.text;
        this.pendingEdits++;
        this.editChain = this.editChain
          .then(() => this.applyEdit(m.text))
          .catch((err) => {
            void vscode.window.showErrorMessage(`Ken Markdown: could not apply edit: ${err}`);
          })
          .finally(() => {
            this.pendingEdits--;
            // Anything that changed the document meanwhile (another editor,
            // a failed edit) is reconciled once the queue drains.
            if (this.pendingEdits === 0) this.pushIfChanged();
          });
        return;
      case "saveAttachment":
        try {
          const path = await this.saveAttachment(m.name, m.data, m.image);
          this.post({ type: "attachmentSaved", id: m.id, path });
        } catch (err) {
          this.post({ type: "attachmentSaved", id: m.id, error: String(err) });
        }
        return;
      case "resolve": {
        const uri = vscode.Uri.joinPath(this.root, m.path);
        this.post({ type: "resolved", id: m.id, url: this.panel.webview.asWebviewUri(uri).toString() });
        return;
      }
      case "linkUris":
        this.post({ type: "linkedUris", id: m.id, items: m.uris.map((u) => this.linkFor(u)) });
        return;
      case "openLink":
        await this.openLink(m.href);
        return;
      case "openWikiLink":
        await this.openWikiLink(m.target);
        return;
      case "flushed":
        this.pendingFlushes.get(m.id)?.(m.text);
        this.pendingFlushes.delete(m.id);
        return;
      case "testResult":
        this.pendingTests.get(m.id)?.(m.result);
        this.pendingTests.delete(m.id);
        return;
      case "error":
        console.error(`[ken-markdown webview] ${m.message}`);
        return;
    }
  }

  private async applyEdit(text: string): Promise<void> {
    const crlf = this.document.eol === vscode.EndOfLine.CRLF;
    const current = this.document.getText();
    const change = minimalChange(current, toEOL(text, crlf));
    if (!change) return;
    const edit = new vscode.WorkspaceEdit();
    edit.replace(
      this.document.uri,
      new vscode.Range(this.document.positionAt(change.start), this.document.positionAt(change.end)),
      change.text,
    );
    await vscode.workspace.applyEdit(edit);
  }

  /**
   * Write a pasted/dropped file and return its root-relative path. Images go
   * into the image folder (`kenMarkdown.imageFolder`, `_Images` by default)
   * beside the document, created on first use; other files go beside it.
   */
  private async saveAttachment(name: string, data: Uint8Array, image: boolean): Promise<string> {
    const folder = image ? imageFolder(readImageFolder(this.document.uri)) : "";
    const dir = folder
      ? vscode.Uri.joinPath(this.document.uri, "..", ...folder.split("/"))
      : vscode.Uri.joinPath(this.document.uri, "..");
    if (folder) await vscode.workspace.fs.createDirectory(dir);
    const finalName = await uniqueName(name, async (candidate) => {
      try {
        await vscode.workspace.fs.stat(vscode.Uri.joinPath(dir, candidate));
        return true;
      } catch {
        return false;
      }
    });
    await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(dir, finalName), data);
    const docDir = this.docPath.includes("/") ? this.docPath.slice(0, this.docPath.lastIndexOf("/")) : "";
    const rel = folder ? `${folder}/${finalName}` : finalName;
    return docDir ? `${docDir}/${rel}` : rel;
  }

  /** How the document should reference a file dropped from the Explorer. */
  private linkFor(raw: string): LinkedUri {
    let uri: vscode.Uri;
    try {
      uri = vscode.Uri.parse(raw, true);
    } catch {
      return { path: raw, relative: false, name: raw };
    }
    const name = path.posix.basename(uri.path) || raw;
    const doc = this.document.uri;
    if (uri.scheme !== doc.scheme || uri.authority !== doc.authority) {
      return { path: uri.toString(), relative: false, name };
    }
    const rel = path.posix.relative(path.posix.dirname(doc.path), uri.path);
    return { path: rel || name, relative: true, name };
  }

  private async openLink(href: string): Promise<void> {
    const link = classifyHref(href);
    if (link.kind === "external") {
      await vscode.env.openExternal(vscode.Uri.parse(link.url));
      return;
    }
    if (link.kind === "anchor") return;
    const base = link.path.startsWith("/") ? this.root : vscode.Uri.joinPath(this.document.uri, "..");
    const target = vscode.Uri.joinPath(base, link.path.replace(/^\//, ""));
    await openFile(target);
  }

  private async openWikiLink(target: string): Promise<void> {
    const name = target.split("|")[0].split("#")[0].trim();
    if (!name) return;
    const leaf = name.split("/").pop()!.replace(/\.(md|markdown)$/i, "");
    const found = await vscode.workspace.findFiles(`**/${leaf}.{md,markdown}`, "**/node_modules/**", 50);
    const want = name.toLowerCase().replace(/\.(md|markdown)$/i, "");
    const match =
      found.find((u) => u.path.toLowerCase().replace(/\.(md|markdown)$/i, "").endsWith(`/${want}`)) ?? found[0];
    if (match) await openFile(match);
    else void vscode.window.showWarningMessage(`No page named "${name}" in the workspace.`);
  }

  /**
   * Ask the webview for any edit it has not reported yet, so a save never
   * misses the last keystroke. Resolves to the edits for the save to include.
   */
  private async flush(): Promise<vscode.TextEdit[]> {
    if (!this.ready) return [];
    const id = ++this.testSeq;
    const text = await new Promise<string | null>((resolve) => {
      this.pendingFlushes.set(id, resolve);
      this.post({ type: "flush", id });
      // A webview that does not answer must not hold up the save.
      setTimeout(() => {
        if (this.pendingFlushes.delete(id)) resolve(null);
      }, 1000);
    });
    await this.editChain;
    if (text === null) return [];
    this.webviewText = text;
    const crlf = this.document.eol === vscode.EndOfLine.CRLF;
    const change = minimalChange(this.document.getText(), toEOL(text, crlf));
    if (!change) return [];
    return [
      vscode.TextEdit.replace(
        new vscode.Range(this.document.positionAt(change.start), this.document.positionAt(change.end)),
        change.text,
      ),
    ];
  }

  private setFocused(focused: boolean) {
    if (this.focused === focused) return;
    this.focused = focused;
    this.host.focusChanged();
  }

  /** Send a message to the webview (commands, shortcut labels). */
  send(message: HostMessage): void {
    if (this.ready) this.post(message);
  }

  /** Test hook: run an action inside the webview and return its result. */
  runTest(action: TestAction): Promise<unknown> {
    const id = ++this.testSeq;
    return new Promise((resolve) => {
      this.pendingTests.set(id, resolve);
      this.post({ type: "test", id, action });
    });
  }

  get isReady(): boolean {
    return this.ready;
  }

  private html(webview: vscode.Webview): string {
    const nonce = makeNonce();
    const dist = vscode.Uri.joinPath(this.extensionUri, "dist");
    const script = webview.asWebviewUri(vscode.Uri.joinPath(dist, "webview", "main.js"));
    const style = webview.asWebviewUri(vscode.Uri.joinPath(dist, "webview", "main.css"));
    const csp = [
      "default-src 'none'",
      `img-src ${webview.cspSource} https: http: data: blob:`,
      `media-src ${webview.cspSource} https: data: blob:`,
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `font-src ${webview.cspSource} data:`,
      `script-src 'nonce-${nonce}' ${webview.cspSource}`,
      `connect-src ${webview.cspSource}`,
    ].join("; ");
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta http-equiv="Content-Security-Policy" content="${csp}" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<link rel="stylesheet" href="${style}" />
<title>Markdown</title>
</head>
<body>
<div class="editor-scroll" id="scroll"><div class="measure" id="editor"></div></div>
<div class="ken-toolbar-host" id="toolbar"></div>
<script type="module" nonce="${nonce}" src="${script}"></script>
</body>
</html>`;
  }

  dispose(): void {
    this.setFocused(false);
    for (const d of this.disposables.splice(0)) d.dispose();
  }
}

async function openFile(uri: vscode.Uri): Promise<void> {
  try {
    await vscode.workspace.fs.stat(uri);
  } catch {
    void vscode.window.showWarningMessage(`File not found: ${vscode.workspace.asRelativePath(uri)}`);
    return;
  }
  // Markdown opens in this editor (it is the default for .md); anything else
  // in whatever VS Code picks for it.
  await vscode.commands.executeCommand("vscode.open", uri);
}

function makeNonce(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let out = "";
  for (let i = 0; i < 32; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}

/** What sessions need from the provider. */
interface SessionHost {
  shortcutLabels(): ShortcutLabels;
  prefs(): EditorPrefs;
  setPrefs(prefs: EditorPrefs): void;
  focusChanged(): void;
}

export class KenMarkdownEditorProvider implements vscode.CustomTextEditorProvider, SessionHost {
  /** Live sessions by document URI, newest last; used by commands and tests. */
  readonly sessions = new Map<string, EditorSession>();
  private readonly all = new Set<EditorSession>();
  private labels: ShortcutLabels = {};

  constructor(private readonly context: vscode.ExtensionContext) {}

  resolveCustomTextEditor(document: vscode.TextDocument, panel: vscode.WebviewPanel): void {
    const session = new EditorSession(document, panel, this.context.extensionUri, this);
    const key = document.uri.toString();
    this.sessions.set(key, session);
    this.all.add(session);
    panel.onDidDispose(() => {
      this.all.delete(session);
      if (this.sessions.get(key) === session) this.sessions.delete(key);
    });
    session.start();
  }

  shortcutLabels(): ShortcutLabels {
    return this.labels;
  }

  prefs(): EditorPrefs {
    return this.context.globalState.get<EditorPrefs>("kenMarkdown.prefs", {});
  }

  setPrefs(prefs: EditorPrefs) {
    void this.context.globalState.update("kenMarkdown.prefs", { ...this.prefs(), ...prefs });
  }

  /** New effective keybindings: refresh every open editor's hints. */
  setShortcutLabels(labels: ShortcutLabels) {
    this.labels = labels;
    for (const s of this.all) s.send({ type: "shortcuts", labels });
  }

  focusChanged() {
    const focused = [...this.all].some((s) => s.focused);
    void vscode.commands.executeCommand("setContext", "kenMarkdown.editorFocused", focused);
  }

  /** The editor a command applies to: the focused one, else the active tab's. */
  target(): EditorSession | undefined {
    const focused = [...this.all].find((s) => s.focused);
    if (focused) return focused;
    return [...this.all].find((s) => s.panel.active);
  }
}
