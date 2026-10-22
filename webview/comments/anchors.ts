/**
 * Comment ranges in the document: invisible markers around the commented
 * content, written to the Markdown as HTML comments,
 *
 *     Revenue grew <!-- ken:comment c1 -->**12%** in Q3.
 *     | … table … |
 *     <!-- /ken:comment c1 -->
 *
 * so a range can start and end anywhere: inside a paragraph, a heading or a
 * table cell (inline markers), or between blocks (block markers, for ranges
 * that start or end at a table, an image, a diagram or a code block).
 *
 * Keeping the Markdown intact, whatever the edit:
 * - `<!--` at the start of a line opens an HTML block in CommonMark (and
 *   interrupts a paragraph), which would swallow the rest of the line. A
 *   marker is therefore never written at the start of a line: it moves to the
 *   end of the previous line of the same block, or becomes a block marker
 *   before the block.
 * - Markers never go inside code (code blocks, diagrams): ranges snap to the
 *   block's edges.
 * - Deleting content that holds one end of a range puts that end back where
 *   the deletion was (the comment shrinks to what is left); deleting all of a
 *   range's content removes its markers; pasted markers are dropped (they
 *   would duplicate a comment); a reversed range is put right.
 * - The caret and Backspace/Delete step over the invisible markers, so they
 *   are never "stuck" on one.
 */
import type { Node as ProseNode, NodeType, Schema } from "@milkdown/kit/prose/model";
import { Fragment, Slice } from "@milkdown/kit/prose/model";
import { Plugin, PluginKey, TextSelection, type EditorState, type Transaction } from "@milkdown/kit/prose/state";
import { isRemoteChange } from "../remoteChange";
import { Decoration, DecorationSet, type EditorView } from "@milkdown/kit/prose/view";
import type { MarkdownNode, ParserState, SerializerState } from "@milkdown/kit/transformer";
import { $nodeSchema, $prose, $remark } from "@milkdown/kit/utils";

import { threadStore } from "./store";

/** A comment still being written (no message yet) is not written to the file. */
const isDraft = (id: string) => {
  const t = threadStore.get(id);
  return !!t && t.messages.length === 0;
};

export type Edge = "start" | "end";

const MARKER = /^<!--\s*(\/?)ken:comment\s+([\w-]+)\s*-->$/;

export function markerText(id: string, edge: Edge): string {
  return edge === "start" ? `<!-- ken:comment ${id} -->` : `<!-- /ken:comment ${id} -->`;
}

export function parseMarker(value: unknown): { id: string; edge: Edge } | null {
  if (typeof value !== "string") return null;
  const m = MARKER.exec(value.trim());
  return m ? { id: m[2]!, edge: m[1] ? "end" : "start" } : null;
}

// ---------------------------------------------------------------------------
// Markdown <-> mdast
// ---------------------------------------------------------------------------

interface MdNode {
  type: string;
  value?: string;
  id?: string;
  edge?: Edge;
  children?: MdNode[];
}

/** Turn marker HTML into `commentAnchor` (inline) / `commentBlockAnchor` (top level). */
export function transformMarkers(node: MdNode, isRoot = true): void {
  const children = node.children;
  if (!Array.isArray(children)) return;
  for (let i = 0; i < children.length; i++) {
    const child = children[i]!;
    let marker = child.type === "html" ? parseMarker(child.value) : null;
    // Block-level HTML may come wrapped in a paragraph of its own.
    if (!marker && child.type === "paragraph" && child.children?.length === 1 && child.children[0]!.type === "html") {
      marker = parseMarker(child.children[0]!.value);
      if (marker && !isRoot) {
        children[i] = { type: "html", value: child.children[0]!.value };
        i--;
        continue;
      }
    }
    if (marker) {
      const isBlock = child.type === "paragraph" || (isRoot && child.type === "html");
      if (isBlock && isRoot) {
        children[i] = { type: "commentBlockAnchor", id: marker.id, edge: marker.edge };
      } else if (child.type === "html" && !isBlockLevel(node)) {
        children[i] = { type: "commentAnchor", id: marker.id, edge: marker.edge };
      } else {
        // A block-level marker inside a list item or quote: attach it to the
        // neighbouring text (start: next paragraph; end: previous one).
        const anchor: MdNode = { type: "commentAnchor", id: marker.id, edge: marker.edge };
        const target =
          marker.edge === "start"
            ? children.slice(i + 1).find((c) => Array.isArray(c.children) && /paragraph|heading/.test(c.type))
            : [...children.slice(0, i)].reverse().find((c) => Array.isArray(c.children) && /paragraph|heading/.test(c.type));
        if (target) {
          if (marker.edge === "start") target.children!.unshift(anchor);
          else target.children!.push(anchor);
        }
        children.splice(i, 1);
        i--;
      }
      continue;
    }
    transformMarkers(child, false);
  }
}

