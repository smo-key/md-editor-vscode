/**
 * The keyboard shortcut list: every editor command with its current key (as
 * bound in VS Code's Keyboard Shortcuts, where they can be changed), plus the
 * keys and Markdown typing shortcuts built into the editor.
 */
import { COMMANDS, shortcutFor, type CommandGroup } from "./commands";

type Post = (message: { type: "openKeybindings" }) => void;

let post: Post = () => undefined;
let panel: HTMLElement | null = null;
let restoreFocus: HTMLElement | null = null;

export function initShortcutsPanel(poster: Post): void {
  post = poster;
}

const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
const MOD = isMac ? "⌘" : "Ctrl+";
const SHIFT = isMac ? "⇧" : "Shift+";

const GROUPS: [string, CommandGroup[]][] = [
  ["Formatting", ["format"]],
  ["Blocks", ["text", "list"]],
  ["Insert", ["insert", "alert"]],
  ["Tables", ["table"]],
  ["Comments", ["comment"]],
  ["History", ["history"]],
];

const BUILT_IN: [string, string][] = [
  ["Insert menu", "/"],
  ["Next / previous table cell", `Tab / ${SHIFT}Tab`],
  ["New row (in the last cell)", "Tab"],
  ["Cell below; leave table from the last row", "Enter"],
  ["Leave table", `${MOD}Enter`],
  ["Indent / outdent list item", `Tab / ${SHIFT}Tab`],
  ["Heading one level smaller / larger", `Tab / ${SHIFT}Tab`],
  ["Heading → paragraph (at its start)", "Backspace"],
  ["Find", `${MOD}F`],
];

const MARKDOWN: [string, string][] = [
  ["Heading 1–6", "# … ###### then space"],
  ["Bulleted / numbered list", "- or 1. then space"],
  ["Checklist", "[ ] then space, in a list"],
  ["Quote", "> then space"],
  ["Code block", "``` then Enter"],
  ["Divider", "---"],
  ["Bold / italic / strike / code", "**b** *i* ~~s~~ `c`"],
  ["Inline equation (LaTeX)", "$x^2$"],
  ["Equation block (LaTeX)", "$$ then space"],
  ["Block types by name", "/h1 /quote /todo /tip … then space"],
];

function row(label: string, key: string): HTMLElement {
  const r = document.createElement("div");
  r.className = "ken-shortcuts-row";
  const l = document.createElement("span");
  l.textContent = label;
  const k = document.createElement("kbd");
  k.textContent = key || "—";
  if (!key) k.classList.add("unbound");
  r.append(l, k);
  return r;
}

function section(title: string, rows: HTMLElement[]): HTMLElement {
  const s = document.createElement("section");
  const h = document.createElement("h3");
  h.textContent = title;
  s.append(h, ...rows);
  return s;
}

function build(): HTMLElement {
  const el = document.createElement("div");
  el.className = "ken-shortcuts";
  el.setAttribute("role", "dialog");
  el.setAttribute("aria-label", "Keyboard shortcuts");
  el.tabIndex = -1;

  const head = document.createElement("header");
  const title = document.createElement("h2");
  title.textContent = "Keyboard shortcuts";
  const customize = document.createElement("button");
  customize.type = "button";
  customize.className = "ken-shortcuts-customize";
  customize.textContent = "Customize…";
  customize.title = "Change these in VS Code's Keyboard Shortcuts";
  customize.addEventListener("click", () => {
    closeShortcutsPanel();
    post({ type: "openKeybindings" });
  });
  const close = document.createElement("button");
  close.type = "button";
  close.className = "ken-shortcuts-close";
  close.textContent = "×";
  close.title = "Close (Esc)";
  close.addEventListener("click", () => closeShortcutsPanel());
  head.append(title, customize, close);

  const body = document.createElement("div");
  body.className = "ken-shortcuts-body";
  for (const [name, groups] of GROUPS) {
    const rows = COMMANDS.filter((c) => groups.includes(c.group)).map((c) => row(c.label, shortcutFor(c.id)));
    body.append(section(name, rows));
  }
  body.append(
    section("Editor", [
      row("Keyboard shortcuts", shortcutFor("kenMarkdown.showShortcuts")),
      ...BUILT_IN.map(([l, k]) => row(l, k)),
    ]),
    section("Markdown as you type", MARKDOWN.map(([l, k]) => row(l, k))),
  );

  el.append(head, body);
  el.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      closeShortcutsPanel();
    }
  });
  return el;
}

export function isShortcutsPanelOpen(): boolean {
  return !!panel;
}

export function openShortcutsPanel(): void {
  closeShortcutsPanel();
  restoreFocus = document.activeElement as HTMLElement | null;
  const backdrop = document.createElement("div");
  backdrop.className = "ken-shortcuts-backdrop";
  backdrop.addEventListener("mousedown", (e) => {
    if (e.target === backdrop) closeShortcutsPanel();
  });
  backdrop.append(build());
  document.body.append(backdrop);
  panel = backdrop;
  backdrop.querySelector<HTMLElement>(".ken-shortcuts")?.focus();
}

export function closeShortcutsPanel(): void {
  if (!panel) return;
  panel.remove();
  panel = null;
  restoreFocus?.focus();
  restoreFocus = null;
}

export function toggleShortcutsPanel(): void {
  if (panel) closeShortcutsPanel();
  else openShortcutsPanel();
}
