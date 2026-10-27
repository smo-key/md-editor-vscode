/**
 * Every editing command the UI offers, in one place: the slash menu, the
 * bottom toolbar and the table context menu all draw from this list, so a
 * command behaves the same wherever it is invoked.
 */
import { commandsCtx, editorViewCtx } from "@milkdown/kit/core";
import type { Ctx } from "@milkdown/kit/ctx";
import { Fragment, type MarkType, type Node as ProseNode } from "@milkdown/kit/prose/model";
import { lift, setBlockType, toggleMark, wrapIn } from "@milkdown/kit/prose/commands";
import { redo, undo, redoDepth, undoDepth } from "@milkdown/kit/prose/history";
import { sharedHistory } from "./collab";
import { liftListItem, sinkListItem, wrapInList } from "@milkdown/kit/prose/schema-list";
import { TextSelection, type EditorState } from "@milkdown/kit/prose/state";
import {
  CellSelection,
  TableMap,
  addColumnAfter,
  addColumnBefore,
  deleteColumn,
  deleteRow,
  deleteTable,
  isInTable,
  moveTableColumn,
  moveTableRow,
  selectedRect,
} from "@milkdown/kit/prose/tables";
import type { EditorView } from "@milkdown/kit/prose/view";
import {
  addBlockTypeCommand,
  blockquoteSchema,
  codeBlockSchema,
  headingSchema,
  hrSchema,
  paragraphSchema,
} from "@milkdown/kit/preset/commonmark";
import {
  addRowAfterCommand,
  addRowBeforeCommand,
  createTable,
  setAlignCommand,
} from "@milkdown/kit/preset/gfm";
import { toggleLinkCommand } from "@milkdown/kit/component/link-tooltip";
import { imageBlockSchema } from "@milkdown/kit/component/image-block";
import {
  AlignCenter,
  AlignLeft,
  AlignRight,
  ArrowDown,
  ArrowDownToLine,
  ArrowLeft,
  ArrowLeftToLine,
  ArrowRight,
  ArrowRightToLine,
  ArrowUp,
  ArrowUpToLine,
  Bold,
  Code,
  CodeXml,
  Heading1,
  Heading2,
  Heading3,
  Heading4,
  Heading5,
  Heading6,
  Image,
  Info,
  Italic,
  Lightbulb,
  Link,
  List,
  MessageSquarePlus,
  MessagesSquare,
  ListIndentDecrease,
  ListIndentIncrease,
  ListChecks,
  ListOrdered,
  ListTree,
  Maximize2,
  MessageSquareWarning,
  Minus,
  OctagonAlert,
  Pilcrow,
  Shapes,
  Redo2,
  Strikethrough,
  Table,
  Tags,
  TableColumnsSplit,
  TableRowsSplit,
  Quote,
  Trash2,
  TriangleAlert,
  Underline,
  Undo2,
  Workflow,
  Sigma,
  Radical,
  PanelTop,
  PanelBottom,
  type IconNode,
} from "lucide";

import { insertGithubAlertCommand, type GithubAlertKind } from "./markdown/githubAlert";
import { insertTocCommand } from "./markdown/toc";
import { tableAt, toggleTableFullWidthCommand } from "./markdown/tableFullWidth";
import { hasFrontmatterPanel, openFrontmatter } from "./frontmatter";
import { insertDiagram } from "./drawio";
import { insertInlineMath } from "./markdown/math";
import { insertAttachments } from "./fileDrop";
import { addComment, commentsOpen, openCommentCount, toggleComments } from "./comments/panel";
import { withColumnWidths } from "./tableResize";

export type CommandGroup = "history" | "text" | "format" | "list" | "insert" | "alert" | "comment" | "table";

export interface EditorCommand {
  id: string;
  label: string;
  icon: IconNode;
  group: CommandGroup;
  /** Extra words the slash menu matches on. */
  keywords?: string[];
  /** Offered in the slash menu. */
  slash?: boolean;
  /** Shown in the bottom toolbar. */
  toolbar?: boolean;
  /** A key built into the editor (not a VS Code keybinding), for hints. */
  builtinKey?: string;
  /** Leave focus where the command put it (it opens its own input), or where it is when this says so. */
  keepFocus?: boolean | (() => boolean);
  /** A count shown on the toolbar button (e.g. open comments). */
  badge?(state: EditorState): number;
  danger?: boolean;
  run(ctx: Ctx, view: EditorView): void;
  isActive?(state: EditorState): boolean;
  isEnabled?(state: EditorState): boolean;
  /** The label in the table menu when it depends on the state (e.g. "Remove header row"). */
  menuLabel?(state: EditorState): string;
}

// --- Shortcut labels ----------------------------------------------------------
// Keys belong to VS Code (Keyboard Shortcuts); the host sends the effective
// label for each command, e.g. "⌘B", so hints follow the user's bindings.

let labels: Record<string, string> = {};
const listeners = new Set<() => void>();

export function setShortcutLabels(next: Record<string, string>): void {
  labels = next;
  for (const l of listeners) l();
}

