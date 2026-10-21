/**
 * The toolbar's heading control: a segmented button.
 *
 * - Left segment: the heading level in play — the caret's own heading level
 *   when it is in a heading, otherwise the level last picked from the menu.
 *   Clicking it applies that level (or, on a heading of that level, turns it
 *   back into text).
 * - Right segment (▾): a menu of Text and Heading 1–6, each previewed at its
 *   size with its shortcut. Picking a heading also makes it the left
 *   segment's level from then on (remembered across editors and sessions).
 */
import type { Ctx } from "@milkdown/kit/ctx";
import type { EditorState } from "@milkdown/kit/prose/state";
import { Check, ChevronDown, createElement, type IconNode } from "lucide";

import { command, execute, headingLevel, shortcutFor } from "./commands";

let lastLevel = 1;
const levelListeners = new Set<(level: number) => void>();

/** The level the left segment offers outside headings (from the host's prefs). */
export function setLastHeadingLevel(level: number): void {
  if (Number.isInteger(level) && level >= 1 && level <= 6) lastLevel = level;
}

export function getLastHeadingLevel(): number {
  return lastLevel;
}

/** Called when the user picks a heading level from the menu (to persist it). */
export function onLastHeadingLevel(listener: (level: number) => void): () => void {
  levelListeners.add(listener);
  return () => levelListeners.delete(listener);
}

const MENU: { id: string; label: string; level: number }[] = [
  { id: "paragraph", label: "Text", level: 0 },
  ...[1, 2, 3, 4, 5, 6].map((level) => ({ id: `heading${level}`, label: `Heading ${level}`, level })),
];

export class HeadingControl {
  readonly el: HTMLElement;
  private readonly main: HTMLButtonElement;
  private readonly arrow: HTMLButtonElement;
  private menu: HTMLElement | null = null;
  private state: EditorState | null = null;
  private shown = lastLevel;

  constructor(private readonly ctx: Ctx) {
    this.el = document.createElement("div");
    this.el.className = "ken-heading-control";
    this.el.setAttribute("role", "group");
    this.el.setAttribute("aria-label", "Heading");

    this.main = document.createElement("button");
    this.main.type = "button";
    this.main.className = "ken-toolbar-button ken-heading-main";
    this.main.dataset.id = "heading";
    this.main.addEventListener("click", () => {
      this.close();
      execute(this.ctx, command(`heading${this.shown}`));
    });

    this.arrow = document.createElement("button");
    this.arrow.type = "button";
    this.arrow.className = "ken-toolbar-button ken-heading-arrow";
    this.arrow.dataset.id = "heading-menu";
    this.arrow.title = "Text style";
    this.arrow.setAttribute("aria-label", "Choose text style");
    this.arrow.setAttribute("aria-haspopup", "menu");
    this.arrow.setAttribute("aria-expanded", "false");
    this.arrow.append(createElement(ChevronDown, { width: 12, height: 12, "stroke-width": 2 }));
    this.arrow.addEventListener("click", () => (this.menu ? this.close() : this.open()));

    this.el.append(this.main, this.arrow);
  }

  update(state: EditorState): void {
    this.state = state;
    const current = headingLevel(state);
    this.shown = current || lastLevel;
    const cmd = command(`heading${this.shown}`);
    const enabled = !cmd.isEnabled || cmd.isEnabled(state);
    this.main.replaceChildren(createElement(cmd.icon as IconNode, { width: 16, height: 16, "stroke-width": 1.75 }));
    this.main.dataset.level = String(this.shown);
    const key = shortcutFor(cmd.id);
    const action = current === this.shown ? `${cmd.label}: back to text` : cmd.label;
    this.main.title = key ? `${action} (${key})` : action;
    this.main.setAttribute("aria-label", action);
    this.main.classList.toggle("active", current > 0);
    this.main.setAttribute("aria-pressed", String(current > 0));
    this.main.disabled = !enabled;
    this.arrow.disabled = !enabled;
    if (this.menu) this.renderMenu();
  }

