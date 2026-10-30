import { describe, expect, it } from "vitest";
import { isDefaultEditor } from "../../src/editorAssociation";

describe("default editor (src/editorAssociation.ts)", () => {
  const ken = "kenMarkdown.editor";
  it("falls back to the editor's own priority without a matching association", () => {
    expect(isDefaultEditor("/w/a.md", ken, {}, true)).toBe(true);
    expect(isDefaultEditor("/w/a.md", ken, { "*.txt": "default" }, true)).toBe(true);
    expect(isDefaultEditor("/w/a.md", ken, undefined, false)).toBe(false);
  });

  it("follows the most specific matching association", () => {
    expect(isDefaultEditor("/w/a.md", ken, { "*.md": "default" }, true)).toBe(false);
    expect(isDefaultEditor("/w/a.md", ken, { "*.md": ken }, false)).toBe(true);
    expect(isDefaultEditor("/w/docs/a.md", ken, { "*.md": ken, "**/docs/*.md": "default" }, true)).toBe(false);
    expect(isDefaultEditor("/w/a.markdown", ken, { "*.{md,markdown}": "default" }, true)).toBe(false);
  });
});
