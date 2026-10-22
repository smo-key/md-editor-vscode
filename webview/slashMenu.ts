/**
 * The slash menu. Typing "/" at the start of a line, or after a space,
 * immediately opens a compact list of block commands, filtered as you keep
 * typing. Works everywhere text can go except code: paragraphs, headings,
 * list items, quotes, alerts and table cells.
 *
 * Replaces Crepe's own slash menu, which only opened when the whole block was
 * the slash text, never inside lists, and after a debounce.
 */
import type { Ctx } from "@milkdown/kit/ctx";
import { Plugin, PluginKey, type EditorState } from "@milkdown/kit/prose/state";
import type { EditorView } from "@milkdown/kit/prose/view";
import { $prose } from "@milkdown/kit/utils";
import { createElement } from "lucide";

import { COMMANDS, execute, shortcutFor, type EditorCommand } from "./commands";

export interface SlashMatch {
  /** Position of the "/". */
  from: number;
  /** The caret (end of the query). */
  to: number;
  query: string;
}

const TRIGGER = /(?:^|\s)\/([\p{L}\p{N}-]{0,32})$/u;

/** The slash query the caret is in, if any. */
export function slashMatch(state: EditorState): SlashMatch | null {
  const { selection } = state;
  if (!selection.empty) return null;
  const { $from } = selection;
  const parent = $from.parent;
  if (!parent.isTextblock || parent.type.spec.code) return null;
  const before = parent.textBetween(0, $from.parentOffset, undefined, "\ufffc");
  const m = TRIGGER.exec(before);
  if (!m) return null;
  return { from: $from.pos - m[1].length - 1, to: $from.pos, query: m[1] };
}

/** Commands matching `query`, best first. */
export function filterCommands(commands: EditorCommand[], query: string): EditorCommand[] {
  const q = query.toLowerCase();
  if (!q) return commands;
  const scored: [number, EditorCommand][] = [];
  for (const c of commands) {
    const label = c.label.toLowerCase();
    const words = [...label.split(/\s+/), ...(c.keywords ?? []).map((k) => k.toLowerCase())];
    let score = -1;
    if (label.startsWith(q)) score = 0;
    else if (words.some((w) => w === q)) score = 1;
    else if (words.some((w) => w.startsWith(q))) score = 2;
    else if (label.includes(q)) score = 3;
    if (score >= 0) scored.push([score, c]);
  }
  return scored.sort((a, b) => a[0] - b[0]).map(([, c]) => c);
}

const key = new PluginKey("ken-slash-menu");

class SlashMenuView {
  private readonly el: HTMLElement;
  private items: EditorCommand[] = [];
  private index = 0;
  private match: SlashMatch | null = null;
  /** A "/" the user dismissed with Escape stays closed until retyped. */
  private dismissed: number | null = null;

  constructor(
    private readonly ctx: Ctx,
    private readonly view: EditorView,
  ) {
    this.el = document.createElement("div");
    this.el.className = "ken-slash-menu";
    this.el.setAttribute("role", "listbox");
    this.el.hidden = true;
    // Keep the editor's focus and selection while clicking in the menu.
    this.el.addEventListener("mousedown", (e) => e.preventDefault());
    document.body.append(this.el);
    view.dom.addEventListener("blur", this.onBlur);
    this.update(view);
  }

  private readonly onBlur = () => this.hide();

  get isOpen(): boolean {
    return !this.el.hidden;
  }

  update(view: EditorView) {
    const match = slashMatch(view.state);
    if (!match || match.from === this.dismissed) {
      if (!match) this.dismissed = null;
      this.hide();
      return;
    }
    const sameQuery = this.match && this.match.from === match.from && this.match.query === match.query;
    this.match = match;
    if (!sameQuery) {
      this.items = filterCommands(
        COMMANDS.filter((c) => c.slash && (!c.isEnabled || c.isEnabled(view.state))),
        match.query,
      );
      this.index = 0;
    }
    if (this.items.length === 0) {
      this.hide();
      return;
    }
    if (!sameQuery || !this.isOpen) this.render();
    this.position();
  }

