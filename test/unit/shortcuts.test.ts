import { readFileSync } from "fs";
import { describe, expect, it } from "vitest";

import { COMMANDS } from "../../webview/commands";
import { boundCommand, matchesKey, setBoundKeys, vscodeOwnsKey } from "../../webview/keys";
import { SHORTCUTS, editorShortcutKeys, editorShortcutLabels, effectiveKeys, keyLabel, parseJsonc } from "../../src/keybindings";
// @ts-expect-error plain ESM script without types
import { sync } from "../../scripts/sync-contributes.mjs";

const key = (init: KeyboardEventInit) => new KeyboardEvent("keydown", init);

describe("key routing (webview/keys.ts)", () => {
  it.each([
    [{ code: "KeyB", key: "b", metaKey: true }, true],
    [{ code: "Digit1", key: "¡", metaKey: true, altKey: true }, true],
    [{ code: "KeyZ", key: "z", metaKey: true, shiftKey: true }, true],
    [{ code: "Slash", key: "/", metaKey: true }, true],
    [{ code: "KeyC", key: "c", metaKey: true }, false],
    [{ code: "KeyV", key: "v", metaKey: true }, false],
    [{ code: "KeyA", key: "a", metaKey: true }, false],
    [{ code: "ArrowLeft", key: "ArrowLeft", metaKey: true }, false],
    [{ code: "Enter", key: "Enter", metaKey: true }, false],
    // macOS Ctrl+letter is text navigation (Ctrl+A/E/K…), not a shortcut.
    [{ code: "KeyE", key: "e", ctrlKey: true }, false],
    [{ code: "KeyB", key: "b" }, false],
  ])("macOS %j → %s", (init, owned) => {
    expect(vscodeOwnsKey(key(init), true)).toBe(owned);
  });

  it.each([
    [{ code: "KeyB", key: "b", ctrlKey: true }, true],
    [{ code: "Digit2", key: "2", ctrlKey: true, altKey: true }, true],
    // AltGr+7 types "{" on a German keyboard: that is typing.
    [{ code: "Digit7", key: "{", ctrlKey: true, altKey: true }, false],
    [{ code: "KeyB", key: "b", metaKey: true }, false],
    [{ code: "KeyX", key: "x", ctrlKey: true }, false],
  ])("Windows/Linux %j → %s", (init, owned) => {
    expect(vscodeOwnsKey(key(init), false)).toBe(owned);
  });
});

describe("effective keybindings (src/keybindings.ts)", () => {
  it("formats keys per platform", () => {
    expect(keyLabel("cmd+alt+1", "darwin")).toBe("⌥⌘1");
    expect(keyLabel("cmd+shift+z", "darwin")).toBe("⇧⌘Z");
    expect(keyLabel("ctrl+alt+1", "win32")).toBe("Ctrl+Alt+1");
    expect(keyLabel("ctrl+shift+b", "linux")).toBe("Ctrl+Shift+B");
    expect(keyLabel("cmd+k cmd+b", "darwin")).toBe("⌘K ⌘B");
    expect(keyLabel("cmd+/", "darwin")).toBe("⌘/");
  });

  it("uses the defaults without user bindings", () => {
    const labels = editorShortcutLabels("darwin", undefined);
    expect(labels.bold).toBe("⌘B");
    expect(labels.heading2).toBe("⌥⌘2");
    expect(labels.divider).toBe("");
    expect(labels["move-up"]).toBe("⌥↑");
    expect(labels["kenMarkdown.showShortcuts"]).toBe("⌘/");
    expect(editorShortcutLabels("linux", []).bold).toBe("Ctrl+B");
  });

  it("applies the user's keybindings.json: additions first, removals", () => {
    const user = parseJsonc(`[
      // move bold
      { "key": "cmd+shift+b", "command": "kenMarkdown.bold" },
      { "key": "cmd+b", "command": "-kenMarkdown.bold" },
      /* bind a command with no default */
      { "key": "cmd+alt+t", "command": "kenMarkdown.insertTable", },
      { "key": "cmd+i", "command": "-kenMarkdown.italic" },
      { "key": "cmd+j", "command": "workbench.action.togglePanel" },
    ]`);
    const keys = effectiveKeys("darwin", user);
    expect(keys.get("kenMarkdown.bold")).toEqual(["cmd+shift+b"]);
    expect(keys.get("kenMarkdown.insertTable")).toEqual(["cmd+alt+t"]);
    expect(keys.get("kenMarkdown.italic")).toEqual([]);
    const labels = editorShortcutLabels("darwin", user);
    expect(labels.bold).toBe("⇧⌘B");
    expect(labels.table).toBe("⌥⌘T");
    expect(labels.italic).toBe("");
  });

  it("parses JSON with comments, trailing commas and slashes in strings", () => {
    expect(parseJsonc('[{"key": "cmd+/", "command": "a//b" /* c */,},]')).toEqual([{ key: "cmd+/", command: "a//b" }]);
  });
});

