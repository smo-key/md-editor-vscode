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

/**
 * A document as the editor takes it: the frontmatter block, the blank lines
 * after it (the Markdown parser drops leading blank lines, so they would be
 * lost on the first save), and the body. `joinDocument` puts them back.
 */
export function splitDocument(text: string): { front: string; gap: string; body: string } {
  const front = splitFrontmatter(text);
  const rest = text.slice(front.length);
  const gap = /^(?:[ \t]*\r?\n)*/.exec(rest)![0];
  return { front, gap, body: rest.slice(gap.length) };
}

export function joinDocument(front: string, gap: string, body: string): string {
  return front + gap + body;
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

// --- YAML syntax colouring --------------------------------------------------

/** A YAML token kind; `null` for text that is not coloured (whitespace). */
export type YamlType =
  | "key"
  | "string" // quoted scalar
  | "plain" // unquoted string
  | "number"
  | "bool"
  | "null"
  | "date"
  | "punct"
  | "comment"
  | "anchor" // &anchor or *alias
  | "tag" // !tag
  | null;

export interface YamlToken {
  type: YamlType;
  text: string;
}

const NUMBER = /^[-+]?(?:\d[\d_]*(?:\.\d*)?|\.\d+)(?:[eE][-+]?\d+)?$|^0x[\da-fA-F_]+$|^0o[0-7_]+$|^[-+]?\.(?:inf|Inf|INF)$|^\.(?:nan|NaN|NAN)$/;
const DATE = /^\d{4}-\d\d?-\d\d?(?:(?:[Tt]|[ \t]+)\d\d?:\d\d:\d\d(?:\.\d*)?(?:[ \t]*(?:Z|[-+]\d\d?(?::\d\d)?))?)?$/;

/** The type of a plain (unquoted) scalar, YAML 1.2 core schema plus timestamps. */
export function scalarType(text: string): Exclude<YamlType, "key" | "punct" | "comment" | "anchor" | "tag" | null> {
  if (/^["']/.test(text)) return "string";
  if (text === "" || /^(?:~|null|Null|NULL)$/.test(text)) return "null";
  if (/^(?:true|True|TRUE|false|False|FALSE)$/.test(text)) return "bool";
  if (NUMBER.test(text)) return "number";
  if (DATE.test(text)) return "date";
  return "plain";
}

/**
 * Tokens of a YAML value as written after `key:` (a scalar, a flow
 * collection, an anchor…). The tokens' text joins back to `text` exactly.
 */
export function yamlTokens(text: string): YamlToken[] {
  const out: YamlToken[] = [];
  const push = (type: YamlType, t: string) => {
    if (!t) return;
    const last = out[out.length - 1];
    if (type === null && last && last.type === null) last.text += t;
    else out.push({ type, text: t });
  };
  let i = 0;
  let depth = 0;
  let first = true;
  const isSpace = (c: string | undefined) => c === " " || c === "\t";
  // After a scalar, is the next thing a `:` (so the scalar is a key)?
  const keyFollows = (from: number) => {
    let j = from;
    while (isSpace(text[j])) j++;
    return text[j] === ":" && (j + 1 >= text.length || isSpace(text[j + 1]) || (depth > 0 && /[,\]}]/.test(text[j + 1]!)));
  };
  while (i < text.length) {
    const c = text[i]!;
    if (isSpace(c)) {
      let j = i;
      while (isSpace(text[j])) j++;
      push(null, text.slice(i, j));
      i = j;
      continue;
    }
    if (c === "#" && (i === 0 || isSpace(text[i - 1]))) {
      push("comment", text.slice(i));
      break;
    }
    if (first && depth === 0 && (c === "|" || c === ">")) {
      const m = /^[|>][-+0-9]*/.exec(text.slice(i))![0];
      push("punct", m);
      i += m.length;
      first = false;
      continue;
    }
    first = false;
    if (c === "&" || c === "*" || c === "!") {
      let j = i + 1;
      while (j < text.length && !isSpace(text[j]) && !(depth > 0 && /[,[\]{}]/.test(text[j]!))) j++;
      push(c === "!" ? "tag" : "anchor", text.slice(i, j));
      i = j;
      continue;
    }
    if (c === "[" || c === "{") {
      depth++;
      push("punct", c);
      i++;
      continue;
    }
    if (depth > 0 && (c === "]" || c === "}" || c === ",")) {
      if (c !== ",") depth--;
      push("punct", c);
      i++;
      continue;
    }
    if (depth > 0 && c === ":") {
      push("punct", c);
      i++;
      continue;
    }
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < text.length) {
        if (c === '"' && text[j] === "\\") j += 2;
        else if (c === "'" && text[j] === "'" && text[j + 1] === "'") j += 2;
        else if (text[j] === c) {
          j++;
          break;
        } else j++;
      }
      j = Math.min(j, text.length);
      push(keyFollows(j) && depth > 0 ? "key" : "string", text.slice(i, j));
      i = j;
      continue;
    }
    // A plain scalar: to a comment, the end, or (in a flow) an indicator.
    let j = i;
    while (j < text.length) {
      const d = text[j]!;
      if (d === "#" && isSpace(text[j - 1])) break;
      if (depth > 0) {
        if (/[,[\]{}]/.test(d)) break;
        if (d === ":" && (j + 1 >= text.length || isSpace(text[j + 1]) || /[,\]}]/.test(text[j + 1]!))) break;
      }
      j++;
    }
    let end = j;
    while (end > i && isSpace(text[end - 1])) end--;
    const scalar = text.slice(i, end);
    push(depth > 0 && keyFollows(end) ? "key" : scalarType(scalar), scalar);
    i = end;
  }
  return out;
}

