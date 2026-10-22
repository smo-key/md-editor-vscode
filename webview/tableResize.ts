/**
 * Resizing table columns by hand.
 *
 * Hovering near the border between two columns shows a resize handle; dragging
 * it sets that column's width (live, never under 40px), and releasing stores
 * the table's column widths on the node (`colWidths`), which is saved in the
 * Markdown as `<!-- ken:table widths=… -->` (see tableFullWidth.ts), so anyone
 * opening the file sees the same widths. Double-clicking a handle returns the
 * table to automatic widths.
 *
 * Widths stay attached to their columns when columns are inserted, moved or
 * deleted (`shiftColumnWidths`), and a column count that changed some other
 * way (e.g. dragging a column with Crepe's handle) is reconciled rather than
 * leaving widths on the wrong columns.
 */
import { Plugin, PluginKey, type EditorState, type Transaction } from "@milkdown/kit/prose/state";
import { TableMap } from "@milkdown/kit/prose/tables";
import type { Node as ProseNode } from "@milkdown/kit/prose/model";
import type { EditorView } from "@milkdown/kit/prose/view";
import { $prose } from "@milkdown/kit/utils";

import type { ColumnWidths } from "./markdown/tableFullWidth";
import { MIN_COLUMN } from "./markdown/tableLayout";

/** How close to a border (px) the pointer has to be to grab it. */
const GRAB = 5;

/** The table node at `tableStart - 1` and its column count. */
function tableAtStart(state: EditorState, tableStart: number): { node: ProseNode; pos: number; cols: number } | null {
  const pos = tableStart - 1;
  const node = state.doc.nodeAt(pos);
  if (!node || node.type.name !== "table") return null;
  return { node, pos, cols: TableMap.get(node).width };
}

/**
 * Keep hand-set widths with their columns after a column operation:
 * `insert` adds an automatic column at `index`, `remove` drops one, `move`
 * carries one from `index` to `to`.
 */
export function shiftColumnWidths(
  widths: ColumnWidths | null | undefined,
  op: { insert: number } | { remove: number } | { move: number; to: number },
): ColumnWidths | null {
  if (!widths) return null;
  const next = widths.slice();
  if ("insert" in op) next.splice(op.insert, 0, null);
  else if ("remove" in op) next.splice(op.remove, 1);
  else {
    const [w] = next.splice(op.move, 1);
    next.splice(op.to, 0, w ?? null);
  }
  return next.some((w) => typeof w === "number") ? next : null;
}

/** The hand-set widths of the table at `tableStart`, if any. */
export function columnWidthsAt(state: EditorState, tableStart: number): ColumnWidths | null {
  return (tableAtStart(state, tableStart)?.node.attrs.colWidths as ColumnWidths | null) ?? null;
}

/**
 * Run a column operation on the table at `tableStart`, carrying its hand-set
 * widths along (captured before, shifted after, so the columns keep theirs).
 */
export function withColumnWidths(
  view: EditorView,
  tableStart: number,
  op: Parameters<typeof shiftColumnWidths>[1],
  act: () => void,
): void {
  const before = columnWidthsAt(view.state, tableStart);
  act();
  if (!before) return;
  const table = tableAtStart(view.state, tableStart);
  if (!table) return;
  const colWidths = shiftColumnWidths(before, op);
  view.dispatch(view.state.tr.setNodeMarkup(table.pos, undefined, { ...table.node.attrs, colWidths }));
}

/** Widths whose length no longer matches the table are padded or trimmed. */
function reconcile(tr: Transaction, state: EditorState): Transaction | null {
  let out: Transaction | null = null;
  state.doc.descendants((node, pos) => {
    if (node.type.name !== "table") return true;
    const widths = node.attrs.colWidths as ColumnWidths | null;
    if (widths) {
      const cols = TableMap.get(node).width;
      if (widths.length !== cols) {
        const fixed = Array.from({ length: cols }, (_, i) => widths[i] ?? null);
        out ??= state.tr;
        out.setNodeMarkup(pos, undefined, {
          ...node.attrs,
          colWidths: fixed.some((w) => typeof w === "number") ? fixed : null,
        });
      }
    }
    return false;
  });
  void tr;
  return out;
}

interface Hover {
  block: HTMLElement;
  table: HTMLTableElement;
  col: number;
}

interface Drag extends Hover {
  startX: number;
  start: number[];
  widths: number[];
}

/** Current column widths of a rendered table, from its colgroup (or cells). */
function renderedWidths(table: HTMLTableElement): number[] {
  const cols = table.querySelector(":scope > colgroup.ken-table-cols")?.children;
  if (cols && cols.length) return Array.from(cols, (c) => parseFloat((c as HTMLElement).style.width) || MIN_COLUMN);
  const row = table.rows[0];
  return row ? Array.from(row.cells, (c) => c.getBoundingClientRect().width) : [];
}

function setRenderedWidths(table: HTMLTableElement, widths: number[]): void {
  const cols = table.querySelector(":scope > colgroup.ken-table-cols")?.children;
  if (!cols || cols.length !== widths.length) return;
  widths.forEach((w, i) => ((cols[i] as HTMLElement).style.width = `${w.toFixed(2)}px`));
  table.style.width = `${widths.reduce((a, b) => a + b, 0).toFixed(2)}px`;
}

class ColumnResizeView {
  private readonly handle: HTMLElement;
  private hover: Hover | null = null;
  private drag: Drag | null = null;

