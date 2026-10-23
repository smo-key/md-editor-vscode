// The body text as last agreed with the host, so an edit that leaves the body
// alone (a frontmatter edit, a document change that serializes the same)
// writes the body's bytes exactly as they were. Serializing would normalize
// syntax nobody touched (`| --- |` to `| - |`, setext headings, `*` bullets).
//
// Besides the body last written, it keeps the bytes the file was opened with
// and the ones of the last change from outside (the source editor, git, a
// reload). When the editor says the same as one of those again (every edit
// undone), those bytes are written, so the file reads as it did. A pair is
// matched on the serialized Markdown, never on the bytes alone, so the bytes
// always say what the editor's document says: an undo that leaves a remote or
// outside change in place serializes differently and is written afresh.
//
// The comment threads block (`back`) is kept apart: when only it changed (a
// reply), it is swapped in the remembered bytes and the body is left alone.
import { replaceThreads } from "./comments/store";

interface Pair {
  /** The serializer's output for the document. */
  markdown: string;
  /** The threads block in `raw`. */
  back: string;
  /** The body as written in the file (threads block included). */
  raw: string;
}

/** What the body was written (or read) as, and the editor document that says the same. */
export class BodyBaseline {
  private doc: unknown = null;
  /** The body last written; `markdown` is "\u0000" for none yet. */
  private current: Pair = { markdown: "\u0000", back: "", raw: "" };
  /** The file's own bytes: as opened, and after the last change from outside. */
  private opened: Pair | null = null;
  private reloaded: Pair | null = null;

  /** The editor's document `doc`, serialized as `markdown` with threads block `back`, is `raw` in the file. */
  remember(doc: unknown, markdown: string, back: string, raw: string): void {
    this.doc = doc;
    this.current = { markdown, back, raw };
  }

  /** The file was opened as `raw`: its bytes come back whenever the editor says the same again. */
  open(doc: unknown, markdown: string, back: string, raw: string): void {
    this.remember(doc, markdown, back, raw);
    this.opened = this.current;
    this.reloaded = null;
  }

  /** The file changed outside the editor to `raw` (the editor followed). */
  reload(doc: unknown, markdown: string, back: string, raw: string): void {
    this.remember(doc, markdown, back, raw);
    this.reloaded = this.current;
  }

  /** Forget every baseline: the next body is serialized and written afresh. */
  forget(): void {
    this.doc = null;
    this.current = { markdown: "\u0000", back: "", raw: "" };
    this.opened = null;
    this.reloaded = null;
  }

  /**
   * The body text for `doc` and threads block `back`: remembered bytes while
   * the editor still says the same thing (the threads block swapped if only
   * it changed), otherwise `compose` of the freshly serialized Markdown
   * (which becomes the baseline).
   */
  body(doc: unknown, back: string, serialize: () => string, compose: (markdown: string) => string): string {
    if (doc === this.doc && back === this.current.back) return this.current.raw;
    // Serialized even for the same document: what it serializes as depends on
    // the threads too (a draft's markers are left out until its first message,
    // which is also when it joins the threads block).
    const markdown = serialize();
    for (const pair of [this.current, this.reloaded, this.opened]) {
      if (!pair || pair.markdown !== markdown) continue;
      this.remember(doc, markdown, back, pair.back === back ? pair.raw : replaceThreads(pair.raw, back));
      return this.current.raw;
    }
    this.remember(doc, markdown, back, compose(markdown));
    return this.current.raw;
  }
}
