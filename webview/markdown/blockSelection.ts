/**
 * Selecting whole blocks: images, tables, diagrams, code and math blocks,
 * rules and raw HTML ("opaque" blocks: the browser draws no text highlight
 * over them, or they hold an editor of their own).
 *
 * - Every opaque block a selection reaches is highlighted as a whole, also
 *   when the selection only starts or ends inside it, so what is selected is
 *   visible (the native highlight only covers text).
 * - What is highlighted is what Backspace, Delete or typing removes: a
 *   selection that starts or ends inside such a block takes the whole block,
 *   never half a table.
 * - Shift+Arrow from text steps over an opaque block in one go instead of
 *   entering it (into a table cell, where the table's own keys turned the
 *   selection into a cell selection and dropped where it started, or into a
 *   code block's own editor). From a cell selection at the table's edge it
 *   carries on past the table.
 * - Shift+click extends the selection by whole blocks when the click, or the
 *   selection's start, is in an image, diagram, code or math block, rule or
 *   raw HTML. A click in a table cell ends the range in that cell.
 *
 * Only selections change here, plus the edits the user asks for; remote
 * collaboration transactions are never touched.
 */
import type { Node as ProseNode, ResolvedPos } from "@milkdown/kit/prose/model";
import { keydownHandler } from "@milkdown/kit/prose/keymap";
import {
  AllSelection,
  type Command,
  type EditorState,
  type Transaction,
  Plugin,
  PluginKey,
  Selection,
  TextSelection,
} from "@milkdown/kit/prose/state";
import { CellSelection, nextCell } from "@milkdown/kit/prose/tables";
import { Decoration, DecorationSet, type EditorView } from "@milkdown/kit/prose/view";
import { editorViewOptionsCtx } from "@milkdown/kit/core";
import type { Ctx } from "@milkdown/kit/ctx";
import { $prose, $view } from "@milkdown/kit/utils";
import { isRemoteChange } from "../remoteChange";
import { TableNodeView } from "@milkdown/kit/component/table-block";
import { tableSchema } from "@milkdown/kit/preset/gfm";

export const BLOCK_SELECTED_CLASS = "ken-block-selected";

/** Invisible comment markers (comments/anchors.ts) are never highlighted. */
const INVISIBLE = new Set(["comment_anchor", "comment_block_anchor", "hardbreak"]);

/** A block drawn as a unit rather than as selectable text. */
export function isOpaqueBlock(node: ProseNode): boolean {
  if (!node.isBlock || INVISIBLE.has(node.type.name)) return false;
  return node.isAtom || !!node.type.spec.code || node.type.name === "table";
}

/** An inline object (image, formula) the text highlight doesn't cover. */
function isOpaqueInline(node: ProseNode): boolean {
  return node.isInline && node.isLeaf && !node.isText && !INVISIBLE.has(node.type.name);
}

interface Span {
  from: number;
  to: number;
}

function isTable(node: ProseNode): boolean {
  return node.type.name === "table";
}

/** The outermost opaque block (or, without tables, atom or code block) that `$pos` lies inside, if any. */
function opaqueAround($pos: ResolvedPos, { tables = true } = {}): Span | null {
  for (let d = 1; d <= $pos.depth; d++) {
    const node = $pos.node(d);
    if (isOpaqueBlock(node) && (tables || !isTable(node))) return { from: $pos.before(d), to: $pos.after(d) };
  }
  return null;
}

/**
 * A range widened so that an end inside an opaque block that the range also
 * leaves takes the whole block.
 */
export function expandRange(doc: ProseNode, from: number, to: number): Span {
  const a = opaqueAround(doc.resolve(from));
  if (a && to > a.to - 1) from = a.from;
  const b = opaqueAround(doc.resolve(to));
  if (b && from < b.from + 1) to = b.to;
  return { from, to };
}

/**
 * A text position just across the block boundary at `pos` in direction
 * `dir`, when the next thing that way is ordinary text (entering only
 * wrappers such as list items and quotes on the way): the selection then
 * ends where a caret could go. Null otherwise.
 */
