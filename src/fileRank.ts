/**
 * Ranking files for the @ menu (webview/fileMention.ts) by a query typed
 * after "@". Pure, so it is unit-tested; src/fileSearch.ts lists the files.
 */

export interface RankedFile {
  /** Workspace-relative path, `/`-separated. */
  path: string;
  score: number;
}

/** Whether `query`'s characters appear in `text` in order. */
function subsequence(text: string, query: string): boolean {
  let i = 0;
  for (const ch of text) if (ch === query[i] && ++i === query.length) return true;
  return query.length === 0;
}

/**
 * The best `limit` files for `query`, best first: a name starting with it,
 * then containing it, then a path containing it, then its letters in order.
 * Ties go to files nearer `near` (the document's folder), then shorter paths.
 */
export function rankFiles(paths: string[], query: string, near = "", limit = 50): string[] {
  const q = query.toLowerCase().replace(/\\/g, "/");
  const nearParts = near.split("/").filter(Boolean);
  const distance = (p: string) => {
    const parts = p.split("/").slice(0, -1);
    let shared = 0;
    while (shared < parts.length && shared < nearParts.length && parts[shared] === nearParts[shared]) shared++;
    return parts.length - shared + (nearParts.length - shared);
  };
  const ranked: RankedFile[] = [];
  for (const path of paths) {
    const lower = path.toLowerCase();
    const name = lower.slice(lower.lastIndexOf("/") + 1);
    let score: number;
    if (!q) score = 0;
    else if (name.startsWith(q)) score = 0;
    else if (name.includes(q)) score = 1;
    else if (lower.includes(q)) score = 2;
    else if (subsequence(name, q)) score = 3;
    else if (subsequence(lower, q)) score = 4;
    else continue;
    ranked.push({ path, score });
  }
  ranked.sort((a, b) => a.score - b.score || distance(a.path) - distance(b.path) || a.path.length - b.path.length || a.path.localeCompare(b.path));
  return ranked.slice(0, limit).map((r) => r.path);
}