  private open(): void {
    this.menu = document.createElement("div");
    this.menu.className = "ken-heading-menu";
    this.menu.setAttribute("role", "menu");
    // Keep the editor's focus and selection while choosing.
    this.menu.addEventListener("mousedown", (e) => e.preventDefault());
    document.body.append(this.menu);
    this.renderMenu();
    this.position();
    this.arrow.setAttribute("aria-expanded", "true");
    this.arrow.classList.add("open");
    window.addEventListener("mousedown", this.onOutside, true);
    window.addEventListener("keydown", this.onKey, true);
    window.addEventListener("blur", this.onBlur);
    window.addEventListener("resize", this.onBlur);
  }

  private renderMenu(): void {
    if (!this.menu || !this.state) return;
    const current = headingLevel(this.state);
    const inText = !current && this.state.selection.$from.parent.type.name === "paragraph";
    const active = this.menu.querySelector<HTMLElement>(".active")?.dataset.id;
    this.menu.replaceChildren();
    for (const item of MENU) {
      const row = document.createElement("button");
      row.type = "button";
      row.className = "ken-heading-item";
      row.setAttribute("role", "menuitemradio");
      row.dataset.id = item.id;
      row.dataset.level = String(item.level);
      const checked = item.level === 0 ? inText : item.level === current;
      row.setAttribute("aria-checked", String(checked));
      const mark = document.createElement("span");
      mark.className = "ken-heading-check";
      if (checked) mark.append(createElement(Check, { width: 13, height: 13, "stroke-width": 2 }));
      const label = document.createElement("span");
      label.className = `ken-heading-label ken-heading-label-${item.level}`;
      label.textContent = item.label;
      row.append(mark, label);
      const key = shortcutFor(item.id);
      if (key) {
        const hint = document.createElement("span");
        hint.className = "ken-heading-hint";
        hint.textContent = key;
        row.append(hint);
      }
      if (item.id === active) row.classList.add("active");
      row.addEventListener("mousemove", () => this.highlight(row));
      row.addEventListener("click", () => this.choose(item.id, item.level));
      this.menu.append(row);
    }
    if (!this.menu.querySelector(".active")) {
      this.highlight(this.menu.querySelector<HTMLElement>('[aria-checked="true"]') ?? this.menu.firstElementChild as HTMLElement);
    }
  }

  private highlight(row: HTMLElement | null): void {
    if (!this.menu || !row) return;
    for (const r of this.menu.querySelectorAll(".active")) r.classList.remove("active");
    row.classList.add("active");
  }

  private position(): void {
    if (!this.menu) return;
    const anchor = this.el.getBoundingClientRect();
    const menu = this.menu.getBoundingClientRect();
    const left = Math.max(4, Math.min(anchor.left, window.innerWidth - menu.width - 4));
    // The toolbar is at the bottom of the window: open upwards.
    const top = Math.max(4, anchor.top - menu.height - 6);
    this.menu.style.left = `${left}px`;
    this.menu.style.top = `${top}px`;
  }

  private choose(id: string, level: number): void {
    this.close();
    if (level > 0) {
      lastLevel = level;
      for (const l of levelListeners) l(level);
    }
    execute(this.ctx, command(id));
  }

  private readonly onOutside = (e: MouseEvent) => {
    const t = e.target as Node;
    if (!this.menu?.contains(t) && !this.el.contains(t)) this.close();
  };

  private readonly onKey = (e: KeyboardEvent) => {
    if (!this.menu) return;
    const rows = [...this.menu.querySelectorAll<HTMLElement>(".ken-heading-item")];
    const i = rows.findIndex((r) => r.classList.contains("active"));
    if (e.key === "Escape") this.close();
    else if (e.key === "ArrowDown") this.highlight(rows[(i + 1) % rows.length]);
    else if (e.key === "ArrowUp") this.highlight(rows[(i - 1 + rows.length) % rows.length]);
    else if (e.key === "Enter") {
      const row = rows[i];
      if (row) this.choose(row.dataset.id!, Number(row.dataset.level));
    } else return;
    e.preventDefault();
    e.stopPropagation();
  };

  private readonly onBlur = () => this.close();

  close(): void {
    if (!this.menu) return;
    this.menu.remove();
    this.menu = null;
    this.arrow.setAttribute("aria-expanded", "false");
    this.arrow.classList.remove("open");
    window.removeEventListener("mousedown", this.onOutside, true);
    window.removeEventListener("keydown", this.onKey, true);
    window.removeEventListener("blur", this.onBlur);
    window.removeEventListener("resize", this.onBlur);
  }

  destroy(): void {
    this.close();
    this.el.remove();
  }
}
