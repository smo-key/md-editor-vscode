/**
 * A chat agent's pending edits (VS Code's chat editing: the Keep/Undo the
 * text editor shows after an agent edits a file), for the Ken editor.
 *
 * VS Code keeps, for each file an agent edited, the file as it was before the
 * edits in a text model of its own (`chat-editing-text-model:` + the file's
 * path); extensions see it as a TextDocument. The editor diffs against it.
 * Keeping or undoing goes through VS Code where it can (the file's
 * Keep/Undo commands), so the chat's list of changed files stays right. A
 * single change has no command outside a text editor, so it is done by
 * editing the file the way VS Code itself follows: undoing restores the
 * original lines; keeping restores them and then puts the agent's lines back
 * as an edit of the user's own, which VS Code copies into its original.
 */
import * as vscode from "vscode";
import { hunksForBlock, lineHunks, revertHunks, type LineHunk } from "./agentEdits";
import { toLF } from "./sync";

export const ORIGINAL_SCHEME = "chat-editing-text-model";
/** A file as it was at an earlier chat request (the chat's "view changes" diffs). */
export const SNAPSHOT_SCHEME = "chat-editing-snapshot-text-model";

function isOriginalOf(doc: vscode.TextDocument, uri: vscode.Uri): boolean {
  if (doc.isClosed || doc.uri.scheme !== ORIGINAL_SCHEME || doc.uri.path !== uri.path) return false;
  try {
    return (JSON.parse(doc.uri.query) as { kind?: string }).kind === "doc";
  } catch {
    return false;
  }
}

/** VS Code's original of `doc` while an agent's edits to it are pending: the one that differs, if several. */
export function originalOf(doc: vscode.TextDocument): vscode.TextDocument | undefined {
  const all = vscode.workspace.textDocuments.filter((d) => isOriginalOf(d, doc.uri));
  const text = doc.getText();
  return all.reverse().find((d) => d.getText() !== text) ?? all[0];
}

/** Whether a text document event concerns some file's original. */
export const isOriginal = (doc: vscode.TextDocument) => doc.uri.scheme === ORIGINAL_SCHEME;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until(test: () => boolean, ms: number): Promise<boolean> {
  for (const end = Date.now() + ms; ; await sleep(25)) {
    if (test()) return true;
    if (Date.now() >= end) return false;
  }
}

async function tryCommand(id: string, ...args: unknown[]): Promise<void> {
  try {
    await vscode.commands.executeCommand(id, ...args);
  } catch {
    // Not in this VS Code, or the file isn't in the focused chat's session.
  }
}

export type AgentAction =
  | { action: "keep" | "undo"; scope: "file" }
  | { action: "keep" | "undo"; scope: "change"; current: string; reverted: string };

/**
 * Keep or undo pending agent edits to `doc`. `write` replaces the document's
 * text (`\n` line endings) with a minimal edit.
 */
export async function runAgentAction(doc: vscode.TextDocument, m: AgentAction, write: (text: string) => Promise<void>): Promise<void> {
  const original = originalOf(doc);
  if (!original) return;
  const lf = (d: vscode.TextDocument) => toLF(d.getText());
  const O = lf(original);
  const M = lf(doc);
  if (O === M) return;
  const settled = () => !original.isClosed && lf(original) === lf(doc);

  if (m.scope === "file") {
    if (m.action === "keep") {
      await tryCommand("chatEditing.acceptFile", doc.uri);
      if (await until(settled, 600)) return;
      if (!(await keep(original, O, M, lineHunks(O, M), write))) notKept();
    } else {
      await tryCommand("chatEditing.discardFile", doc.uri);
      if (await until(() => doc.isClosed || settled(), 600)) return;
      await write(O);
    }
    return;
  }

  const hunks = hunksForBlock(O, M, m.current, m.reverted);
  if (!hunks.length) return;
  if (m.action === "undo") await write(revertHunks(O, M, hunks));
  else if (!(await keep(original, O, M, hunks, write))) notKept();
  // The last change resolved: VS Code's entry for the file is done too.
  if (await until(settled, 300)) await tryCommand("chatEditing.acceptFile", doc.uri);
}

/**
 * Keep `hunks`: put their original lines back, give VS Code a moment to see
 * them as unchanged, then write the agent's lines again, now an edit of the
 * user's that VS Code copies into its original. If VS Code was too slow (it
 * then treats the rewrite as still the agent's), nothing is lost: try again,
 * waiting longer.
 */
async function keep(original: vscode.TextDocument, O: string, M: string, hunks: LineHunk[], write: (text: string) => Promise<void>): Promise<boolean> {
  const restored = revertHunks(O, M, hunks);
  for (const wait of [150, 400, 1000]) {
    await write(restored);
    await sleep(wait);
    await write(M);
    if (await until(() => original.isClosed || toLF(original.getText()) !== O, 300)) return true;
  }
  return false;
}

function notKept() {
  void vscode.window.showWarningMessage("Ken Markdown: VS Code did not take this change on its own. Use Keep for the whole file, or keep it from the chat.");
}
