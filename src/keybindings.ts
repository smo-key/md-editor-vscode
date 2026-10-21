/**
 * The keys each editor command is actually bound to: the defaults from
 * package.json, adjusted by the user's keybindings.json (bindings added in
 * the Keyboard Shortcuts editor, and `-command` removals). VS Code offers no
 * API for this, so the file is read directly; anything unexpected falls back
 * to the defaults. Used for tooltips, slash-menu hints and the shortcut list.
 */
import shortcutsJson from "./shortcuts.json";

export interface ShortcutDef {
  command: string;
  editor: string;
  title: string;
  key?: string;
  mac?: string;
  alias?: boolean;
}

export const SHORTCUTS = (shortcutsJson as { shortcuts: ShortcutDef[] }).shortcuts;

interface UserBinding {
  key?: unknown;
  command?: unknown;
}

/** Strip comments and trailing commas from VS Code's JSON-with-comments. */
export function parseJsonc(text: string): unknown {
  let out = "";
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      out += c;
      if (c === "\\") out += text[++i] ?? "";
      else if (c === '"') inString = false;
    } else if (c === '"') {
      inString = true;
      out += c;
    } else if (c === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      out += "\n";
    } else if (c === "/" && text[i + 1] === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++;
      i++;
    } else {
      out += c;
    }
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, "$1"));
}

const norm = (key: string) =>
  key
    .toLowerCase()
    .split(/\s+/)
    .map((chord) => chord.split("+").sort().join("+"))
    .join(" ");

/**
 * Effective keys per VS Code command, in VS Code's notation
 * (e.g. "cmd+alt+1"), first = primary.
 */
export function effectiveKeys(platform: NodeJS.Platform, userBindings: unknown): Map<string, string[]> {
  const mac = platform === "darwin";
  const keys = new Map<string, string[]>();
  for (const s of SHORTCUTS) {
    const list = keys.get(s.command) ?? [];
    const key = mac ? (s.mac ?? s.key) : s.key;
    if (key && !list.some((k) => norm(k) === norm(key))) list.push(key);
    keys.set(s.command, list);
  }
  if (!Array.isArray(userBindings)) return keys;
  for (const entry of userBindings as UserBinding[]) {
    if (typeof entry?.command !== "string") continue;
    const removal = entry.command.startsWith("-");
    const command = removal ? entry.command.slice(1) : entry.command;
    const list = keys.get(command);
    if (!list) continue;
    const key = typeof entry.key === "string" ? entry.key : undefined;
    if (removal) {
      const kept = key ? list.filter((k) => norm(k) !== norm(key)) : [];
      keys.set(command, kept);
    } else if (key && !list.some((k) => norm(k) === norm(key))) {
      // User bindings take precedence, so show them first.
      list.unshift(key);
    }
  }
  return keys;
}

const MAC_SYMBOLS: Record<string, string> = { ctrl: "⌃", alt: "⌥", shift: "⇧", cmd: "⌘", meta: "⌘" };
const MAC_ORDER = ["ctrl", "alt", "shift", "cmd", "meta"];
const PC_NAMES: Record<string, string> = { ctrl: "Ctrl", alt: "Alt", shift: "Shift", meta: "Win", win: "Win", cmd: "Win" };
const PC_ORDER = ["ctrl", "shift", "alt", "meta", "win", "cmd"];
const KEY_NAMES: Record<string, string> = {
  enter: "Enter",
  escape: "Esc",
  backspace: "Backspace",
  delete: "Delete",
  tab: "Tab",
  space: "Space",
  up: "↑",
  down: "↓",
  left: "←",
  right: "→",
  oem_2: "/",
};

/** "cmd+alt+1" → "⌥⌘1" on macOS, "Ctrl+Alt+1" elsewhere; chords joined by a space. */
export function keyLabel(key: string, platform: NodeJS.Platform): string {
  const mac = platform === "darwin";
  return key
    .trim()
    .split(/\s+/)
    .map((chord) => {
      const parts = chord.toLowerCase().split("+");
      const main = parts.pop() ?? "";
      const name = KEY_NAMES[main] ?? (main.length === 1 ? main.toUpperCase() : main[0].toUpperCase() + main.slice(1));
      if (mac) {
        const mods = MAC_ORDER.filter((m) => parts.includes(m)).map((m) => MAC_SYMBOLS[m]);
        return [...new Set(mods)].join("") + name;
      }
      const mods = PC_ORDER.filter((m) => parts.includes(m)).map((m) => PC_NAMES[m]);
      return [...new Set(mods), name].join("+");
    })
    .join(" ");
}

/** Label per editor command id (webview/commands.ts), for the webview. */
export function editorShortcutLabels(platform: NodeJS.Platform, userBindings: unknown): Record<string, string> {
  const keys = effectiveKeys(platform, userBindings);
  const labels: Record<string, string> = {};
  for (const s of SHORTCUTS) {
    if (labels[s.editor] !== undefined) continue;
    const first = keys.get(s.command)?.[0];
    labels[s.editor || s.command] = first ? keyLabel(first, platform) : "";
  }
  return labels;
}
