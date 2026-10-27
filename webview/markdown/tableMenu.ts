/**
 * Right-click menu for Markdown tables.
 *
 * Crepe's own table affordances are hover handles, which are easy to miss and
 * awkward on a trackpad. This adds the obvious gesture: right-click a cell and
 * get every table action in one list — the same commands as the bottom
 * toolbar's table mode. The webview's native menu is suppressed so this is
 * the only one.
 *
 * The handler puts the caret in the clicked cell first, so every action works
 * on the cell that was clicked rather than wherever the caret happened to be.
 */
import type { Ctx } from "@milkdown/kit/ctx";
import type { EditorView } from "@milkdown/kit/prose/view";
import { Plugin, PluginKey, TextSelection } from "@milkdown/kit/prose/state";
import { $prose } from "@milkdown/kit/utils";

import { openContextMenu, type MenuEntry } from "../contextMenu";
import { COMMANDS, execute } from "../commands";
import { tableAt } from "./tableFullWidth";

/** A position inside the cell under the pointer, if it is in a table. */
function cellAtPointer(view: EditorView, event: MouseEvent): number | undefined {
  const target = event.target;
  if (!(target instanceof Element)) return undefined;
  if (!target.closest("th, td")) return undefined;
  const coords = view.posAtCoords({ left: event.clientX, top: event.clientY });
  if (!coords) return undefined;
  const pos = coords.inside >= 0 ? coords.inside : coords.pos;
  return tableAt(view.state, pos) ? pos : undefined;
}

/** Menu sections, in order; a separator goes between each. */
const SECTIONS = [
  ["row-above", "row-below", "col-left", "col-right"],
  ["row-up", "row-down", "col-left-move", "col-right-move"],
  ["align-left", "align-center", "align-right"],
  ["table-width", "table-header", "table-total"],
  ["delete-row", "delete-col", "delete-table"],
];

export function tableMenuItems(ctx: Ctx, view: EditorView): MenuEntry[] {
  const entries: MenuEntry[] = [];
  SECTIONS.forEach((ids, i) => {
    if (i > 0) entries.push("separator");
    for (const id of ids) {
      const cmd = COMMANDS.find((c) => c.id === id)!;
      const label = cmd.menuLabel?.(view.state) ?? cmd.label;
      entries.push({
        label,
        icon: cmd.icon,
        danger: cmd.danger,
        disabled: cmd.isEnabled ? !cmd.isEnabled(view.state) : false,
        onSelect: () => execute(ctx, cmd),
      });
    }
  });
  return entries;
}

/** Right-click inside a table cell opens the table menu. */
export const tableContextMenu = $prose(
  (ctx) =>
    new Plugin({
      key: new PluginKey("ken-table-menu"),
      props: {
        handleDOMEvents: {
          contextmenu: (view, event) => {
            const pos = cellAtPointer(view, event);
            if (pos === undefined) return false;
            event.preventDefault();
            view.dispatch(view.state.tr.setSelection(TextSelection.near(view.state.doc.resolve(pos))));
            openContextMenu(event.clientX, event.clientY, tableMenuItems(ctx, view));
            return true;
          },
        },
      },
    }),
);