function textInside(doc: ProseNode, pos: number, dir: 1 | -1): number | null {
  let $p = doc.resolve(pos);
  for (;;) {
    const node = dir > 0 ? $p.nodeAfter : $p.nodeBefore;
    if (!node) return null;
    if (node.isTextblock) return node.type.spec.code ? null : dir > 0 ? $p.pos + 1 : $p.pos - 1;
    if (node.isAtom || isOpaqueBlock(node) || node.isInline) return null;
    $p = doc.resolve(dir > 0 ? $p.pos + 1 : $p.pos - 1);
  }
}

/** Where a selection end at `pos` sits, given which way it points outward. */
function settle(doc: ProseNode, pos: number, outward: 1 | -1): number {
  const $p = doc.resolve(pos);
  if ($p.parent.inlineContent) return pos;
  return textInside(doc, pos, outward) ?? textInside(doc, pos, (-outward) as 1 | -1) ?? pos;
}

/**
 * A range selection from `anchor` to `head` that takes whole opaque blocks
 * at either end, ending in text where it can. Covers the whole document as
 * an AllSelection.
 */
export function blockRangeSelection(doc: ProseNode, anchor: number, head: number): Selection {
  const forward = head >= anchor;
  const span = expandRange(doc, Math.min(anchor, head), Math.max(anchor, head));
  if (span.from <= 0 && span.to >= doc.content.size) return new AllSelection(doc);
  let from = span.from;
  let to = span.to;
  // An end on a block boundary moves into the text just outside the range
  // (the end of the paragraph before, the start of the one after), never
  // into another block; else into the text just inside it.
  from = settle(doc, from, -1);
  to = settle(doc, to, 1);
  const [a, h] = forward ? [from, to] : [to, from];
  return TextSelection.create(doc, a, h);
}

/** Whether an opaque block lies wholly within `from`..`to`. */
function coversBlock(doc: ProseNode, from: number, to: number): boolean {
  let found = false;
  doc.nodesBetween(from, to, (node, pos) => {
    if (found) return false;
    if (isOpaqueBlock(node) && pos >= from && pos + node.nodeSize <= to) found = true;
    return !found;
  });
  return found;
}

/**
 * What deleting the selection removes, when that differs from ProseMirror's
 * own deletion: whole blocks at its ends, and, for a selection running from
 * the end of one paragraph to the start of another over blocks, only the
 * blocks (the paragraphs on either side stay apart, as they look).
 */
export function deletionRange(state: EditorState): Span | null {
  const sel = state.selection;
  if (sel.empty || sel instanceof CellSelection || sel instanceof AllSelection) return null;
  const doc = state.doc;
  let { from, to } = expandRange(doc, sel.from, sel.to);
  if (!coversBlock(doc, from, to)) return null;
  const $from = doc.resolve(from);
  const $to = doc.resolve(to);
  if ($from.parent.isTextblock && $from.parentOffset === $from.parent.content.size && $to.parent.isTextblock && $to.parentOffset === 0) {
    const after = $from.after();
    const before = $to.before();
    if (after <= before) ({ from, to } = { from: after, to: before });
  }
  return from === sel.from && to === sel.to ? null : { from, to };
}

/**
 * Delete `span` and put a text caret where the selection's text survives:
 * at its start when that was in text that stays, else at its end (the rest
 * of that paragraph). Never a node selection: typing would then replace the
 * image or rule before the gap. `caret` is false when neither end survives
 * (the caller decides: typing starts a paragraph in the gap, deleting moves
 * to the nearest text).
 */
function deleteSpan(state: EditorState, span: Span): { tr: Transaction; caret: boolean } {
  const { from, to, $from, $to } = state.selection;
  // An end of the selection in text that the deletion leaves standing.
  const nearSurvives = $from.parent.inlineContent && from <= span.from;
  const farSurvives = $to.parent.inlineContent && to >= span.to;
  const tr = state.tr.delete(span.from, span.to);
  const inText = (pos: number) => (tr.doc.resolve(pos).parent.inlineContent ? pos : null);
  const at = (nearSurvives ? inText(tr.mapping.map(from, -1)) : null) ?? (farSurvives ? inText(tr.mapping.map(to, 1)) : null);
  if (at !== null) {
    tr.setSelection(TextSelection.create(tr.doc, at));
    return { tr, caret: true };
  }
  return { tr, caret: false };
}

