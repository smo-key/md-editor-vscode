/**
 * The model behind the diff view: which top-level blocks of a document were
 * kept, removed or added, and the word-level changes inside a block that was
 * edited. Pure ProseMirror, so it is unit-tested directly.
 *
 * Blocks are matched by content (a longest common subsequence over the
 * top-level nodes). Between two kept blocks, removed and added blocks of the
 * same type are paired up as edits of each other: those show what changed
 * inside them (via Milkdown's `computeDocDiff`), the rest are wholly new or
 * wholly gone.
 */
import type { Node as ProseNode } from "@milkdown/kit/prose/model";
import { computeDocDiff } from "@milkdown/kit/plugin/diff";

export type BlockKind = "same" | "removed" | "added";

export interface BlockEntry {
  kind: BlockKind;
  node: ProseNode;
  /** The other half of an edited block: the added block for a removed one, and vice versa. */
  pair?: ProseNode;
}

/** Which blocks the view shows: both versions interleaved, or one side. */
export type DiffSide = "combined" | "old" | "new";

export interface DiffMark {
  from: number;
  to: number;
  /** A whole block (node decoration) or a run of text (inline decoration). */
  block: boolean;
  className: string;
  /**
   * Shared by the two sides of a split view: `s<n>` for the n-th entry when it
   * is unchanged, `c<n>` for the n-th run of changes. Blocks only.
   */
  anchor?: string;
}

export interface DiffLayout {
  nodes: ProseNode[];
  marks: DiffMark[];
  /** Blocks wholly added, wholly removed, and edited (a removed/added pair). */
  added: number;
  removed: number;
  edited: number;
}

function blocksOf(doc: ProseNode): ProseNode[] {
  const out: ProseNode[] = [];
  doc.forEach((n) => out.push(n));
  // Milkdown keeps an empty paragraph at the end to type into: not content.
  while (out.length && out[out.length - 1]!.type.name === "paragraph" && out[out.length - 1]!.content.size === 0) out.pop();
  return out;
}

const keyOf = (n: ProseNode) => JSON.stringify(n.toJSON());

/** Pair removed and added blocks of the same type, in order; the rest stay alone. */
function pairRun(removed: ProseNode[], added: ProseNode[], out: BlockEntry[]) {
  let i = 0;
  let j = 0;
  while (i < removed.length || j < added.length) {
    const r = removed[i];
    const a = added[j];
    if (r && a && r.type === a.type) {
      out.push({ kind: "removed", node: r, pair: a }, { kind: "added", node: a, pair: r });
      i++;
      j++;
    } else if (r && (!a || removed.length - i >= added.length - j)) {
      out.push({ kind: "removed", node: r });
      i++;
    } else {
      out.push({ kind: "added", node: a! });
      j++;
    }
  }
}

/** Above this many cells the LCS table is skipped: everything between is replaced. */
const LCS_LIMIT = 4_000_000;

export function diffBlocks(oldDoc: ProseNode, newDoc: ProseNode): BlockEntry[] {
  const a = blocksOf(oldDoc);
  const b = blocksOf(newDoc);
  const ka = a.map(keyOf);
  const kb = b.map(keyOf);
  let start = 0;
  while (start < a.length && start < b.length && ka[start] === kb[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && ka[endA - 1] === kb[endB - 1]) {
    endA--;
    endB--;
  }
  const out: BlockEntry[] = a.slice(0, start).map((node) => ({ kind: "same" as const, node }));
  const n = endA - start;
  const m = endB - start;
  // ops over the middle: "=" kept, "-" removed, "+" added
  const ops: string[] = [];
  if (n * m > LCS_LIMIT) {
    for (let i = 0; i < n; i++) ops.push("-");
    for (let j = 0; j < m; j++) ops.push("+");
  } else {
    const dp: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        dp[i]![j] = ka[start + i] === kb[start + j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
      }
    }
    let i = 0;
    let j = 0;
    while (i < n || j < m) {
      if (i < n && j < m && ka[start + i] === kb[start + j]) {
        ops.push("=");
        i++;
        j++;
      } else if (j < m && (i >= n || dp[i]![j + 1]! >= dp[i + 1]![j]!)) {
        ops.push("+");
        j++;
      } else {
        ops.push("-");
        i++;
      }
    }
  }
  let i = start;
  let j = start;
  let removed: ProseNode[] = [];
  let added: ProseNode[] = [];
  const flush = () => {
    pairRun(removed, added, out);
    removed = [];
    added = [];
  };
  for (const op of ops) {
    if (op === "=") {
      flush();
      out.push({ kind: "same", node: a[i]! });
      i++;
      j++;
    } else if (op === "-") removed.push(a[i++]!);
    else added.push(b[j++]!);
  }
  flush();
  for (let k = endA; k < a.length; k++) out.push({ kind: "same", node: a[k]! });
  return out;
}

/** The changed runs inside an edited block, in its own coordinates (0 = before the block). */
function innerChanges(entry: BlockEntry): { from: number; to: number }[] {
  if (!entry.pair) return [];
  const docType = entry.node.type.schema.topNodeType;
  const [oldNode, newNode] = entry.kind === "removed" ? [entry.node, entry.pair] : [entry.pair, entry.node];
  let changes;
  try {
    changes = computeDocDiff(docType.create(null, oldNode), docType.create(null, newNode));
  } catch {
    return [];
  }
  return changes
    .map((c) => (entry.kind === "removed" ? { from: c.fromA, to: c.toA } : { from: c.fromB, to: c.toB }))
    .filter((r) => r.to > r.from);
}

/** The blocks a side shows, with the decorations that mark what changed. */
export function layoutDiff(entries: BlockEntry[], side: DiffSide): DiffLayout {
  const nodes: ProseNode[] = [];
  const marks: DiffMark[] = [];
  let pos = 0;
  let added = 0;
  let removed = 0;
  let edited = 0;
  let run = 0;
  let inRun = false;
  entries.forEach((entry, index) => {
    if (entry.pair) {
      if (entry.kind === "added") edited++;
    } else if (entry.kind === "removed") removed++;
    else if (entry.kind === "added") added++;
    if (entry.kind !== "same" && !inRun) run++;
    inRun = entry.kind !== "same";
    if (side === "old" && entry.kind === "added") return;
    if (side === "new" && entry.kind === "removed") return;
    nodes.push(entry.node);
    const anchor = entry.kind === "same" ? `s${index}` : `c${run}`;
    if (entry.kind === "same") marks.push({ from: pos, to: pos + entry.node.nodeSize, block: true, className: "", anchor });
    else {
      const edited = entry.pair ? " ken-diff-edited" : "";
      marks.push({ from: pos, to: pos + entry.node.nodeSize, block: true, className: `ken-diff-${entry.kind}${edited}`, anchor });
      for (const r of innerChanges(entry)) {
        marks.push({ from: pos + r.from, to: pos + r.to, block: false, className: `ken-diff-${entry.kind}-text` });
      }
    }
    pos += entry.node.nodeSize;
  });
  return { nodes, marks, added, removed, edited };
}