/** The key label for a command id ("" when it has no key). */
export function shortcutFor(id: string): string {
  return labels[id] || COMMANDS.find((c) => c.id === id)?.builtinKey || "";
}

export function onShortcutLabels(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

// --- State queries -----------------------------------------------------------

function markActive(state: EditorState, type: MarkType | undefined): boolean {
  if (!type) return false;
  const { from, to, empty, $from } = state.selection;
  if (empty) return !!type.isInSet(state.storedMarks ?? $from.marks());
  return state.doc.rangeHasMark(from, to, type);
}

/** The innermost ancestor of the selection of one of `names`, with its depth. */
function ancestor(state: EditorState, names: string[]): { node: ProseNode; depth: number } | null {
  const { $from } = state.selection;
  for (let d = $from.depth; d > 0; d--) {
    const node = $from.node(d);
    if (names.includes(node.type.name)) return { node, depth: d };
  }
  return null;
}

/** Which kind of list the caret is in: the innermost list decides. */
function listKind(state: EditorState): "bullet" | "ordered" | "task" | null {
  const { $from } = state.selection;
  for (let d = $from.depth; d > 0; d--) {
    const node = $from.node(d);
    if (node.type.name === "list_item") {
      if (node.attrs.checked != null) return "task";
      const list = $from.node(d - 1);
      return list.type.name === "ordered_list" ? "ordered" : "bullet";
    }
  }
  return null;
}

/** The caret block's heading level, 0 when it is not a heading. */
export function headingLevel(state: EditorState): number {
  const parent = state.selection.$from.parent;
  return parent.type.name === "heading" ? (parent.attrs.level as number) : 0;
}

function inCodeBlock(state: EditorState): boolean {
  return state.selection.$from.parent.type.name === "code_block";
}

// --- Actions -----------------------------------------------------------------

const call = (ctx: Ctx, key: unknown, payload?: unknown) =>
  ctx.get(commandsCtx).call(key as never, payload as never);

function run(view: EditorView, command: (state: EditorState, dispatch?: EditorView["dispatch"]) => boolean) {
  command(view.state, view.dispatch);
}

/** Replace an empty textblock with `node`, or insert it after the current block. */
function insertBlock(view: EditorView, node: ProseNode | null | undefined) {
  if (!node) return;
  const { state } = view;
  const { $from } = state.selection;
  const parent = $from.parent;
  const depth = $from.depth;
  const empty = parent.isTextblock && parent.content.size === 0 && depth >= 1;
  const from = empty ? $from.before(depth) : $from.after(Math.max(depth, 1));
  const to = empty ? $from.after(depth) : from;
  const tr = state.tr.replaceWith(from, to, node);
  const sel = TextSelection.findFrom(tr.doc.resolve(from), 1, true) ?? TextSelection.near(tr.doc.resolve(from));
  view.dispatch(tr.setSelection(sel).scrollIntoView());
}

function toggleHeading(view: EditorView, ctx: Ctx, level: number) {
  const type = headingLevel(view.state) === level ? paragraphSchema.type(ctx) : headingSchema.type(ctx);
  run(view, setBlockType(type, type === paragraphSchema.type(ctx) ? null : { level }));
}

/** Toggle a list kind: lift out of the same kind, convert another kind in place, else wrap. */
function toggleList(view: EditorView, ctx: Ctx, kind: "bullet" | "ordered" | "task") {
  const { schema } = view.state;
  const item = schema.nodes.list_item;
  const current = listKind(view.state);
  if (current === kind) {
    run(view, liftListItem(item));
    return;
  }
  if (current) {
    // Convert the innermost list and its items in place.
    const { $from } = view.state.selection;
    for (let d = $from.depth; d > 0; d--) {
      const list = $from.node(d);
      if (list.type.name !== "bullet_list" && list.type.name !== "ordered_list") continue;
      const ordered = kind === "ordered";
      const listType = ordered ? schema.nodes.ordered_list : schema.nodes.bullet_list;
      const pos = $from.before(d);
      const attrs = ordered ? { order: 1, spread: list.attrs.spread } : { spread: list.attrs.spread };
      const tr = view.state.tr.setNodeMarkup(pos, listType, attrs);
      // Items carry their list's kind too; a sync plugin rebuilds the list from them.
      let index = 0;
      list.forEach((child, offset) => {
        const checked = kind === "task" ? (child.attrs.checked ?? false) : null;
        const itemAttrs: Record<string, unknown> = { ...child.attrs, checked };
        if ("listType" in child.attrs) itemAttrs.listType = ordered ? "ordered" : "bullet";
        if ("label" in child.attrs) itemAttrs.label = ordered ? `${++index}.` : "•";
        tr.setNodeMarkup(pos + 1 + offset, undefined, itemAttrs);
      });
      view.dispatch(tr);
      return;
    }
  }
  const listType = kind === "ordered" ? schema.nodes.ordered_list : schema.nodes.bullet_list;
  // A list item starts with a paragraph: a heading (or other textblock)
  // becomes plain text first.
  const block = view.state.selection.$from.parent;
  if (block.isTextblock && block.type !== schema.nodes.paragraph && block.type !== schema.nodes.code_block) {
    run(view, setBlockType(schema.nodes.paragraph));
  }
  // A checklist is created checked in the same transaction: setting the
  // attribute afterwards re-renders the new item's view, and the browser's
  // caret ends up after the list.
  const wrap = wrapInList(listType);
  const ok = wrap(view.state, (tr) => {
    if (kind === "task") {
      const { $from } = tr.selection;
      for (let d = $from.depth; d > 0; d--) {
        if ($from.node(d).type.name === "list_item") {
          tr.setNodeMarkup($from.before(d), undefined, { ...$from.node(d).attrs, checked: false });
          break;
        }
      }
    }
    view.dispatch(tr);
  });
  if (!ok) return;
  void ctx;
}

function toggleQuote(view: EditorView, ctx: Ctx) {
  const quote = blockquoteSchema.type(ctx);
  if (ancestor(view.state, ["blockquote"])) {
    run(view, lift);
    return;
  }
  if (wrapIn(quote)(view.state, view.dispatch)) return;
  // Wrapping is impossible in some places (e.g. a lone empty paragraph in a
  // list item); replacing the block always works.
  insertBlock(view, quote.createAndFill(null, paragraphSchema.type(ctx).create()));
}

function toggleCodeBlock(view: EditorView, ctx: Ctx, language = "") {
  if (inCodeBlock(view.state)) {
    run(view, setBlockType(paragraphSchema.type(ctx)));
    return;
  }
  const code = codeBlockSchema.type(ctx);
  // Turn the line into code where possible; insert an empty block otherwise.
  if (!setBlockType(code, { language })(view.state, view.dispatch)) {
    insertBlock(view, code.create({ language }));
  }
}

function insertLink(view: EditorView, ctx: Ctx) {
  const { state } = view;
  if (state.selection.empty) {
    // Give the link some text to hang on, selected so it can be typed over.
    const text = "link";
    const from = state.selection.from;
    const tr = state.tr.insertText(text, from);
    view.dispatch(tr.setSelection(TextSelection.create(tr.doc, from, from + text.length)));
  }
  call(ctx, toggleLinkCommand.key);
}

// --- Tables ------------------------------------------------------------------

export interface CellInfo {
  row: number;
  col: number;
  rows: number;
  cols: number;
  /** Start of the table's content (`selectedRect().tableStart`). */
  tableStart: number;
}

export function currentCell(state: EditorState): CellInfo | null {
  if (!isInTable(state)) return null;
  try {
    const rect = selectedRect(state);
    return {
      row: rect.top,
      col: rect.left,
      rows: rect.map.height,
      cols: rect.map.width,
      tableStart: rect.tableStart,
    };
  } catch {
    return null;
  }
}

/** Put the caret at the end of a cell's text, in the table at `tableStart`. */
export function focusCell(view: EditorView, tableStart: number, row: number, col: number) {
  const table = view.state.doc.nodeAt(tableStart - 1);
  if (!table || table.type.name !== "table") return;
  const map = TableMap.get(table);
  const r = Math.max(0, Math.min(row, map.height - 1));
  const c = Math.max(0, Math.min(col, map.width - 1));
  const cellPos = tableStart + map.map[r * map.width + c];
  const cell = view.state.doc.nodeAt(cellPos);
  const end = cellPos + (cell?.nodeSize ?? 2) - 1;
  const sel = TextSelection.near(view.state.doc.resolve(end), -1);
  view.dispatch(view.state.tr.setSelection(sel).scrollIntoView());
}

const inTable = (state: EditorState) => currentCell(state) !== null;

/** The table holding the selection, and its position. */
function currentTable(state: EditorState): { node: ProseNode; pos: number } | null {
  const c = currentCell(state);
  if (!c) return null;
  const node = state.doc.nodeAt(c.tableStart - 1);
  return node ? { node, pos: c.tableStart - 1 } : null;
}

/** 1 when the selection's table has a header row, else 0. */
function headerRows(state: EditorState): number {
  return currentTable(state)?.node.firstChild?.type.name === "table_header_row" ? 1 : 0;
}

/** The header row (when there is one) stays first and cannot be deleted on its own. */
const inBodyRow = (state: EditorState) => {
  const c = currentCell(state);
  return !!c && c.row >= headerRows(state);
};

/** Rebuild a row as `rowType` with `cellType` cells, content and attributes kept. */
function retypeRow(row: ProseNode, rowType: string, cellType: string, state: EditorState): ProseNode {
  const { nodes } = state.schema;
  const cells: ProseNode[] = [];
  row.forEach((cell) => cells.push(nodes[cellType]!.create(cell.attrs, cell.content, cell.marks)));
  return nodes[rowType]!.create(row.attrs, cells);
}

/** Header row → first ordinary row, or the first row → header row. */
function toggleHeaderRow(view: EditorView) {
  const c = currentCell(view.state);
  const table = currentTable(view.state);
  if (!c || !table) return;
  const first = table.node.firstChild!;
  const has = first.type.name === "table_header_row";
  const row = has ? retypeRow(first, "table_row", "table_cell", view.state) : retypeRow(first, "table_header_row", "table_header", view.state);
  const from = table.pos + 1;
  view.dispatch(view.state.tr.replaceWith(from, from + first.nodeSize, row));
  focusCell(view, c.tableStart, c.row, c.col);
  view.focus();
}

const NUMBER = /^([-+]?)([$€£¥]?)\s*([\d,]*\.?\d+)(%?)$/;

/**
 * Column totals for a new total row: the sum of a column whose filled cells
 * are all numbers (currency, thousands separators and percentages kept), else
 * nothing. The first column is labelled "Total" instead when it isn't numeric.
 */
export function columnTotals(rows: string[][]): string[] {
  const width = Math.max(0, ...rows.map((r) => r.length));
  const out: string[] = [];
  for (let col = 0; col < width; col++) {
    const values = rows.map((r) => (r[col] ?? "").trim()).filter((v) => v !== "");
    const parsed = values.map((v) => NUMBER.exec(v));
    if (values.length === 0 || parsed.some((m) => !m)) {
      out.push("");
      continue;
    }
    let sum = 0;
    let decimals = 0;
    let commas = false;
    const units = new Set<string>();
    const percents = new Set<string>();
    for (const m of parsed as RegExpExecArray[]) {
      const digits = m[3]!;
      commas ||= digits.includes(",");
      decimals = Math.max(decimals, digits.includes(".") ? digits.split(".")[1]!.length : 0);
      units.add(m[2]!);
      percents.add(m[4]!);
      sum += (m[1] === "-" ? -1 : 1) * Number(digits.replace(/,/g, ""));
    }
    const unit = units.size === 1 ? [...units][0]! : "";
    const percent = percents.size === 1 ? [...percents][0]! : "";
    const fixed = Math.abs(sum).toFixed(decimals);
    const [int, frac] = fixed.split(".");
    const grouped = commas ? int!.replace(/\B(?=(\d{3})+(?!\d))/g, ",") : int!;
    out.push(`${sum < 0 ? "-" : ""}${unit}${grouped}${frac ? "." + frac : ""}${percent}`);
  }
  if (width > 0 && out[0] === "") out[0] = "Total";
  return out;
}

/** Turn the total row on (adding a row of column totals) or off (the row stays). */
function toggleTotalRow(view: EditorView) {
  const c = currentCell(view.state);
  const table = currentTable(view.state);
  if (!c || !table) return;
  const { node, pos } = table;
  if (node.attrs.totalRow) {
    view.dispatch(view.state.tr.setNodeMarkup(pos, undefined, { ...node.attrs, totalRow: false }));
    focusCell(view, c.tableStart, c.row, c.col);
    view.focus();
    return;
  }
  const { schema } = view.state;
  const body: string[][] = [];
  node.forEach((row) => {
    if (row.type.name !== "table_row") return;
    const texts: string[] = [];
    row.forEach((cell) => texts.push(cell.textContent));
    body.push(texts);
  });
  const totals = columnTotals(body);
  const last = node.lastChild!;
  const cells: ProseNode[] = [];
  last.forEach((cell, _o, i) => {
    const text = totals[i] ?? "";
    cells.push(schema.nodes.table_cell!.create({ alignment: cell.attrs.alignment }, schema.nodes.paragraph!.create(null, text ? schema.text(text) : null)));
  });
  const row = schema.nodes.table_row!.create(null, cells);
  const end = pos + node.nodeSize - 1;
  const tr = view.state.tr.insert(end, row);
  tr.setNodeMarkup(pos, undefined, { ...node.attrs, totalRow: true });
  view.dispatch(tr);
  focusCell(view, c.tableStart, c.rows, 0);
  view.focus();
}

function tableAction(view: EditorView, act: (cell: CellInfo) => void, after?: (cell: CellInfo) => [number, number]) {
  const cell = currentCell(view.state);
  if (!cell) return;
  act(cell);
  if (after) {
    const [row, col] = after(cell);
    focusCell(view, cell.tableStart, row, col);
  }
  view.focus();
}

function moveRow(view: EditorView, by: number) {
  tableAction(
    view,
    (c) => run(view, moveTableRow({ from: c.row, to: c.row + by, select: false, pos: c.tableStart })),
    (c) => [c.row + by, c.col],
  );
}

function moveCol(view: EditorView, by: number) {
  tableAction(
    view,
    (c) =>
      withColumnWidths(view, c.tableStart, { move: c.col, to: c.col + by }, () =>
        run(view, moveTableColumn({ from: c.col, to: c.col + by, select: false, pos: c.tableStart })),
      ),
    (c) => [c.row, c.col + by],
  );
}

function alignColumn(view: EditorView, ctx: Ctx, alignment: "left" | "center" | "right") {
  tableAction(
    view,
    (c) => {
      // Alignment belongs to the whole column in GFM.
      const table = view.state.doc.nodeAt(c.tableStart - 1)!;
      const map = TableMap.get(table);
      const first = c.tableStart + map.map[c.col];
      const last = c.tableStart + map.map[(map.height - 1) * map.width + c.col];
      const tr = view.state.tr.setSelection(CellSelection.create(view.state.doc, first, last));
      view.dispatch(tr);
      call(ctx, setAlignCommand.key, alignment);
    },
    (c) => [c.row, c.col],
  );
}

function columnAlignment(state: EditorState): string | null {
  const cell = ancestor(state, ["table_cell", "table_header"]);
  return cell ? (cell.node.attrs.alignment as string) : null;
}

// --- The commands ------------------------------------------------------------

const heading = (level: number, icon: IconNode): EditorCommand => ({
  id: `heading${level}`,
  label: `Heading ${level}`,
  icon,
  group: "text",
  keywords: [`h${level}`, "title"],
  slash: true,
  toolbar: level <= 3,
  run: (ctx, view) => toggleHeading(view, ctx, level),
  isActive: (state) => headingLevel(state) === level,
  isEnabled: (state) => !inCodeBlock(state),
});

const alert = (kind: GithubAlertKind, label: string, icon: IconNode): EditorCommand => ({
  id: `alert-${kind}`,
  label,
  icon,
  group: "alert",
  keywords: ["alert", "callout", "admonition", kind],
  slash: true,
  run: (ctx) => call(ctx, insertGithubAlertCommand.key, kind),
});

/** Focus is in a field of the Properties panel (frontmatter.ts). */
const inProperties = () => !!document.activeElement?.closest(".ken-frontmatter");

export const COMMANDS: EditorCommand[] = [
  // History
  {
    id: "undo",
    label: "Undo",
    icon: Undo2,
    group: "history",
    toolbar: true,
    // In a collaboration session, only your own changes (collab.ts).
    run: (_ctx, view) => run(view, sharedHistory(view.state)?.undo ?? undo),
    // Undo while editing a property stays in the Properties panel (it may undo the property).
    keepFocus: inProperties,
    isEnabled: (state) => {
      const shared = sharedHistory(state);
      return shared ? !!shared.undo(state) : undoDepth(state) > 0;
    },
  },
  {
    id: "redo",
    label: "Redo",
    icon: Redo2,
    group: "history",
    toolbar: true,
    run: (_ctx, view) => run(view, sharedHistory(view.state)?.redo ?? redo),
    keepFocus: inProperties,
    isEnabled: (state) => {
      const shared = sharedHistory(state);
      return shared ? !!shared.redo(state) : redoDepth(state) > 0;
    },
  },

  // Block types
  {
    id: "paragraph",
    label: "Text",
    icon: Pilcrow,
    group: "text",
    keywords: ["paragraph", "plain", "normal"],
    slash: true,
    run: (ctx, view) => run(view, setBlockType(paragraphSchema.type(ctx))),
    isActive: (state) => state.selection.$from.parent.type.name === "paragraph" && !listKind(state),
  },
  heading(1, Heading1),
  heading(2, Heading2),
  heading(3, Heading3),
  heading(4, Heading4),
  heading(5, Heading5),
  heading(6, Heading6),

  // Inline formatting
  {
    id: "bold",
    label: "Bold",
    icon: Bold,
    group: "format",
    toolbar: true,
    run: (_ctx, view) => run(view, toggleMark(view.state.schema.marks.strong)),
    isActive: (state) => markActive(state, state.schema.marks.strong),
    isEnabled: (state) => !inCodeBlock(state),
  },
  {
    id: "italic",
    label: "Italic",
    icon: Italic,
    group: "format",
    toolbar: true,
    run: (_ctx, view) => run(view, toggleMark(view.state.schema.marks.emphasis)),
    isActive: (state) => markActive(state, state.schema.marks.emphasis),
    isEnabled: (state) => !inCodeBlock(state),
  },
  {
    id: "underline",
    label: "Underline",
    icon: Underline,
    group: "format",
    toolbar: true,
    run: (_ctx, view) => run(view, toggleMark(view.state.schema.marks.underline)),
    isActive: (state) => markActive(state, state.schema.marks.underline),
    isEnabled: (state) => !inCodeBlock(state) && !!state.schema.marks.underline,
  },
  {
    id: "strike",
    label: "Strikethrough",
    icon: Strikethrough,
    group: "format",
    toolbar: true,
    run: (_ctx, view) => run(view, toggleMark(view.state.schema.marks.strike_through)),
    isActive: (state) => markActive(state, state.schema.marks.strike_through),
    isEnabled: (state) => !inCodeBlock(state),
  },
  {
    id: "inline-code",
    label: "Inline code",
    icon: Code,
    group: "format",
    toolbar: true,
    run: (_ctx, view) => run(view, toggleMark(view.state.schema.marks.inlineCode)),
    isActive: (state) => markActive(state, state.schema.marks.inlineCode),
    isEnabled: (state) => !inCodeBlock(state),
  },
  {
    id: "link",
    label: "Link",
    icon: Link,
    group: "format",
    toolbar: true,
    run: (ctx, view) => insertLink(view, ctx),
    isActive: (state) => markActive(state, state.schema.marks.link),
    isEnabled: (state) => !inCodeBlock(state),
  },

  // Lists
  {
    id: "bullet-list",
    label: "Bulleted list",
    icon: List,
    group: "list",
    keywords: ["ul", "unordered", "bullet"],
    slash: true,
    toolbar: true,
    run: (ctx, view) => toggleList(view, ctx, "bullet"),
    isActive: (state) => listKind(state) === "bullet",
    isEnabled: (state) => !inCodeBlock(state),
  },
  {
    id: "ordered-list",
    label: "Numbered list",
    icon: ListOrdered,
    group: "list",
    keywords: ["ol", "ordered", "number"],
    slash: true,
    toolbar: true,
    run: (ctx, view) => toggleList(view, ctx, "ordered"),
    isActive: (state) => listKind(state) === "ordered",
    isEnabled: (state) => !inCodeBlock(state),
  },
  {
    id: "task-list",
    label: "Checklist",
    icon: ListChecks,
    group: "list",
    keywords: ["todo", "task", "checkbox"],
    slash: true,
    toolbar: true,
    run: (ctx, view) => toggleList(view, ctx, "task"),
    isActive: (state) => listKind(state) === "task",
    isEnabled: (state) => !inCodeBlock(state),
  },

  {
    id: "outdent",
    label: "Outdent list item",
    icon: ListIndentDecrease,
    group: "list",
    keywords: ["unindent", "dedent", "lift"],
    toolbar: true,
    builtinKey: "⇧Tab",
    run: (_ctx, view) => run(view, liftListItem(view.state.schema.nodes.list_item)),
    isEnabled: (state) => !!listKind(state) && liftListItem(state.schema.nodes.list_item)(state),
  },
  {
    id: "indent",
    label: "Indent list item",
    icon: ListIndentIncrease,
    group: "list",
    keywords: ["indent", "nest", "sink"],
    toolbar: true,
    builtinKey: "Tab",
    run: (_ctx, view) => run(view, sinkListItem(view.state.schema.nodes.list_item)),
    isEnabled: (state) => !!listKind(state) && sinkListItem(state.schema.nodes.list_item)(state),
  },

  // Blocks
  {
    id: "frontmatter",
    label: "Properties (frontmatter)",
    icon: Tags,
    group: "insert",
    keywords: ["frontmatter", "properties", "metadata", "yaml"],
    slash: true,
    toolbar: true,
    keepFocus: true,
    run: () => openFrontmatter(),
    isEnabled: () => hasFrontmatterPanel(),
  },
  {
    id: "quote",
    label: "Quote",
    icon: Quote,
    group: "insert",
    keywords: ["blockquote"],
    slash: true,
    toolbar: true,
    run: (ctx, view) => toggleQuote(view, ctx),
    isActive: (state) => !!ancestor(state, ["blockquote"]),
    isEnabled: (state) => !inCodeBlock(state) && !inTable(state),
  },
  {
    id: "code-block",
    label: "Code block",
    icon: CodeXml,
    group: "insert",
    keywords: ["fence", "snippet", "pre"],
    slash: true,
    toolbar: true,
    run: (ctx, view) => toggleCodeBlock(view, ctx),
    isActive: inCodeBlock,
    isEnabled: (state) => !inTable(state),
  },
  {
    id: "table",
    label: "Table",
    icon: Table,
    group: "insert",
    keywords: ["grid", "columns"],
    slash: true,
    toolbar: true,
    run: (ctx, view) => {
      insertBlock(view, createTable(ctx, 3, 3));
      view.focus();
    },
    isEnabled: (state) => !inCodeBlock(state) && !inTable(state),
  },
  {
    id: "divider",
    label: "Divider",
    icon: Minus,
    group: "insert",
    keywords: ["hr", "rule", "separator", "line"],
    slash: true,
    toolbar: true,
    run: (ctx, view) => {
      const { $from } = view.state.selection;
      const parent = $from.parent;
      if (parent.isTextblock && parent.content.size === 0) {
        // An empty line becomes the rule plus a fresh line to type on, as
        // the `/hr` shortcut does, rather than the caret jumping into the next block.
        const hr = hrSchema.type(ctx).create();
        const line = paragraphSchema.type(ctx).create();
        const container = $from.node(-1);
        const i = $from.index(-1);
        if ($from.depth >= 1 && container.canReplace(i, i + 1, Fragment.from([hr, line]))) {
          const from = $from.before();
          const tr = view.state.tr.replaceWith(from, $from.after(), [hr, line]);
          view.dispatch(tr.setSelection(TextSelection.create(tr.doc, from + hr.nodeSize + 1)).scrollIntoView());
        } else call(ctx, addBlockTypeCommand.key, { nodeType: hrSchema.type(ctx) });
      }
      else insertBlock(view, hrSchema.type(ctx).create());
    },
    isEnabled: (state) => !inCodeBlock(state) && !inTable(state),
  },
  {
    id: "image",
    label: "Image",
    icon: Image,
    group: "insert",
    keywords: ["picture", "photo", "upload"],
    slash: true,
    toolbar: true,
    run: (ctx, view) => insertBlock(view, imageBlockSchema.type(ctx).create()),
    isEnabled: (state) => !inCodeBlock(state) && !inTable(state),
  },
  {
    id: "mermaid",
    label: "Diagram",
    icon: Workflow,
    group: "insert",
    keywords: ["mermaid", "chart", "flowchart", "graph"],
    slash: true,
    run: (ctx, view) => {
      const code = codeBlockSchema.type(ctx);
      insertBlock(view, code.create({ language: "mermaid" }, view.state.schema.text("graph TD\n  A --> B")));
    },
    isEnabled: (state) => !inCodeBlock(state) && !inTable(state),
  },
  {
    id: "math-block",
    label: "Equation",
    icon: Sigma,
    group: "insert",
    keywords: ["math", "latex", "tex", "katex", "formula", "$$"],
    slash: true,
    run: (ctx, view) => insertBlock(view, codeBlockSchema.type(ctx).create({ language: "LaTeX" })),
    isEnabled: (state) => !inCodeBlock(state) && !inTable(state),
  },
  {
    id: "math-inline",
    label: "Inline equation",
    icon: Radical,
    group: "insert",
    keywords: ["math", "latex", "tex", "katex", "formula", "$"],
    slash: true,
    // Its editor takes focus.
    keepFocus: true,
    run: (ctx) => insertInlineMath(ctx),
    isEnabled: (state) => !inCodeBlock(state),
  },
  {
    id: "drawio",
    label: "draw.io diagram",
    icon: Shapes,
    group: "insert",
    keywords: ["drawio", "draw.io", "diagrams.net", "diagram", "flowchart", "whiteboard"],
    slash: true,
    keepFocus: true,
    run: (_ctx, view) =>
      void insertDiagram(view, (href) =>
        view.dispatch(insertAttachments(view.state.tr, view.state.selection.from, [{ href, name: "", image: true }])),
      ),
    isEnabled: (state) => !inCodeBlock(state) && !inTable(state),
  },
  {
    id: "toc",
    label: "Table of contents",
    icon: ListTree,
    group: "insert",
    keywords: ["toc", "contents", "outline"],
    slash: true,
    run: (ctx) => call(ctx, insertTocCommand.key),
    isEnabled: (state) => !inCodeBlock(state) && !inTable(state),
  },

  // Comments
  {
    id: "comment-add",
    label: "Add comment",
    icon: MessageSquarePlus,
    group: "comment",
    keywords: ["comment", "note", "review", "annotate"],
    slash: true,
    toolbar: true,
    keepFocus: true,
    run: () => addComment(),
    isEnabled: (state) => !state.selection.empty || state.selection.$from.parent.content.size > 0,
  },
  {
    id: "comments",
    label: "Comments",
    icon: MessagesSquare,
    group: "comment",
    toolbar: true,
    keepFocus: true,
    run: () => toggleComments(),
    isActive: () => commentsOpen(),
    badge: (state) => openCommentCount(state.doc),
  },

  // Alerts
  alert("note", "Note", Info),
  alert("tip", "Tip", Lightbulb),
  alert("important", "Important", MessageSquareWarning),
  alert("warning", "Warning", TriangleAlert),
  alert("caution", "Caution", OctagonAlert),

  // Table (contextual)
  {
    id: "row-above",
    label: "Insert row above",
    icon: ArrowUpToLine,
    group: "table",
    run: (ctx, view) => tableAction(view, () => call(ctx, addRowBeforeCommand.key), (c) => [c.row, c.col]),
    isEnabled: inBodyRow,
  },
  {
    id: "row-below",
    label: "Insert row below",
    icon: ArrowDownToLine,
    group: "table",
    run: (ctx, view) => tableAction(view, () => call(ctx, addRowAfterCommand.key), (c) => [c.row + 1, c.col]),
    isEnabled: inTable,
  },
  {
    id: "col-left",
    label: "Insert column left",
    icon: ArrowLeftToLine,
    group: "table",
    run: (_ctx, view) =>
      tableAction(
        view,
        (c) => withColumnWidths(view, c.tableStart, { insert: c.col }, () => run(view, addColumnBefore)),
        (c) => [c.row, c.col],
      ),
    isEnabled: inTable,
  },
  {
    id: "col-right",
    label: "Insert column right",
    icon: ArrowRightToLine,
    group: "table",
    run: (_ctx, view) =>
      tableAction(
        view,
        (c) => withColumnWidths(view, c.tableStart, { insert: c.col + 1 }, () => run(view, addColumnAfter)),
        (c) => [c.row, c.col + 1],
      ),
    isEnabled: inTable,
  },
  {
    id: "row-up",
    label: "Move row up",
    icon: ArrowUp,
    group: "table",
    run: (_ctx, view) => moveRow(view, -1),
    isEnabled: (state) => (currentCell(state)?.row ?? 0) > headerRows(state),
  },
  {
    id: "row-down",
    label: "Move row down",
    icon: ArrowDown,
    group: "table",
    run: (_ctx, view) => moveRow(view, 1),
    isEnabled: (state) => {
      const c = currentCell(state);
      return !!c && c.row >= headerRows(state) && c.row < c.rows - 1;
    },
  },
  {
    id: "col-left-move",
    label: "Move column left",
    icon: ArrowLeft,
    group: "table",
    run: (_ctx, view) => moveCol(view, -1),
    isEnabled: (state) => (currentCell(state)?.col ?? 0) > 0,
  },
  {
    id: "col-right-move",
    label: "Move column right",
    icon: ArrowRight,
    group: "table",
    run: (_ctx, view) => moveCol(view, 1),
    isEnabled: (state) => {
      const c = currentCell(state);
      return !!c && c.col < c.cols - 1;
    },
  },
  {
    id: "align-left",
    label: "Align column left",
    icon: AlignLeft,
    group: "table",
    run: (ctx, view) => alignColumn(view, ctx, "left"),
    isActive: (state) => columnAlignment(state) === "left",
    isEnabled: inTable,
  },
  {
    id: "align-center",
    label: "Align column center",
    icon: AlignCenter,
    group: "table",
    run: (ctx, view) => alignColumn(view, ctx, "center"),
    isActive: (state) => columnAlignment(state) === "center",
    isEnabled: inTable,
  },
  {
    id: "align-right",
    label: "Align column right",
    icon: AlignRight,
    group: "table",
    run: (ctx, view) => alignColumn(view, ctx, "right"),
    isActive: (state) => columnAlignment(state) === "right",
    isEnabled: inTable,
  },
  {
    id: "table-width",
    label: "Full width",
    icon: Maximize2,
    group: "table",
    run: (ctx, view) => {
      const c = currentCell(view.state);
      if (!c) return;
      call(ctx, toggleTableFullWidthCommand.key, { pos: c.tableStart });
      focusCell(view, c.tableStart, c.row, c.col);
      view.focus();
    },
    isActive: (state) => {
      const c = currentCell(state);
      return !!c && !!tableAt(state, c.tableStart)?.node.attrs.fullWidth;
    },
    menuLabel: (state) => (currentTable(state)?.node.attrs.fullWidth ? "Fit to text column" : "Full width"),
    isEnabled: inTable,
  },
  {
    id: "table-header",
    label: "Header row",
    icon: PanelTop,
    group: "table",
    keywords: ["header", "heading row"],
    run: (_ctx, view) => toggleHeaderRow(view),
    isActive: (state) => inTable(state) && headerRows(state) === 1,
    menuLabel: (state) => (headerRows(state) ? "Remove header row" : "Make first row the header"),
    // A table keeps at least one ordinary row.
    isEnabled: (state) => {
      const c = currentCell(state);
      return !!c && c.rows > 1;
    },
  },
  {
    id: "table-total",
    label: "Total row",
    icon: PanelBottom,
    group: "table",
    keywords: ["total", "sum"],
    run: (_ctx, view) => toggleTotalRow(view),
    isActive: (state) => !!currentTable(state)?.node.attrs.totalRow,
    menuLabel: (state) => (currentTable(state)?.node.attrs.totalRow ? "Remove total row styling" : "Add total row"),
    isEnabled: inTable,
  },
  {
    id: "delete-row",
    label: "Delete row",
    icon: TableRowsSplit,
    group: "table",
    danger: true,
    run: (_ctx, view) => tableAction(view, () => run(view, deleteRow), (c) => [Math.min(c.row, c.rows - 2), c.col]),
    isEnabled: (state) => {
      const c = currentCell(state);
      return !!c && c.row >= headerRows(state) && c.rows - headerRows(state) > 1;
    },
  },
  {
    id: "delete-col",
    label: "Delete column",
    icon: TableColumnsSplit,
    group: "table",
    danger: true,
    run: (_ctx, view) =>
      tableAction(
        view,
        (c) => withColumnWidths(view, c.tableStart, { remove: c.col }, () => run(view, deleteColumn)),
        (c) => [c.row, Math.min(c.col, c.cols - 2)],
      ),
    isEnabled: (state) => (currentCell(state)?.cols ?? 0) > 1,
  },
  {
    id: "delete-table",
    label: "Delete table",
    icon: Trash2,
    group: "table",
    danger: true,
    run: (_ctx, view) => {
      run(view, deleteTable);
      view.focus();
    },
    isEnabled: inTable,
  },
];

export function command(id: string): EditorCommand {
  const found = COMMANDS.find((c) => c.id === id);
  if (!found) throw new Error(`unknown command ${id}`);
  return found;
}

/** Run a command against the live editor. */
export function execute(ctx: Ctx, cmd: EditorCommand): void {
  const view = ctx.get(editorViewCtx);
  if (cmd.isEnabled && !cmd.isEnabled(view.state)) return;
  cmd.run(ctx, view);
  const keep = typeof cmd.keepFocus === "function" ? cmd.keepFocus() : cmd.keepFocus;
  if (!keep && !view.hasFocus()) view.focus();
}