/** Delete `span`, leaving a text caret even where no text is beside the gap. */
function deleteSpanToCaret(state: EditorState, span: Span): Transaction {
  const { tr, caret } = deleteSpan(state, span);
  if (caret) return tr;
  const gap = tr.mapping.map(span.from, -1);
  const found = TextSelection.findFrom(tr.doc.resolve(gap), -1, true) ?? TextSelection.findFrom(tr.doc.resolve(gap), 1, true);
  if (found) return tr.setSelection(found);
  tr.insert(gap, state.schema.nodes.paragraph.create());
  return tr.setSelection(TextSelection.create(tr.doc, gap + 1));
}

/** Delete `span` and type `text` where the caret lands, in a new paragraph if no text is beside the gap. */
function replaceSpanWithText(state: EditorState, span: Span, text: string): Transaction {
  const { tr, caret } = deleteSpan(state, span);
  if (caret) return tr.insertText(text);
  const gap = tr.mapping.map(span.from, -1);
  tr.insert(gap, state.schema.nodes.paragraph.create(null, state.schema.text(text)));
  return tr.setSelection(TextSelection.create(tr.doc, gap + 1 + text.length));
}

function decorations(state: EditorState): DecorationSet {
  const sel = state.selection;
  if (sel.empty || sel instanceof CellSelection) return DecorationSet.empty;
  const { from, to } = expandRange(state.doc, sel.from, sel.to);
  const decos: Decoration[] = [];
  const attrs = { class: BLOCK_SELECTED_CLASS };
  state.doc.nodesBetween(from, to, (node, pos) => {
    const end = pos + node.nodeSize;
    if (end <= from || pos >= to) return false;
    if (isOpaqueBlock(node)) {
      // Entirely within one block (text in a code block, a cell): that
      // block's own selection shows it.
      if (from > pos && to < end) return true;
      decos.push(Decoration.node(pos, end, attrs));
      return false;
    }
    if (isOpaqueInline(node) && pos >= from && end <= to) decos.push(Decoration.node(pos, end, attrs));
    return true;
  });
  return DecorationSet.create(state.doc, decos);
}

/** The node right across the end of `$pos`'s text block, climbing out of wrappers. */
function blockAcross(doc: ProseNode, $pos: ResolvedPos, dir: 1 | -1): Span | null {
  let pos = dir > 0 ? $pos.after() : $pos.before();
  for (;;) {
    const $p = doc.resolve(pos);
    const node = dir > 0 ? $p.nodeAfter : $p.nodeBefore;
    if (node) return isOpaqueBlock(node) ? (dir > 0 ? { from: pos, to: pos + node.nodeSize } : { from: pos - node.nodeSize, to: pos }) : null;
    if ($p.depth === 0) return null;
    pos = dir > 0 ? $p.after() : $p.before();
  }
}

function atTextblockEdge(view: EditorView | undefined, $head: ResolvedPos, key: Arrow): boolean {
  const dir = DIR[key];
  const offsetEdge = dir > 0 ? $head.parentOffset === $head.parent.content.size : $head.parentOffset === 0;
  if (key === "ArrowLeft" || key === "ArrowRight" || !view) return offsetEdge;
  try {
    return view.endOfTextblock(key === "ArrowDown" ? "down" : "up");
  } catch {
    return offsetEdge;
  }
}

type Arrow = "ArrowUp" | "ArrowDown" | "ArrowLeft" | "ArrowRight";
const DIR: Record<Arrow, 1 | -1> = { ArrowUp: -1, ArrowLeft: -1, ArrowDown: 1, ArrowRight: 1 };