  constructor(private readonly view: EditorView) {
    this.handle = document.createElement("div");
    this.handle.className = "ken-col-resize";
    this.handle.contentEditable = "false";
    this.handle.title = "Drag to resize the column; double-click for automatic widths";
    this.handle.addEventListener("pointerdown", this.onDown);
    this.handle.addEventListener("dblclick", this.onReset);
    view.dom.addEventListener("mousemove", this.onMove);
    view.dom.addEventListener("mouseleave", this.onLeave);
  }

  private readonly onMove = (e: MouseEvent) => {
    if (this.drag) return;
    const cell = (e.target as Element | null)?.closest?.("th, td");
    const table = cell?.closest<HTMLTableElement>("table.children");
    const block = table?.closest<HTMLElement>(".milkdown-table-block");
    if (!(cell instanceof HTMLTableCellElement) || !table || !block) return this.hideUnlessOnHandle(e);
    const r = cell.getBoundingClientRect();
    let col = -1;
    if (Math.abs(e.clientX - r.right) <= GRAB) col = cell.cellIndex;
    else if (Math.abs(e.clientX - r.left) <= GRAB && cell.cellIndex > 0) col = cell.cellIndex - 1;
    if (col < 0) return this.hideUnlessOnHandle(e);
    this.hover = { block, table, col };
    this.place();
  };

  private hideUnlessOnHandle(e: MouseEvent) {
    if (e.target === this.handle) return;
    this.hide();
  }

  private readonly onLeave = (e: MouseEvent) => {
    if (!this.drag && e.relatedTarget !== this.handle) this.hide();
  };

  /** Put the handle over the right edge of column `hover.col`. */
  private place() {
    const h = this.hover;
    if (!h) return;
    const row = h.table.rows[0];
    const cell = row?.cells[h.col];
    if (!cell) return;
    if (this.handle.parentElement !== h.block) h.block.append(this.handle);
    const blockRect = h.block.getBoundingClientRect();
    const tableRect = h.table.getBoundingClientRect();
    const x = cell.getBoundingClientRect().right;
    this.handle.style.left = `${x - blockRect.left - 4}px`;
    this.handle.style.top = `${tableRect.top - blockRect.top}px`;
    this.handle.style.height = `${tableRect.height}px`;
    this.handle.dataset.show = "true";
  }

  private hide() {
    this.hover = null;
    this.handle.dataset.show = "false";
  }

  private readonly onDown = (e: PointerEvent) => {
    if (!this.hover || e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const start = renderedWidths(this.hover.table);
    if (!start.length) return;
    this.drag = { ...this.hover, startX: e.clientX, start, widths: start.slice() };
    this.handle.setPointerCapture(e.pointerId);
    this.handle.classList.add("dragging");
    document.body.classList.add("ken-col-resizing");
    this.handle.addEventListener("pointermove", this.onDrag);
    this.handle.addEventListener("pointerup", this.onUp);
    this.handle.addEventListener("pointercancel", this.onUp);
  };

  private readonly onDrag = (e: PointerEvent) => {
    const d = this.drag;
    if (!d) return;
    d.widths = d.start.slice();
    d.widths[d.col] = Math.max(MIN_COLUMN, d.start[d.col]! + (e.clientX - d.startX));
    setRenderedWidths(d.table, d.widths);
    this.place();
  };

  private readonly onUp = (e: PointerEvent) => {
    const d = this.drag;
    this.drag = null;
    this.handle.releasePointerCapture(e.pointerId);
    this.handle.classList.remove("dragging");
    document.body.classList.remove("ken-col-resizing");
    this.handle.removeEventListener("pointermove", this.onDrag);
    this.handle.removeEventListener("pointerup", this.onUp);
    this.handle.removeEventListener("pointercancel", this.onUp);
    if (!d || Math.abs(e.clientX - d.startX) < 1) return;
    // Every column as it now looks, so nothing else moves when it re-lays out.
    this.store(d.table, d.widths.map((w) => Math.round(w)));
  };

  private readonly onReset = (e: MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (this.hover) this.store(this.hover.table, null);
  };

  private store(table: HTMLTableElement, widths: ColumnWidths | null) {
    const pos = this.tablePos(table);
    if (pos === null) return;
    const node = this.view.state.doc.nodeAt(pos);
    if (!node) return;
    this.view.dispatch(this.view.state.tr.setNodeMarkup(pos, undefined, { ...node.attrs, colWidths: widths }));
  }

  private tablePos(table: HTMLTableElement): number | null {
    let found: number | null = null;
    this.view.state.doc.descendants((node, pos) => {
      if (found !== null) return false;
      if (node.type.name !== "table") return true;
      const dom = this.view.nodeDOM(pos);
      if (dom instanceof HTMLElement && (dom === table || dom.contains(table))) found = pos;
      return false;
    });
    return found;
  }

  update() {
    if (this.hover && !this.hover.block.isConnected) this.hide();
    else if (this.hover && !this.drag) this.place();
  }

  destroy() {
    this.view.dom.removeEventListener("mousemove", this.onMove);
    this.view.dom.removeEventListener("mouseleave", this.onLeave);
    this.handle.remove();
  }
}

export const columnResizePlugin = $prose(
  () =>
    new Plugin({
      key: new PluginKey("ken-column-resize"),
      view: (view) => new ColumnResizeView(view),
      appendTransaction: (trs, _old, state) =>
        trs.some((tr) => tr.docChanged) ? reconcile(trs[trs.length - 1]!, state) : null,
    }),
);
