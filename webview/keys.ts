/**
 * Keyboard routing between the editor and VS Code.
 *
 * A webview forwards every key press to VS Code's keybinding system, even one
 * the page already handled, so the editor handling Cmd+B itself would bold
 * the text *and* run VS Code's Cmd+B (toggle the sidebar). Instead, the
 * editor's commands are VS Code commands with keybindings (customizable in
 * Keyboard Shortcuts, see src/shortcuts.json), and the page leaves those keys
 * to VS Code: Cmd/Ctrl + letter or digit is marked handled (preventDefault)
 * before ProseMirror or CodeMirror see it, which both then ignore it, while
 * the event still reaches VS Code. Clipboard, select-all, typing (AltGr) and
 * macOS Ctrl text navigation are untouched.
 *
 * Other keys bound to editor commands (Alt+↑ moves a row, Ctrl+Alt+→ a
 * column…) are claimed the same way, but only while the command can act and
 * the caret is in the editor's text (not a code block or a text field), so
 * where the command has nothing to do the key keeps its usual meaning. The
 * host sends the effective keys, so a rebinding is followed.
 */
const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);

const NATIVE = new Set(["KeyA", "KeyC", "KeyV", "KeyX"]);

export function vscodeOwnsKey(e: KeyboardEvent, mac = isMac): boolean {
  const mod = mac ? e.metaKey : e.ctrlKey;
  if (!mod || e.isComposing) return false;
  if (!/^(Key[A-Z]|Digit[0-9]|Slash)$/.test(e.code)) return false;
  // Plain clipboard and select-all keys stay native (VS Code routes those).
  if (NATIVE.has(e.code) && !e.shiftKey && !e.altKey) return false;
  // Ctrl+Alt is AltGr on Windows/Linux keyboards: a key that types a
  // character (e.g. "{") is typing, not a shortcut.
  if (!mac && e.altKey && e.key.length === 1 && !/^[0-9a-z]$/i.test(e.key)) return false;
  return true;
}

const CODES: Record<string, string> = {
  up: "ArrowUp",
  down: "ArrowDown",
  left: "ArrowLeft",
  right: "ArrowRight",
  enter: "Enter",
  backspace: "Backspace",
  delete: "Delete",
  tab: "Tab",
  space: "Space",
  escape: "Escape",
  home: "Home",
  end: "End",
  pageup: "PageUp",
  pagedown: "PageDown",
  "[": "BracketLeft",
  "]": "BracketRight",
  "\\": "Backslash",
  "/": "Slash",
  "-": "Minus",
  "=": "Equal",
  ",": "Comma",
  ".": "Period",
  ";": "Semicolon",
  "'": "Quote",
  "`": "Backquote",
};

/** Does the event press `key` (VS Code notation, one chord: "ctrl+alt+up")? */
export function matchesKey(e: KeyboardEvent, key: string): boolean {
  const chords = key.trim().toLowerCase().split(/\s+/);
  if (chords.length !== 1) return false;
  const parts = chords[0]!.split("+");
  // "ctrl++" is the plus key.
  const main = parts.pop() || "+";
  const mods = new Set(parts);
  const meta = mods.has("cmd") || mods.has("meta") || mods.has("win");
  if (e.ctrlKey !== mods.has("ctrl") || e.altKey !== mods.has("alt") || e.shiftKey !== mods.has("shift") || e.metaKey !== meta) return false;
  let code = CODES[main];
  if (!code && /^[a-z]$/.test(main)) code = `Key${main.toUpperCase()}`;
  if (!code && /^[0-9]$/.test(main)) code = `Digit${main}`;
  if (!code && /^f\d{1,2}$/.test(main)) code = main.toUpperCase();
  return !!code && e.code === code;
}

let bound: Record<string, string[]> = {};

/** Effective keys per editor command id (from the host). */
export function setBoundKeys(keys: Record<string, string[]>): void {
  bound = keys;
}

/** The editor command bound to this key press, if any. */
export function boundCommand(e: KeyboardEvent): string | null {
  for (const [id, keys] of Object.entries(bound)) {
    if (keys.some((k) => matchesKey(e, k))) return id;
  }
  return null;
}

/** The key's target is the editor's own text (not a code block, a field or a panel). */
export function inEditorText(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  return !!target.closest(".ProseMirror") && !target.closest(".cm-editor, input, textarea");
}

export function installKeyRouting(target: Window = window, canRun: (id: string) => boolean = () => false): void {
  target.addEventListener(
    "keydown",
    (e) => {
      if (vscodeOwnsKey(e)) {
        e.preventDefault();
        return;
      }
      if (e.isComposing || !inEditorText(e.target)) return;
      const id = boundCommand(e);
      if (id && canRun(id)) e.preventDefault();
    },
    true,
  );
}