/** Shift+Arrow that steps over an opaque block instead of entering it. */
export function shiftArrow(key: Arrow): Command {
  const dir = DIR[key];
  return (state, dispatch, view) => {
    const sel = state.selection;
    const doc = state.doc;
    let anchor: number;
    let head: number;
    if (sel instanceof CellSelection) {
      // Carry on past the table once the cell selection reaches its edge.
      const axis = key === "ArrowLeft" || key === "ArrowRight" ? "horiz" : "vert";
      if (nextCell(sel.$headCell, axis, dir)) return false;
      const table = opaqueAround(sel.$headCell);
      if (!table) return false;
      anchor = dir > 0 ? table.from : table.to;
      const past = dir > 0 ? textInside(doc, table.to, 1) : textInside(doc, table.from, -1);
      head = past ?? (dir > 0 ? table.to : table.from);
    } else if (sel instanceof TextSelection) {
      anchor = sel.anchor;
      const block = opaqueAround(sel.$head);
      if (block && !(anchor > block.from && anchor < block.to)) {
        // The head is in a block the selection started outside: leave it.
        head = dir > 0 ? block.to : block.from;
      } else if (!block) {
        if (!atTextblockEdge(view, sel.$head, key)) return false;
        const next = blockAcross(doc, sel.$head, dir);
        if (!next) return false;
        head = dir > 0 ? next.to : next.from;
      } else {
        return false;
      }
    } else {
      return false;
    }
    if (dispatch) dispatch(state.tr.setSelection(blockRangeSelection(doc, anchor, head)).scrollIntoView());
    return true;
  };
}

/** The position before the table cell around `$pos`, if any. */
function cellStart($pos: ResolvedPos): number | null {
  for (let d = $pos.depth; d > 0; d--) {
    const role = $pos.node(d).type.spec.tableRole as string | undefined;
    if (role === "cell" || role === "header_cell") return $pos.before(d);
  }
  return null;
}

/**
 * A text selection running between two cells of one table, as the cell
 * selection that covers them. Typing or deleting over such a text selection
 * would cut the table's rows apart; over the cell selection, it clears the
 * cells and keeps the table's shape.
 */
export function asCellSelection(state: EditorState): CellSelection | null {
  const sel = state.selection;
  if (!(sel instanceof TextSelection) || sel.empty) return null;
  const a = cellStart(sel.$anchor);
  const h = cellStart(sel.$head);
  if (a === null || h === null || a === h) return null;
  const tableA = tableAround(sel.$anchor);
  const tableH = tableAround(sel.$head);
  if (!tableA || !tableH || tableA.from !== tableH.from) return null;
  return CellSelection.create(state.doc, a, h);
}

/**
 * Typing over cells: they are cleared and the text goes into the first one
 * (top left), the table keeping its rows, columns and alignments.
 */
function typeIntoCells(state: EditorState, cells: CellSelection, text: string): Transaction {
  const first = Math.min(...cells.ranges.map((r) => r.$from.pos));
  const tr = state.tr.setSelection(cells).deleteSelection();
  const $cell = tr.doc.resolve(tr.mapping.map(first, -1));
  const caret = TextSelection.findFrom($cell, 1, true);
  if (!caret) return tr;
  return tr.setSelection(caret).insertText(text);
}

/** Backspace/Delete on a text selection across cells clears those cells. */
const deleteAcrossCells: Command = (state, dispatch) => {
  const cells = asCellSelection(state);
  if (!cells) return false;
  if (dispatch) dispatch(state.tr.setSelection(cells).deleteSelection().scrollIntoView());
  return true;
};

/** Backspace/Delete on a selection reaching into opaque blocks removes them whole. */
export const deleteBlockRange: Command = (state, dispatch) => {
  if (deleteAcrossCells(state, dispatch)) return true;
  const span = deletionRange(state);
  if (!span) return false;
  if (dispatch) dispatch(deleteSpanToCaret(state, span).scrollIntoView());
  return true;
};

const keys = keydownHandler({
  "Shift-ArrowUp": shiftArrow("ArrowUp"),
  "Shift-ArrowDown": shiftArrow("ArrowDown"),
  "Shift-ArrowLeft": shiftArrow("ArrowLeft"),
  "Shift-ArrowRight": shiftArrow("ArrowRight"),
  Backspace: deleteBlockRange,
  Delete: deleteBlockRange,
});

