/**
 * A line-based model of YAML frontmatter, for the properties panel.
 *
 * Only what the user edits changes: each top-level `key: value` entry owns
 * its line and the indented / `- ` continuation lines below it; comments,
 * blank lines and anything else are kept byte for byte. Values are edited as
 * the YAML text they are (a list stays `[a, b]` or a block of `- ` lines).
 */

export interface FrontEntry {
  key: string;
  /** Text after `key:` on the key's own line. */
  inline: string;
  /** Lines below the key that belong to it (indented, or `- ` items). */
  continuation: string[];
}

/** A segment of the body: an entry, or a line that is not one (comment, blank…). */
export type FrontSegment = { entry: FrontEntry } | { line: string };

export interface Frontmatter {
  segments: FrontSegment[];
  /** Line ending used by the file. */
  eol: string;
}

const KEY_LINE = /^([^\s#\-][^:]*?):(?:[ \t]+(.*?))?[ \t]*$/;

/** The frontmatter block (`---` … `---`) at the start of a document, or "". */
export function splitFrontmatter(text: string): string {
  return text.match(/^---\r?\n[\s\S]*?\r?\n---[ \t]*(\r?\n|$)|^---\r?\n---[ \t]*(\r?\n|$)/)?.[0] ?? "";
}

/** Parse a frontmatter block (with its `---` lines). */
export function parseFrontmatter(front: string): Frontmatter {
  const eol = front.includes("\r\n") ? "\r\n" : "\n";
  const lines = front.split(/\r?\n/);
  // Drop the opening and closing `---` (and the empty string after the last newline).
  if (lines[0]?.trim() === "---") lines.shift();
  while (lines.length && lines[lines.length - 1] === "") lines.pop();
  if (lines.length && lines[lines.length - 1]!.trim() === "---") lines.pop();
  const segments: FrontSegment[] = [];
  for (const line of lines) {
    const m = KEY_LINE.exec(line);
    const last = segments[segments.length - 1];
    if (m) {
      segments.push({ entry: { key: m[1]!.trim(), inline: m[2] ?? "", continuation: [] } });
    } else if (last && "entry" in last && (/^[ \t]/.test(line) || /^- /.test(line)) && line.trim() !== "") {
      last.entry.continuation.push(line);
    } else {
      segments.push({ line });
    }
  }
  return { segments, eol };
}

export function entries(fm: Frontmatter): FrontEntry[] {
  return fm.segments.flatMap((s) => ("entry" in s ? [s.entry] : []));
}

/** Back to a frontmatter block, `---` lines included. */
export function formatFrontmatter(fm: Frontmatter): string {
  const lines = ["---"];
  for (const s of fm.segments) {
    if ("line" in s) lines.push(s.line);
    else {
      const { key, inline, continuation } = s.entry;
      // A row still waiting for its name is not written.
      if (!key) continue;
      lines.push(inline ? `${key}: ${inline}` : `${key}:`);
      lines.push(...continuation);
    }
  }
  lines.push("---");
  return lines.join(fm.eol) + fm.eol;
}

/** The value as one editable text: the inline part, then the continuation lines. */
export function valueText(entry: FrontEntry): string {
  if (!entry.continuation.length) return entry.inline;
  return [entry.inline, ...entry.continuation].join("\n").replace(/^\n/, "");
}

/** Set an entry's value from editable text (see `valueText`). */
export function setValueText(entry: FrontEntry, text: string): void {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const first = lines[0] ?? "";
  if (lines.length === 1) {
    entry.inline = first.trim();
    entry.continuation = [];
  } else if (/^[ \t]/.test(first) || /^- /.test(first) || first === "") {
    entry.inline = "";
    entry.continuation = lines.filter((l, i) => i > 0 || l !== "").map((l) => (/^[ \t]|^- /.test(l) ? l : `  ${l}`));
  } else {
    entry.inline = first.trim();
    entry.continuation = lines.slice(1).map((l) => (/^[ \t]|^- /.test(l) ? l : `  ${l}`));
  }
}

/** A short one-line preview of a value, for the collapsed panel. */
export function previewValue(entry: FrontEntry): string {
  if (!entry.continuation.length) return entry.inline.replace(/^["']|["']$/g, "");
  const items = entry.continuation.map((l) => l.trim().replace(/^- /, ""));
  return items.join(", ");
}
