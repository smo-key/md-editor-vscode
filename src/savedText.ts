import { toEOL, toLF } from "./sync";

/**
 * Pure helpers for clearing the modified marker once Ken's edits bring a
 * document back to its saved text. No `vscode` import, so vitest covers them.
 */

/**
 * The text VS Code shows for a file's saved bytes: UTF-8 without a BOM, with
 * every line ending converted to the document's (as VS Code does on load).
 */
export function savedTextFor(bytes: Uint8Array, crlf: boolean): string {
  let raw = new TextDecoder("utf-8").decode(bytes);
  if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
  return toEOL(toLF(raw), crlf);
}

/** Whether `text` equals `saved`; the length check first keeps most keystrokes cheap. */
export function sameAsSaved(text: string, saved: string | undefined): boolean {
  return saved !== undefined && text.length === saved.length && text === saved;
}
