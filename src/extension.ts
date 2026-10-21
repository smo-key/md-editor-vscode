import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import { SHORTCUTS, editorShortcutLabels, parseJsonc } from "./keybindings";
import type { TestAction } from "./protocol";
import { KenMarkdownEditorProvider, VIEW_TYPE } from "./provider";

export function activate(context: vscode.ExtensionContext) {
  const provider = new KenMarkdownEditorProvider(context);
  context.subscriptions.push(
    vscode.window.registerCustomEditorProvider(VIEW_TYPE, provider, {
      webviewOptions: { retainContextWhenHidden: true, enableFindWidget: true },
      supportsMultipleEditorsPerDocument: true,
    }),
    vscode.commands.registerCommand("kenMarkdown.openEditor", async (uri?: vscode.Uri) => {
      const target = uri ?? activeUri();
      if (target) await vscode.commands.executeCommand("vscode.openWith", target, VIEW_TYPE);
    }),
    vscode.commands.registerCommand("kenMarkdown.openSource", async (uri?: vscode.Uri) => {
      const target = uri ?? activeUri();
      if (target) await vscode.commands.executeCommand("vscode.openWith", target, "default");
    }),
  );

  // Every editor command is a VS Code command, so its keys live in VS Code's
  // Keyboard Shortcuts editor (defaults in package.json, from shortcuts.json).
  for (const command of new Set(SHORTCUTS.map((s) => s.command))) {
    const def = SHORTCUTS.find((s) => s.command === command)!;
    context.subscriptions.push(
      vscode.commands.registerCommand(command, () => {
        const session = provider.target();
        if (!session) return;
        session.send(def.editor ? { type: "command", id: def.editor } : { type: "showShortcuts" });
      }),
    );
  }

  // Effective keys (defaults + the user's keybindings.json) for hints and the
  // shortcut list, refreshed when the user edits their keybindings.
  const keybindingsFile = path.join(context.globalStorageUri.fsPath, "..", "..", "keybindings.json");
  const refreshLabels = () => {
    let user: unknown = [];
    try {
      user = parseJsonc(fs.readFileSync(keybindingsFile, "utf8"));
    } catch {
      // No user keybindings (or unreadable): the defaults apply.
    }
    provider.setShortcutLabels(editorShortcutLabels(process.platform, user));
  };
  refreshLabels();
  fs.watchFile(keybindingsFile, { interval: 1000 }, refreshLabels);
  context.subscriptions.push({ dispose: () => fs.unwatchFile(keybindingsFile, refreshLabels) });

  // Integration tests drive the webview through this hidden command.
  if (context.extensionMode === vscode.ExtensionMode.Test) {
    context.subscriptions.push(
      vscode.commands.registerCommand("kenMarkdown._testKeybindingsFile", () => keybindingsFile),
      vscode.commands.registerCommand("kenMarkdown._test", async (uri: string, action?: TestAction) => {
        const session = provider.sessions.get(uri);
        if (!action) return session?.isReady ?? false;
        if (!session) throw new Error(`no editor for ${uri}`);
        return session.runTest(action);
      }),
    );
  }
}

function activeUri(): vscode.Uri | undefined {
  const tab = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
  if (tab instanceof vscode.TabInputCustom || tab instanceof vscode.TabInputText) return tab.uri;
  return vscode.window.activeTextEditor?.document.uri;
}

export function deactivate() {}