/** Nodes whose children are blocks (so an HTML child there is block-level). */
function isBlockLevel(node: MdNode): boolean {
  return /^(root|listItem|blockquote|list|githubAlert|footnoteDefinition)$/.test(node.type);
}

export const remarkCommentMarkers = $remark("kenCommentMarkers", () => (() => (tree: MdNode) => transformMarkers(tree)) as never);

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const anchorAttrs = { id: { default: "" }, edge: { default: "start" } };

export const commentAnchorSchema = $nodeSchema("comment_anchor", () => ({
  group: "inline",
  inline: true,
  atom: true,
  selectable: false,
  draggable: false,
  attrs: anchorAttrs,
  parseDOM: [
    {
      tag: "span[data-comment-anchor]",
      getAttrs: (dom: HTMLElement) => ({ id: dom.dataset.commentAnchor ?? "", edge: dom.dataset.edge ?? "start" }),
    },
  ],
  toDOM: (node: ProseNode) => [
    "span",
    { class: "ken-c-anchor", "data-comment-anchor": node.attrs.id, "data-edge": node.attrs.edge, contenteditable: "false" },
  ],
  parseMarkdown: {
    match: (node: MarkdownNode) => node.type === "commentAnchor",
    runner: (state: ParserState, node: MarkdownNode, type: NodeType) => {
      state.addNode(type, { id: node.id, edge: node.edge });
    },
  },
  toMarkdown: {
    match: (node: ProseNode) => node.type.name === "comment_anchor",
    runner: (state: SerializerState, node: ProseNode) => {
      if (!isDraft(node.attrs.id)) state.addNode("html", undefined, markerText(node.attrs.id, node.attrs.edge));
    },
  },
}));

export const commentBlockAnchorSchema = $nodeSchema("comment_block_anchor", () => ({
  group: "block",
  atom: true,
  selectable: false,
  draggable: false,
  attrs: anchorAttrs,
  parseDOM: [
    {
      tag: "div[data-comment-anchor]",
      getAttrs: (dom: HTMLElement) => ({ id: dom.dataset.commentAnchor ?? "", edge: dom.dataset.edge ?? "start" }),
    },
  ],
  toDOM: (node: ProseNode) => [
    "div",
    { class: "ken-c-block-anchor", "data-comment-anchor": node.attrs.id, "data-edge": node.attrs.edge, contenteditable: "false" },
  ],
  parseMarkdown: {
    match: (node: MarkdownNode) => node.type === "commentBlockAnchor",
    runner: (state: ParserState, node: MarkdownNode, type: NodeType) => {
      state.addNode(type, { id: node.id, edge: node.edge });
    },
  },
  toMarkdown: {
    match: (node: ProseNode) => node.type.name === "comment_block_anchor",
    runner: (state: SerializerState, node: ProseNode) => {
      if (!isDraft(node.attrs.id)) state.addNode("html", undefined, markerText(node.attrs.id, node.attrs.edge));
    },
  },
}));

// ---------------------------------------------------------------------------
// Reading ranges
// ---------------------------------------------------------------------------

export interface Anchor {
  id: string;
  edge: Edge;
  pos: number;
  inline: boolean;
}

const isAnchor = (node: ProseNode | null | undefined) =>
  !!node && (node.type.name === "comment_anchor" || node.type.name === "comment_block_anchor");

