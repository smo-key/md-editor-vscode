/**
 * Table keys that make a table quick to fill in, ahead of the GFM preset's:
 * Tab in the last cell adds a row; Enter moves to the cell below and leaves
 * the table from the last row (a GFM cell holds a single line, so Enter can
 * never split one). Mod-Enter still leaves the table from anywhere. (Shortcuts
 * with letters and digits belong to VS Code: see keys.ts.)
 */
import { commandsCtx, editorViewCtx } from "@milkdown/kit/core";
import type { Ctx } from "@milkdown/kit/ctx";
import { addRowAfterCommand, exitTable } from "@milkdown/kit/preset/gfm";
import { NodeSelection, Plugin, PluginKey } from "@milkdown/kit/prose/state";
import { $prose, $useKeymap } from "@milkdown/kit/utils";

import { currentCell, focusCell } from "./commands";

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

/**
 * Tab / Shift+Tab on a heading make it one level smaller / larger (H2 → H3,
 * H3 → H2), stopping at H6 and H1. Lists keep Tab for indenting, tables for
 * moving between cells: this only applies in a heading.
 */
export const headingLevelKeys = $useKeymap("kenHeadingLevel", {
  Deeper: {
    priority: 150,
    shortcuts: "Tab",
    command: () => (state, dispatch) => {
      const { $from } = state.selection;
      const node = $from.parent;
      if (node.type.name !== "heading") return false;
      const level = node.attrs.level as number;
      if (level < 6 && dispatch) dispatch(state.tr.setNodeMarkup($from.before(), undefined, { ...node.attrs, level: level + 1 }));
      return true;
    },
  },
  Shallower: {
    priority: 150,
    shortcuts: "Shift-Tab",
    command: () => (state, dispatch) => {
      const { $from } = state.selection;
      const node = $from.parent;
      if (node.type.name !== "heading") return false;
      const level = node.attrs.level as number;
      if (level > 1 && dispatch) dispatch(state.tr.setNodeMarkup($from.before(), undefined, { ...node.attrs, level: level - 1 }));
      return true;
    },
  },
});
