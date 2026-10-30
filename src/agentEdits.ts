/**
 * Pure text helpers behind keeping and undoing a chat agent's edits one change
 * at a time (no `vscode` import, so vitest covers them).
 *
 * VS Code tracks an agent's edits to a file against the file as it was before
 * them (the "original"). The editor shows those edits block by block; acting
 * on one block means finding the lines of the file it covers, which these
 * functions do with line diffs: original → current file for the agent's
 * changes, and the editor's own Markdown → current file to place a block.
 */
import { minimalChange } from "./sync";

/** A run of changed lines: `[oStart, oEnd)` of the original became `[mStart, mEnd)` of the current text. */
export interface LineHunk {
  oStart: number;
  oEnd: number;
  mStart: number;
  mEnd: number;
}

/** Above this many cells the line LCS is skipped: everything between the common ends is one hunk. */
const LCS_LIMIT = 4_000_000;

/** Pairs of equal lines `[i, j]` (`a[i]` matches `b[j]`), in order, by longest common subsequence. */
function matchLines(a: string[], b: string[], key: (line: string) => string = (l) => l): [number, number][] {
  const ka = a.map(key);
  const kb = b.map(key);
  const pairs: [number, number][] = [];
  let start = 0;
  while (start < ka.length && start < kb.length && ka[start] === kb[start]) {
    pairs.push([start, start]);
    start++;
  }
  let endA = ka.length;
  let endB = kb.length;
  while (endA > start && endB > start && ka[endA - 1] === kb[endB - 1]) {
    endA--;
    endB--;
  }
  const n = endA - start;
  const m = endB - start;
  if (n > 0 && m > 0 && n * m <= LCS_LIMIT) {
    const dp: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        dp[i]![j] = ka[start + i] === kb[start + j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
      }
    }
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (ka[start + i] === kb[start + j]) {
        pairs.push([start + i, start + j]);
        i++;
        j++;
      } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) i++;
      else j++;
    }
  }
  for (let k = 0; k < ka.length - endA; k++) pairs.push([endA + k, endB + k]);
  return pairs;
}

/** The changed line runs between `original` and `current`. */
export function lineHunks(original: string, current: string): LineHunk[] {
  const a = original.split("\n");
  const b = current.split("\n");
  const out: LineHunk[] = [];
  let i = 0;
  let j = 0;
  for (const [pi, pj] of [...matchLines(a, b), [a.length, b.length] as [number, number]]) {
    if (pi > i || pj > j) out.push({ oStart: i, oEnd: pi, mStart: j, mEnd: pj });
    i = pi + 1;
    j = pj + 1;
  }
  return out;
}

/** `current` with the given hunks put back to the original's lines. */
export function revertHunks(original: string, current: string, hunks: LineHunk[]): string {
  const a = original.split("\n");
  const b = current.split("\n");
  const out: string[] = [];
  let j = 0;
  for (const h of [...hunks].sort((x, y) => x.mStart - y.mStart)) {
    out.push(...b.slice(j, h.mStart), ...a.slice(h.oStart, h.oEnd));
    j = h.mEnd;
  }
  out.push(...b.slice(j));
  return out.join("\n");
}

const lineOf = (text: string, offset: number) => {
  let n = 0;
  for (let k = text.indexOf("\n"); k >= 0 && k < offset; k = text.indexOf("\n", k + 1)) n++;
  return n;
};

/** Lines compared loosely when placing the editor's Markdown in the file: it normalises bullets and spacing. */
const looseLine = (line: string) =>
  line
    .trim()
    .replace(/^([*+]|\d+[.)])\s+/, (m) => (/^\d/.test(m) ? "1. " : "- "))
    .replace(/\s+/g, " ");

/**
 * The agent's hunks (original → current) that one block of the editor
 * covers. The editor describes the block by its Markdown with the block
 * (`editor`) and without it (`reverted`, the block put back as it was): the
 * lines those two differ in are placed in the current text and every agent
 * hunk they touch is picked.
 */
export function hunksForBlock(original: string, current: string, editor: string, reverted: string): LineHunk[] {
  const change = minimalChange(editor, reverted);
  if (!change) return [];
  const e = editor.split("\n");
  const m = current.split("\n");
  const first = lineOf(editor, change.start);
  const last = lineOf(editor, Math.max(change.start, change.end - 1));
  // The editor's lines map to the file's by their matching neighbours.
  const pairs = editor === current ? e.map((_, k) => [k, k] as [number, number]) : matchLines(e, m, looseLine);
  let from = 0;
  let to = m.length;
  for (const [ei, mi] of pairs) {
    if (ei < first) from = mi + 1;
    else if (ei > last) {
      to = mi;
      break;
    }
  }
  return lineHunks(original, current).filter((h) =>
    h.mEnd > h.mStart ? h.mStart < to && h.mEnd > from : h.mStart >= from && h.mStart <= to,
  );
}
