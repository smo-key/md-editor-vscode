/**
 * The project's files, for the @ menu: every file in the open workspace
 * folders except those VS Code is told to hide (`files.exclude`,
 * `search.exclude`), dependency and VCS folders, and git-ignored files.
 * Listed once and kept until files are created, deleted or the exclusions
 * change; each query is then ranked in memory (src/fileRank.ts).
 */
import * as vscode from "vscode";
import * as path from "path";

import { rankFiles } from "./fileRank";
import type { FileHit } from "./protocol";

const MAX_FILES = 20000;

/** One brace glob of every excluded pattern that is switched on. */
function excludeGlob(): string {
  const patterns = new Set(["**/node_modules/**", "**/.git/**"]);
  for (const section of ["files.exclude", "search.exclude"]) {
    const setting = vscode.workspace.getConfiguration().get<Record<string, unknown>>(section) ?? {};
    for (const [glob, on] of Object.entries(setting)) if (on === true) patterns.add(glob);
  }
  return `{${[...patterns].join(",")}}`;
}

export class WorkspaceFiles implements vscode.Disposable {
  private list: Promise<vscode.Uri[]> | null = null;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(private readonly ignored: (uris: vscode.Uri[]) => Promise<Set<string>>) {
    const watcher = vscode.workspace.createFileSystemWatcher("**/*", false, true, false);
    const stale = () => (this.list = null);
    this.disposables.push(
      watcher,
      watcher.onDidCreate(stale),
      watcher.onDidDelete(stale),
      vscode.workspace.onDidChangeWorkspaceFolders(stale),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration("files.exclude") || e.affectsConfiguration("search.exclude")) stale();
      }),
    );
  }

  private files(): Promise<vscode.Uri[]> {
    this.list ??= Promise.resolve(vscode.workspace.findFiles("**/*", excludeGlob(), MAX_FILES)).catch(() => []);
    return this.list;
  }

  /** The files best matching `query`, as links from `doc` would reach them. */
  async find(query: string, doc: vscode.Uri, limit = 50): Promise<FileHit[]> {
    if (!vscode.workspace.workspaceFolders?.length) return [];
    const all = (await this.files()).filter((u) => u.toString() !== doc.toString());
    const byPath = new Map(all.map((u) => [vscode.workspace.asRelativePath(u, true), u]));
    const near = path.posix.dirname(vscode.workspace.asRelativePath(doc, true));
    // Rank a few extra: git-ignored ones are only checked among the best.
    const best = rankFiles([...byPath.keys()], query, near, limit * 2).map((p) => byPath.get(p)!);
    const ignored = await this.ignored(best);
    const docDir = path.posix.dirname(doc.path);
    return best
      .filter((u) => !ignored.has(path.normalize(u.fsPath)) && u.scheme === doc.scheme && u.authority === doc.authority)
      .slice(0, limit)
      .map((u) => {
        const rel = vscode.workspace.asRelativePath(u, true);
        const dir = path.posix.dirname(rel);
        return { path: path.posix.relative(docDir, u.path), name: path.posix.basename(u.path), dir: dir === "." ? "" : dir };
      });
  }

  dispose(): void {
    for (const d of this.disposables.splice(0)) d.dispose();
  }
}
