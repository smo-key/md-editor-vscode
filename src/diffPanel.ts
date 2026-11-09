/**
 * The rendered diff view (webview/diff.ts), for two kinds of comparison:
 *
 * - "Open Changes in Ken Markdown": a Markdown file's changes since the last
 *   commit. Opened from the editor's title bar, the Source Control view, or
 *   the command palette; follows the repository as commits move HEAD.
 * - "Compare in Ken Markdown": any two Markdown files (or versions of one,
 *   such as the two sides of a text diff, which can be `git:` documents).
 *   Opened from a text diff's title bar, two files selected in the Explorer,
 *   or the command palette (which asks for the second file).
 *
 * Either way the view follows the documents as they are edited, unsaved
 * changes included.
 */
import * as vscode from "vscode";
import * as path from "path";

import { VIEW_TYPE, openPrintPage, readConfig } from "./provider";
import { pickFormat, pickTarget, writeExport, type ExportFormat } from "./exportDoc";
import { ORIGINAL_SCHEME, SNAPSHOT_SCHEME, hasPendingEdits } from "./agentEditsHost";
import { isDefaultEditor } from "./editorAssociation";
import { minimalChange, toEOL, toLF } from "./sync";
import type { DiffContent, DiffHostMessage, DiffLayoutMode, DiffReadOnly, DiffSideName, DiffWebviewMessage, EditorPrefs, ShortcutKeys, ShortcutLabels } from "./protocol";

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

/** What to compare: a file against its last commit, or two documents. */
export type DiffSource =
  | { kind: "head"; uri: vscode.Uri }
  | { kind: "pair"; old: vscode.Uri; new: vscode.Uri }
  /** A file with no earlier version to compare with (e.g. new in a multi-file diff). */
  | { kind: "added"; uri: vscode.Uri };

const isMarkdown = (uri: vscode.Uri) => /\.(md|markdown)$/i.test(uri.path);

/** A short name for a document in labels: its workspace-relative path, plus the ref for a `git:` one. */
function describe(uri: vscode.Uri): string {
  if (uri.scheme === "git") {
    try {
      const q = JSON.parse(uri.query) as { path?: string; ref?: string };
      const file = q.path ? vscode.workspace.asRelativePath(vscode.Uri.file(q.path)) : uri.path;
      const ref = q.ref === "~" ? "Index" : q.ref === "" || q.ref === undefined ? "HEAD" : q.ref.length > 12 ? q.ref.slice(0, 7) : q.ref;
      return `${file} (${ref})`;
    } catch {
      // Fall through.
    }
  }
  if (uri.scheme === ORIGINAL_SCHEME) return `${vscode.workspace.asRelativePath(uri.path)} (before chat edits)`;
  if (uri.scheme === SNAPSHOT_SCHEME) return `${vscode.workspace.asRelativePath(uri.path)} (chat)`;
  if (!isFile(uri)) return `${vscode.workspace.asRelativePath(uri.path)} (${uri.scheme})`;
  return vscode.workspace.asRelativePath(uri);
}

/**
 * What a "Compare in Ken Markdown" invocation compares: the two files selected
 * in the Explorer (`uris`), or the two sides of the active text diff.
 */
export function pairFrom(arg: unknown, uris: unknown): { old: vscode.Uri; new: vscode.Uri } | undefined {
  if (Array.isArray(uris) && uris.length === 2 && uris.every((u) => u instanceof vscode.Uri)) {
    return { old: uris[0] as vscode.Uri, new: uris[1] as vscode.Uri };
  }
  const tab = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
  if (tab instanceof vscode.TabInputTextDiff && (!(arg instanceof vscode.Uri) || arg.toString() === tab.modified.toString())) {
    return { old: tab.original, new: tab.modified };
  }
  return undefined;
}

/**
 * A text diff this view can show instead: both sides Markdown files or their
 * versions in git (Source Control, Compare Selected, Timeline). Diffs other
 * tools open with their own schemes (e.g. AI edit reviews) are left alone.
 */
export function isReplaceableDiff(original: vscode.Uri, modified: vscode.Uri): boolean {
  const ok = (u: vscode.Uri) => {
    if (u.scheme === "git") {
      try {
        return isMarkdown(vscode.Uri.file((JSON.parse(u.query) as { path?: string }).path ?? u.path));
      } catch {
        return isMarkdown(u);
      }
    }
    return (u.scheme === "file" || u.scheme === "untitled" || u.scheme === "vscode-remote") && isMarkdown(u);
  };
  return ok(original) && ok(modified);
}

