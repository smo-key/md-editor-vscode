// Writes the editor's commands and default keybindings (src/shortcuts.json)
// into package.json's `contributes`. Run after editing shortcuts.json:
//   npm run sync-contributes
import { readFileSync, writeFileSync } from "fs";

// The editor, or the diff view (src/diffPanel.ts), whose sides are editors too.
export const IN_EDITOR = "(activeCustomEditorId == 'kenMarkdown.editor' || activeWebviewPanelId == 'kenMarkdown.diff')";
export const FOCUS_WHEN = `kenMarkdown.editorFocused && ${IN_EDITOR}`;

export function contributions(shortcuts) {
  const commands = [];
  const keybindings = [];
  const seen = new Set();
  for (const s of shortcuts) {
    if (!seen.has(s.command)) {
      seen.add(s.command);
      commands.push({ command: s.command, title: s.title, category: "Ken Markdown", ...(s.icon ? { icon: s.icon } : {}) });
    }
    if (s.key) keybindings.push({ command: s.command, key: s.key, mac: s.mac ?? s.key, when: FOCUS_WHEN });
  }
  return { commands, keybindings };
}

export function sync(pkg, shortcuts) {
  const { commands, keybindings } = contributions(shortcuts);
  const own = (c) => c.command.startsWith("kenMarkdown.") && shortcuts.some((s) => s.command === c.command);
  const others = (pkg.contributes.commands ?? []).filter((c) => !own(c));
  pkg.contributes.commands = [...others, ...commands];
  pkg.contributes.keybindings = keybindings;
  // Editor-only commands make no sense elsewhere: hide them from the palette
  // unless a Ken Markdown editor is active.
  const palette = (pkg.contributes.menus.commandPalette ?? []).filter((m) => !commands.some((c) => c.command === m.command));
  pkg.contributes.menus.commandPalette = [
    ...palette,
    ...commands.map((c) => ({ command: c.command, when: IN_EDITOR })),
  ];
  return pkg;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const pkg = JSON.parse(readFileSync("package.json", "utf8"));
  const { shortcuts } = JSON.parse(readFileSync("src/shortcuts.json", "utf8"));
  writeFileSync("package.json", JSON.stringify(sync(pkg, shortcuts), null, 2) + "\n");
  console.log(`package.json: ${shortcuts.length} shortcuts synced`);
}
