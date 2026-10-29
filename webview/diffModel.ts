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

/**
 * Attributes the editor derives from the content (heading anchors, list
 * labels) rather than reads from the file: a block that differs only in
 * those is unchanged.
 */
const DERIVED: Record<string, string[]> = { heading: ["id"], list_item: ["label", "listType"] };

function keyJson(n: ProseNode): unknown {
  const json = n.toJSON() as { attrs?: Record<string, unknown>; content?: unknown[] };
  const drop = DERIVED[n.type.name];
  if (drop && json.attrs) json.attrs = Object.fromEntries(Object.entries(json.attrs).filter(([k]) => !drop.includes(k)));
  if (n.content.size) {
    const children: unknown[] = [];
    n.forEach((c) => children.push(keyJson(c)));
    json.content = children;
  }
  return json;
}

const keyOf = (n: ProseNode) => JSON.stringify(keyJson(n));

/** How alike two blocks' text is: shared words over all words (0…1). */
function similarity(a: ProseNode, b: ProseNode): number {
  const words = (n: ProseNode) => n.textContent.toLowerCase().split(/\s+/).filter(Boolean);
  const wa = words(a);
  const wb = words(b);
  if (!wa.length && !wb.length) return 1;
  const counts = new Map<string, number>();
  for (const w of wa) counts.set(w, (counts.get(w) ?? 0) + 1);
  let shared = 0;
  for (const w of wb) {
    const c = counts.get(w) ?? 0;
    if (c > 0) {
      shared++;
      counts.set(w, c - 1);
    }
  }
  return (2 * shared) / (wa.length + wb.length);
}

/** Blocks this alike (and of the same type) are shown as one block edited. */
const EDIT_THRESHOLD = 0.3;

/**
 * Pair removed and added blocks that are edits of each other: the same type
 * and alike enough, matched in order to make the pairs as alike as possible
 * overall. The rest are wholly removed or added.
 */
function pairRun(removed: ProseNode[], added: ProseNode[], out: BlockEntry[]) {
  const n = removed.length;
  const m = added.length;
  // A huge rewrite: no pairing (each pair costs a word comparison).
  if (n * m > 10_000) {
    for (const node of removed) out.push({ kind: "removed", node });
    for (const node of added) out.push({ kind: "added", node });
    return;
  }
  const score = (i: number, j: number) => {
    const r = removed[i]!;
    const a = added[j]!;
    if (r.type !== a.type) return -1;
    const sim = similarity(r, a);
    return sim >= EDIT_THRESHOLD ? sim : -1;
  };
  // best[i][j]: the best total over removed[i..] and added[j..].
  const best: Float64Array[] = Array.from({ length: n + 1 }, () => new Float64Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      const s = score(i, j);
      best[i]![j] = Math.max(best[i + 1]![j]!, best[i]![j + 1]!, s >= 0 ? s + best[i + 1]![j + 1]! : -Infinity);
    }
  }
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m) {
      const s = score(i, j);
      if (s >= 0 && best[i]![j] === s + best[i + 1]![j + 1]!) {
        out.push({ kind: "removed", node: removed[i]!, pair: added[j]! }, { kind: "added", node: added[j]!, pair: removed[i]! });
        i++;
        j++;
        continue;
      }
      if (best[i]![j] === best[i + 1]![j]) {
        out.push({ kind: "removed", node: removed[i++]! });
        continue;
      }
      out.push({ kind: "added", node: added[j++]! });
      continue;
    }
    if (i < n) out.push({ kind: "removed", node: removed[i++]! });
    else out.push({ kind: "added", node: added[j++]! });
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
export function innerChanges(entry: BlockEntry): { from: number; to: number }[] {
  if (!entry.pair) return [];
  const docType = entry.node.type.schema.topNodeType;
  const [oldNode, newNode] = entry.kind === "removed" ? [entry.node, entry.pair] : [entry.pair, entry.node];
  let changes;
  try {
    changes = computeDocDiff(docType.create(null, oldNode), docType.create(null, newNode), { ignoreAttrs: DERIVED });
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

/** A removed block shown, in the combined view, as a widget before position `pos` of the new document. */
export interface RemovedWidget {
  pos: number;
  entry: BlockEntry;
  /** Text offsets (in the block's text) of the words removed from an edited block. */
  words: [number, number][];
}

/**
 * The combined view: the new document as it is (editable), with the removed
 * blocks shown before the block that follows them.
 */
export function combinedWidgets(entries: BlockEntry[]): RemovedWidget[] {
  const out: RemovedWidget[] = [];
  let pos = 0;
  for (const entry of entries) {
    if (entry.kind === "removed") {
      const doc = entry.node.type.schema.topNodeType.create(null, entry.node);
      const words = innerChanges(entry).map(
        (r) => [doc.textBetween(0, r.from, "", ""), doc.textBetween(0, r.to, "", "")].map((t) => t.length) as [number, number],
      );
      out.push({ pos, entry, words });
    } else pos += entry.node.nodeSize;
  }
  return out;
}

/** A block (or run of changes) of a pane: its anchor and its span in the pane's content, in px. */
export interface AnchorSpan {
  anchor: string;
  top: number;
  bottom: number;
}

/**
 * Where `to` should be scrolled to match `from`: the same point of the same
 * block (or run of changes). A run only one side has maps to the gap where it
 * would be on the other.
 */
export function syncedScrollTop(fromTop: number, from: AnchorSpan[], to: AnchorSpan[]): number | null {
  if (!from.length || !to.length) return null;
  const target = new Map(to.map((s) => [s.anchor, s]));
  let i = from.findIndex((s) => s.bottom > fromTop);
  if (i < 0) i = from.length - 1;
  const here = from[i]!;
  const there = target.get(here.anchor);
  if (there) {
    const ratio = here.bottom > here.top ? Math.min(1, Math.max(0, (fromTop - here.top) / (here.bottom - here.top))) : 0;
    return there.top + ratio * (there.bottom - there.top);
  }
  // Only on this side: hold the other side at the gap, after the last block both share.
  for (let k = i - 1; k >= 0; k--) {
    const shared = target.get(from[k]!.anchor);
    if (shared) return shared.bottom;
  }
  return 0;
}

