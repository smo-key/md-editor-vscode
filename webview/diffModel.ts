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
import { Fragment, type Node as ProseNode } from "@milkdown/kit/prose/model";
import { computeDocDiff } from "@milkdown/kit/plugin/diff";

export type BlockKind = "same" | "removed" | "added";

export interface BlockEntry {
  kind: BlockKind;
  node: ProseNode;
  /** The other half of an edited block: the added block for a removed one, and vice versa. */
  pair?: ProseNode;
  /** An edited table: which rows and columns were kept, removed and added (shared by both halves). */
  table?: TableDiff;
}

/** A row or column of an edited table: its index in the old table, the new one, or both (kept). */
export interface TableOp {
  old: number | null;
  new: number | null;
}

/** An edited table, row by row and column by column, in the merged order. */
export interface TableDiff {
  rows: TableOp[];
  cols: TableOp[];
}

/** Which blocks the view shows: both versions interleaved, or one side. */
export type DiffSide = "combined" | "old" | "new";

export interface DiffMark {
  from: number;
  to: number;
  /** A whole block (node decoration) or a run of text (inline decoration). */
  block: boolean;
  className: string;
  /** What changed, for a change the text doesn't show (a modified run). */
  title?: string;
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

/** Mark attributes that record how a mark was written, not what it means (a link's syntax). */
const DERIVED_MARKS: Record<string, string[]> = { link: ["form"] };

/** `n` with its marks' derived attributes cleared, so blocks differing only in those compare equal. */
function withoutDerivedMarks(n: ProseNode): ProseNode {
  if (n.isText) {
    const marks = n.marks.map((m) => {
      const drop = DERIVED_MARKS[m.type.name];
      if (!drop || drop.every((k) => m.attrs[k] == null)) return m;
      return m.type.create({ ...m.attrs, ...Object.fromEntries(drop.map((k) => [k, null])) });
    });
    return marks.every((m, i) => m === n.marks[i]) ? n : n.mark(marks);
  }
  if (!n.childCount) return n;
  const children: ProseNode[] = [];
  let changed = false;
  n.forEach((c) => {
    const d = withoutDerivedMarks(c);
    changed ||= d !== c;
    children.push(d);
  });
  return changed ? n.copy(Fragment.from(children)) : n;
}

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

const keyOf = (n: ProseNode) => JSON.stringify(keyJson(withoutDerivedMarks(n)));

/** How alike two blocks' text is: shared words over all words (0…1). */
function similarity(a: ProseNode, b: ProseNode): number {
  // Nested blocks (table cells, list items) are separate words, not run together.
  const words = (n: ProseNode) => n.textBetween(0, n.content.size, " ", " ").toLowerCase().split(/\s+/).filter(Boolean);
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
    if (sim >= EDIT_THRESHOLD) return sim;
    // Two tables whose columns line up are one table edited, however much of it changed.
    return r.type.name === "table" && diffTables(r, a) ? EDIT_THRESHOLD : -1;
  };
  for (const [i, j] of align(n, m, score)) {
    if (i != null && j != null) {
      const r = removed[i]!;
      const a = added[j]!;
      const table = r.type.name === "table" ? diffTables(r, a) : null;
      const extra = table ? { table } : {};
      out.push({ kind: "removed", node: r, pair: a, ...extra }, { kind: "added", node: a, pair: r, ...extra });
    } else if (i != null) out.push({ kind: "removed", node: removed[i]! });
    else out.push({ kind: "added", node: added[j!]! });
  }
}

/**
 * Line up `n` old items with `m` new ones in order, pairing those `score`
 * allows (>= 0) so the pairs score best overall. Unpaired items come out
 * between the pairs, the old ones first.
 */
