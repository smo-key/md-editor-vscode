/**
 * Table keys that make a table quick to fill in, ahead of the GFM preset's:
 * Tab in the last cell adds a row; Enter moves to the cell below and leaves
 * the table from the last row (a GFM cell holds a single line, so Enter can
 * never split one). Mod-Enter still leaves the table from anywhere.
 */
import { commandsCtx, editorViewCtx } from "@milkdown/kit/core";
import type { Ctx } from "@milkdown/kit/ctx";
import { addRowAfterCommand, exitTable } from "@milkdown/kit/preset/gfm";
import { NodeSelection, Plugin, PluginKey } from "@milkdown/kit/prose/state";
import { $prose, $useKeymap } from "@milkdown/kit/utils";

import { command, currentCell, execute, focusCell } from "./commands";

export const tableKeys = $useKeymap("kenTableKeys", {
  NextCellOrNewRow: {
    priority: 200,
    shortcuts: "Tab",
    command: (ctx: Ctx) => (state) => {
      const c = currentCell(state);
      if (!c || c.row !== c.rows - 1 || c.col !== c.cols - 1) return false;
      ctx.get(commandsCtx).call(addRowAfterCommand.key);
      focusCell(ctx.get(editorViewCtx), c.tableStart, c.row + 1, 0);
      return true;
    },
  },
  CellBelowOrExit: {
    priority: 200,
    shortcuts: "Enter",
    command: (ctx: Ctx) => (state) => {
      const c = currentCell(state);
      if (!c) return false;
      if (c.row < c.rows - 1) {
        focusCell(ctx.get(editorViewCtx), c.tableStart, c.row + 1, c.col);
        return true;
      }
      return ctx.get(commandsCtx).call(exitTable.key);
    },
  },
  Link: {
    priority: 200,
    shortcuts: "Mod-k",
    command: (ctx: Ctx) => () => {
      execute(ctx, command("link"));
      return true;
    },
  },
});

/**
 * Clicking into a table cell places the caret where you clicked. Crepe's table
 * view instead selects the cell's whole paragraph a frame after the click, so
 * the next keystroke replaced the cell's content (and a keystroke inside that
 * frame failed outright). Those selections are filtered out here.
 */
export const tableCellClickFix = $prose(
  () =>
    new Plugin({
      key: new PluginKey("ken-table-click"),
      filterTransaction: (tr) => {
        if (tr.docChanged || !tr.selectionSet) return true;
        const sel = tr.selection;
        if (!(sel instanceof NodeSelection) || sel.node.type.name !== "paragraph") return true;
        const parent = sel.$from.parent.type.name;
        return parent !== "table_cell" && parent !== "table_header";
      },
    }),
);
