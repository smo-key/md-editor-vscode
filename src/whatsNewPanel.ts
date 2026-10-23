import * as vscode from "vscode";
import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import { parseChangelog, sectionsFor, shouldShowWhatsNew, whatsNewHtml } from "./whatsNew";

/** The version that last ran, to tell an update from a first install. */
export const LAST_VERSION_KEY = "kenMarkdown.lastVersion";

let panel: vscode.WebviewPanel | undefined;

/**
 * Records the running version and, after a major or minor update, shows
 * What's New. A first install records the version and shows nothing. Updates
 * from releases that never recorded it (0.4.0 and older) look the same.
 */
export function checkWhatsNew(context: vscode.ExtensionContext): void {
  const current: string = context.extension.packageJSON.version;
  const previous = context.globalState.get<string>(LAST_VERSION_KEY);
  if (previous !== current) void context.globalState.update(LAST_VERSION_KEY, current);
  if (context.extensionMode === vscode.ExtensionMode.Test) return;
  // Beside, so it doesn't cover the document whose opening activated us.
  if (shouldShowWhatsNew(previous, current)) showWhatsNew(context, previous, vscode.ViewColumn.Beside);
}

/** Opens (or refreshes) the What's New panel for the running version. */
export function showWhatsNew(
  context: vscode.ExtensionContext,
  previous?: string,
  viewColumn = vscode.ViewColumn.Active,
): vscode.WebviewPanel {
  const version: string = context.extension.packageJSON.version;
  const changelog = vscode.Uri.joinPath(context.extensionUri, "CHANGELOG.md");
  let text = "";
  try {
    text = fs.readFileSync(path.join(context.extensionUri.fsPath, "CHANGELOG.md"), "utf8");
  } catch {
    // No changelog in the package: the page says there are no notes.
  }
  const title = `What's New in Ken Markdown Editor ${version}`;
  if (panel) {
    panel.title = title;
    panel.reveal(undefined, viewColumn !== vscode.ViewColumn.Active);
  } else {
    panel = vscode.window.createWebviewPanel(
      "kenMarkdown.whatsNew",
      title,
      { viewColumn, preserveFocus: viewColumn !== vscode.ViewColumn.Active },
      { enableScripts: true, localResourceRoots: [] },
    );
    panel.iconPath = vscode.Uri.joinPath(context.extensionUri, "media", "icon.png");
    panel.onDidDispose(() => (panel = undefined));
    panel.webview.onDidReceiveMessage(async (m: { type?: string; href?: unknown }) => {
      if (m.type === "close") panel?.dispose();
      else if (m.type === "changelog") await vscode.commands.executeCommand("markdown.showPreview", changelog);
      else if (m.type === "open" && typeof m.href === "string" && /^(https?:|mailto:)/i.test(m.href)) {
        await vscode.env.openExternal(vscode.Uri.parse(m.href));
      }
    });
  }
  const sections = sectionsFor(parseChangelog(text), previous, version);
  panel.webview.html = whatsNewHtml({ version, previous, sections, nonce: crypto.randomBytes(16).toString("base64") });
  return panel;
}
