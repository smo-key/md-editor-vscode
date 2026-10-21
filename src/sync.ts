/** Pure helpers shared by the provider; kept free of `vscode` so vitest covers them. */

export interface TextChange {
  /** Offset in the old text where the change starts. */
  start: number;
  /** Offset in the old text where the change ends (exclusive). */
  end: number;
  /** Replacement text. */
  text: string;
}

/**
 * The smallest single replacement turning `before` into `after`: common prefix
 * and suffix are left alone, so VS Code's undo stack, dirty markers and
 * collaborators see a focused edit rather than a whole-file rewrite.
 * Returns null when the texts are equal.
 */
export function minimalChange(before: string, after: string): TextChange | null {
  if (before === after) return null;
  const max = Math.min(before.length, after.length);
  let prefix = 0;
  while (prefix < max && before.charCodeAt(prefix) === after.charCodeAt(prefix)) prefix++;
  // Never split a surrogate pair.
  if (prefix > 0 && isHighSurrogate(before.charCodeAt(prefix - 1))) prefix--;
  let suffix = 0;
  while (
    suffix < max - prefix &&
    before.charCodeAt(before.length - 1 - suffix) === after.charCodeAt(after.length - 1 - suffix)
  ) {
    suffix++;
  }
  if (suffix > 0 && isLowSurrogate(before.charCodeAt(before.length - suffix))) suffix--;
  return {
    start: prefix,
    end: before.length - suffix,
    text: after.slice(prefix, after.length - suffix),
  };
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

/** Normalise line endings to `\n` (what the editor speaks). */
export function toLF(text: string): string {
  return text.replace(/\r\n?/g, "\n");
}

/** Convert `\n` text to the document's line ending. */
export function toEOL(text: string, crlf: boolean): string {
  return crlf ? text.replace(/\n/g, "\r\n") : text;
}

/** A safe file name for a pasted attachment, deduped against `exists`. */
export async function uniqueName(
  name: string,
  exists: (candidate: string) => Promise<boolean>,
): Promise<string> {
  const clean = name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, "-").replace(/^\.+/, "") || "file";
  const dot = clean.lastIndexOf(".");
  const stem = dot > 0 ? clean.slice(0, dot) : clean;
  const ext = dot > 0 ? clean.slice(dot) : "";
  for (let n = 0; n < 10000; n++) {
    const candidate = n === 0 ? clean : `${stem}-${n}${ext}`;
    if (!(await exists(candidate))) return candidate;
  }
  return `${stem}-${Date.now()}${ext}`;
}

/** Link targets: an external URL, an in-document anchor, or a relative path. */
export type LinkKind =
  | { kind: "external"; url: string }
  | { kind: "anchor"; anchor: string }
  | { kind: "file"; path: string; fragment: string };

export function classifyHref(href: string): LinkKind {
  if (/^[a-z][a-z0-9+.-]*:/i.test(href)) return { kind: "external", url: href };
  if (href.startsWith("#")) return { kind: "anchor", anchor: href.slice(1) };
  const hash = href.indexOf("#");
  const raw = hash >= 0 ? href.slice(0, hash) : href;
  const fragment = hash >= 0 ? href.slice(hash + 1) : "";
  let path = raw.split("?")[0];
  try {
    path = decodeURIComponent(path);
  } catch {
    // Keep the raw path: a stray `%` is a legal file-name character.
  }
  return { kind: "file", path, fragment };
}
