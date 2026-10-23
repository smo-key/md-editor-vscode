/**
 * Comment threads, and how they are kept in the Markdown file.
 *
 * The commented text is marked in place with invisible HTML comments (see
 * anchors.ts); the threads themselves live in one block at the very end of
 * the file, one thread per line so diffs stay readable:
 *
 *     <!-- ken:comments
 *     {"c1":{"resolved":false,"messages":[{"id":"m1","author":"Ana","date":"2026-10-22T15:00:00.000Z","text":"Source?"}]}}
 *     -->
 *
 * GitHub and other renderers hide the block. `--` inside text is written as
 * `-\u002d` (still the same JSON string) so it can never close the comment.
 */

export interface CommentMessage {
  id: string;
  author: string;
  /** ISO 8601. */
  date: string;
  text: string;
}

export interface CommentThread {
  id: string;
  resolved: boolean;
  messages: CommentMessage[];
}

const BLOCK = /(?:^|\r?\n)[ \t]*<!--[ \t]*ken:comments[ \t]*\r?\n([\s\S]*?)\r?\n?[ \t]*-->[ \t]*(?:\r?\n[ \t]*)*$/;

/** Split a document into its text and its trailing threads block. */
export function splitThreads(text: string): { body: string; block: string } {
  const m = BLOCK.exec(text);
  if (!m) return { body: text, block: "" };
  const body = text.slice(0, m.index).replace(/(\r?\n)*$/, "");
  return { body: body ? body + (text.includes("\r\n") ? "\r\n" : "\n") : "", block: m[0].replace(/^\r?\n/, "") };
}

/**
 * `text` with its trailing threads block replaced by `block` ("" removes it),
 * the text before it kept byte for byte. A block added to text without one
 * follows a blank line, as the editor writes it.
 */
export function replaceThreads(text: string, block: string): string {
  const m = BLOCK.exec(text);
  // The match takes the line break before the block: the text keeps it.
  const before = m ? text.slice(0, m.index) + (m.index > 0 ? "\n" : "") : text;
  if (!block) return m && before.endsWith("\n\n") ? before.slice(0, -1) : before;
  if (!before) return block;
  if (m) return before + block;
  return before.replace(/\n*$/, "\n") + "\n" + block;
}

/** Threads from the block's text (tolerant: a bad line loses only itself). */
export function parseThreads(block: string): Map<string, CommentThread> {
  const threads = new Map<string, CommentThread>();
  const m = BLOCK.exec(block.startsWith("\n") ? block : `\n${block}`);
  if (!m) return threads;
  const body = m[1]!.trim();
  if (!body) return threads;
  const add = (obj: unknown) => {
    if (!obj || typeof obj !== "object") return;
    for (const [id, raw] of Object.entries(obj as Record<string, unknown>)) {
      const t = raw as Partial<CommentThread> | null;
      if (!t || !Array.isArray(t.messages)) continue;
      threads.set(id, {
        id,
        resolved: t.resolved === true,
        messages: t.messages
          .filter((x): x is CommentMessage => !!x && typeof (x as CommentMessage).text === "string")
          .map((x, i) => ({
            id: typeof x.id === "string" ? x.id : `m${i + 1}`,
            author: typeof x.author === "string" ? x.author : "",
            date: typeof x.date === "string" ? x.date : "",
            text: x.text,
          })),
      });
    }
  };
  try {
    add(JSON.parse(body));
  } catch {
    // One thread per line, as written: parse what can be parsed.
    for (const line of body.split(/\r?\n/)) {
      const l = line.trim().replace(/^[{,]\s*/, "").replace(/\s*[,}]$/, "");
      if (!l) continue;
      try {
        add(JSON.parse(`{${l}}`));
      } catch {
        // Skip a damaged line.
      }
    }
  }
  return threads;
}

/** The threads block for `threads` (in the given order), or "" for none. */
export function formatThreads(threads: CommentThread[], eol = "\n"): string {
  if (!threads.length) return "";
  const lines = threads.map((t, i) => {
    const value = JSON.stringify({ resolved: t.resolved, messages: t.messages });
    return `${i === 0 ? "{" : " "}${JSON.stringify(t.id)}:${value}${i === threads.length - 1 ? "}" : ","}`;
  });
  const json = lines.join(eol).replace(/--/g, "-\\u002d");
  return `<!-- ken:comments${eol}${json}${eol}-->${eol}`;
}

let counter = 0;
/** A short id unlikely to clash with any in the document. */
export function newId(prefix: string, taken: (id: string) => boolean): string {
  for (;;) {
    const id = `${prefix}${Date.now().toString(36).slice(-4)}${(counter++).toString(36)}`;
    if (!taken(id)) return id;
  }
}

type Listener = () => void;

/** The document's threads, shared by the editor plugin and the comments UI. */
export class ThreadStore {
  private threads = new Map<string, CommentThread>();
  private readonly listeners = new Set<Listener>();
  /** Shown to others as the author of new comments. */
  author = "";

  load(block: string): void {
    this.threads = parseThreads(block);
    this.emit();
  }

  get(id: string): CommentThread | undefined {
    return this.threads.get(id);
  }

  all(): CommentThread[] {
    return [...this.threads.values()];
  }

  has(id: string): boolean {
    return this.threads.has(id);
  }

  create(id: string): CommentThread {
    const t: CommentThread = { id, resolved: false, messages: [] };
    this.threads.set(id, t);
    this.emit();
    return t;
  }

  reply(id: string, text: string): void {
    const t = this.threads.get(id) ?? this.create(id);
    t.messages.push({
      id: newId("m", (m) => t.messages.some((x) => x.id === m)),
      author: this.author,
      date: new Date().toISOString(),
      text,
    });
    this.emit();
  }

  editMessage(id: string, messageId: string, text: string): void {
    const m = this.threads.get(id)?.messages.find((x) => x.id === messageId);
    if (!m) return;
    m.text = text;
    this.emit();
  }

  deleteMessage(id: string, messageId: string): void {
    const t = this.threads.get(id);
    if (!t) return;
    t.messages = t.messages.filter((m) => m.id !== messageId);
    this.emit();
  }

  setResolved(id: string, resolved: boolean): void {
    const t = this.threads.get(id);
    if (!t) return;
    t.resolved = resolved;
    this.emit();
  }

  /** Forget a thread entirely (its markers are removed by the caller). */
  remove(id: string): void {
    if (this.threads.delete(id)) this.emit();
  }

  /** The block to write: threads with markers in the document, in document order. */
  format(idsInOrder: string[], eol = "\n"): string {
    const list = idsInOrder.map((id) => this.threads.get(id)).filter((t): t is CommentThread => !!t && t.messages.length > 0);
    return formatThreads(list, eol);
  }

  onChange(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit() {
    for (const l of this.listeners) l();
  }
}

/** The one store for this editor. */
export const threadStore = new ThreadStore();