export function collectAnchors(doc: ProseNode): Anchor[] {
  const out: Anchor[] = [];
  doc.descendants((node, pos) => {
    if (isAnchor(node)) {
      out.push({ id: node.attrs.id, edge: node.attrs.edge, pos, inline: node.isInline });
      return false;
    }
    return true;
  });
  return out;
}

export interface CommentRange {
  id: string;
  /** Position of the start marker, and of the end marker. */
  from: number;
  to: number;
}

/** Complete ranges (both markers present), in document order. */
export function commentRanges(doc: ProseNode): CommentRange[] {
  const starts = new Map<string, number>();
  const ranges: CommentRange[] = [];
  for (const a of collectAnchors(doc)) {
    if (a.edge === "start") starts.set(a.id, a.pos);
    else if (starts.has(a.id)) ranges.push({ id: a.id, from: starts.get(a.id)!, to: a.pos });
  }
  return ranges.sort((a, b) => a.from - b.from);
}

/** Ids of the comments in the document, in document order. */
export function commentIds(doc: ProseNode): string[] {
  return commentRanges(doc).map((r) => r.id);
}

// ---------------------------------------------------------------------------
// Placing markers
// ---------------------------------------------------------------------------

function types(schema: Schema) {
  return { inline: schema.nodes.comment_anchor!, block: schema.nodes.comment_block_anchor! };
}

/** Is `pos` inside text where an inline marker may go (not code)? */
function inlineOk(doc: ProseNode, pos: number): boolean {
  const $p = doc.resolve(pos);
  const parent = $p.parent;
  if (!parent.inlineContent || parent.type.spec.code) return false;
  return parent.canReplaceWith($p.index(), $p.index(), doc.type.schema.nodes.comment_anchor!);
}

/**
 * Insert a marker at (or as near as allowed to) `pos`: inline in text, else a
 * block marker at the top level — before the top-level block for a start,
 * after it for an end. Returns the position used.
 */
export function insertMarker(tr: Transaction, pos: number, id: string, edge: Edge): number {
  const { inline, block } = types(tr.doc.type.schema);
  const clamped = Math.max(0, Math.min(pos, tr.doc.content.size));
  if (inlineOk(tr.doc, clamped)) {
    tr.insert(clamped, inline.create({ id, edge }));
    return clamped;
  }
  const $p = tr.doc.resolve(clamped);
  const at = $p.depth === 0 ? clamped : edge === "start" ? $p.before(1) : $p.after(1);
  tr.insert(at, block.create({ id, edge }));
  return at;
}

/** Wrap the selection (or the current block, when nothing is selected) in a new comment. */
export function addCommentRange(state: EditorState, id: string): Transaction | null {
  const { selection, doc } = state;
  let { from, to } = selection;
  if (selection.empty) {
    const $f = selection.$from;
    if ($f.depth === 0) return null;
    from = $f.start($f.depth);
    to = $f.end($f.depth);
    if (from === to) return null;
  }
  // Ranges inside code snap out to the code block's edges.
  const $from = doc.resolve(from);
  const $to = doc.resolve(to);
  if ($from.parent.type.spec.code) from = $from.before($from.depth);
  if ($to.parent.type.spec.code) to = $to.after($to.depth);
  const tr = state.tr;
  insertMarker(tr, to, id, "end");
  insertMarker(tr, from, id, "start");
  return tr.setMeta(key, { touched: true });
}

/** Remove a comment's markers (the thread itself is the store's). */
export function removeCommentRange(state: EditorState, id: string): Transaction | null {
  const anchors = collectAnchors(state.doc).filter((a) => a.id === id);
  if (!anchors.length) return null;
  const tr = state.tr;
  for (const a of anchors.reverse()) tr.delete(a.pos, a.pos + 1);
  return tr.setMeta(key, { removed: id });
}

// ---------------------------------------------------------------------------
// Keeping markers valid
// ---------------------------------------------------------------------------

/** The innermost textblock containing `pos` and its top-level block index. */
function topIndex(doc: ProseNode, pos: number): number {
  return doc.resolve(pos).index(0);
}