/**
 * Shift+click: when the click lands in an opaque block, or the selection
 * starts in one, the selection takes that block whole. Plain text-to-text
 * shift+clicks stay native.
 */
function shiftClick(view: EditorView, event: MouseEvent): boolean {
  if (!event.shiftKey || event.button !== 0 || event.metaKey || event.ctrlKey || event.altKey) return false;
  const hit = view.posAtCoords({ left: event.clientX, top: event.clientY });
  if (!hit) return false;
  const { doc, selection } = view.state;
  const anchor = selection instanceof CellSelection ? selection.$anchorCell.pos : selection.anchor;
  let head = hit.pos;
  const inside = hit.inside >= 0 ? doc.nodeAt(hit.inside) : null;
  // Tables are text here: a click in a cell ends the range in that cell
  // (where a comment on it ends, say). The highlight and deleting still take
  // the table whole.
  const clicked =
    inside && isOpaqueBlock(inside) && !isTable(inside)
      ? { from: hit.inside, to: hit.inside + inside.nodeSize }
      : opaqueAround(doc.resolve(head), { tables: false });
  const started = opaqueAround(doc.resolve(anchor), { tables: false });
  const $hit = doc.resolve(head);
  if (!clicked && !started && tableAround($hit) && !tableAround(selection.$anchor) && $hit.parent.inlineContent) {
    // Into a cell's text from outside the table: a text range ending at the
    // click, set here rather than left to the browser. Inside the table's
    // view the browser's extended selection was sometimes reset before
    // ProseMirror read it, and the range was lost.
    event.preventDefault();
    view.dispatch(view.state.tr.setSelection(TextSelection.create(doc, anchor, head)));
    view.focus();
    return true;
  }
  if (clicked) {
    if (anchor > clicked.from && anchor < clicked.to) return false;
    head = anchor <= clicked.from ? clicked.to : clicked.from;
  } else if (!started || (head > started.from && head < started.to)) {
    return false;
  }
  event.preventDefault();
  view.dispatch(view.state.tr.setSelection(blockRangeSelection(doc, anchor, head)));
  view.focus();
  return true;
}

/** On `<body>` while the mouse is selecting by dragging (see `trackDragSelect`). */
export const DRAG_SELECTING_CLASS = "ken-drag-selecting";

/** Pixels the pointer moves, button held, before a press counts as a drag. */
const DRAG_THRESHOLD = 4;

/**
 * Marks a mouse drag-select in progress: from a press in the editor until
 * the button is released, once the pointer has moved. While it is on, the
 * styles keep a text cursor everywhere and hide hover affordances (zoom-in
 * on images, "Edit diagram", table and code tools), and the click the
 * browser fires on release is swallowed, so letting go over an image
 * doesn't open the lightbox or press a button. A press without a drag is an
 * ordinary click. Returns the cleanup.
 */
export function trackDragSelect(dom: HTMLElement): () => void {
  const doc = dom.ownerDocument;
  const win = doc.defaultView ?? window;
  let start: { x: number; y: number } | null = null;
  let dragging = false;
  let clearTimer: ReturnType<typeof setTimeout> | undefined;
  const set = (on: boolean) => {
    dragging = on;
    doc.body.classList.toggle(DRAG_SELECTING_CLASS, on);
  };
  const onDown = (e: MouseEvent) => {
    if (e.button !== 0) return;
    clearTimeout(clearTimer);
    set(false);
    start = { x: e.clientX, y: e.clientY };
  };
  const onMove = (e: MouseEvent) => {
    if ((e.buttons & 1) === 0) {
      // Released outside the window: no mouseup came.
      start = null;
      if (dragging) set(false);
      return;
    }
    if (!start || dragging) return;
    if (Math.abs(e.clientX - start.x) > DRAG_THRESHOLD || Math.abs(e.clientY - start.y) > DRAG_THRESHOLD) set(true);
  };
  const onUp = (e: MouseEvent) => {
    if (e.button !== 0) return;
    start = null;
    // The click that follows this mouseup (same task) still sees the drag.
    if (dragging) clearTimer = setTimeout(() => set(false), 0);
  };
  const onClick = (e: MouseEvent) => {
    if (!dragging) return;
    e.preventDefault();
    e.stopPropagation();
  };
  dom.addEventListener("mousedown", onDown, true);
  win.addEventListener("mousemove", onMove, true);
  win.addEventListener("mouseup", onUp, true);
  win.addEventListener("click", onClick, true);
  return () => {
    clearTimeout(clearTimer);
    set(false);
    dom.removeEventListener("mousedown", onDown, true);
    win.removeEventListener("mousemove", onMove, true);
    win.removeEventListener("mouseup", onUp, true);
    win.removeEventListener("click", onClick, true);
  };
}

