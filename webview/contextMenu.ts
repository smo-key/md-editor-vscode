/**
 * A small DOM context menu for the editor, styled with VS Code's menu tokens.
 * A small context menu; entries share one `MenuEntry` shape.
 */
import { createElement, type IconNode } from "lucide";

export interface MenuItem {
  label: string;
  icon?: IconNode;
  danger?: boolean;
  disabled?: boolean;
  onSelect: () => void;
}

export type MenuEntry = MenuItem | "separator";

// Opening a menu inside a table can make Crepe scroll the clicked cell into
// view a frame later; that scroll must not dismiss the menu it caused.
const SCROLL_GRACE_MS = 250;

let menu: HTMLElement | null = null;
let openedAt = 0;
let cleanup: (() => void) | null = null;

export function closeContextMenu(): void {
  cleanup?.();
  cleanup = null;
  menu?.remove();
  menu = null;
}

export function openContextMenu(x: number, y: number, items: MenuEntry[]): void {
  closeContextMenu();
  openedAt = performance.now();
  const el = document.createElement("div");
  el.className = "ken-context-menu";
  el.setAttribute("role", "menu");

  const buttons: HTMLButtonElement[] = [];
  for (const entry of items) {
    if (entry === "separator") {
      const sep = document.createElement("div");
      sep.className = "ken-context-menu-separator";
      sep.setAttribute("role", "separator");
      el.append(sep);
      continue;
    }
    const button = document.createElement("button");
    button.type = "button";
    button.className = "ken-context-menu-item";
    button.setAttribute("role", "menuitem");
    if (entry.danger) button.classList.add("danger");
    button.disabled = !!entry.disabled;
    if (entry.icon) {
      const icon = createElement(entry.icon, { width: 14, height: 14, "stroke-width": 1.75 });
      icon.classList.add("ken-context-menu-icon");
      button.append(icon);
    }
    const label = document.createElement("span");
    label.textContent = entry.label;
    button.append(label);
    button.addEventListener("click", () => {
      closeContextMenu();
      entry.onSelect();
    });
    buttons.push(button);
    el.append(button);
  }

  document.body.append(el);
  menu = el;

  // Keep the menu on screen.
  const rect = el.getBoundingClientRect();
  const left = Math.max(4, Math.min(x, window.innerWidth - rect.width - 4));
  const top = Math.max(4, Math.min(y, window.innerHeight - rect.height - 4));
  el.style.left = `${left}px`;
  el.style.top = `${top}px`;

  const onPointer = (e: PointerEvent) => {
    if (menu && !menu.contains(e.target as Node)) closeContextMenu();
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      closeContextMenu();
      return;
    }
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const enabled = buttons.filter((b) => !b.disabled);
      const i = enabled.indexOf(document.activeElement as HTMLButtonElement);
      const next = e.key === "ArrowDown" ? i + 1 : i - 1;
      enabled[(next + enabled.length) % enabled.length]?.focus();
    }
  };
  const onScroll = () => {
    if (performance.now() - openedAt > SCROLL_GRACE_MS) closeContextMenu();
  };
  const onBlur = () => closeContextMenu();
  window.addEventListener("pointerdown", onPointer, true);
  window.addEventListener("keydown", onKey, true);
  window.addEventListener("scroll", onScroll, true);
  window.addEventListener("blur", onBlur);
  cleanup = () => {
    window.removeEventListener("pointerdown", onPointer, true);
    window.removeEventListener("keydown", onKey, true);
    window.removeEventListener("scroll", onScroll, true);
    window.removeEventListener("blur", onBlur);
  };
}
