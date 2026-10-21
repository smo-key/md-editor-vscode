/**
 * Right-click menu for Markdown tables.
 *
 * Crepe's own table affordances are hover handles, which are easy to miss and
 * awkward on a trackpad. This adds the obvious gesture: right-click a cell and
 * get the editor's context menu with every table action in one list. The
 * WebView's native menu is suppressed so the app's menu is the only one.
 *
 * Every action is a GFM preset command, run against the cell under the
 * pointer: the handler puts the selection there first, so `addRowBefore` and
 * friends act on the cell that was clicked rather than wherever the caret
 * happened to be.
 */
import { commandsCtx } from "@milkdown/kit/core";
import type { Ctx } from "@milkdown/kit/ctx";
import type { EditorView } from "@milkdown/kit/prose/view";
import { Plugin, PluginKey, TextSelection } from "@milkdown/kit/prose/state";
import {
  addColAfterCommand,
  addColBeforeCommand,
  addRowAfterCommand,
  addRowBeforeCommand,
  deleteSelectedCellsCommand,
  selectColCommand,
  selectRowCommand,
  setAlignCommand,
} from "@milkdown/kit/preset/gfm";
import { $prose } from "@milkdown/kit/utils";

import {
  AlignCenter,
  AlignLeft,
  AlignRight,
  ArrowDownToLine,
  ArrowLeftToLine,
  ArrowRightToLine,
  ArrowUpToLine,
  Maximize2,
  Minimize2,
  Trash2,
} from "lucide";

import { openContextMenu, type MenuEntry } from "../contextMenu";
import { tableAt, toggleTableFullWidthCommand } from "./tableFullWidth";

/** Where the pointer was, in document and grid terms. */
interface CellTarget {
  /** A position inside the clicked cell. */
  pos: number;
  /** Index of the clicked cell's column, counting from zero. */
  col: number;
  /** Index of the clicked cell's row; the header row is row zero. */
  row: number;
}

/**
 * Resolve the cell under the pointer. The grid indices come from the DOM
 * (`cellIndex`/`rowIndex` are exactly the numbers the select commands want)
 * and the document position from `posAtCoords`, so a click anywhere in the
 * cell — padding included — lands in the right place.
 */
function cellAtPointer(
  view: EditorView,
  event: MouseEvent,
): CellTarget | undefined {
  const target = event.target;
  if (!(target instanceof Element)) return undefined;
  const cell = target.closest("th, td");
  if (!(cell instanceof HTMLTableCellElement)) return undefined;
  const row = cell.parentElement;
  if (!(row instanceof HTMLTableRowElement)) return undefined;

  const coords = view.posAtCoords({ left: event.clientX, top: event.clientY });
  if (!coords) return undefined;
  const pos = coords.inside >= 0 ? coords.inside : coords.pos;
  if (!tableAt(view.state, pos)) return undefined;

  return { pos, col: cell.cellIndex, row: row.rowIndex };
}

/** Put the caret in the clicked cell so the table commands act on it. */
function focusCell(view: EditorView, pos: number): void {
  const selection = TextSelection.near(view.state.doc.resolve(pos));
  view.dispatch(view.state.tr.setSelection(selection));
}

function run(view: EditorView, target: CellTarget, act: () => void) {
  focusCell(view, target.pos);
  act();
  view.focus();
}

function buildItems(
  ctx: Ctx,
  view: EditorView,
  target: CellTarget,
): MenuEntry[] {
  const commands = ctx.get(commandsCtx);
  const call = (key: Parameters<typeof commands.call>[0], payload?: unknown) =>
    commands.call(key, payload);

  const table = tableAt(view.state, target.pos);
  const isFull = Boolean(table?.node.attrs.fullWidth);

  const act = (fn: () => void) => () => run(view, target, fn);

  // Alignment is a property of the whole column in GFM, so select the column
  // first: `setAlign` writes the attribute onto every selected cell, and the
  // preset's keep-align plugin then holds the column together.
  const align = (alignment: "left" | "center" | "right") =>
    act(() => {
      call(selectColCommand.key, { index: target.col });
      call(setAlignCommand.key, alignment);
    });

  return [
    {
      label: "Insert row above",
      icon: ArrowUpToLine,
      onSelect: act(() => call(addRowBeforeCommand.key)),
    },
    {
      label: "Insert row below",
      icon: ArrowDownToLine,
      onSelect: act(() => call(addRowAfterCommand.key)),
    },
    {
      label: "Insert column left",
      icon: ArrowLeftToLine,
      onSelect: act(() => call(addColBeforeCommand.key)),
    },
    {
      label: "Insert column right",
      icon: ArrowRightToLine,
      onSelect: act(() => call(addColAfterCommand.key)),
    },
    "separator",
    { label: "Align left", icon: AlignLeft, onSelect: align("left") },
    { label: "Align center", icon: AlignCenter, onSelect: align("center") },
    { label: "Align right", icon: AlignRight, onSelect: align("right") },
    "separator",
    {
      label: isFull ? "Fit to text column" : "Full width",
      icon: isFull ? Minimize2 : Maximize2,
      onSelect: act(() =>
        call(toggleTableFullWidthCommand.key, { pos: target.pos }),
      ),
    },
    "separator",
    {
      label: "Delete row",
      icon: Trash2,
      danger: true,
      onSelect: act(() => {
        call(selectRowCommand.key, { index: target.row });
        call(deleteSelectedCellsCommand.key);
      }),
    },
    {
      label: "Delete column",
      icon: Trash2,
      danger: true,
      onSelect: act(() => {
        call(selectColCommand.key, { index: target.col });
        call(deleteSelectedCellsCommand.key);
      }),
    },
    {
      label: "Delete table",
      icon: Trash2,
      danger: true,
      onSelect: () => {
        const found = tableAt(view.state, target.pos);
        if (!found) return;
        view.dispatch(
          view.state.tr.delete(found.pos, found.pos + found.node.nodeSize),
        );
        view.focus();
      },
    },
  ];
}

const tableMenuKey = new PluginKey("ken-table-menu");

/** Right-click inside a table cell opens the app's table menu. */
export const tableContextMenu = $prose(
  (ctx) =>
    new Plugin({
      key: tableMenuKey,
      props: {
        handleDOMEvents: {
          contextmenu: (view, event) => {
            const target = cellAtPointer(view, event);
            if (!target) return false;
            // Suppress the WebView's own menu; ours replaces it here.
            event.preventDefault();
            openContextMenu(
              event.clientX,
              event.clientY,
              buildItems(ctx, view, target),
            );
            return true;
          },
        },
      },
    }),
);