function align(n: number, m: number, score: (i: number, j: number) => number): [number | null, number | null][] {
  const scores: Float64Array[] = Array.from({ length: n }, (_, i) => Float64Array.from({ length: m }, (_, j) => score(i, j)));
  // best[i][j]: the best total over old[i..] and new[j..].
  const best: Float64Array[] = Array.from({ length: n + 1 }, () => new Float64Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      const s = scores[i]![j]!;
      best[i]![j] = Math.max(best[i + 1]![j]!, best[i]![j + 1]!, s >= 0 ? s + best[i + 1]![j + 1]! : -Infinity);
    }
  }
  const out: [number | null, number | null][] = [];
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m) {
      const s = scores[i]![j]!;
      if (s >= 0 && best[i]![j] === s + best[i + 1]![j + 1]!) {
        out.push([i++, j++]);
        continue;
      }
      if (best[i]![j] === best[i + 1]![j]) {
        out.push([i++, null]);
        continue;
      }
      out.push([null, j++]);
      continue;
    }
    if (i < n) out.push([i++, null]);
    else out.push([null, j++]);
  }
  return out;
}

// --- Tables ----------------------------------------------------------------------

/** A table's cells, row by row (rows may be ragged). */
function gridOf(table: ProseNode): ProseNode[][] {
  const rows: ProseNode[][] = [];
  table.forEach((row) => {
    const cells: ProseNode[] = [];
    row.forEach((c) => cells.push(c));
    rows.push(cells);
  });
  return rows;
}

const cellText = (c: ProseNode | undefined) => (c ? c.textBetween(0, c.content.size, " ", " ").trim().toLowerCase() : "");

/** Above this many row pairs (or column pairs) an edited table is shown as one block, as other blocks are. */
const TABLE_LIMIT = 40_000;

/** A row (or column) pair this alike is one row edited; less alike, one removed and one added. */
const ROW_THRESHOLD = 0.4;

/**
 * Match the rows and columns of two versions of a table: columns by their
 * header and contents, then rows by their cells in the matched columns. The
 * header rows always match. Null when the two have no column in common (the
 * table is then shown as one block edited).
 */
export function diffTables(oldTable: ProseNode, newTable: ProseNode): TableDiff | null {
  const a = gridOf(oldTable);
  const b = gridOf(newTable);
  if (!a.length || !b.length) return null;
  const width = (g: ProseNode[][]) => g.reduce((w, r) => Math.max(w, r.length), 0);
  const na = width(a);
  const nb = width(b);
  if (na * nb > TABLE_LIMIT || a.length * b.length > TABLE_LIMIT) return null;

  // Columns: the same header, or mostly the same cells; position breaks ties when the count is unchanged.
  const column = (g: ProseNode[][], c: number) => g.slice(1).map((r) => cellText(r[c]));
  const colsA = Array.from({ length: na }, (_, c) => column(a, c));
  const colsB = Array.from({ length: nb }, (_, c) => column(b, c));
  const colScore = (i: number, j: number) => {
    const ha = cellText(a[0]![i]);
    const hb = cellText(b[0]![j]);
    const shared = sharedShare(colsA[i]!, colsB[j]!);
    const header = ha === hb ? 1 : wordShare(ha, hb);
    const sim = (header + shared) / 2;
    if ((ha === hb && ha) || sim >= ROW_THRESHOLD) return sim + (na === nb && i === j ? 0.01 : 0);
    return na === nb && i === j ? 0.01 : -1;
  };
  const cols = align(na, nb, colScore).map(([o, n]) => ({ old: o, new: n }));
  const kept = cols.filter((c) => c.old != null && c.new != null);
  if (!kept.length) return null;

  // Rows: how alike their cells in the kept columns are.
  const keysA = a.map((r) => r.map((c) => keyOf(c)));
  const keysB = b.map((r) => r.map((c) => keyOf(c)));
  const rowScore = (i: number, j: number) => {
    let total = 0;
    for (const c of kept) {
      const ca = a[i]![c.old!];
      const cb = b[j]![c.new!];
      if (!ca || !cb) continue;
      total += keysA[i]![c.old!] === keysB[j]![c.new!] ? 1 : 0.9 * similarity(ca, cb);
    }
    const sim = total / kept.length;
    if (sim >= ROW_THRESHOLD) return sim;
    // The same label in the first kept column: the same row, its values changed.
    const first = kept[0]!;
    if (cellText(a[i]![first.old!]) && cellText(a[i]![first.old!]) === cellText(b[j]![first.new!])) return sim + 0.01;
    return a.length === b.length && i === j ? 0.001 : -1;
  };
  const body = align(a.length - 1, b.length - 1, (i, j) => rowScore(i + 1, j + 1));
  const rows: TableOp[] = [{ old: 0, new: 0 }, ...body.map(([o, n]) => ({ old: o == null ? null : o + 1, new: n == null ? null : n + 1 }))];
  return { rows, cols };
}