  private render() {
    this.el.replaceChildren();
    let group = "";
    this.items.forEach((cmd, i) => {
      if (group && cmd.group !== group && !this.match?.query) {
        const sep = document.createElement("div");
        sep.className = "ken-slash-separator";
        this.el.append(sep);
      }
      group = cmd.group;
      const row = document.createElement("div");
      row.className = "ken-slash-item";
      row.setAttribute("role", "option");
      row.dataset.id = cmd.id;
      if (cmd.danger) row.classList.add("danger");
      const icon = createElement(cmd.icon, { width: 14, height: 14, "stroke-width": 1.75 });
      icon.classList.add("ken-slash-icon");
      const label = document.createElement("span");
      label.className = "ken-slash-label";
      label.textContent = cmd.label;
      row.append(icon, label);
      const key = shortcutFor(cmd.id);
      if (key) {
        const hint = document.createElement("span");
        hint.className = "ken-slash-hint";
        hint.textContent = key;
        row.append(hint);
      }
      row.addEventListener("mousemove", () => {
        if (this.index !== i) this.select(i);
      });
      row.addEventListener("click", () => this.choose(i));
      this.el.append(row);
    });
    this.el.hidden = false;
    this.select(this.index);
  }

  private select(i: number) {
    this.index = i;
    const rows = this.el.querySelectorAll<HTMLElement>(".ken-slash-item");
    rows.forEach((row, j) => row.classList.toggle("active", j === i));
    rows[i]?.scrollIntoView({ block: "nearest" });
  }

  private position() {
    if (!this.match) return;
    const coords = this.view.coordsAtPos(this.match.from);
    const menu = this.el.getBoundingClientRect();
    // Stay clear of the toolbar, wherever it is.
    const toolbar = document.querySelector(".ken-toolbar")?.getBoundingClientRect();
    const atTop = document.body.dataset.toolbar === "top";
    const floor = (toolbar && !atTop && toolbar.height ? toolbar.top : window.innerHeight) - 4;
    const ceiling = (toolbar && atTop && toolbar.height ? toolbar.bottom : 0) + 4;
    const below = coords.bottom + 4;
    const top = below + menu.height <= floor ? below : Math.max(ceiling, coords.top - menu.height - 4);
    const left = Math.max(4, Math.min(coords.left, window.innerWidth - menu.width - 4));
    this.el.style.top = `${top}px`;
    this.el.style.left = `${left}px`;
  }

  private choose(i: number) {
    const cmd = this.items[i];
    const match = this.match;
    if (!cmd || !match) return;
    this.hide();
    // Remove the "/query" text, then run the command where it was.
    this.view.dispatch(this.view.state.tr.delete(match.from, match.to));
    execute(this.ctx, cmd);
  }

  hide() {
    this.el.hidden = true;
    this.match = null;
  }

  /** Keyboard handling while open; true when the key was used. */
  keydown(event: KeyboardEvent): boolean {
    if (!this.isOpen || event.isComposing) return false;
    const n = this.items.length;
    switch (event.key) {
      case "ArrowDown":
        this.select((this.index + 1) % n);
        return true;
      case "ArrowUp":
        this.select((this.index - 1 + n) % n);
        return true;
      case "Enter":
      case "Tab":
        this.choose(this.index);
        return true;
      case "Escape":
        this.dismissed = this.match?.from ?? null;
        this.hide();
        return true;
      default:
        return false;
    }
  }

  destroy() {
    this.view.dom.removeEventListener("blur", this.onBlur);
    this.el.remove();
  }
}

export const slashMenuPlugin = $prose((ctx) => {
  let menu: SlashMenuView | null = null;
  return new Plugin({
    key,
    view: (view) => {
      menu = new SlashMenuView(ctx, view);
      return menu;
    },
    props: {
      // A DOM handler runs before every keymap, so Enter, Tab and the arrows
      // reach the menu first while it is open.
      handleDOMEvents: {
        keydown: (_view, event) => {
          if (!menu?.keydown(event)) return false;
          event.preventDefault();
          return true;
        },
      },
    },
  });
});
