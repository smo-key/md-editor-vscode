/**
 * "Open Changes in Ken Markdown": a Markdown file's changes since the last
 * commit, rendered (webview/diff.ts) instead of as a text diff. Opened from
 * the editor's title bar, a text diff of a Markdown file, the Source Control
 * view, or the command palette. The view follows the document as it is edited
 * (unsaved changes included) and the repository as commits move HEAD.
 */
import * as vscode from "vscode";
import * as path from "path";

import { readConfig } from "./provider";
import type { DiffContent, DiffHostMessage, DiffLayoutMode, DiffWebviewMessage } from "./protocol";

interface Repository {
  show(ref: string, path: string): Promise<string>;
  state: { onDidChange: vscode.Event<void>; HEAD?: { commit?: string; name?: string } };
}
interface GitApi {
  getRepository(uri: vscode.Uri): Repository | null;
}

async function gitRepository(uri: vscode.Uri): Promise<Repository | null> {
  const ext = vscode.extensions.getExtension<{ getAPI(version: 1): GitApi }>("vscode.git");
  if (!ext) return null;
  try {
    const api = (ext.isActive ? ext.exports : await ext.activate()).getAPI(1);
    return api.getRepository(uri);
  } catch {
    return null;
  }
}

/** The file a command argument (or, without one, the active tab) is about. */
export function targetUri(arg: unknown): vscode.Uri | undefined {
  let uri: vscode.Uri | undefined;
  if (arg instanceof vscode.Uri) uri = arg;
  else if (arg && typeof arg === "object" && (arg as { resourceUri?: unknown }).resourceUri instanceof vscode.Uri) {
    uri = (arg as { resourceUri: vscode.Uri }).resourceUri;
  } else {
    const tab = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
    if (tab instanceof vscode.TabInputTextDiff) uri = tab.modified;
    else if (tab instanceof vscode.TabInputCustom || tab instanceof vscode.TabInputText) uri = tab.uri;
    else uri = vscode.window.activeTextEditor?.document.uri;
  }
  // A git: URI (one side of a text diff) names the file in its query.
  if (uri?.scheme === "git") {
    try {
      const file = (JSON.parse(uri.query) as { path?: string }).path;
      if (file) uri = vscode.Uri.file(file);
    } catch {
      // Not the git extension's query: leave it.
    }
  }
  return uri;
}

function makeNonce(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let out = "";
  for (let i = 0; i < 32; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}

class DiffPanel {
  private readonly disposables: vscode.Disposable[] = [];
  private repo: Repository | null = null;
  private oldText = "";
  private ready = false;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    readonly uri: vscode.Uri,
    readonly panel: vscode.WebviewPanel,
    private readonly extensionUri: vscode.Uri,
    private layout: DiffLayoutMode,
    onDispose: () => void,
  ) {
    const dir = vscode.Uri.joinPath(uri, "..");
    const roots = [vscode.Uri.joinPath(extensionUri, "dist"), dir, ...(vscode.workspace.workspaceFolders ?? []).map((f) => f.uri)];
    panel.webview.options = { enableScripts: true, localResourceRoots: roots };
    panel.webview.html = this.html();
    this.disposables.push(
      panel.webview.onDidReceiveMessage((m: DiffWebviewMessage) => this.onMessage(m)),
      vscode.workspace.onDidChangeTextDocument((e) => {
        if (e.document.uri.toString() === uri.toString()) this.schedule(false);
      }),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration("kenMarkdown", uri)) this.post({ type: "config", config: readConfig(uri) });
      }),
    );
    panel.onDidDispose(() => {
      clearTimeout(this.timer);
      for (const d of this.disposables.splice(0)) d.dispose();
      onDispose();
    });
  }

  private post(m: DiffHostMessage) {
    void this.panel.webview.postMessage(m);
  }

  /** Refresh soon (typing); `head` re-reads the committed version too. */
  private schedule(head: boolean) {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.refresh(head), head ? 0 : 300);
  }

  private async content(head: boolean): Promise<DiffContent> {
    if (head || !this.repo) {
      this.repo ??= await gitRepository(this.uri);
      try {
        this.oldText = this.repo ? await this.repo.show("HEAD", this.uri.fsPath) : "";
      } catch {
        // Not in HEAD: a new file.
        this.oldText = "";
      }
    }
    let newText = "";
    try {
      newText = (await vscode.workspace.openTextDocument(this.uri)).getText();
    } catch {
      // Deleted: everything was removed.
    }
    const commit = this.repo?.state.HEAD?.commit?.slice(0, 7);
    return { oldText: this.oldText, newText, oldLabel: commit ? `HEAD (${commit})` : "HEAD", newLabel: "Working Tree" };
  }

  private async refresh(head: boolean) {
    if (!this.ready) return;
    this.post({ type: "diffUpdate", ...(await this.content(head)) });
  }

  private async onMessage(m: DiffWebviewMessage) {
    switch (m.type) {
      case "diffReady": {
        const content = await this.content(true);
        this.ready = true;
        if (this.repo) this.disposables.push(this.repo.state.onDidChange(() => this.schedule(true)));
        const base = this.panel.webview.asWebviewUri(vscode.Uri.joinPath(this.uri, "..")).toString() + "/";
        this.post({ type: "diffInit", config: readConfig(this.uri), layout: this.layout, base, ...content });
        return;
      }
      case "diffLayout":
        this.layout = m.layout;
        return;
      case "openFile":
        await vscode.commands.executeCommand("vscode.open", this.uri);
        return;
      case "error":
        console.error(`Ken Markdown diff: ${m.message}`);
        return;
    }
  }

  private html(): string {
    const webview = this.panel.webview;
    const nonce = makeNonce();
    const dist = vscode.Uri.joinPath(this.extensionUri, "dist", "webview");
    const script = webview.asWebviewUri(vscode.Uri.joinPath(dist, "diff.js"));
    const style = webview.asWebviewUri(vscode.Uri.joinPath(dist, "diff.css"));
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
<title>Changes</title>
</head>
<body>
<script type="module" nonce="${nonce}" src="${script}"></script>
</body>
</html>`;
  }
}

export class DiffPanels implements vscode.Disposable {
  private readonly open = new Map<string, DiffPanel>();

  constructor(private readonly context: vscode.ExtensionContext) {}

  async show(arg?: unknown): Promise<void> {
    const uri = targetUri(arg);
    if (!uri || !/\.(md|markdown)$/i.test(uri.path)) {
      void vscode.window.showInformationMessage("Ken Markdown: open a Markdown file to see its changes.");
      return;
    }
    const key = uri.toString();
    const existing = this.open.get(key);
    if (existing) {
      existing.panel.reveal();
      return;
    }
    const layout = vscode.workspace.getConfiguration("kenMarkdown", uri).get<DiffLayoutMode>("diff.layout", "combined");
    const panel = vscode.window.createWebviewPanel(
      "kenMarkdown.diff",
      `${path.basename(uri.path)} (Changes)`,
      vscode.ViewColumn.Active,
      { retainContextWhenHidden: true, enableFindWidget: true },
    );
    this.open.set(key, new DiffPanel(uri, panel, this.context.extensionUri, layout === "split" ? "split" : "combined", () => this.open.delete(key)));
  }

  /** Open diff views (tests). */
  get count(): number {
    return this.open.size;
  }

  dispose(): void {
    for (const p of this.open.values()) p.panel.dispose();
  }
}