/** End position of the last text line before `pos` inside the same top-level block, if any. */
function previousLineEnd(doc: ProseNode, pos: number): number | null {
  const top = topIndex(doc, pos);
  let best: number | null = null;
  doc.nodesBetween(0, pos, (node, p) => {
    if (node.isTextblock) {
      const end = p + node.nodeSize - 1;
      if (end < pos && !node.type.spec.code && topIndex(doc, p + 1) === top) best = end;
      return false;
    }
    return true;
  });
  return best;
}

/** Is the inline marker at `pos` at the start of a Markdown line (where `<!--` would open an HTML block)? */
function atLineStart(doc: ProseNode, pos: number): "start" | "afterBreak" | null {
  const $p = doc.resolve(pos);
  // Table cells are inline content of a table row line: never a line start.
  const cell = $p.depth >= 2 ? $p.node($p.depth - 1).type.name : "";
  if (cell === "table_cell" || cell === "table_header") return null;
  // "# " comes first on a heading's line.
  if ($p.parent.type.name === "heading") return null;
  // Only other markers (or nothing) before it on the line?
  let i = $p.index();
  while (i > 0) {
    const before = $p.parent.child(i - 1);
    if (isAnchor(before)) {
      i--;
      continue;
    }
    return /^hard_?break$/.test(before.type.name) ? "afterBreak" : null;
  }
  return "start";
}

/** Position of the line break before the marker at `pos` (skipping other markers). */
function breakBefore(doc: ProseNode, pos: number): number {
  let p = pos;
  for (;;) {
    const before = doc.resolve(p).nodeBefore;
    if (!before) return p;
    p -= before.nodeSize;
    if (!isAnchor(before)) return p;
  }
}

/** One fix for the document's markers, or null when they are all valid. */
export function normalizeMarkers(state: EditorState): Transaction | null {
  const { doc } = state;
  const anchors = collectAnchors(doc);
  const byId = new Map<string, Anchor[]>();
  for (const a of anchors) byId.set(a.id, [...(byId.get(a.id) ?? []), a]);

  for (const [id, list] of byId) {
    const starts = list.filter((a) => a.edge === "start");
    const ends = list.filter((a) => a.edge === "end");
    // Duplicates (e.g. text copied within the document): keep the first of each.
    const extra = [...starts.slice(1), ...ends.slice(1)];
    if (extra.length) {
      const tr = state.tr;
      for (const a of extra.sort((x, y) => y.pos - x.pos)) tr.delete(a.pos, a.pos + 1);
      return tr.setMeta(key, { normalized: true });
    }
    const s = starts[0];
    const e = ends[0];
    if (s && e && e.pos < s.pos) {
      // Reversed: swap the two.
      const tr = state.tr;
      tr.setNodeMarkup(s.pos, undefined, { id, edge: "end" });
      tr.setNodeMarkup(e.pos, undefined, { id, edge: "start" });
      return tr.setMeta(key, { normalized: true });
    }
    if (s && e) {
      // Nothing left between them: the commented content is gone.
      const between = doc.slice(s.pos + 1, e.pos).content;
      let content = false;
      between.descendants((n) => {
        if (content) return false;
        if (isAnchor(n)) return false;
        if (n.isText || n.isLeaf || n.type.spec.code || (n.isBlock && n.isAtom)) content = true;
        return !content;
      });
      if (!content) {
        const tr = state.tr;
        tr.delete(e.pos, e.pos + 1);
        tr.delete(s.pos, s.pos + 1);
        return tr.setMeta(key, { emptied: id });
      }
    }
  }

  // A marker at the start of a Markdown line would break that line: move it.
  for (const a of anchors) {
    if (!a.inline) continue;
    const where = atLineStart(doc, a.pos);
    if (!where) continue;
    const tr = state.tr;
    if (where === "afterBreak") {
      // Before the line break instead (the same place in the text).
      const at = breakBefore(doc, a.pos);
      tr.delete(a.pos, a.pos + 1);
      tr.insert(at, types(doc.type.schema).inline.create({ id: a.id, edge: a.edge }));
      return tr.setMeta(key, { normalized: true });
    }
    tr.delete(a.pos, a.pos + 1);
    const prev = previousLineEnd(tr.doc, a.pos);
    if (prev !== null) tr.insert(prev, types(doc.type.schema).inline.create({ id: a.id, edge: a.edge }));
    else {
      const $p = tr.doc.resolve(a.pos);
      tr.insert($p.before(1), types(doc.type.schema).block.create({ id: a.id, edge: a.edge }));
    }
    return tr.setMeta(key, { normalized: true });
  }
  return null;
}