/** Shared items over all items of two lists (0…1; two empty lists are alike). */
function sharedShare(a: string[], b: string[]): number {
  if (!a.length && !b.length) return 1;
  const counts = new Map<string, number>();
  for (const w of a) counts.set(w, (counts.get(w) ?? 0) + 1);
  let shared = 0;
  for (const w of b) {
    const c = counts.get(w) ?? 0;
    if (c > 0) {
      shared++;
      counts.set(w, c - 1);
    }
  }
  return (2 * shared) / (a.length + b.length);
}

const wordShare = (a: string, b: string) => sharedShare(a.split(/\s+/).filter(Boolean), b.split(/\s+/).filter(Boolean));

/**
 * A changed run inside an edited block. `modified`: its text is the same in
 * both versions, so what changed is hidden (a link's address, an image's
 * source, formatting, a code block's language, a cell's alignment): the view
 * marks it yellow, on both sides, with `title` saying what changed. `node`:
 * the run is a whole node whose attributes changed (no text of its own).
 */
export interface Change {
  from: number;
  to: number;
  modified?: boolean;
  node?: boolean;
  title?: string;
}

const textOf = (doc: ProseNode, from: number, to: number) => doc.textBetween(from, to, "\n", "\uFFFC");

const label = (name: string) => name.replace(/_/g, " ");

function shown(v: unknown): string {
  if (v == null || v === "") return "none";
  const t = typeof v === "string" ? v : JSON.stringify(v);
  return t.length > 80 ? `${t.slice(0, 77)}…` : t;
}

/** The marks and nodes (with their attributes) a run covers. */
function itemsIn(doc: ProseNode, from: number, to: number) {
  const out: { name: string; mark: boolean; attrs: Record<string, unknown> }[] = [];
  doc.nodesBetween(from, Math.max(to, from + 1), (n) => {
    if (n.isText) for (const m of n.marks) out.push({ name: m.type.name, mark: true, attrs: m.attrs });
    else if (n.type !== doc.type) out.push({ name: n.type.name, mark: false, attrs: n.attrs });
  });
  return out;
}

/** What changed in a run whose text didn't: formatting, and attributes such as a link's address. */
function describeChange(a: ProseNode, fa: number, ta: number, b: ProseNode, fb: number, tb: number): string {
  const ia = itemsIn(a, fa, ta);
  const ib = itemsIn(b, fb, tb);
  const parts: string[] = [];
  const marks = (items: typeof ia) => [...new Set(items.filter((x) => x.mark).map((x) => label(x.name)))].sort().join(", ");
  if (marks(ia) !== marks(ib)) parts.push(`Formatting: ${marks(ia) || "none"} → ${marks(ib) || "none"}`);
  const used = new Set<number>();
  for (const x of ia) {
    const k = ib.findIndex((y, i) => !used.has(i) && y.name === x.name && y.mark === x.mark);
    if (k < 0) continue;
    used.add(k);
    const y = ib[k]!;
    const skip = (x.mark ? DERIVED_MARKS : DERIVED)[x.name] ?? [];
    for (const key of new Set([...Object.keys(x.attrs), ...Object.keys(y.attrs)])) {
      if (skip.includes(key) || JSON.stringify(x.attrs[key] ?? null) === JSON.stringify(y.attrs[key] ?? null)) continue;
      parts.push(`${label(x.name)} ${key}: ${shown(x.attrs[key])} → ${shown(y.attrs[key])}`);
    }
  }
  return [...new Set(parts)].join("\n") || "Changed";
}

