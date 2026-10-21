/**
 * The bottom toolbar: quick access to the essential commands, with their
 * state (active, disabled) following the caret. Inside a table it swaps the
 * list and insert groups (which do not apply there) for every table action.
 */
import type { Ctx } from "@milkdown/kit/ctx";
import { Plugin, PluginKey, type EditorState } from "@milkdown/kit/prose/state";
import type { EditorView } from "@milkdown/kit/prose/view";
import { $prose } from "@milkdown/kit/utils";
import { createElement } from "lucide";

import { COMMANDS, command, currentCell, execute, type EditorCommand } from "./commands";

const MAIN = [
  ["undo", "redo"],
  ["heading1", "heading2", "heading3"],
  ["bold", "italic", "strike", "inline-code", "link"],
  ["bullet-list", "ordered-list", "task-list"],
  ["quote", "code-block", "table", "divider", "image"],
];

const TABLE = [
  ["undo", "redo"],
  ["bold", "italic", "strike", "inline-code", "link"],
  ["row-above", "row-below", "col-left", "col-right"],
  ["row-up", "row-down", "col-left-move", "col-right-move"],
  ["align-left", "align-center", "align-right", "table-width"],
  ["delete-row", "delete-col", "delete-table"],
];

class Toolbar {
  readonly el: HTMLElement;
  private mode: "main" | "table" | null = null;
  private buttons = new Map<string, HTMLButtonElement>();

  constructor(
    private readonly ctx: Ctx,
    private readonly host: HTMLElement,
  ) {
    this.el = document.createElement("div");
    this.el.className = "ken-toolbar";
    this.el.setAttribute("role", "toolbar");
    this.el.setAttribute("aria-label", "Formatting");
    // Clicking a button must not take focus or the selection from the text.
    this.el.addEventListener("mousedown", (e) => e.preventDefault());
    host.append(this.el);
  }

  private build(mode: "main" | "table") {
    this.mode = mode;
    this.buttons.clear();
    this.el.replaceChildren();
    this.el.dataset.mode = mode;
    const groups = mode === "table" ? TABLE : MAIN;
    if (mode === "table") {
      const label = document.createElement("span");
      label.className = "ken-toolbar-label";
      label.textContent = "Table";
      this.el.append(label);
    }
    groups.forEach((ids, g) => {
      if (g > 0 || mode === "table") {
        const sep = document.createElement("span");
        sep.className = "ken-toolbar-separator";
        this.el.append(sep);
      }
      for (const id of ids) this.el.append(this.button(command(id)));
    });
  }

  private button(cmd: EditorCommand): HTMLButtonElement {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "ken-toolbar-button";
    if (cmd.danger) b.classList.add("danger");
    b.dataset.id = cmd.id;
    b.title = cmd.shortcut ? `${cmd.label} (${cmd.shortcut})` : cmd.label;
    b.setAttribute("aria-label", cmd.label);
    b.append(createElement(cmd.icon, { width: 16, height: 16, "stroke-width": 1.75 }));
    b.addEventListener("click", () => execute(this.ctx, cmd));
    this.buttons.set(cmd.id, b);
    return b;
  }

  update(state: EditorState) {
    const mode = currentCell(state) ? "table" : "main";
    if (mode !== this.mode) this.build(mode);
    for (const [id, b] of this.buttons) {
      const cmd = COMMANDS.find((c) => c.id === id)!;
      const enabled = !cmd.isEnabled || cmd.isEnabled(state);
      const active = !!cmd.isActive?.(state);
      b.disabled = !enabled;
      b.classList.toggle("active", active);
      b.setAttribute("aria-pressed", String(active));
    }
  }

  destroy() {
    this.el.remove();
  }
}

/** Mounts the toolbar into `host` and keeps it in step with the editor. */
export function toolbarPlugin(host: HTMLElement) {
  return $prose(
    (ctx) =>
      new Plugin({
        key: new PluginKey("ken-toolbar"),
        view: (view: EditorView) => {
          const toolbar = new Toolbar(ctx, host);
          toolbar.update(view.state);
          return {
            update: (v) => toolbar.update(v.state),
            destroy: () => toolbar.destroy(),
          };
        },
      }),
  );
}