describe("shortcut definitions", () => {
  it("cover every editor command, and only real ones", () => {
    const ids = new Set(COMMANDS.map((c) => c.id));
    for (const s of SHORTCUTS) if (s.editor) expect(ids.has(s.editor), s.editor).toBe(true);
    for (const c of COMMANDS) expect(SHORTCUTS.some((s) => s.editor === c.id), c.id).toBe(true);
  });

  it("are in package.json (run `npm run sync-contributes`)", () => {
    const pkg = JSON.parse(readFileSync("package.json", "utf8"));
    const synced = sync(JSON.parse(JSON.stringify(pkg)), SHORTCUTS);
    expect(pkg.contributes.commands).toEqual(synced.contributes.commands);
    expect(pkg.contributes.keybindings).toEqual(synced.contributes.keybindings);
    expect(pkg.contributes.menus.commandPalette).toEqual(synced.contributes.menus.commandPalette);
  });

  it("only bind keys while a Ken Markdown editor has focus", () => {
    const pkg = JSON.parse(readFileSync("package.json", "utf8"));
    for (const kb of pkg.contributes.keybindings) {
      expect(kb.when).toContain("kenMarkdown.editorFocused");
    }
  });
});

describe("bound keys (webview/keys.ts)", () => {
  it("matches VS Code key notation against key presses", () => {
    expect(matchesKey(key({ code: "ArrowUp", key: "ArrowUp", altKey: true }), "alt+up")).toBe(true);
    expect(matchesKey(key({ code: "ArrowUp", key: "ArrowUp", altKey: true, shiftKey: true }), "alt+up")).toBe(false);
    expect(matchesKey(key({ code: "Backslash", key: "\\", metaKey: true }), "cmd+\\")).toBe(true);
    expect(matchesKey(key({ code: "BracketRight", key: "]", ctrlKey: true }), "ctrl+]")).toBe(true);
    expect(matchesKey(key({ code: "Enter", key: "Enter", ctrlKey: true, altKey: true }), "ctrl+alt+enter")).toBe(true);
  });

  it("finds the command for a key, following the user's bindings", () => {
    const user = [{ key: "ctrl+shift+up", command: "kenMarkdown.moveUp" }];
    setBoundKeys(editorShortcutKeys("linux", user));
    expect(boundCommand(key({ code: "ArrowUp", key: "ArrowUp", ctrlKey: true, shiftKey: true }))).toBe("move-up");
    expect(boundCommand(key({ code: "ArrowUp", key: "ArrowUp", altKey: true }))).toBe("move-up");
    expect(boundCommand(key({ code: "ArrowUp", key: "ArrowUp" }))).toBeNull();
    setBoundKeys({});
  });
});

describe("default keys", () => {
  it.each(["darwin", "win32"] as const)("never give two commands the same key on %s", (platform) => {
    const owner = new Map<string, string>();
    for (const [command, keys] of effectiveKeys(platform, [])) {
      for (const k of keys) {
        const norm = k.split("+").sort().join("+");
        expect(owner.get(norm) ?? command, `${k}: ${owner.get(norm)} and ${command}`).toBe(command);
        owner.set(norm, command);
      }
    }
  });
});