/** Whether `old` is `file`'s version in git's HEAD. */
export function isHeadOf(old: vscode.Uri, file: vscode.Uri): boolean {
  if (old.scheme !== "git" || file.scheme !== "file") return false;
  try {
    const q = JSON.parse(old.query) as { path?: string; ref?: string };
    return q.ref === "HEAD" && !!q.path && vscode.Uri.file(q.path).toString() === file.toString();
  } catch {
    return false;
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

/** What diff views need from the extension. */
export interface DiffHost {
  shortcuts(): { labels: ShortcutLabels; keys: ShortcutKeys };
  /** Whether a diff view has keyboard focus (part of `kenMarkdown.editorFocused`). */
  focusChanged(focused: boolean): void;
  openExternal(url: string): Thenable<boolean>;
  /** The editor's prefs, shared with Markdown editors (the outline's state). */
  prefs(): EditorPrefs;
  setPrefs(prefs: EditorPrefs): void;
}

/** Whether a document can be edited here (a version in git can't). */
function writable(uri: vscode.Uri): boolean {
  return uri.scheme !== "git" && isFile(uri) && vscode.workspace.fs.isWritableFileSystem(uri.scheme) !== false;
}

/** Schemes of versions agents and chats provide, even where they are served as a file system. */
const TOOL_SCHEMES = new Set(["vscode-agent-host", "chat-editing-text-model", "chat-editing-snapshot-text-model"]);

/**
 * A document in a file system (or a new, untitled one), as opposed to a
 * version some tool provides: a chat agent's before and after, a review's.
 * Such versions say which they are in a query (Copilot's agent host serves
 * them from a file system of its own), files don't.
 */
const isFile = (uri: vscode.Uri) =>
  uri.scheme === "untitled" ||
  (!TOOL_SCHEMES.has(uri.scheme) && !uri.query && vscode.workspace.fs.isWritableFileSystem(uri.scheme) !== undefined);

/** What the extension decided about diffs it may open instead (Output › Ken Markdown). */
let logChannel: vscode.LogOutputChannel | undefined;
const log = () => (logChannel ??= vscode.window.createOutputChannel("Ken Markdown", { log: true }));

/** A tab's input, for the log. */
function describeInput(input: unknown): string {
  if (input instanceof vscode.TabInputTextDiff) return `text diff ${input.original.toString()} ↔ ${input.modified.toString()}`;
  if (input instanceof vscode.TabInputText) return `text ${input.uri.toString()}`;
  if (input instanceof vscode.TabInputCustom) return `custom ${input.viewType} ${input.uri.toString()}`;
  if (input instanceof vscode.TabInputWebview) return `webview ${input.viewType}`;
  const diffs = tabDiffs(input);
  if (diffs.length) return `multi diff ${diffs.map((d) => `${d.old.toString()} ↔ ${d.new.toString()}`).join("; ")}`;
  return input === undefined ? "unknown" : (input as object).constructor?.name ?? typeof input;
}


/** The text diffs a tab shows: one, or each file of a multi-file diff (the chat's session and request changes). */
function tabDiffs(input: unknown): { old: vscode.Uri; new: vscode.Uri }[] {
  if (input instanceof vscode.TabInputTextDiff) return [{ old: input.original, new: input.modified }];
  // Not in the 1.90 API typings; there at runtime since 1.88.
  const Multi = (vscode as unknown as { TabInputTextMultiDiff?: new (...a: never[]) => { textDiffs: vscode.TabInputTextDiff[] } }).TabInputTextMultiDiff;
  if (Multi && input instanceof Multi) return input.textDiffs.map((d) => ({ old: d.original, new: d.modified }));
  return [];
}

/** The text of the chat's original of a file, if it keeps one. */
function pendingOriginalText(uri: vscode.Uri): string | undefined {
  return vscode.workspace.textDocuments.find((d) => d.uri.scheme === ORIGINAL_SCHEME && d.uri.path === uri.path)?.getText();
}

function isMultiDiff(input: unknown): boolean {
  const Multi = (vscode as unknown as { TabInputTextMultiDiff?: new (...a: never[]) => unknown }).TabInputTextMultiDiff;
  return !!Multi && input instanceof Multi;
}

/**
 * The versions the visible text editors show of each Markdown file that has a
 * tool's version among them (a multi-file diff's sides are editors too). The
 * newer is the file when one side is the file, else the version that reads
 * as the file does now, else the later editor.
 */
function editorPairs(): { old: vscode.Uri; new: vscode.Uri }[] {
  const byPath = new Map<string, vscode.TextDocument[]>();
  for (const e of vscode.window.visibleTextEditors) {
    const d = e.document;
    if (!isMarkdown(d.uri)) continue;
    const list = byPath.get(d.uri.path) ?? [];
    if (!list.some((x) => x.uri.toString() === d.uri.toString())) list.push(d);
    byPath.set(d.uri.path, list);
  }
  const out: { old: vscode.Uri; new: vscode.Uri }[] = [];
  for (const docs of byPath.values()) {
    if (docs.length !== 2 || docs.every((d) => isFile(d.uri))) continue;
    const [a, b] = docs as [vscode.TextDocument, vscode.TextDocument];
    const file = vscode.workspace.textDocuments.find((d) => isFile(d.uri) && d.uri.path === a.uri.path);
    const newer = isFile(a.uri) ? a : isFile(b.uri) ? b : file && b.getText() !== file.getText() && a.getText() === file.getText() ? a : b;
    const older = newer === a ? b : a;
    // A version that reads as the file does now is the file: its pending edits, if any, show in the editor.
    out.push({ old: older.uri, new: !isFile(newer.uri) && file && newer.getText() === file.getText() ? file.uri : newer.uri });
  }
  return out;
}

/** Markdown files with a chat agent's edits pending: their originals against the files. */
function pendingChatFiles(): { old: vscode.Uri; new: vscode.Uri }[] {
  const out: { old: vscode.Uri; new: vscode.Uri }[] = [];
  for (const doc of vscode.workspace.textDocuments) {
    if (doc.uri.scheme !== ORIGINAL_SCHEME || !isMarkdown(doc.uri)) continue;
    const file = vscode.workspace.textDocuments.find((d) => d.uri.scheme !== ORIGINAL_SCHEME && d.uri.scheme !== SNAPSHOT_SCHEME && d.uri.path === doc.uri.path);
    if (file && file.getText() !== doc.getText() && !out.some((o) => o.new.toString() === file.uri.toString())) out.push({ old: doc.uri, new: file.uri });
  }
  return out;
}

/**
 * The diffs a tab shows of Markdown files where a side is a version a tool
 * provides (a chat or agent's edits, its session or request changes), when
 * that's all it shows. Git's versions are left to `isReplaceableDiff`.
 */
function toolPairs(input: unknown): { old: vscode.Uri; new: vscode.Uri }[] {
  const diffs = tabDiffs(input);
  const ok = (d: { old: vscode.Uri; new: vscode.Uri }) =>
    d.old.scheme !== "git" && d.new.scheme !== "git" && (!isFile(d.old) || !isFile(d.new)) && (isMarkdown(d.new) || isMarkdown(d.old));
  return diffs.length && diffs.every(ok) ? diffs : [];
}

class DiffPanel {
  private readonly disposables: vscode.Disposable[] = [];
  private repo: Repository | null = null;
  private oldText = "";
  /** Whether the file is in HEAD (head comparisons). */
  private inHead = true;
  private ready = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  /** The document shown as the newer version. */
  private readonly uri: vscode.Uri;
  /** Edits from the view, applied one after another. */
  private editChain: Promise<unknown> = Promise.resolve();
  focused = false;

  constructor(
    private readonly source: DiffSource,
    readonly panel: vscode.WebviewPanel,
    private readonly extensionUri: vscode.Uri,
    private layout: DiffLayoutMode,
    onDispose: () => void,
    private readonly openTextDiff: (old: vscode.Uri, uri: vscode.Uri, title: string) => void,
    private readonly host: DiffHost,
  ) {
    const uri = (this.uri = source.kind === "pair" ? source.new : source.uri);
    const watched = source.kind === "pair" ? [source.old, source.new] : [uri];
    const dirs = watched.filter((u) => u.scheme === "file").map((u) => vscode.Uri.joinPath(u, ".."));
    const roots = [vscode.Uri.joinPath(extensionUri, "dist"), ...dirs, ...(vscode.workspace.workspaceFolders ?? []).map((f) => f.uri)];
    panel.webview.options = { enableScripts: true, localResourceRoots: roots };
    panel.webview.html = this.html();
    this.disposables.push(
      panel.webview.onDidReceiveMessage((m: DiffWebviewMessage) => this.onMessage(m)),
      vscode.workspace.onDidChangeTextDocument((e) => {
        if (watched.some((w) => w.toString() === e.document.uri.toString())) this.schedule(false);
      }),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration("kenMarkdown", uri)) this.post({ type: "config", config: readConfig(uri) });
      }),
    );
    panel.onDidDispose(() => {
      clearTimeout(this.timer);
      if (this.focused) {
        this.focused = false;
        this.host.focusChanged(false);
      }
      for (const d of this.disposables.splice(0)) d.dispose();
      onDispose();
    });
  }

  send(m: DiffHostMessage) {
    if (this.ready) this.post(m);
  }

  private testSeq = 0;
  private readonly tests = new Map<number, (r: unknown) => void>();

  /** Tests: counts of the view's elements matching each selector. */
  query(selectors: string[]): Promise<unknown> {
    const id = ++this.testSeq;
    return new Promise((resolve) => {
      this.tests.set(id, resolve);
      this.post({ type: "test", id, selectors });
    });
  }

  /** The document behind a side, when it can be written. */
  private sideUri(side: DiffSideName): vscode.Uri | null {
    if (side === "new") return this.uri;
    return this.source.kind === "pair" ? this.source.old : null;
  }

  private get readOnly(): DiffReadOnly {
    const ro = (side: DiffSideName) => {
      const uri = this.sideUri(side);
      return !uri || !writable(uri);
    };
    return { old: ro("old"), new: ro("new") };
  }

  private async applyEdit(side: DiffSideName, text: string): Promise<void> {
    const uri = this.sideUri(side);
    if (!uri || !writable(uri)) return;
    const doc = await vscode.workspace.openTextDocument(uri);
    const change = minimalChange(doc.getText(), toEOL(text, doc.eol === vscode.EndOfLine.CRLF));
    if (!change) return;
    const edit = new vscode.WorkspaceEdit();
    edit.replace(uri, new vscode.Range(doc.positionAt(change.start), doc.positionAt(change.end)), change.text);
    await vscode.workspace.applyEdit(edit);
  }

  private post(m: DiffHostMessage) {
    void this.panel.webview.postMessage(m);
  }

  /** Refresh soon (typing); `head` re-reads the committed version too. */
  private schedule(head: boolean) {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.refresh(head), head ? 0 : 300);
  }

  /** The tool versions read so far (by URI), each kept as it first read. */
  private readonly versions = new Map<string, string>();

  /**
   * A side's text. A tool's version (an agent's or a chat's snapshot of the
   * file) is fixed, so it is read once: re-read while the file is edited, an
   * agent host's version can come back empty or as the file is now, which
   * flipped the view to "added" or to no changes and back as the user typed.
   * The chat's original (Keep/Undo) does change; it is read each time.
   */
  private async readVersion(u: vscode.Uri, read: (u: vscode.Uri) => Promise<string | null>): Promise<string | null> {
    if (isFile(u) || u.scheme === ORIGINAL_SCHEME) return read(u);
    const key = u.toString();
    const kept = this.versions.get(key);
    if (kept !== undefined) return kept;
    const text = await read(u);
    // Empty may be a read that came too early; kept only once it has text.
    if (text) this.versions.set(key, text);
    return text;
  }

  private async content(head: boolean): Promise<DiffContent> {
    /** A document's text, or null when it doesn't exist. */
    const read = async (u: vscode.Uri) => {
      try {
        return toLF((await vscode.workspace.openTextDocument(u)).getText());
      } catch {
        return null;
      }
    };
    if (this.source.kind === "added") {
      const newText = (await read(this.uri)) ?? "";
      return { oldText: "", newText, oldLabel: "", newLabel: describe(this.uri), status: "added" };
    }
    if (this.source.kind === "pair") {
      const [oldText, newText] = await Promise.all([this.readVersion(this.source.old, read), this.readVersion(this.source.new, read)]);
      return {
        oldText: oldText ?? "",
        newText: newText ?? "",
        oldLabel: describe(this.source.old),
        newLabel: describe(this.source.new),
        status: newText === null && oldText ? "deleted" : !oldText && newText ? "added" : undefined,
      };
    }
    if (head || !this.repo) {
      this.repo ??= await gitRepository(this.uri);
      try {
        this.oldText = this.repo ? await this.repo.show("HEAD", this.uri.fsPath) : "";
        this.inHead = !!this.repo;
      } catch {
        // Not in HEAD: a new file.
        this.oldText = "";
        this.inHead = false;
      }
    }
    // Null: deleted, everything was removed.
    const newText = await read(this.uri);
    const commit = this.repo?.state.HEAD?.commit?.slice(0, 7);
    const status = newText === null && this.oldText ? "deleted" : !this.inHead && newText ? "added" : undefined;
    return { oldText: toLF(this.oldText), newText: newText ?? "", oldLabel: commit ? `HEAD (${commit})` : "HEAD", newLabel: "Working Tree", status };
  }

  private requestSeq = 0;
  private readonly pending = new Map<number, (value: unknown) => void>();

  /** Ask the view for something (the export page, the Word pictures) and wait for it. */
  private request<T>(build: (id: number) => DiffHostMessage, fallback: T): Promise<T> {
    const id = ++this.requestSeq;
    return new Promise<T>((resolve) => {
      const timer = setTimeout(() => resolve(fallback), 60000);
      this.pending.set(id, ((v: T) => {
        clearTimeout(timer);
        resolve(v);
      }) as (value: unknown) => void);
      this.post(build(id));
    });
  }

  /** Tests: export without the dialogs. */
  testExport: { format: ExportFormat; target: vscode.Uri; done: (ok: boolean) => void } | undefined;

  /**
   * Export the comparison: HTML and PDF as the view shows it (both versions,
   * changes in red and green); Word as the newer version alone (the older one
   * when the file was deleted), a clean document.
   */
  private async export(): Promise<void> {
    const preset = this.testExport;
    this.testExport = undefined;
    const format = preset?.format ?? (await pickFormat());
    if (!format) return preset?.done(false);
    const content = await this.content(false);
    const side: DiffSideName = content.status === "deleted" ? "old" : "new";
    const uri = this.sideUri(side) ?? this.uri;
    const target = preset?.target ?? (await pickTarget(this.uri.with({ path: this.uri.path.replace(/(\.(md|markdown))?$/i, format === "docx" ? "$1" : " (changes)$1") }), format));
    if (!target) return preset?.done(false);
    try {
      const document = await vscode.workspace.openTextDocument(isFile(uri) ? uri : this.uri).then(
        (d) => d,
        () => vscode.workspace.openTextDocument({ content: content[`${side}Text`], language: "markdown" }),
      );
      const complete = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `Exporting ${path.posix.basename(target.path)}…` },
        async () =>
          writeExport({
            format,
            target,
            html: format === "docx" ? "" : await this.request((id) => ({ type: "exportPage", id }), ""),
            assets:
              format === "docx"
                ? await this.request((id) => ({ type: "exportAssets", id, side }), { images: {}, diagrams: [] as null[] })
                : undefined,
            document,
            markdown: content[`${side}Text`],
            extensionUri: this.extensionUri,
            openExternal: (url) => this.host.openExternal(url),
          }),
      );
      preset?.done(complete);
      if (preset) return;
      if (!complete) {
        void vscode.window.showInformationMessage("Ken Markdown: no Chrome, Edge or Chromium was found to make the PDF, so the page opened in your browser: choose “Save as PDF” in its print dialog.");
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

  /** The last edit of each side from the view that has been applied, and how many are on their way. */
  private readonly seen: Record<DiffSideName, number> = { old: 0, new: 0 };
  private pendingEdits = 0;
  /** A refresh put off while edits were on their way (`head`: with the committed version). */
  private deferred: boolean | undefined;

  private async refresh(head: boolean) {
    if (!this.ready) return;
    // The view's own edits first: text read before they land is older than what it shows.
    if (this.pendingEdits > 0) {
      this.deferred = !!this.deferred || head;
      return;
    }
    const seen = { ...this.seen };
    this.post({ type: "diffUpdate", seen, ...(await this.content(head)) });
  }

  async onMessage(m: DiffWebviewMessage) {
    switch (m.type) {
      case "diffReady": {
        const content = await this.content(true);
        this.ready = true;
        if (this.repo && this.source.kind === "head") this.disposables.push(this.repo.state.onDidChange(() => this.schedule(true)));
        const dir = (u: vscode.Uri | null) => (u && u.scheme !== "git" && isFile(u) ? this.panel.webview.asWebviewUri(vscode.Uri.joinPath(u, "..")).toString() + "/" : "");
        const newBase = dir(this.uri);
        const base = { old: dir(this.sideUri("old")) || newBase, new: newBase };
        const { labels, keys } = this.host.shortcuts();
        this.post({
          type: "diffInit",
          config: readConfig(this.uri),
          layout: this.layout,
          base,
          readOnly: this.readOnly,
          shortcuts: labels,
          keys,
          prefs: this.host.prefs(),
          ...content,
        });
        return;
      }
      case "testResult":
        this.tests.get(m.id)?.(m.result);
        this.tests.delete(m.id);
        return;
      case "diffEdit":
        this.pendingEdits++;
        this.editChain = this.editChain
          .then(() => this.applyEdit(m.side, m.text))
          .catch((err) => void vscode.window.showErrorMessage(`Ken Markdown: could not apply edit: ${err}`))
          .finally(() => {
            if (m.seq) this.seen[m.side] = Math.max(this.seen[m.side], m.seq);
            if (--this.pendingEdits > 0 || this.deferred === undefined) return;
            const head = this.deferred;
            this.deferred = undefined;
            this.schedule(head);
          });
        return;
      case "focus":
        if (this.focused !== m.focused) {
          this.focused = m.focused;
          this.host.focusChanged(m.focused);
        }
        return;
      case "readClipboard":
        this.post({ type: "clipboardText", id: m.id, text: await vscode.env.clipboard.readText() });
        return;
      case "print":
        await openPrintPage(m.html, path.basename(this.uri.path), (url) => this.host.openExternal(url));
        return;
      case "diffLayout":
        this.layout = m.layout;
        return;
      case "setPrefs":
        this.host.setPrefs(m.prefs);
        return;
      case "export":
        await this.export();
        return;
      case "exportPageReady":
        this.pending.get(m.id)?.(m.html);
        this.pending.delete(m.id);
        return;
      case "exportAssetsReady":
        this.pending.get(m.id)?.({ images: m.images, diagrams: m.diagrams });
        this.pending.delete(m.id);
        return;
      case "openTextDiff": {
        if (this.source.kind === "added") {
          await vscode.commands.executeCommand("vscode.open", this.uri);
          return;
        }
        const old =
          this.source.kind === "pair"
            ? this.source.old
            : this.uri.with({ scheme: "git", query: JSON.stringify({ path: this.uri.fsPath, ref: "HEAD" }) });
        this.openTextDiff(old, this.uri, this.panel.title);
        return;
      }
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

  /** Text diffs opened on purpose ("Text diff" in the view), not to be replaced. */
  private readonly keepText = new Set<string>();
  /** Markdown text diffs open now, by group and tab label, to recognise them reopened with another editor. */
  private readonly textDiffs = new Map<string, { old: vscode.Uri; new: vscode.Uri }>();

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly host: DiffHost,
  ) {
    // Markdown diffs open here instead of as text (kenMarkdown.diff.openMarkdownDiffs).
    context.subscriptions.push(
      vscode.window.tabGroups.onDidChangeTabs((e) => {
        for (const tab of e.closed) {
          if (tab.input instanceof vscode.TabInputTextDiff) this.keepText.delete(`${tab.input.original}|${tab.input.modified}`);
        }
        void this.takeOver([...e.opened, ...e.changed]);
      }),
    );
  }

  /** Replace text diffs of two Markdown documents with this view. */
  private async takeOver(tabs: readonly vscode.Tab[]): Promise<void> {
    for (const tab of tabs) {
      const input = tab.input;
      if (!(input instanceof vscode.TabInputText) && !(input instanceof vscode.TabInputCustom) && !(input instanceof vscode.TabInputWebview)) {
        log().info(`tab ${tab.label} (group ${tab.group.viewColumn}): ${describeInput(input)}`);
      }
      const where = `${tab.group.viewColumn}:${tab.label}`;
      // A Markdown text diff reopened with another editor ("Reopen Editor
      // With… › Ken Markdown Editor") becomes a diff of two plain editors,
      // which VS Code reports as an unknown tab: the rendered comparison
      // replaces it, as it would the text diff.
      if (input === undefined) {
        const was = this.textDiffs.get(where);
        if (!was) continue;
        this.textDiffs.delete(where);
        this.keepText.delete(`${was.old}|${was.new}`);
        const column = tab.group.viewColumn;
        await vscode.window.tabGroups.close(tab, true);
        if (!isFile(was.old) || !isFile(was.new)) await this.openTool(was.old, was.new, column);
        else this.open_({ kind: "pair", ...was }, column);
        continue;
      }
      // A chat's or agent's diff of a Markdown file (or its session's or a
      // request's changes, when that's the one file): the Ken editor shows
      // pending edits, Keep/Undo and all; other versions open in the rendered
      // comparison.
      // A multi-file diff whose files VS Code hasn't listed (the chat's session
      // and request changes): its files are read from the editors it shows.
      const count = /\((\d+)\D*\)\s*$/.exec(tab.label);
      if (isMultiDiff(input) && tabDiffs(input).length === 0 && count) {
        void this.multiFromEditors(tab, Number(count[1]));
        continue;
      }
      const tools = toolPairs(input);
      // Remembered, to recognise it reopened with the Ken Markdown Editor.
      if (input instanceof vscode.TabInputTextDiff && tools.length === 1) this.textDiffs.set(where, tools[0]!);
      if (tools.length && !tools.some((t) => this.keepText.has(`${t.old}|${t.new}`))) {
        const targets = await Promise.all(tools.map((t) => this.toolTarget(t.old, t.new)));
        log().info(`→ ${targets.map((t) => t ?? "left as text").join(", ")}`);
        if (targets.every(Boolean)) {
          const column = tab.group.viewColumn;
          await vscode.window.tabGroups.close(tab, true);
          for (const t of tools) await this.openTool(t.old, t.new, column);
          continue;
        }
      }
      if (!(input instanceof vscode.TabInputTextDiff) || !isReplaceableDiff(input.original, input.modified)) continue;
      this.textDiffs.set(where, { old: input.original, new: input.modified });
      const key = `${input.original}|${input.modified}`;
      if (this.keepText.has(key)) continue;
      const setting = vscode.workspace.getConfiguration("kenMarkdown", input.modified).get<string>("diff.openMarkdownDiffs", "ken");
      if (setting !== "ken") continue;
      const column = tab.group.viewColumn;
      await vscode.window.tabGroups.close(tab, true);
      this.open_({ kind: "pair", old: input.original, new: input.modified }, column);
    }
  }

  private readonly multiPending = new Set<string>();

  /**
   * Replace a multi-file diff of Markdown files with this view (one tab per
   * file), once its editors show all `count` files: each file's two versions
   * are the visible text editors sharing its path. Diffs with other files, or
   * whose versions can't be told apart, stay as they are.
   */
  private async multiFromEditors(tab: vscode.Tab, count: number): Promise<void> {
    const key = `${tab.group.viewColumn}:${tab.label}`;
    if (this.multiPending.has(key)) return;
    this.multiPending.add(key);
    try {
      for (const end = Date.now() + 4000; Date.now() < end; await new Promise((r) => setTimeout(r, 150))) {
        const current = tab.group.tabs.find((t) => t.label === tab.label && isMultiDiff(t.input));
        if (!current || !current.isActive) return;
        const pairs = editorPairs();
        log().info(`multi diff "${tab.label}": ${pairs.length}/${count} files from editors: ${pairs.map((p) => `${p.old} ↔ ${p.new}`).join("; ")}`);
        if (pairs.length < count) continue;
        if (pairs.length > count || !pairs.every((p) => isMarkdown(p.new))) return;
        const targets = await Promise.all(pairs.map((p) => this.toolTarget(p.old, p.new)));
        if (targets.some((t) => !t)) return;
        const column = tab.group.viewColumn;
        await vscode.window.tabGroups.close(current, true);
        for (const p of pairs) await this.openTool(p.old, p.new, column);
        return;
      }
    } finally {
      this.multiPending.delete(key);
    }
  }

  /**
   * How a tool's diff of a Markdown file opens here (null: left as text): in
   * the Ken editor when the file has a chat agent's edits pending (`editor`),
   * else as a comparison (`pair`). Only while the Ken editor is the file's
   * default editor and Markdown diffs open in Ken.
   */
  private async toolTarget(original: vscode.Uri, modified: vscode.Uri, asked = false): Promise<"editor" | "pair" | null> {
    const path = isMarkdown(modified) ? modified.path : original.path;
    if (!/\.(md|markdown)$/i.test(path)) return null;
    // Opened here unasked only while Markdown diffs open in Ken and it is the default editor.
    if (!asked) {
      if (vscode.workspace.getConfiguration("kenMarkdown", modified).get<string>("diff.openMarkdownDiffs", "ken") !== "ken") return null;
      const associations = vscode.workspace.getConfiguration("workbench").get("editorAssociations");
      if (!isDefaultEditor(path, VIEW_TYPE, associations, true)) return null;
    }
    if (!isFile(modified)) return "pair";
    if (original.scheme === ORIGINAL_SCHEME) return "editor";
    try {
      return hasPendingEdits(await vscode.workspace.openTextDocument(modified)) ? "editor" : "pair";
    } catch {
      return "pair";
    }
  }

  /** Whether a pair is a tool's versions of a Markdown file (a chat's or an agent's), which this view can show. */
  async isToolDiff(pair: { old: vscode.Uri; new: vscode.Uri }): Promise<boolean> {
    return toolPairs(new vscode.TabInputTextDiff(pair.old, pair.new)).length === 1;
  }

  private async openTool(old: vscode.Uri, uri: vscode.Uri, column: vscode.ViewColumn = vscode.ViewColumn.Active): Promise<void> {
    if ((await this.toolTarget(old, uri, true)) === "editor") {
      await vscode.commands.executeCommand("vscode.openWith", uri, VIEW_TYPE, { viewColumn: column, preserveFocus: true });
    } else this.open_({ kind: "pair", old, new: uri }, column);
  }

  private openTextDiff(old: vscode.Uri, uri: vscode.Uri, title: string) {
    const key = `${old}|${uri}`;
    this.keepText.add(key);
    void vscode.commands.executeCommand("vscode.diff", old, uri, `${title} (Text)`);
  }

  /**
   * One file of a diff (right-click in it, e.g. in a multi-file diff): its two
   * versions are the visible editors showing that file, opened here as the
   * Ken editor (pending chat edits), the rendered comparison, or with a banner
   * when the file was added or deleted.
   */
  async openDiffFile(arg?: unknown): Promise<void> {
    const uri = arg instanceof vscode.Uri ? arg : vscode.window.activeTextEditor?.document.uri;
    if (!uri) return;
    const docs: vscode.Uri[] = [];
    for (const e of vscode.window.visibleTextEditors) {
      const u = e.document.uri;
      if (u.path === uri.path && !docs.some((d) => d.toString() === u.toString())) docs.push(u);
    }
    log().info(`open diff file ${uri.toString()}: editors ${docs.map(String).join("; ")}`);
    if (docs.length === 2) {
      // The diff shows the older version first; a file on disk is always the newer.
      let [old, file] = docs as [vscode.Uri, vscode.Uri];
      if (isFile(old) && !isFile(file)) [old, file] = [file, old];
      if (!isFile(old) || !isFile(file)) return this.openTool(old, file);
      return this.open_({ kind: "pair", old, new: file });
    }
    const alone = await this.newOrDeleted(uri, true);
    if (alone) return this.open_(alone);
    if (isFile(uri)) await vscode.commands.executeCommand("vscode.openWith", uri, VIEW_TYPE);
  }

  /** A file's changes since the last commit. */
  async show(arg?: unknown): Promise<void> {
    const uri = targetUri(arg);
    if (!uri || !isMarkdown(uri)) {
      void vscode.window.showInformationMessage("Ken Markdown: open a Markdown file to see its changes.");
      return;
    }
    this.open_({ kind: "head", uri });
  }

  /**
   * Two documents side by side: the Explorer's two selected files, the active
   * text diff's sides, or the given (or active) file and one picked now.
   */
  async compare(arg?: unknown, uris?: unknown): Promise<void> {
    // From a multi-file diff's title bar, the argument is the diff itself, not a file.
    const fromMulti = arg instanceof vscode.Uri && arg.scheme === "multi-diff-editor";
    if (fromMulti) arg = undefined;
    let pair = pairFrom(arg, uris);
    if (pair && (await this.toolTarget(pair.old, pair.new, true))) return this.openTool(pair.old, pair.new);
    if (!pair && !(arg instanceof vscode.Uri)) {
      // A multi-file diff (e.g. the chat's session or request changes): its Markdown files.
      let diffs = tabDiffs(vscode.window.tabGroups.activeTabGroup.activeTab?.input).filter((d) => isMarkdown(d.new));
      // VS Code reports a multi-file diff's files only once it has loaded them;
      // the chat's (session and request changes) may not be: offer the
      // Markdown files with an agent's edits pending instead.
      if (!diffs.length && tabDiffs(vscode.window.tabGroups.activeTabGroup.activeTab?.input).length === 0) diffs = pendingChatFiles();
      if (diffs.length) {
        const picked =
          diffs.length === 1
            ? diffs
            : (
                await vscode.window.showQuickPick(
                  diffs.map((d) => ({ label: path.basename(d.new.path), description: vscode.workspace.asRelativePath(d.new.path), d })),
                  { canPickMany: true, title: "Open in Ken Markdown" },
                )
              )?.map((i) => i.d);
        for (const d of picked ?? []) {
          if (!isFile(d.old) || !isFile(d.new)) await this.openTool(d.old, d.new);
          else this.open_({ kind: "pair", ...d });
        }
        return;
      }
    }
    if (!pair) {
      const first = targetUri(arg);
      if (!first) {
        void vscode.window.showInformationMessage("Ken Markdown: open a Markdown file to compare it with another.");
        return;
      }
      // A file that is new, or gone, has nothing to pick a second file for.
      const alone = await this.newOrDeleted(first, fromMulti);
      if (alone) return this.open_(alone);
      const picked = await vscode.window.showOpenDialog({
        title: `Compare ${path.basename(first.path)} with…`,
        openLabel: "Compare",
        canSelectMany: false,
        defaultUri: vscode.Uri.joinPath(first, ".."),
        filters: { Markdown: ["md", "markdown"] },
      });
      if (!picked?.[0]) return;
      pair = { old: picked[0], new: first };
    }
    this.open_({ kind: "pair", ...pair });
  }

  /**
   * How to show a file that has no earlier version (new: untracked in git,
   * created by a chat agent, or new in the multi-file diff it was picked
   * from) or no newer one (deleted, picked as a version from git or a tool);
   * null for a file with both.
   */
  private async newOrDeleted(uri: vscode.Uri, fromMulti: boolean): Promise<DiffSource | null> {
    const exists = async (u: vscode.Uri) => {
      try {
        await vscode.workspace.fs.stat(u);
        return true;
      } catch {
        return false;
      }
    };
    if (!isFile(uri) || uri.scheme === "git") {
      let file: vscode.Uri | undefined;
      try {
        file = uri.scheme === "git" ? vscode.Uri.file((JSON.parse(uri.query) as { path: string }).path) : (vscode.workspace.workspaceFolders?.[0]?.uri ?? vscode.Uri.file("/")).with({ path: uri.path });
      } catch {
        return null;
      }
      return (await exists(file)) ? null : { kind: "pair", old: uri, new: file };
    }
    if (!(await exists(uri))) return { kind: "head", uri };
    try {
      if (hasPendingEdits(await vscode.workspace.openTextDocument(uri)) && pendingOriginalText(uri) === "") return { kind: "added", uri };
    } catch {
      // Not a text document.
    }
    const repo = await gitRepository(uri);
    if (repo) {
      try {
        await repo.show("HEAD", uri.fsPath);
      } catch {
        return { kind: "head", uri };
      }
    }
    return fromMulti ? { kind: "added", uri } : null;
  }

  private open_(source: DiffSource, column: vscode.ViewColumn = vscode.ViewColumn.Active): void {
    // A file against its HEAD version is "Open Changes", however it was opened.
    if (source.kind === "pair" && isHeadOf(source.old, source.new)) source = { kind: "head", uri: source.new };
    const key = source.kind === "pair" ? `pair:${source.old}|${source.new}` : `${source.kind}:${source.uri}`;
    const existing = this.open.get(key);
    if (existing) {
      existing.panel.reveal();
      return;
    }
    const uri = source.kind === "pair" ? source.new : source.uri;
    const layout = vscode.workspace.getConfiguration("kenMarkdown", uri).get<DiffLayoutMode>("diff.layout", "combined");
    const title =
      source.kind === "pair"
        ? `${path.basename(source.old.path)} ↔ ${path.basename(source.new.path)}`
        : source.kind === "added"
          ? `${path.basename(uri.path)} (Added)`
          : `${path.basename(uri.path)} (Changes)`;
    const panel = vscode.window.createWebviewPanel("kenMarkdown.diff", title, column, {
      retainContextWhenHidden: true,
      enableFindWidget: true,
    });
    this.open.set(key, new DiffPanel(source, panel, this.context.extensionUri, layout === "split" ? "split" : "combined", () => this.open.delete(key), (o, n, t) => this.openTextDiff(o, n, t), this.host));
  }

  /** The diff view a command applies to: the focused one, else the active one. */
  target(): DiffPanel | undefined {
    const all = [...this.open.values()];
    return all.find((p) => p.focused) ?? all.find((p) => p.panel.active);
  }

  /** New effective keybindings: refresh every view's hints and claimed keys. */
  setShortcuts(labels: ShortcutLabels, keys: ShortcutKeys): void {
    for (const p of this.open.values()) p.send({ type: "shortcuts", labels, keys });
  }

  /** Tests: handle `m` as if the newest diff view had posted it. */
  async testMessage(m: DiffWebviewMessage): Promise<void> {
    await [...this.open.values()].pop()?.onMessage(m);
  }

  /** Tests: export the newest diff view without the dialogs; resolves with whether it completed. */
  testExport(format: ExportFormat, target: vscode.Uri): Promise<boolean> {
    const panel = [...this.open.values()].pop();
    if (!panel) return Promise.resolve(false);
    return new Promise((done) => {
      panel.testExport = { format, target, done };
      void panel.onMessage({ type: "export" });
    });
  }

  /** Tests: query the newest diff view. */
  testQuery(selectors: string[]): Promise<unknown> {
    return [...this.open.values()].pop()?.query(selectors) ?? Promise.resolve(null);
  }

  /** Open diff views (tests). */
  get count(): number {
    return this.open.size;
  }

  dispose(): void {
    for (const p of this.open.values()) p.panel.dispose();
  }
}
