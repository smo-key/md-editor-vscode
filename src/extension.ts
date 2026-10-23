import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import { SHORTCUTS, editorShortcutLabels, parseJsonc } from "./keybindings";
import type { TestAction } from "./protocol";
import { KenMarkdownEditorProvider, VIEW_TYPE } from "./provider";
import { CollabManager } from "./collab/manager";
import { checkWhatsNew, showWhatsNew } from "./whatsNewPanel";

export function activate(context: vscode.ExtensionContext) {
  const collab = new CollabManager();
  const provider = new KenMarkdownEditorProvider(context, collab);
  const collabContext = () =>
    void vscode.commands.executeCommand("setContext", "kenMarkdown.collaboration", collab.role ?? false);
  collabContext();
  context.subscriptions.push(
    collab,
    collab.onDidChange(collabContext),
    vscode.commands.registerCommand("kenMarkdown.collaboration.start", () => collab.start()),
    vscode.commands.registerCommand("kenMarkdown.collaboration.join", (invite?: string) =>
      collab.join(typeof invite === "string" ? invite : undefined),
    ),
    vscode.commands.registerCommand("kenMarkdown.collaboration.copyInvite", () => collab.copyInvite()),
    vscode.commands.registerCommand("kenMarkdown.collaboration.leave", () => collab.leave()),
    vscode.commands.registerCommand("kenMarkdown.collaboration.menu", () => collab.menu()),
    vscode.window.registerCustomEditorProvider(VIEW_TYPE, provider, {
      webviewOptions: { retainContextWhenHidden: true, enableFindWidget: true },
      supportsMultipleEditorsPerDocument: true,
    }),
    vscode.commands.registerCommand("kenMarkdown.openEditor", async (uri?: vscode.Uri) => {
      const target = uri ?? activeUri();
      if (target) await vscode.commands.executeCommand("vscode.openWith", target, VIEW_TYPE);
    }),
    vscode.commands.registerCommand("kenMarkdown.showWhatsNew", () => void showWhatsNew(context)),
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

  checkWhatsNew(context);

  // Integration tests drive the webview through this hidden command.
  if (context.extensionMode === vscode.ExtensionMode.Test) {
    context.subscriptions.push(
      vscode.commands.registerCommand("kenMarkdown._testKeybindingsFile", () => keybindingsFile),
      vscode.commands.registerCommand("kenMarkdown._testCollab", () => collab.stats()),
      // URLs the host would have opened in the browser (openExternal is stubbed in tests).
      vscode.commands.registerCommand("kenMarkdown._testExternalOpened", () => [...provider.externalOpened]),
      vscode.commands.registerCommand("kenMarkdown._testEditors", (uri: string) => provider.sessionsFor(uri).length),
      vscode.commands.registerCommand("kenMarkdown._testAt", async (uri: string, index: number, action: TestAction) => {
        const session = provider.sessionsFor(uri)[index];
        if (!session) throw new Error(`no editor #${index} for ${uri}`);
        return session.runTest(action);
      }),
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
