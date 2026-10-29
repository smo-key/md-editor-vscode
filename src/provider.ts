import * as vscode from "vscode";
import * as os from "os";
import { WorkspaceFiles } from "./fileSearch";
import { pickFormat, pickTarget, writeExport, type ExportFormat } from "./exportDoc";
import * as path from "path";
import type {
  EditorConfig,
  EditorPrefs,
  HostMessage,
  LinkedUri,
  ShortcutKeys,
  ShortcutLabels,
  TestAction,
  ToolbarPosition,
  WebviewMessage,
  ExportAsset,
} from "./protocol";
import { headingNumbersConfig } from "./headingNumbers";
import { editUrl, lucidPreviewMode, openUrl, parseLucidUrl } from "./lucidUrl";
import { tabSizeValue } from "./tabSize";
import { classifyHref, imageFolder, minimalChange, toEOL, toLF, uniqueName } from "./sync";
import {
  byCloseness,
  COPY_LIMIT,
  excludeGlob,
  insideFolder,
  isImageName,
  mayCopyScheme,
  nameGlob,
  sameBytes,
  workspaceFilesMode,
} from "./workspaceFiles";
import type { CollabManager, Endpoint } from "./collab/manager";
import { fromBase64, toBase64 } from "./collab/wire";

export const VIEW_TYPE = "kenMarkdown.editor";

/** An empty draw.io diagram, as an editable SVG (the diagram rides in `content`). */
const BLANK_DRAWIO_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" version="1.1" width="1px" height="1px" viewBox="-0.5 -0.5 1 1" content="&lt;mxfile&gt;&lt;diagram id=&quot;page1&quot; name=&quot;Page-1&quot;&gt;&lt;mxGraphModel&gt;&lt;root&gt;&lt;mxCell id=&quot;0&quot;/&gt;&lt;mxCell id=&quot;1&quot; parent=&quot;0&quot;/&gt;&lt;/root&gt;&lt;/mxGraphModel&gt;&lt;/diagram&gt;&lt;/mxfile&gt;"><defs/><g/></svg>\n';

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
  if (value === "bottom" || value === true) return "bottom";
  return "top";
}

function readImageFolder(scope: vscode.Uri): string {
  return vscode.workspace.getConfiguration("kenMarkdown", scope).get<string>("imageFolder", "_Images");
}

/** Whether files already in the workspace are linked (default) or copied. */
function readWorkspaceFiles(scope: vscode.Uri) {
  return workspaceFilesMode(vscode.workspace.getConfiguration("kenMarkdown", scope).get<string>("workspaceFiles", "link"));
}

/** `editor.tabSize` as it applies to a Markdown document, `[markdown]` overrides included. */
function readTabSize(scope?: vscode.Uri): number {
  const editor = vscode.workspace.getConfiguration("editor", { uri: scope, languageId: "markdown" });
  return tabSizeValue(editor.get<unknown>("tabSize"));
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
    paragraphSpacing: c.get<number>("paragraphSpacing", 0.65),
    headingSpacingBefore: c.get<number>("headingSpacingBefore", 2.25),
    headingSpacingAfter: c.get<number>("headingSpacingAfter", 0.55),
    maxWidth: c.get<number>("maxWidth", 720),
    toolbar: toolbarPosition(c.get<unknown>("toolbar", "top")),
    alwaysShowProperties: c.get<boolean>("alwaysShowProperties", false),
    commentAuthor: c.get<string>("commentAuthor", "").trim() || defaultAuthor(),
    lucidchart: { preview: lucidPreviewMode(c.get<unknown>("lucidchart.preview", "auto")) },
    headingNumbers: headingNumbersConfig({
      enabled: c.get<unknown>("headingNumbers.enabled", false),
      preset: c.get<unknown>("headingNumbers.preset", "custom"),
      styles: ["h1", "h2", "h3", "h4", "h5", "h6"].map((h) => c.get<unknown>(`headingNumbers.${h}`)),
      parents: ["h1", "h2", "h3", "h4", "h5", "h6"].map((h) => c.get<unknown>(`headingNumbers.${h}Parents`)),
      prefixes: ["h1", "h2", "h3", "h4", "h5", "h6"].map((h) => c.get<unknown>(`headingNumbers.${h}Prefix`)),
      separator: c.get<unknown>("headingNumbers.separator", "."),
    }),
    tabSize: readTabSize(scope),
  };
}

