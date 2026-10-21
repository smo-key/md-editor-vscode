/**
 * Every editing command the UI offers, in one place: the slash menu, the
 * bottom toolbar and the table context menu all draw from this list, so a
 * command behaves the same wherever it is invoked.
 */
import { commandsCtx, editorViewCtx } from "@milkdown/kit/core";
import type { Ctx } from "@milkdown/kit/ctx";
import type { MarkType, Node as ProseNode } from "@milkdown/kit/prose/model";
import { lift, setBlockType, toggleMark, wrapIn } from "@milkdown/kit/prose/commands";
import { redo, undo, redoDepth, undoDepth } from "@milkdown/kit/prose/history";
import { liftListItem, wrapInList } from "@milkdown/kit/prose/schema-list";
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
  ListChecks,
  ListOrdered,
  ListTree,
  Maximize2,
  MessageSquareWarning,
  Minus,
  OctagonAlert,
  Pilcrow,
  Redo2,
  Strikethrough,
  Table,
  TableColumnsSplit,
  TableRowsSplit,
  TextQuote,
  Trash2,
  TriangleAlert,
  Undo2,
  Workflow,
  type IconNode,
} from "lucide";

import { insertGithubAlertCommand, type GithubAlertKind } from "./markdown/githubAlert";
import { insertTocCommand } from "./markdown/toc";
import { tableAt, toggleTableFullWidthCommand } from "./markdown/tableFullWidth";

export type CommandGroup = "history" | "text" | "format" | "list" | "insert" | "alert" | "table";

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
  danger?: boolean;
  run(ctx: Ctx, view: EditorView): void;
  isActive?(state: EditorState): boolean;
  isEnabled?(state: EditorState): boolean;
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
  return labels[id] ?? "";
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

function headingLevel(state: EditorState): number {
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
  if (!wrapInList(listType)(view.state, view.dispatch)) return;
  if (kind === "task") {
    const { $from } = view.state.selection;
    for (let d = $from.depth; d > 0; d--) {
      if ($from.node(d).type.name === "list_item") {
        view.dispatch(view.state.tr.setNodeMarkup($from.before(d), undefined, { ...$from.node(d).attrs, checked: false }));
        break;
      }
    }
  }
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

/** The header row is GFM's: it stays first and cannot be deleted on its own. */
const inBodyRow = (state: EditorState) => (currentCell(state)?.row ?? 0) > 0;

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
    (c) => run(view, moveTableColumn({ from: c.col, to: c.col + by, select: false, pos: c.tableStart })),
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

export const COMMANDS: EditorCommand[] = [
  // History
  {
    id: "undo",
    label: "Undo",
    icon: Undo2,
    group: "history",
    toolbar: true,
    run: (_ctx, view) => run(view, undo),
    isEnabled: (state) => undoDepth(state) > 0,
  },
  {
    id: "redo",
    label: "Redo",
    icon: Redo2,
    group: "history",
    toolbar: true,
    run: (_ctx, view) => run(view, redo),
    isEnabled: (state) => redoDepth(state) > 0,
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
    isEnabled: (state) => !inCodeBlock(state) && !inTable(state),
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
    isEnabled: (state) => !inCodeBlock(state) && !inTable(state),
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
    isEnabled: (state) => !inCodeBlock(state) && !inTable(state),
  },

  // Blocks
  {
    id: "quote",
    label: "Quote",
    icon: TextQuote,
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
      const parent = view.state.selection.$from.parent;
      if (parent.isTextblock && parent.content.size === 0) call(ctx, addBlockTypeCommand.key, { nodeType: hrSchema.type(ctx) });
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
    id: "toc",
    label: "Table of contents",
    icon: ListTree,
    group: "insert",
    keywords: ["toc", "contents", "outline"],
    slash: true,
    run: (ctx) => call(ctx, insertTocCommand.key),
    isEnabled: (state) => !inCodeBlock(state) && !inTable(state),
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
    run: (_ctx, view) => tableAction(view, () => run(view, addColumnBefore), (c) => [c.row, c.col]),
    isEnabled: inTable,
  },
  {
    id: "col-right",
    label: "Insert column right",
    icon: ArrowRightToLine,
    group: "table",
    run: (_ctx, view) => tableAction(view, () => run(view, addColumnAfter), (c) => [c.row, c.col + 1]),
    isEnabled: inTable,
  },
  {
    id: "row-up",
    label: "Move row up",
    icon: ArrowUp,
    group: "table",
    run: (_ctx, view) => moveRow(view, -1),
    isEnabled: (state) => (currentCell(state)?.row ?? 0) > 1,
  },
  {
    id: "row-down",
    label: "Move row down",
    icon: ArrowDown,
    group: "table",
    run: (_ctx, view) => moveRow(view, 1),
    isEnabled: (state) => {
      const c = currentCell(state);
      return !!c && c.row > 0 && c.row < c.rows - 1;
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
      return !!c && c.row > 0 && c.rows > 2;
    },
  },
  {
    id: "delete-col",
    label: "Delete column",
    icon: TableColumnsSplit,
    group: "table",
    danger: true,
    run: (_ctx, view) => tableAction(view, () => run(view, deleteColumn), (c) => [c.row, Math.min(c.col, c.cols - 2)]),
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
  if (!view.hasFocus()) view.focus();
}
