// Files pasted or dropped from inside the workspace are linked where they are
// instead of copied (`kenMarkdown.workspaceFiles`). Pure path logic, no
// `vscode` import, so vitest covers it; provider.ts does the file system work.
import * as path from "path";

export type WorkspaceFilesMode = "link" | "copy";

/** The setting's value; anything but "copy" links. */
export function workspaceFilesMode(value: unknown): WorkspaceFilesMode {
  return value === "copy" ? "copy" : "link";
}

/** A URI path with its drive letter (`/C:/…`) lower-cased and no trailing slash. */
function normalize(p: string): string {
  return path.posix.normalize(p.replace(/^\/([A-Za-z]):/, (_, d: string) => `/${d.toLowerCase()}:`)).replace(/\/+$/, "");
}

/**
 * Whether `file` lies below `folder` (both `/`-separated URI paths). Case is
 * ignored when `ignoreCase` (Windows); the drive letter's case always is.
 */
export function insideFolder(folder: string, file: string, ignoreCase: boolean): boolean {
  let f = normalize(folder);
  let p = normalize(file);
  if (ignoreCase) {
    f = f.toLowerCase();
    p = p.toLowerCase();
  }
  return p.startsWith(f + "/");
}

/**
 * A glob matching `name` (a file name, no `/`): glob characters become `?`,
 * so callers must still compare names exactly.
 */
export function nameGlob(name: string): string {
  return name.replace(/[[\]{}*?!,]/g, "?");
}

export function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * Paths ordered by closeness to `fromDir`: fewest `../` steps in the link
 * first (below the document beats elsewhere), then fewest segments, then name.
 */
export function byCloseness(fromDir: string, paths: string[]): string[] {
  const key = (p: string) => {
    const segs = path.posix.relative(fromDir, p).split("/");
    return [segs.filter((s) => s === "..").length, segs.length];
  };
  return [...paths].sort((a, b) => {
    const [ua, sa] = key(a);
    const [ub, sb] = key(b);
    return ua - ub || sa - sb || (a < b ? -1 : a > b ? 1 : 0);
  });
}

// Kept in step with IMAGE_EXTS in webview/markdown/attachments.ts (which needs DOM types).
const IMAGE_EXTS = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "ico", "avif", "tif", "tiff"]);

/** Whether a file name is an image, by extension (`.drawio.svg`/`.drawio.png` are). */
export function isImageName(name: string): boolean {
  const dot = name.lastIndexOf(".");
  return dot > 0 && IMAGE_EXTS.has(name.slice(dot + 1).toLowerCase());
}

/** `a{b,c}d` as `abd`, `acd`; nested braces too. Unbalanced braces stay as they are. */
export function expandBraces(glob: string): string[] {
  // Innermost group first: the first `}` and the `{` just before it.
  const close = glob.indexOf("}");
  if (close < 0) return [glob];
  const open = glob.lastIndexOf("{", close);
  if (open < 0) return [glob];
  const head = glob.slice(0, open);
  const tail = glob.slice(close + 1);
  const all = glob
    .slice(open + 1, close)
    .split(",")
    .flatMap((alt) => expandBraces(head + alt + tail));
  return [...new Set(all)];
}

/**
 * One exclude glob for `findFiles` from glob → enabled maps (`files.exclude`,
 * `search.exclude`), `node_modules` always included. Only `true` entries count
 * (a `{ when }` sibling rule can't be expressed in a glob). Each pattern also
 * excludes everything below it, as the settings do for folders.
 */
export function excludeGlob(...settings: Record<string, unknown>[]): string {
  const out: string[] = [];
  const add = (pattern: string) => {
    for (const p of expandBraces(pattern)) {
      const clean = p.trim().replace(/\/+$/, "");
      if (!clean || /[{},]/.test(clean)) continue;
      for (const g of [clean, `${clean}/**`]) if (!out.includes(g)) out.push(g);
    }
  };
  add("**/node_modules");
  for (const map of settings) for (const [pattern, on] of Object.entries(map ?? {})) if (on === true) add(pattern);
  return `{${out.join(",")}}`;
}

/** Largest file copied from a URI drop; bigger ones are linked where they are. */
export const COPY_LIMIT = 50 * 1024 * 1024;

interface UriLike {
  scheme: string;
  authority: string;
}

/**
 * Whether a dropped URI may be read and copied beside the document: a local
 * file, or a file on the document's own file system (a remote workspace's
 * `vscode-remote`, a virtual workspace). Never VS Code's own stores
 * (`vscode-userdata` holds settings and keybindings) or unsaved buffers.
 */
export function mayCopyScheme(uri: UriLike, doc: UriLike): boolean {
  if (uri.scheme === "file") return true;
  if (uri.scheme === "vscode-userdata" || uri.scheme === "untitled") return false;
  return uri.scheme === doc.scheme && uri.authority === doc.authority;
}