/** The bits of the built-in Git extension's API (`vscode.git`, version 1) used here. */
interface GitApi {
  getRepository(uri: vscode.Uri): { checkIgnore(paths: string[]): Promise<Set<string>> } | null;
}

/**
 * Which of these files git ignores, as normalized file system paths. Empty when
 * the Git extension is off or the files are not in a repository.
 */
export async function gitIgnored(uris: vscode.Uri[]): Promise<Set<string>> {
  if (uris.length === 0) return new Set();
  try {
    const ext = vscode.extensions.getExtension<{ getAPI(version: 1): GitApi }>("vscode.git");
    if (!ext) return new Set();
    const api = (ext.isActive ? ext.exports : await ext.activate()).getAPI(1);
    // Grouped by repository: a workspace folder may hold several (submodules).
    const byRepo = new Map<NonNullable<ReturnType<GitApi["getRepository"]>>, string[]>();
    for (const u of uris) {
      const repo = api.getRepository(u);
      if (repo) byRepo.set(repo, [...(byRepo.get(repo) ?? []), u.fsPath]);
    }
    const out = new Set<string>();
    for (const [repo, paths] of byRepo) for (const p of await repo.checkIgnore(paths)) out.add(path.normalize(p));
    return out;
  } catch {
    return new Set();
  }
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

  /** This editor's part in a collaboration session, while there is one. */
  private collab: { peer: string; room: string; endpoint: Endpoint; listener: vscode.Disposable } | undefined;

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
        if (
          e.affectsConfiguration("kenMarkdown", this.document.uri) ||
          e.affectsConfiguration("editor.tabSize", { uri: this.document.uri, languageId: "markdown" })
        ) {
          this.post({ type: "config", config: readConfig(this.document.uri) });
        }
      }),
      this.host.collab.onDidChange(() => this.syncCollab()),
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
        // A reloaded webview starts over in the session too.
        this.leaveCollab(true, false);
        this.ready = true;
        this.webviewText = toLF(this.document.getText());
        this.post({
          type: "init",
          text: this.webviewText,
          config: readConfig(this.document.uri),
          docPath: this.docPath,
          shortcuts: this.host.shortcutLabels(),
          keys: this.host.shortcutKeys(),
          prefs: this.host.prefs(),
        });
        this.syncCollab();
        return;
      case "setPrefs":
        this.host.setPrefs(m.prefs);
        return;
      case "focus":
        this.setFocused(m.focused);
        return;
      case "openKeybindings":
        await vscode.commands.executeCommand("workbench.action.openGlobalKeybindings", "@ext:ArthurPachachura.ken-markdown-editor");
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
          const path = (m.sourceName && (await this.findInWorkspace(m.sourceName, m.data))) || (await this.saveAttachment(m.name, m.data, m.image));
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
      case "print":
        await this.print(m.html, m.name);
        return;
      case "export":
        await this.export();
        return;
      case "exportAssetsReady":
        this.pendingAssets.get(m.id)?.({ images: m.images, diagrams: m.diagrams });
        this.pendingAssets.delete(m.id);
        return;
      case "exportPageReady":
        this.pendingPages.get(m.id)?.(m.html);
        this.pendingPages.delete(m.id);
        return;
      case "findFiles":
        this.post({ type: "filesFound", id: m.id, items: await this.host.files.find(m.query, this.document.uri) });
        return;
      case "readClipboard":
        this.post({ type: "clipboardText", id: m.id, text: await vscode.env.clipboard.readText() });
        return;
      case "readFile":
        try {
          // A plain copy: a Node Buffer would reach the webview as {type: "Buffer", data} (Buffer.toJSON).
          const data = new Uint8Array(await vscode.workspace.fs.readFile(this.inRoot(m.path)));
          this.post({ type: "fileRead", id: m.id, data });
        } catch (err) {
          this.post({ type: "fileRead", id: m.id, error: String(err) });
        }
        return;
      case "writeFile":
        try {
          await vscode.workspace.fs.writeFile(this.inRoot(m.path), m.data);
          this.post({ type: "fileWritten", id: m.id });
        } catch (err) {
          this.post({ type: "fileWritten", id: m.id, error: String(err) });
        }
        return;
      case "createDiagram":
        try {
          const stem = this.docPath.slice(this.docPath.lastIndexOf("/") + 1).replace(/\.(md|markdown)$/i, "");
          const path = await this.saveAttachment(`${stem}-diagram.drawio.svg`, new TextEncoder().encode(BLANK_DRAWIO_SVG), true);
          this.post({ type: "diagramCreated", id: m.id, path });
        } catch (err) {
          this.post({ type: "diagramCreated", id: m.id, error: String(err) });
        }
        return;
      case "revealFile":
        try {
          await vscode.commands.executeCommand(m.where === "os" ? "revealFileInOS" : "revealInExplorer", this.inRoot(m.path));
        } catch (err) {
          void vscode.window.showWarningMessage(`Ken Markdown: cannot show ${m.path}: ${err}`);
        }
        return;
      case "openFile":
        try {
          await openFile(this.inRoot(m.path));
        } catch {
          // Reported by openFile.
        }
        return;
      case "linkUris":
        this.post({ type: "linkedUris", id: m.id, items: await Promise.all(m.uris.map((u) => this.linkFor(u))) });
        return;
      case "openLink":
        await this.openLink(m.href);
        return;
      case "openWikiLink":
        await this.openWikiLink(m.target);
        return;
      case "openLucid":
        await this.openLucid(m.url, m.action);
        return;
      case "flushed":
        this.pendingFlushes.get(m.id)?.(m.text);
        this.pendingFlushes.delete(m.id);
        return;
      case "collabUpdate":
        if (this.collab) {
          const { endpoint, room, peer } = this.collab;
          endpoint.send({ t: "update", room, peer, data: toBase64(m.data) });
        }
        return;
      case "collabAwareness":
        if (this.collab) {
          const { endpoint, room, peer } = this.collab;
          endpoint.send({ t: "awareness", room, peer, data: toBase64(m.data) });
        }
        return;
      case "collabStopped":
        // An editor that did not write is behind its file: catch it up.
        if (!m.writer) {
          this.webviewText = "\u0000";
          this.pushIfChanged();
        }
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

  /** Join the session's room for this document, or leave it, to match the session. */
  private syncCollab(): void {
    const endpoint = this.host.collab.endpoint;
    if (this.collab && this.collab.endpoint !== endpoint) this.leaveCollab(true, true);
    if (!endpoint || this.collab || !this.ready) return;
    const peer = makeNonce().slice(0, 16);
    const room = this.docPath;
    const listener = endpoint.onMessage((m) => {
      if (m.to !== peer || m.room !== room) return;
      switch (m.t) {
        case "welcome":
          this.post({
            type: "collabStart",
            seed: m.seed,
            state: fromBase64(m.state),
            awareness: fromBase64(m.awareness),
            name: readConfig(this.document.uri).commentAuthor,
          });
          return;
        case "update":
          this.post({ type: "collabUpdate", data: fromBase64(m.data) });
          return;
        case "awareness":
          this.post({ type: "collabAwareness", data: fromBase64(m.data) });
          return;
        case "writer":
          this.post({ type: "collabWriter", writer: m.writer });
          return;
      }
    });
    this.collab = { peer, room, endpoint, listener };
    endpoint.send({
      t: "join",
      room,
      peer,
      name: readConfig(this.document.uri).commentAuthor,
      store: this.host.collab.storeFor(this.document.uri),
    });
  }

  private leaveCollab(tellHub: boolean, tellWebview: boolean): void {
    const c = this.collab;
    if (!c) return;
    this.collab = undefined;
    c.listener.dispose();
    if (tellHub) {
      try {
        c.endpoint.send({ t: "leave", room: c.room, peer: c.peer });
      } catch {
        // The session is already gone.
      }
    }
    if (tellWebview && this.ready) this.post({ type: "collabStop" });
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

  /** A root-relative path from the webview, refused if it climbs out of the root. */
  private inRoot(path: string): vscode.Uri {
    const parts = path.split(/[\\/]+/).filter((p) => p && p !== ".");
    if (parts.some((p) => p === "..")) throw new Error(`path outside the workspace: ${path}`);
    return vscode.Uri.joinPath(this.root, ...parts);
  }

  /** The document's workspace folder, when it is in one. */
  private get workspaceFolder(): vscode.WorkspaceFolder | undefined {
    return vscode.workspace.getWorkspaceFolder(this.document.uri);
  }

  /** Whether `uri` is a file in the document's workspace folder. */
  private inWorkspace(uri: vscode.Uri): boolean {
    const folder = this.workspaceFolder?.uri;
    if (!folder || uri.scheme !== folder.scheme || uri.authority !== folder.authority) return false;
    return insideFolder(folder.path, uri.path, process.platform === "win32");
  }

  /** Root-relative path of a URI in the document's workspace folder (which is `root` then). */
  private rootRelative(uri: vscode.Uri): string {
    return path.posix.relative(this.root.path, uri.path);
  }

  /**
   * A file in the document's workspace folder named `name` with exactly these
   * bytes, as a root-relative path: what a file pasted or dropped from the OS
   * (whose path the webview never learns) most likely is. Undefined when
   * `kenMarkdown.workspaceFiles` is "copy" or there is none.
   *
   * Searched like VS Code's search: `files.exclude`, `search.exclude` and
   * `node_modules` are skipped, and git-ignored files (build output such as
   * `dist/`, which a clean build deletes) are never linked. The document's own
   * folder is searched first so the result cap can't hide the nearest copy.
   */
  private async findInWorkspace(name: string, data: Uint8Array): Promise<string | undefined> {
    const folder = this.workspaceFolder;
    if (!folder || readWorkspaceFiles(this.document.uri) !== "link" || !name || name.includes("/")) return undefined;
    try {
      const exclude = excludeGlob(
        vscode.workspace.getConfiguration("files", folder.uri).get<Record<string, unknown>>("exclude", {}),
        vscode.workspace.getConfiguration("search", folder.uri).get<Record<string, unknown>>("exclude", {}),
      );
      const docDir = vscode.Uri.joinPath(this.document.uri, "..");
      const bases = docDir.toString() === folder.uri.toString() ? [folder.uri] : [docDir, folder.uri];
      const tried = new Set<string>();
      for (const base of bases) {
        const found = await vscode.workspace.findFiles(new vscode.RelativePattern(base, `**/${nameGlob(name)}`), exclude, 500);
        const fresh = found.filter((u) => path.posix.basename(u.path) === name && !tried.has(u.path));
        fresh.forEach((u) => tried.add(u.path));
        const ignored = await gitIgnored(fresh);
        const byPath = new Map(fresh.filter((u) => !ignored.has(path.normalize(u.fsPath))).map((u) => [u.path, u]));
        for (const p of byCloseness(docDir.path, [...byPath.keys()])) {
          const uri = byPath.get(p)!;
          if ((await vscode.workspace.fs.stat(uri)).size !== data.length) continue;
          if (sameBytes(await vscode.workspace.fs.readFile(uri), data)) return this.rootRelative(uri);
        }
      }
    } catch {
      // Not found is fine: the file is copied as before.
    }
    return undefined;
  }

  /**
   * Whether the webview may have `uri` read and copied: the URI could come from
   * a compromised webview rather than a real drop, so only files a drop could
   * have carried qualify. Those are local files or files on the document's own
   * file system, that are in an open workspace folder (the Explorer, search,
   * SCM) or open in an editor (a dragged tab).
   */
  private mayCopy(uri: vscode.Uri): boolean {
    if (!mayCopyScheme(uri, this.document.uri)) return false;
    if (vscode.workspace.getWorkspaceFolder(uri)) return true;
    const key = uri.toString();
    if (vscode.workspace.textDocuments.some((d) => d.uri.toString() === key)) return true;
    const tabUri = (input: unknown) => {
      const u = (input as { uri?: unknown } | undefined)?.uri;
      return u instanceof vscode.Uri ? u.toString() : undefined;
    };
    return vscode.window.tabGroups.all.some((g) => g.tabs.some((t) => tabUri(t.input) === key));
  }

  /**
   * How the document should reference a file dropped from the Explorer (or
   * any URI drop): linked where it is when it is in the document's workspace
   * folder and `kenMarkdown.workspaceFiles` is "link", else copied like a
   * pasted file. Folders, files over 50 MB, URIs that may not be copied (see
   * `mayCopy`) and unreadable ones are linked as they are.
   */
  private async linkFor(raw: string): Promise<LinkedUri> {
    let uri: vscode.Uri;
    try {
      uri = vscode.Uri.parse(raw, true);
    } catch {
      return { path: raw, relative: false, name: raw };
    }
    const name = path.posix.basename(uri.path) || raw;
    const doc = this.document.uri;
    const asIs = (): LinkedUri => {
      if (uri.scheme !== doc.scheme || uri.authority !== doc.authority) return { path: uri.toString(), relative: false, name };
      const rel = path.posix.relative(path.posix.dirname(doc.path), uri.path);
      return { path: rel || name, relative: true, name };
    };
    if (this.inWorkspace(uri) && readWorkspaceFiles(doc) === "link") return asIs();
    if (!this.mayCopy(uri)) return asIs();
    try {
      const stat = await vscode.workspace.fs.stat(uri);
      if (stat.type & vscode.FileType.Directory) return asIs();
      if (stat.size > COPY_LIMIT) {
        void vscode.window.showWarningMessage(
          `${name} is larger than ${COPY_LIMIT / 1024 / 1024} MB, so it was linked where it is instead of copied.`,
        );
        return asIs();
      }
      const data = await vscode.workspace.fs.readFile(uri);
      const saved = await this.saveAttachment(name, data, isImageName(name));
      const docDir = path.posix.dirname(this.docPath);
      const rel = path.posix.relative(docDir === "." ? "" : docDir, saved);
      return { path: rel, relative: true, name: path.posix.basename(saved) };
    } catch {
      return asIs();
    }
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

  /**
   * Edit or open a Lucid link in the browser. The URL comes from the webview,
   * which renders untrusted documents, so it is re-parsed here: anything that
   * isn't an allowlisted Lucid document or published image is ignored, and only
   * a URL rebuilt from the parsed link is opened.
   */
  private async openLucid(url: unknown, action: unknown): Promise<void> {
    const ref = typeof url === "string" ? parseLucidUrl(url) : null;
    if (!ref) return;
    await this.host.openExternal(action === "edit" && ref.kind === "document" ? editUrl(ref) : openUrl(ref));
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

  /** A test's export: no dialogs, and told when it is done. */
  pendingExport: { format: ExportFormat; target: vscode.Uri; done: (ok: boolean) => void } | undefined;
  private pageSeq = 0;
  private readonly pendingPages = new Map<number, (html: string) => void>();

  /** Tests: export without the dialogs; resolves with whether it completed. */
  testExport(format: ExportFormat, target: vscode.Uri): Promise<boolean> {
    return new Promise((done) => {
      this.pendingExport = { format, target, done };
      this.send({ type: "command", id: "export" });
    });
  }

  private readonly pendingAssets = new Map<number, (a: { images: Record<string, ExportAsset>; diagrams: (ExportAsset | null)[] }) => void>();

  /** Pictures for the Word export (diagrams, SVG images), drawn by the webview. */
  private assets(): Promise<{ images: Record<string, ExportAsset>; diagrams: (ExportAsset | null)[] }> {
    const id = ++this.pageSeq;
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve({ images: {}, diagrams: [] }), 30000);
      this.pendingAssets.set(id, (a) => {
        clearTimeout(timer);
        resolve(a);
      });
      this.post({ type: "exportAssets", id });
    });
  }

  /** The print page, without printing, from the webview. */
  private page(): Promise<string> {
    const id = ++this.pageSeq;
    return new Promise((resolve) => {
      this.pendingPages.set(id, resolve);
      this.post({ type: "exportPage", id });
    });
  }

  /** Export as HTML, PDF or DOCX: ask which and where, then write it. */
  private async export(): Promise<void> {
    const preset = this.pendingExport;
    this.pendingExport = undefined;
    const format = preset?.format ?? (await pickFormat());
    if (!format) return preset?.done(false);
    const target = preset?.target ?? (await pickTarget(this.document.uri, format));
    if (!target) return preset?.done(false);
    try {
      const complete = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `Exporting ${path.posix.basename(target.path)}…` },
        async () =>
          writeExport({
            format,
            target,
            html: format === "docx" ? "" : await this.page(),
            assets: format === "docx" ? await this.assets() : undefined,
            document: this.document,
            extensionUri: this.extensionUri,
            openExternal: (url) => this.host.openExternal(url),
          }),
      );
      preset?.done(complete);
      if (preset) return;
      if (!complete) {
        void vscode.window.showInformationMessage(
          "Ken Markdown: no Chrome, Edge or Chromium was found to make the PDF, so the page opened in your browser: choose “Save as PDF” in its print dialog. (kenMarkdown.export.browserPath can name another Chromium-based browser.)",
        );
        return;
      }
      const reveal = process.platform === "darwin" ? "Show in Finder" : process.platform === "win32" ? "Show in File Explorer" : "Open Folder";
      const choice = await vscode.window.showInformationMessage(`Exported ${path.posix.basename(target.path)}`, "Open", reveal);
      if (choice === "Open") await this.host.openExternal(target.toString());
      else if (choice === reveal) await vscode.commands.executeCommand("revealFileInOS", target);
    } catch (err) {
      preset?.done(false);
      void vscode.window.showErrorMessage(`Ken Markdown: could not export: ${err instanceof Error ? err.message : err}`);
    }
  }

  private async print(html: string, name: string): Promise<void> {
    await openPrintPage(html, name, (url) => this.host.openExternal(url));
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

  get uri(): string {
    return this.document.uri.toString();
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
      // The draw.io (diagrams.net) editor, for editing .drawio.svg/.png diagrams,
      // and Lucid's embedded viewer for Lucidchart/Lucidspark link previews. Only
      // lucid.app is needed: src/lucidUrl.ts normalizes every Lucid link to it.
      "frame-src https://embed.diagrams.net https://lucid.app",
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
    this.leaveCollab(true, false);
    this.setFocused(false);
    for (const d of this.disposables.splice(0)) d.dispose();
  }
}