const RAW_KEY = /^((?:"(?:[^"\\]|\\.)*"|'(?:[^']|'')*'|[^\s#'"[\]{},&*!|>%@`?:-][^:#]*?|-[^\s:#][^:#]*?))([ \t]*)(:)(?=[ \t]|$)/;

/** Raw YAML, one token list per line, for the raw view's colouring. */
export function highlightYaml(text: string): YamlToken[][] {
  const lines: YamlToken[][] = [];
  // Inside a block scalar (`|` / `>`): the indent of the line that opened it.
  let blockOwner: number | null = null;
  for (const line of text.split("\n")) {
    const indent = /^[ \t]*/.exec(line)![0].length;
    if (blockOwner !== null) {
      if (line.trim() === "") {
        lines.push(line ? [{ type: null, text: line }] : []);
        continue;
      }
      if (indent > blockOwner) {
        lines.push([{ type: "string", text: line }]);
        continue;
      }
      blockOwner = null;
    }
    const tokens: YamlToken[] = [];
    if (indent) tokens.push({ type: null, text: line.slice(0, indent) });
    let rest = line.slice(indent);
    if (/^#/.test(rest)) {
      tokens.push({ type: "comment", text: rest });
      lines.push(tokens);
      continue;
    }
    if (/^(?:---|\.\.\.)[ \t]*$/.test(rest)) {
      tokens.push({ type: "punct", text: rest });
      lines.push(tokens);
      continue;
    }
    let dash: RegExpExecArray | null;
    while ((dash = /^-(?=[ \t]|$)([ \t]*)/.exec(rest))) {
      tokens.push({ type: "punct", text: "-" });
      if (dash[1]) tokens.push({ type: null, text: dash[1] });
      rest = rest.slice(dash[0].length);
    }
    const key = RAW_KEY.exec(rest);
    if (key) {
      tokens.push({ type: "key", text: key[1]! });
      if (key[2]) tokens.push({ type: null, text: key[2] });
      tokens.push({ type: "punct", text: ":" });
      rest = rest.slice(key[0].length);
    }
    const value = yamlTokens(rest);
    tokens.push(...value);
    if (value.find((t) => t.type)?.text.match(/^[|>]/) && value.find((t) => t.type)?.type === "punct") blockOwner = indent;
    lines.push(tokens);
  }
  return lines;
}

/** A value as tokens for the one-line collapsed preview (a block list reads `a, b`). */
export function previewTokens(entry: FrontEntry): YamlToken[] {
  if (!entry.continuation.length) return yamlTokens(entry.inline.trim());
  const out: YamlToken[] = [];
  entry.continuation.forEach((l, i) => {
    if (i) out.push({ type: "punct", text: "," }, { type: null, text: " " });
    out.push(...yamlTokens(l.trim().replace(/^-[ \t]*/, "")));
  });
  return out;
}

// --- What the rows can edit ---------------------------------------------------

const NESTED = "Nested properties can only be edited as YAML";
const MULTILINE = "Multi-line values can only be edited as YAML";
const ANCHORS = "Anchors and aliases can only be edited as YAML";
const TAGS = "YAML tags can only be edited as YAML";
const COMMENTS = "Comments inside a property can only be edited as YAML";
const OTHER = "This frontmatter uses YAML the property rows cannot show; edit it as YAML";

/** Why a one-line value (inline, or a list item) cannot be a row's text, or null. */
function scalarProblem(text: string): string | null {
  const tokens = yamlTokens(text);
  if (tokens.some((t) => t.type === "comment")) return COMMENTS;
  if (tokens.some((t) => t.type === "anchor")) return ANCHORS;
  if (tokens.some((t) => t.type === "tag")) return TAGS;
  const lead = tokens.find((t) => t.type);
  if (lead?.type === "punct" && /^[|>]/.test(lead.text)) return MULTILINE;
  return null;
}

/**
 * Why the rows cannot show this frontmatter faithfully (null when they can).
 *
 * A row is a key and its value's text, so the rows hold flat properties:
 * one-line scalars and flow collections (`[a, b]`, `{a: 1}`), and block lists
 * of one-line scalars. Anything whose meaning lives in structure or in lines
 * a row would merge or hide needs the YAML view: nested mappings and lists of
 * mappings, multi-line scalars (`|`, `>`, or a plain/quoted value continued on
 * further lines), anchors/aliases and tags (they tie values across rows), and
 * comments inside a property. Comment and blank lines between properties are
 * fine: the model keeps them byte for byte. Rows without a name (a draft) are
 * not written, so they do not count.
 */
export function rowsUnsupported(fm: Frontmatter): string | null {
  for (const s of fm.segments) {
    if ("line" in s) {
      if (s.line.trim() === "" || /^[ \t]*#/.test(s.line)) continue;
      return OTHER;
    }
    const { key, inline, continuation } = s.entry;
    if (!key) continue;
    if (/^[&*!]/.test(key)) return ANCHORS;
    const inlineProblem = scalarProblem(inline);
    if (inlineProblem) return inlineProblem;
    if (!continuation.length) continue;
    if (continuation.some((l) => /^[ \t]*#/.test(l))) return COMMENTS;
    if (inline.trim()) return MULTILINE;
    let indent: string | null = null;
    for (const line of continuation) {
      const item = /^([ \t]*)-(?:[ \t]+(.*))?$/.exec(line);
      if (!item) return RAW_KEY.test(line.trim()) ? NESTED : MULTILINE;
      if (indent === null) indent = item[1]!;
      else if (item[1] !== indent) return NESTED;
      const text = (item[2] ?? "").trim();
      if (!text || /^-(?:[ \t]|$)/.test(text) || RAW_KEY.test(text)) return NESTED;
      const problem = scalarProblem(text);
      if (problem) return problem;
    }
  }
  return null;
}

// --- One property, by line ----------------------------------------------------

/** The entry for `key` in a frontmatter block: its first line and line count. */
function findProperty(lines: string[], key: string): { start: number; count: number } | null {
  // lines[0] is the opening `---`; stop at the closing one.
  for (let i = 1; i < lines.length && lines[i]!.trim() !== "---"; i++) {
    const m = KEY_LINE.exec(lines[i]!);
    if (!m || m[1]!.trim() !== key) continue;
    let end = i + 1;
    while (end < lines.length && lines[end]!.trim() !== "---" && lines[end]!.trim() !== "" && (/^[ \t]/.test(lines[end]!) || /^- /.test(lines[end]!))) end++;
    return { start: i, count: end - i };
  }
  return null;
}

/** A property's value as its YAML text (`valueText`), or undefined when absent. */
export function propertyValue(front: string, key: string): string | undefined {
  if (!front) return undefined;
  const entry = entries(parseFrontmatter(front)).find((e) => e.key === key);
  return entry ? valueText(entry) : undefined;
}

/**
 * Set (or with `null`, remove) one one-line property, touching only its own
 * line(s): every other line stays byte for byte. A missing property is added
 * before the closing `---`; frontmatter is created when there is none, and
 * removed when the property was all it held.
 */
export function setProperty(front: string, key: string, value: string | null): string {
  if (!front) return value === null ? "" : `---\n${key}: ${value}\n---\n`;
  const eol = front.includes("\r\n") ? "\r\n" : "\n";
  const lines = front.split(/\r?\n/);
  const found = findProperty(lines, key);
  const line = value === null ? [] : [`${key}: ${value}`];
  if (found) lines.splice(found.start, found.count, ...line);
  else if (value !== null) {
    let close = lines.length - 1;
    while (close > 0 && lines[close]!.trim() !== "---") close--;
    if (close === 0) return front;
    lines.splice(close, 0, ...line);
  } else return front;
  const next = lines.join(eol);
  return /^---[ \t]*\r?\n---[ \t]*(\r?\n)?$/.test(next) ? "" : next;
}
