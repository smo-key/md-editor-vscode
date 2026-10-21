import * as vscode from "vscode";
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

  // Integration tests drive the webview through this hidden command.
  if (context.extensionMode === vscode.ExtensionMode.Test) {
    context.subscriptions.push(
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
