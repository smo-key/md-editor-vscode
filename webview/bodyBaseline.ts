// The body text as last agreed with the host, so an edit that leaves the body
// alone (a frontmatter edit, a document change that serializes the same)
// writes the body's bytes exactly as they were. Serializing would normalize
// syntax nobody touched (`| --- |` to `| - |`, setext headings, `*` bullets).

/** What the body was written (or read) as, and the editor document that says the same. */
export class BodyBaseline {
  private doc: unknown = null;
  /** The serializer's output for that document; "\u0000" for none yet. */
  private markdown = "\u0000";
  private back = "";
  private raw = "";

  /** The editor's document `doc`, serialized as `markdown` with threads block `back`, is `raw` in the file. */
  remember(doc: unknown, markdown: string, back: string, raw: string): void {
    this.doc = doc;
    this.markdown = markdown;
    this.back = back;
    this.raw = raw;
  }

  /** Forget the baseline: the next body is serialized and written afresh. */
  forget(): void {
    this.doc = null;
    this.markdown = "\u0000";
  }

  /**
   * The body text for `doc` and threads block `back`: the baseline's own
   * bytes while the editor still says the same thing, otherwise `compose`
   * of the freshly serialized Markdown (which becomes the baseline).
   */
  body(doc: unknown, back: string, serialize: () => string, compose: (markdown: string) => string): string {
    if (doc === this.doc && back === this.back) return this.raw;
    const markdown = serialize();
    if (markdown === this.markdown && back === this.back) {
      this.doc = doc;
      return this.raw;
    }
    this.remember(doc, markdown, back, compose(markdown));
    return this.raw;
  }
}