/**
 * Put back an end of a range that an edit deleted while the other end
 * survived: at the place the deletion happened, so the comment covers what is
 * left of its content.
 */
function restoreLostEdges(trs: readonly Transaction[], oldState: EditorState, newState: EditorState): Transaction | null {
  // A comment being deleted on purpose is not restored.
  if (trs.some((tr) => tr.getMeta(key)?.removed)) return null;
  const before = collectAnchors(oldState.doc);
  if (!before.length) return null;
  const after = collectAnchors(newState.doc);
  const has = (id: string, edge: Edge) => after.some((a) => a.id === id && a.edge === edge);
  const lost = before.filter((a) => !has(a.id, a.edge) && has(a.id, a.edge === "start" ? "end" : "start"));
  if (!lost.length) return null;
  const tr = newState.tr;
  for (const a of lost) {
    let pos = a.pos;
    for (const t of trs) pos = t.mapping.map(pos, a.edge === "start" ? 1 : -1);
    insertMarker(tr, tr.mapping.map(pos), a.id, a.edge);
  }
  return tr.setMeta(key, { restored: true }).setMeta("addToHistory", true);
}

/** Drop markers from pasted content: they would duplicate a comment. */
function stripMarkers(fragment: Fragment): Fragment {
  const nodes: ProseNode[] = [];
  fragment.forEach((node) => {
    if (isAnchor(node)) return;
    nodes.push(node.isLeaf ? node : node.copy(stripMarkers(node.content)));
  });
  return Fragment.from(nodes);
}

// ---------------------------------------------------------------------------
// Caret and deletion around the invisible markers
// ---------------------------------------------------------------------------

function skip(doc: ProseNode, pos: number, dir: -1 | 1): number {
  let p = pos;
  for (;;) {
    const $p = doc.resolve(p);
    const next = dir < 0 ? $p.nodeBefore : $p.nodeAfter;
    if (next && next.type.name === "comment_anchor") p += dir;
    else return p;
  }
}

function handleKey(view: EditorView, event: KeyboardEvent): boolean {
  const { state } = view;
  const sel = state.selection;
  if (!sel.empty || event.metaKey || event.ctrlKey || event.altKey) return false;
  const $c = sel.$from;
  const dir = event.key === "ArrowLeft" || event.key === "Backspace" ? -1 : event.key === "ArrowRight" || event.key === "Delete" ? 1 : 0;
  if (!dir) return false;
  const adjacent = dir < 0 ? $c.nodeBefore : $c.nodeAfter;
  if (!adjacent || adjacent.type.name !== "comment_anchor") return false;
  const past = skip(state.doc, $c.pos, dir);
  const $past = state.doc.resolve(past);
  const inLine = dir < 0 ? past > $past.start() : past < $past.end();
  if (event.key.startsWith("Arrow")) {
    if (event.shiftKey) return false;
    const target = inLine ? past + dir : past;
    view.dispatch(state.tr.setSelection(TextSelection.create(state.doc, target)));
    return true;
  }
  // Backspace / Delete: remove the character beyond the marker(s), not them.
  if (!inLine) {
    // At the edge of the block: move past the markers and let the default
    // (joining blocks) happen from there.
    view.dispatch(state.tr.setSelection(TextSelection.create(state.doc, past)));
    return false;
  }
  const from = dir < 0 ? past - 1 : past;
  const tr = state.tr.delete(from, from + 1);
  view.dispatch(tr.scrollIntoView());
  return true;
}

// ---------------------------------------------------------------------------
// Highlights
// ---------------------------------------------------------------------------