/**
 * One side's runs of `changes` (between `oldDoc` and `newDoc`), shifted by
 * `offset`: changed text as it is, runs whose text is the same as modified.
 */
function sideChanges(oldDoc: ProseNode, newDoc: ProseNode, isOld: boolean, offset = 0): Change[] {
  let changes;
  try {
    changes = computeDocDiff(oldDoc, newDoc, { ignoreAttrs: DERIVED });
  } catch {
    return [];
  }
  const out: Change[] = [];
  for (const c of changes) {
    const [doc, from, to] = isOld ? [oldDoc, c.fromA, c.toA] : [newDoc, c.fromB, c.toB];
    if (textOf(oldDoc, c.fromA, c.toA) !== textOf(newDoc, c.fromB, c.toB)) {
      if (to > from) out.push({ from: from + offset, to: to + offset });
      continue;
    }
    const title = describeChange(oldDoc, c.fromA, c.toA, newDoc, c.fromB, c.toB);
    if (to > from && textOf(doc, from, to)) {
      out.push({ from: from + offset, to: to + offset, modified: true, title });
      continue;
    }
    // No text of its own: the node it starts at changed (a code block's language, a cell's alignment).
    const node = doc.nodeAt(from);
    if (node && !node.isText) out.push({ from: from + offset, to: from + node.nodeSize + offset, modified: true, node: true, title });
  }
  return out;
}

/** The changed runs inside a cell, against the other version's cell, in the cell's own coordinates (0 = before the cell). */
function cellChanges(cell: ProseNode, other: ProseNode, isOld: boolean): Change[] {
  const docType = cell.type.schema.topNodeType;
  const [oldCell, newCell] = isOld ? [cell, other] : [other, cell];
  return sideChanges(docType.create(null, withoutDerivedMarks(oldCell).content), docType.create(null, withoutDerivedMarks(newCell).content), isOld, 1);
}

/** One cell (or row) of an edited table and how it changed, with its span in the table (0 = before the table). */
interface TablePiece {
  from: number;
  to: number;
  /** A whole row or cell only this version has, or a cell both have that was edited. */
  change: "only" | "edited";
  row: boolean;
  /** For an edited cell: the runs that changed, in table coordinates. */
  words: Change[];
  /** An edited cell whose content is the same (its alignment changed): what changed. */
  modified?: string;
}

