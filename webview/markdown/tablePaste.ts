/**
 * Pasting tabular data.
 *
 * - Into a table: a block of cells (copied from this or another table, a
 *   spreadsheet such as Excel or Google Sheets, or CSV/TSV text) fills the
 *   cells from the caret's cell (or the top-left of a selected block of cells)
 *   onward, adding rows and columns as needed; a selection that is a multiple
 *   of the copied block is tiled with it, as spreadsheets do. One value pasted
 *   over a block of selected cells goes into every one of them.
 * - Anywhere else: spreadsheet or CSV/TSV text becomes a new table, its first
 *   row the header.
 *
 * Runs as a DOM paste handler, ahead of Milkdown's clipboard (which would
 * parse the text as Markdown) and of prosemirror-tables' own paste handling.
 */
import { DOMParser as PMDOMParser, Fragment, type Node as ProseNode, type Schema } from "@milkdown/kit/prose/model";
import { Plugin, PluginKey, TextSelection, type EditorState, type Transaction } from "@milkdown/kit/prose/state";
import {
  CellSelection,
  TableMap,
  __clipCells as clipCells,
  __insertCells as insertCells,
  isInTable,
  selectionCell,
} from "@milkdown/kit/prose/tables";
import type { EditorView } from "@milkdown/kit/prose/view";
import { $prose } from "@milkdown/kit/utils";