/** Write a print page to a temporary file and open it in the default browser, which prints it. */
export async function openPrintPage(html: string, name: string, openExternal: (url: string) => Thenable<boolean>): Promise<void> {
  const safe = name.replace(/\.(md|markdown)$/i, "").replace(/[^\w.-]+/g, "-").slice(0, 60) || "document";
  const file = vscode.Uri.file(path.join(os.tmpdir(), `ken-print-${safe}-${Date.now()}.html`));
  try {
    await vscode.workspace.fs.writeFile(file, Buffer.from(html, "utf8"));
    await openExternal(file.toString());
  } catch (err) {
    void vscode.window.showErrorMessage(`Ken Markdown: could not open the page to print: ${err}`);
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
  readonly collab: CollabManager;
  shortcutLabels(): ShortcutLabels;
  shortcutKeys(): ShortcutKeys;
  /** The workspace's files, for the @ menu. */
  readonly files: WorkspaceFiles;
  prefs(): EditorPrefs;
  setPrefs(prefs: EditorPrefs): void;
  focusChanged(): void;
  /** Open an http(s) URL outside VS Code (recorded instead in integration tests). */
  openExternal(url: string): Thenable<boolean>;
}

export class KenMarkdownEditorProvider implements vscode.CustomTextEditorProvider, SessionHost {
  /** Live sessions by document URI, newest last; used by commands and tests. */
  readonly sessions = new Map<string, EditorSession>();
  private readonly all = new Set<EditorSession>();
  private labels: ShortcutLabels = {};
  private keys: ShortcutKeys = {};
  readonly files = new WorkspaceFiles(gitIgnored);
  /** URLs `openExternal` would have opened, in test mode only (no browser is launched). */
  readonly externalOpened: string[] = [];

  constructor(
    private readonly context: vscode.ExtensionContext,
    readonly collab: CollabManager,
  ) {}

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

  /** Every open editor on a document, oldest first (tests). */
  sessionsFor(uri: string): EditorSession[] {
    return [...this.all].filter((s) => s.uri === uri);
  }

  shortcutLabels(): ShortcutLabels {
    return this.labels;
  }

  shortcutKeys(): ShortcutKeys {
    return this.keys;
  }

  openExternal(url: string): Thenable<boolean> {
    if (this.context.extensionMode === vscode.ExtensionMode.Test) {
      this.externalOpened.push(url);
      return Promise.resolve(true);
    }
    return vscode.env.openExternal(vscode.Uri.parse(url, true));
  }

  prefs(): EditorPrefs {
    return this.context.globalState.get<EditorPrefs>("kenMarkdown.prefs", {});
  }

  setPrefs(prefs: EditorPrefs) {
    void this.context.globalState.update("kenMarkdown.prefs", { ...this.prefs(), ...prefs });
  }

  /** New effective keybindings: refresh every open editor's hints. */
  setShortcutLabels(labels: ShortcutLabels, keys: ShortcutKeys = {}) {
    this.labels = labels;
    this.keys = keys;
    for (const s of this.all) s.send({ type: "shortcuts", labels, keys });
  }

  /** Whether a diff view (diffPanel.ts) has focus: its keys are the editor's too. */
  diffFocused = false;

  focusChanged() {
    const focused = this.diffFocused || [...this.all].some((s) => s.focused);
    void vscode.commands.executeCommand("setContext", "kenMarkdown.editorFocused", focused);
  }

  /** The editor a command applies to: the focused one, else the active tab's. */
  target(): EditorSession | undefined {
    const focused = [...this.all].find((s) => s.focused);
    if (focused) return focused;
    return [...this.all].find((s) => s.panel.active);
  }
}