/** The rows and cells of one version of an edited table that changed. */
function tablePieces(table: ProseNode, other: ProseNode, diff: TableDiff, isOld: boolean): TablePiece[] {
  const side = isOld ? "old" : "new";
  const otherSide = isOld ? "new" : "old";
  const grid = gridOf(other);
  const rowAt = new Map(diff.rows.filter((r) => r[side] != null).map((r) => [r[side]!, r[otherSide]]));
  const colAt = new Map(diff.cols.filter((c) => c[side] != null).map((c) => [c[side]!, c[otherSide]]));
  const out: TablePiece[] = [];
  table.forEach((row, rowOffset, ri) => {
    const rowStart = rowOffset + 1;
    const otherRow = rowAt.get(ri);
    if (otherRow == null) {
      out.push({ from: rowStart, to: rowStart + row.nodeSize, change: "only", row: true, words: [] });
      return;
    }
    row.forEach((cell, cellOffset, ci) => {
      const from = rowStart + 1 + cellOffset;
      const otherCol = colAt.get(ci);
      const otherCell = otherCol == null ? undefined : grid[otherRow]?.[otherCol];
      if (!otherCell) {
        out.push({ from, to: from + cell.nodeSize, change: "only", row: false, words: [] });
        return;
      }
      if (keyOf(cell) === keyOf(otherCell)) return;
      const words = cellChanges(cell, otherCell, isOld).map((r) => ({ ...r, from: from + r.from, to: from + r.to }));
      const piece: TablePiece = { from, to: from + cell.nodeSize, change: "edited", row: false, words };
      if (!words.length) {
        // The same content: the cell's own attributes changed.
        const doc = cell.type.schema.topNodeType;
        const [a, b] = isOld ? [cell, otherCell] : [otherCell, cell];
        piece.modified = describeChange(doc.create(null, a), 0, 1, doc.create(null, b), 0, 1);
      }
      out.push(piece);
    });
  });
  return out;
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
export function innerChanges(entry: BlockEntry): Change[] {
  if (!entry.pair) return [];
  const docType = entry.node.type.schema.topNodeType;
  const [oldNode, newNode] = entry.kind === "removed" ? [entry.node, entry.pair] : [entry.pair, entry.node];
  return sideChanges(docType.create(null, withoutDerivedMarks(oldNode)), docType.create(null, withoutDerivedMarks(newNode)), entry.kind === "removed");
}

/** The decoration marking a changed run of a block at `pos`, on the side of `kind`. */
export function changeMark(r: Change, pos: number, kind: "added" | "removed"): DiffMark {
  if (!r.modified) return { from: pos + r.from, to: pos + r.to, block: false, className: `ken-diff-${kind}-text` };
  return { from: pos + r.from, to: pos + r.to, block: !!r.node, className: r.node ? "ken-diff-modified" : "ken-diff-modified-text", title: r.title };
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
      const edited = entry.pair ? ` ken-diff-edited${entry.table ? " ken-diff-table" : ""}` : "";
      marks.push({ from: pos, to: pos + entry.node.nodeSize, block: true, className: `ken-diff-${entry.kind}${edited}`, anchor });
      if (entry.table) {
        // An edited table: its own rows, columns and cells that changed.
        for (const p of tablePieces(entry.node, entry.pair!, entry.table, entry.kind === "removed")) {
          const cls = `ken-diff-${entry.kind}-part${p.row ? " ken-diff-row" : ""}${p.change === "edited" ? " ken-diff-cell-edited" : ""}${p.modified ? " ken-diff-modified" : ""}`;
          marks.push({ from: pos + p.from, to: pos + p.to, block: true, className: cls, ...(p.modified ? { title: p.modified } : {}) });
          for (const r of p.words) marks.push(changeMark(r, pos, entry.kind));
        }
      } else {
        for (const r of innerChanges(entry)) marks.push(changeMark(r, pos, entry.kind));
      }
    }
    pos += entry.node.nodeSize;
  });
  return { nodes, marks, added, removed, edited };
}

/**
 * What of an edited table's old version the combined view shows inside the
 * new table: a removed row (`cells` in the merged column order, null where
 * only the new table has the column), a removed column's cell (null in a row
 * only the new table has), or the old content of an edited cell.
 */
export type TablePart =
  | { kind: "row"; cells: (ProseNode | null)[]; header: boolean }
  | { kind: "cell"; cell: ProseNode | null; header: boolean }
  | { kind: "cell-old"; cell: ProseNode };

/** A removed block shown, in the combined view, as a widget before position `pos` of the new document. */
export interface RemovedWidget {
  pos: number;
  entry: BlockEntry;
  /** Text offsets (in the block's text, or the cell's for `cell-old`) of the words removed from an edited block. */
  words: [number, number][];
  /** The same words as positions in the block (0 = before it), with the modified runs. */
  changes?: Change[];
  /** For `cell-old`: which of `words` are modified (the same text, changed otherwise). */
  modified?: boolean[];
  /** The block shown just before this one in the combined view (for the spacing that depends on it). */
  before?: ProseNode;
  /** Set for a piece of an edited table, placed inside the new table; the whole block otherwise. */
  part?: TablePart;
}