/** Parse delimiter-separated text (RFC 4180 quoting, as Excel writes it). */
export function parseDelimited(text: string, delimiter: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let atStart = true;
  const src = text.replace(/\r\n?/g, "\n").replace(/\n$/, "");
  for (let i = 0; i < src.length; i++) {
    const c = src[i]!;
    if (quoted) {
      if (c === '"' && src[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') quoted = false;
      else field += c;
      continue;
    }
    if (c === '"' && atStart) {
      quoted = true;
      atStart = false;
    } else if (c === delimiter) {
      row.push(field);
      field = "";
      atStart = true;
    } else if (c === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      atStart = true;
    } else {
      field += c;
      atStart = false;
    }
  }
  row.push(field);
  rows.push(row);
  return rows;
}

/**
 * The grid in a piece of plain text, or null when it isn't one: tab-separated
 * (what spreadsheets put on the clipboard) with at least two columns, or
 * comma-separated with at least two rows and a steady two or more columns.
 */
export function textGrid(text: string): string[][] | null {
  if (!text.trim()) return null;
  const consistent = (rows: string[][]) => rows.every((r) => r.length === rows[0]!.length);
  if (text.includes("\t")) {
    const rows = parseDelimited(text, "\t");
    const width = Math.max(...rows.map((r) => r.length));
    if (width >= 2) return rows.map((r) => [...r, ...Array<string>(width - r.length).fill("")]);
  }
  if (text.includes(",")) {
    const rows = parseDelimited(text, ",");
    if (rows.length >= 2 && rows[0]!.length >= 2 && consistent(rows)) return rows;
  }
  return null;
}

type CellsBlock = { width: number; height: number; rows: Fragment[] };

function textCell(schema: Schema, text: string, header = false): ProseNode {
  const type = header ? schema.nodes.table_header! : schema.nodes.table_cell!;
  const paragraphs = text.split("\n").map((line) => schema.nodes.paragraph!.create(null, line ? schema.text(line) : null));
  return type.create({ alignment: null }, paragraphs);
}

function gridCells(schema: Schema, grid: string[][]): CellsBlock {
  const width = Math.max(...grid.map((r) => r.length));
  const rows = grid.map((r) => Fragment.from(Array.from({ length: width }, (_, i) => textCell(schema, r[i] ?? ""))));
  return { width, height: rows.length, rows };
}

/** Cells from an HTML `<table>` (a copy from this editor, a web page, a spreadsheet), formatting kept. */
function htmlCells(schema: Schema, table: HTMLTableElement): CellsBlock | null {
  const parser = PMDOMParser.fromSchema(schema);
  const rows: Fragment[] = [];
  for (const tr of Array.from(table.querySelectorAll("tr"))) {
    const cells: ProseNode[] = [];
    for (const td of Array.from(tr.querySelectorAll(":scope > td, :scope > th"))) {
      const cell = parser.parse(td, { topNode: schema.nodes.table_cell!.createAndFill()! });
      cells.push(cell);
    }
    if (cells.length) rows.push(Fragment.from(cells));
  }
  if (!rows.length) return null;
  const width = Math.max(...rows.map((r) => r.childCount));
  const padded = rows.map((r) => {
    const extra: ProseNode[] = [];
    for (let i = r.childCount; i < width; i++) extra.push(schema.nodes.table_cell!.createAndFill()!);
    return r.append(Fragment.from(extra));
  });
  return { width, height: padded.length, rows: padded };
}

function htmlDocument(html: string): Document | null {
  if (!html) return null;
  return new DOMParser().parseFromString(html, "text/html");
}

/** What the clipboard holds, as cells for a table. */
export function clipboardCells(schema: Schema, data: DataTransfer): CellsBlock | null {
  const html = htmlDocument(data.getData("text/html"));
  const pmTable = html?.querySelector("[data-pm-slice] table, table[data-pm-slice]") ?? (html?.querySelector("[data-pm-slice]") ? html.querySelector("table") : null);
  if (pmTable) return htmlCells(schema, pmTable as HTMLTableElement);
  const grid = textGrid(data.getData("text/plain"));
  if (grid) return gridCells(schema, grid);
  const table = html?.querySelector("table");
  return table ? htmlCells(schema, table) : null;
}

/** One value, as a cell (formatting kept for a copy from this editor). */
function singleCell(schema: Schema, data: DataTransfer): ProseNode | null {
  const html = htmlDocument(data.getData("text/html"));
  if (html?.querySelector("[data-pm-slice]")) {
    return PMDOMParser.fromSchema(schema).parse(html.body, { topNode: schema.nodes.table_cell!.createAndFill()! });
  }
  const text = data.getData("text/plain");
  return text ? textCell(schema, text.replace(/\r\n?/g, "\n").replace(/\n$/, "")) : null;
}

/**
 * The block as it lands at (`top`, `left`) in `table`: header cells in the
 * header row and ordinary ones elsewhere, whatever was copied, each with its
 * column's alignment (alignment belongs to the column in GFM).
 */
function fitToTable(block: CellsBlock, table: ProseNode, top: number, left: number): CellsBlock {
  const { table_cell: cell, table_header: header } = table.type.schema.nodes;
  const hasHeader = table.firstChild?.type.name === "table_header_row";
  const map = TableMap.get(table);
  const alignment = (col: number) => {
    if (col >= map.width) return null;
    return table.nodeAt(map.map[col]!)?.attrs.alignment ?? null;
  };
  const rows = block.rows.map((row, i) => {
    const want = hasHeader && top + i === 0 ? header! : cell!;
    const cells: ProseNode[] = [];
    row.forEach((c, _o, j) => cells.push(want.create({ ...c.attrs, alignment: alignment(left + j) }, c.content, c.marks)));
    return Fragment.from(cells);
  });
  return { ...block, rows };
}

function pasteIntoTable(view: EditorView, cells: CellsBlock | null, single: ProseNode | null): boolean {
  const { state } = view;
  const sel = state.selection;
  const dispatch = (tr: Transaction) => view.dispatch(tr.scrollIntoView().setMeta("uiEvent", "paste"));
  if (sel instanceof CellSelection) {
    const table = sel.$anchorCell.node(-1);
    const start = sel.$anchorCell.start(-1);
    const rect = TableMap.get(table).rectBetween(sel.$anchorCell.pos - start, sel.$headCell.pos - start);
    const w = rect.right - rect.left;
    const h = rect.bottom - rect.top;
    let block = cells && (cells.width > 1 || cells.height > 1) ? cells : null;
    if (!block) {
      const cell = cells ? cells.rows[0]!.child(0) : single;
      if (!cell) return false;
      // One value: into every selected cell.
      block = clipCells({ width: 1, height: 1, rows: [Fragment.from(cell)] }, w, h);
    } else if (w % block.width === 0 && h % block.height === 0) {
      block = clipCells(block, w, h);
    }
    insertCells(state, dispatch, start, rect, fitToTable(block, table, rect.top, rect.left));
    return true;
  }
  if (!cells || (cells.width === 1 && cells.height === 1)) return false;
  const $cell = selectionCell(state);
  const start = $cell.start(-1);
  const table = $cell.node(-1);
  const rect = TableMap.get(table).findCell($cell.pos - start);
  insertCells(state, dispatch, start, rect, fitToTable(cells, table, rect.top, rect.left));
  return true;
}

/** A new table from a grid, its first row the header. */
export function tableFromGrid(schema: Schema, grid: string[][]): ProseNode {
  const width = Math.max(...grid.map((r) => r.length));
  const row = (cells: string[], header: boolean) =>
    (header ? schema.nodes.table_header_row! : schema.nodes.table_row!).create(
      null,
      Array.from({ length: width }, (_, i) => textCell(schema, cells[i] ?? "", header)),
    );
  const rows = [row(grid[0]!, true), ...grid.slice(1).map((r) => row(r, false))];
  if (rows.length === 1) rows.push(row([], false));
  return schema.nodes.table!.create(null, rows);
}

function insertTable(view: EditorView, table: ProseNode) {
  const { state } = view;
  const { $from } = state.selection;
  const parent = $from.parent;
  const depth = $from.depth;
  const empty = parent.isTextblock && parent.content.size === 0 && depth >= 1;
  let tr = state.tr;
  if (!state.selection.empty) tr = tr.deleteSelection();
  const $at = tr.doc.resolve(tr.mapping.map($from.pos));
  const from = empty ? $at.before(depth) : $at.after(Math.max(1, Math.min(depth, $at.depth)));
  const to = empty ? $at.after(depth) : from;
  tr.replaceWith(from, to, table);
  const sel = TextSelection.findFrom(tr.doc.resolve(from + table.nodeSize), 1, true) ?? TextSelection.near(tr.doc.resolve(from + 1));
  view.dispatch(tr.setSelection(sel).scrollIntoView().setMeta("uiEvent", "paste"));
}

const inCode = (state: EditorState) => {
  const { $from } = state.selection;
  return !!$from.parent.type.spec.code || (state.storedMarks ?? $from.marks()).some((m) => m.type.spec.code);
};

export function handleTablePaste(view: EditorView, data: DataTransfer | null): boolean {
  if (!view.editable || !data || data.files.length > 0 || inCode(view.state)) return false;
  const { schema } = view.state;
  if (isInTable(view.state)) {
    const cells = clipboardCells(schema, data);
    const single = view.state.selection instanceof CellSelection && !cells ? singleCell(schema, data) : null;
    return pasteIntoTable(view, cells, single);
  }
  // Anything copied from this editor pastes as itself.
  if (htmlDocument(data.getData("text/html"))?.querySelector("[data-pm-slice]")) return false;
  const grid = textGrid(data.getData("text/plain"));
  // One row of tab-separated text is a table only when it came from one (a spreadsheet's HTML).
  if (!grid || (grid.length < 2 && !htmlDocument(data.getData("text/html"))?.querySelector("table"))) return false;
  if (view.state.selection.$from.depth > 1 && view.state.selection.$from.node(1).type.name === "table") return false;
  insertTable(view, tableFromGrid(schema, grid));
  return true;
}

export const tablePastePlugin = $prose(
  () =>
    new Plugin({
      key: new PluginKey("ken-table-paste"),
      props: {
        handleDOMEvents: {
          paste: (view, event) => {
            if (!handleTablePaste(view, event.clipboardData)) return false;
            event.preventDefault();
            return true;
          },
        },
      },
    }),
);
