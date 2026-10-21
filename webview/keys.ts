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

export function installKeyRouting(target: Window = window): void {
  target.addEventListener(
    "keydown",
    (e) => {
      if (vscodeOwnsKey(e)) e.preventDefault();
    },
    true,
  );
}
