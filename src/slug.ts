/** GitHub's heading anchors, shared by the editor and the DOCX export. Pure. */

/**
 * Slugify one heading the way GitHub does: lower case, drop punctuation, and
 * turn runs of whitespace into single hyphens. Letters, digits, combining
 * marks, `_` and `-` survive; everything else is dropped.
 */
export function headingSlug(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\p{M}\s_-]+/gu, "")
    .replace(/\s+/gu, "-");
}

/**
 * Slugs for a document's headings, in document order, with GitHub's duplicate
 * rule applied: the first `Setup` is `setup`, the next `setup-1`, and so on.
 */
export function headingSlugs(texts: readonly string[]): string[] {
  const seen = new Map<string, number>();
  return texts.map((text) => {
    const base = headingSlug(text);
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    return count === 0 ? base : `${base}-${count}`;
  });
}