const key = new PluginKey<DecorationSet>("ken-block-selection");

/** The table cell around `$pos`, if any. */
function cellAround($pos: ResolvedPos): ProseNode | null {
  for (let d = $pos.depth; d > 0; d--) {
    const role = $pos.node(d).type.spec.tableRole as string | undefined;
    if (role === "cell" || role === "header_cell") return $pos.node(d);
  }
  return null;
}

/**
 * A text selection from outside a table to the very start of a cell, which
 * a mouse drag produces whenever the pointer enters a cell. The table plugin
 * "normalizes" exactly these by collapsing them to the anchor's paragraph
 * (prosemirror-tables' isTextSelectionAcrossCells), so mid-drag the
 * selection and its highlight dropped off the table and came back on the
 * next pointer move: the flicker.
 */
/** What the table plugin collapses: a text range ending at the start of a cell other than the one it starts in. */
function tablesWouldCollapse(sel: Selection): boolean {
  if (!(sel instanceof TextSelection)) return false;
  const { $from, $to } = sel;
  return $to.parentOffset === 0 && cellAround($from) !== cellAround($to);
}

function collapsedByTables(wanted: Selection, final: Selection): boolean {
  if (!(final instanceof TextSelection) || wanted.eq(final) || !tablesWouldCollapse(wanted)) return false;
  return final.from === wanted.$from.start() && final.to === wanted.$from.end();
}

/** The table around `$pos`, if any. */
function tableAround($pos: ResolvedPos): Span | null {
  for (let d = 1; d <= $pos.depth; d++) {
    if (isTable($pos.node(d))) return { from: $pos.before(d), to: $pos.after(d) };
  }
  return null;
}

/** Whether the range starts outside any table and its head is in one. */
function entersTable(sel: Selection): boolean {
  return !tableAround(sel.$anchor) && !!tableAround(sel.$head);
}

/**
 * Undo that collapse for a drag from outside into a table: the selection
 * takes the table whole instead (selection only). A drag that starts in a
 * table is the table plugin's to handle: a range within one table can't be
 * widened, and putting it back would only be collapsed again, endlessly
 * (which froze and crashed the page); one leaving the table would lose its
 * start in the cell.
 */
function keepTableSelection(trs: readonly Transaction[], oldState: EditorState, state: EditorState): Transaction | null {
  if (isRemoteChange(trs) || trs.some((tr) => tr.docChanged || tr.getMeta(key))) return null;
  const candidates = [oldState.selection, ...trs.map((tr) => tr.selection)];
  const wanted = candidates.find((s) => collapsedByTables(s, state.selection) && entersTable(s));
  if (!wanted) return null;
  const sel = blockRangeSelection(state.doc, wanted.anchor, wanted.head);
  // Never hand the table plugin something it collapses again. And only ends
  // in text: mid-drag, an end between blocks (a table right after an image)
  // can't be shown as a browser selection, so the drag's start was lost.
  if (tablesWouldCollapse(sel) || sel.eq(state.selection)) return null;
  if (!sel.$anchor.parent.inlineContent || !sel.$head.parent.inlineContent) return null;
  return state.tr.setSelection(sel).setMeta(key, true).setMeta("addToHistory", false);
}