export interface HighlightOptions {
  /** Whether a thread is resolved (resolved comments are not highlighted). */
  isResolved: (id: string) => boolean;
  /** Whether a thread has any messages (a new, empty one is still shown). */
  exists: (id: string) => boolean;
}

export const key = new PluginKey<{ active: string | null; decorations: DecorationSet }>("ken-comments");

function decorate(doc: ProseNode, active: string | null, opts: HighlightOptions): DecorationSet {
  const decos: Decoration[] = [];
  for (const r of commentRanges(doc)) {
    if (opts.isResolved(r.id) || !opts.exists(r.id)) continue;
    const cls = r.id === active ? "ken-comment ken-comment-active" : "ken-comment";
    const attrs = { class: cls, "data-comment": r.id };
    doc.nodesBetween(r.from, r.to, (node, pos) => {
      const end = pos + node.nodeSize;
      if (node.isTextblock && !node.type.spec.code) {
        const from = Math.max(r.from, pos + 1);
        const to = Math.min(r.to, end - 1);
        if (to > from) decos.push(Decoration.inline(from, to, attrs));
        return false;
      }
      if (node.isBlock && (node.isAtom || node.type.spec.code || node.type.name === "table")) {
        if (pos >= r.from && end <= r.to && !isAnchor(node)) {
          decos.push(Decoration.node(pos, end, { class: `${cls}-block`, "data-comment": r.id }));
          return false;
        }
        return node.type.name === "table";
      }
      return true;
    });
  }
  return DecorationSet.create(doc, decos);
}

/** Ask the highlights to redraw (after a thread changed), optionally focusing one. */
export function refreshComments(view: EditorView, active?: string | null): void {
  view.dispatch(view.state.tr.setMeta(key, { refresh: true, active }).setMeta("addToHistory", false));
}

export function activeComment(state: EditorState): string | null {
  return key.getState(state)?.active ?? null;
}

/** The comment the caret is in, if any (innermost). */
export function commentAt(state: EditorState, pos: number): string | null {
  let found: CommentRange | null = null;
  for (const r of commentRanges(state.doc)) {
    if (pos > r.from && pos <= r.to && (!found || r.from >= found.from)) found = r;
  }
  return found?.id ?? null;
}

export function commentPlugins(opts: HighlightOptions, onActivate: (id: string | null) => void) {
  return $prose(
    () =>
      new Plugin<{ active: string | null; decorations: DecorationSet }>({
        key,
        state: {
          init: (_c, state) => ({ active: null, decorations: decorate(state.doc, null, opts) }),
          apply(tr, prev, _old, state) {
            const meta = tr.getMeta(key) as { refresh?: boolean; active?: string | null } | undefined;
            const active = meta && "active" in meta && meta.active !== undefined ? meta.active : prev.active;
            if (tr.docChanged || meta?.refresh || active !== prev.active) {
              return { active, decorations: decorate(state.doc, active, opts) };
            }
            return prev;
          },
        },
        appendTransaction(trs, oldState, newState) {
          // Someone else's change arrives already normalized by their editor.
          if (!trs.some((tr) => tr.docChanged) || isRemoteChange(trs)) return null;
          return restoreLostEdges(trs, oldState, newState) ?? normalizeMarkers(newState);
        },
        props: {
          decorations: (state) => key.getState(state)?.decorations,
          transformPasted: (slice) => new Slice(stripMarkers(slice.content), slice.openStart, slice.openEnd),
          handleKeyDown: handleKey,
          handleClick: (view, pos, event) => {
            // Extending a selection is not "open this comment".
            if (event.shiftKey || event.detail > 1) return false;
            const target = (event.target as Element | null)?.closest?.("[data-comment]");
            const id = target?.getAttribute("data-comment") ?? commentAt(view.state, pos);
            // After the editor has finished handling the click itself.
            if (id && !opts.isResolved(id)) setTimeout(() => view.state.selection.empty && onActivate(id), 0);
            return false;
          },
        },
      }),
  );
}

export const commentSchemas = [remarkCommentMarkers, commentAnchorSchema, commentBlockAnchorSchema].flat();