/** Text offsets of `ranges` (positions in `doc`). */
const textOffsets = (doc: ProseNode, ranges: Change[]) =>
  ranges.map((r) => [doc.textBetween(0, r.from, "", ""), doc.textBetween(0, r.to, "", "")].map((t) => t.length) as [number, number]);

/** The old table's removed rows, removed columns and edited cells, placed in the new table (which starts at `start`). */
function tableWidgets(entry: BlockEntry, start: number, out: RemovedWidget[]) {
  const diff = entry.table!;
  const oldGrid = gridOf(entry.pair!);
  const newTable = entry.node;
  const isHeader = (row: ProseNode) => row.type.name === "table_header_row";
  const headerOld = (i: number) => entry.pair!.child(i).type.name === "table_header_row";
  const rowStarts: number[] = [];
  let p = start + 1;
  newTable.forEach((row) => {
    rowStarts.push(p);
    p += row.nodeSize;
  });
  const tableEnd = p;
  let next = 0;
  for (const r of diff.rows) {
    const at = r.new != null ? rowStarts[r.new]! : next < rowStarts.length ? rowStarts[next]! : tableEnd;
    if (r.new == null) {
      const cells = diff.cols.map((c) => (c.old == null ? null : (oldGrid[r.old!]![c.old] ?? null)));
      out.push({ pos: at, entry, words: [], part: { kind: "row", cells, header: headerOld(r.old!) } });
      continue;
    }
    next = r.new + 1;
    const row = newTable.child(r.new);
    const cellStarts: number[] = [];
    let q = at + 1;
    row.forEach((cell) => {
      cellStarts.push(q);
      q += cell.nodeSize;
    });
    let nextCell = 0;
    for (const c of diff.cols) {
      if (c.new != null) {
        nextCell = c.new + 1;
        if (r.old == null || c.old == null) continue;
        const cell = oldGrid[r.old]![c.old];
        const now = row.maybeChild(c.new);
        if (!cell || !now || keyOf(cell) === keyOf(now)) continue;
        const doc = cell.type.schema.topNodeType.create(null, cell.content);
        const runs = cellChanges(cell, now, true).filter((x) => !x.node);
        if (!runs.length) continue;
        const words = textOffsets(doc, runs.map((x) => ({ from: x.from - 1, to: x.to - 1 })));
        out.push({ pos: (cellStarts[c.new] ?? q) + 1, entry, words, modified: runs.map((x) => !!x.modified), part: { kind: "cell-old", cell } });
        continue;
      }
      const cell = r.old == null ? null : (oldGrid[r.old]![c.old!] ?? null);
      const pos = nextCell < cellStarts.length ? cellStarts[nextCell]! : q;
      out.push({ pos, entry, words: [], part: { kind: "cell", cell, header: isHeader(row) } });
    }
  }
}

/**
 * The combined view: the new document as it is (editable), with the removed
 * blocks shown before the block that follows them. An edited table shows its
 * removed rows, columns and old cell text inside the new table instead.
 */
export function combinedWidgets(entries: BlockEntry[]): RemovedWidget[] {
  const out: RemovedWidget[] = [];
  let pos = 0;
  let before: ProseNode | undefined;
  for (const entry of entries) {
    if (entry.kind === "removed") {
      if (entry.table) continue;
      const doc = entry.node.type.schema.topNodeType.create(null, entry.node);
      const changes = innerChanges(entry);
      out.push({ pos, entry, words: textOffsets(doc, changes.filter((c) => !c.node && !c.modified)), changes, ...(before ? { before } : {}) });
    } else {
      if (entry.table) tableWidgets(entry, pos, out);
      pos += entry.node.nodeSize;
    }
    before = entry.node;
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