export const blockSelectionPlugin = $prose(
  () =>
    new Plugin({
      key,
      // Shift+click listens ahead of everything (capturing): a click on a code
      // block or a diagram goes to that block's own editor otherwise.
      view: (view) => {
        const onDown = (event: MouseEvent) => {
          if (shiftClick(view, event)) event.stopPropagation();
        };
        view.dom.addEventListener("mousedown", onDown, true);
        const stopTracking = trackDragSelect(view.dom);
        return {
          destroy: () => {
            view.dom.removeEventListener("mousedown", onDown, true);
            stopTracking();
          },
        };
      },
      appendTransaction: keepTableSelection,
      // The highlight is worked out only when the document or the selection
      // changes, not on every view update (a selection over a long document
      // walks all of it).
      state: {
        init: (_, state) => decorations(state),
        apply: (tr, old: DecorationSet, oldState, state) =>
          tr.docChanged || !oldState.selection.eq(state.selection) ? decorations(state) : old,
      },
      props: {
        decorations: (state) => key.getState(state) as DecorationSet | undefined,
        // Cut and paste over text across cells work on those cells: turn the
        // selection into the cell selection first, then let them run.
        handleDOMEvents: {
          cut: (view) => {
            const cells = asCellSelection(view.state);
            if (cells) view.dispatch(view.state.tr.setSelection(cells));
            return false;
          },
        },
        handlePaste: (view, _event, slice) => {
          const cells = asCellSelection(view.state);
          if (!cells) return false;
          view.dispatch(view.state.tr.setSelection(cells).replaceSelection(slice).scrollIntoView());
          return true;
        },
        // Typing over such a selection replaces what Backspace would remove.
        handleTextInput(view, _from, _to, text) {
          const sel = view.state.selection;
          const cells = sel instanceof CellSelection ? sel : asCellSelection(view.state);
          if (cells) {
            view.dispatch(typeIntoCells(view.state, cells, text).scrollIntoView());
            return true;
          }
          const span = deletionRange(view.state);
          if (!span) return false;
          view.dispatch(replaceSpanWithText(view.state, span, text).scrollIntoView());
          return true;
        },
      },
    }),
);

/**
 * The keys go on the view itself: its props are consulted before any
 * plugin's, and the table plugin's own Shift+Arrow handling (which turns a
 * selection reaching a cell edge into a cell selection) would otherwise win.
 */
export function blockSelectionKeys(ctx: Ctx): void {
  ctx.update(editorViewOptionsCtx, (opts) => {
    const prev = opts.handleKeyDown;
    return {
      ...opts,
      handleKeyDown: (view, event) => keys(view, event) || (prev?.(view, event) ?? false),
    };
  });
}

/**
 * Crepe's table view, kept on screen when only its decorations change.
 *
 * ProseMirror asks a node view to `update` when the node or the decorations
 * around it change. Crepe's table view refuses an update for an unchanged
 * node, so ProseMirror destroyed and rebuilt the whole table (its Vue app,
 * handles and cells) each time a selection began or stopped reaching it:
 * the table flashed, and the browser's selection inside it was thrown away
 * mid-drag, so the selection jumped. Here an unchanged node is a no-op.
 */
class StableTableView extends TableNodeView {
  override update(node: ProseNode): boolean {
    if (node.type !== this.node.type) return false;
    if (node.sameMarkup(this.node) && node.content.eq(this.node.content)) return true;
    return super.update(node);
  }

  /**
   * A press in a cell goes to ProseMirror. Crepe's view claimed it (to
   * select the cell's paragraph a frame later, which tableCellClickFix
   * filters out anyway) whenever the caret was in another cell or outside the
   * table, so ProseMirror's and the table plugin's mouse handling never saw
   * it: a drag across cells made a browser text selection instead of a cell
   * selection, and typing over that broke the table.
   */
  override stopEvent(e: Event): boolean {
    if ((e.type === "mousedown" || e.type === "pointerdown") && e.target instanceof Element) {
      if (e.target.closest("button")) return true;
      if (e.target.closest("th, td")) {
        return false;
      }
    }
    return super.stopEvent(e);
  }
}

/** Registered after Crepe's table feature, so it replaces Crepe's view. */
export const stableTableView = $view(tableSchema.node, (ctx) => (node, view, getPos) => new StableTableView(ctx, node, view, getPos));
