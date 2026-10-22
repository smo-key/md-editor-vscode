import { describe, expect, it } from "vitest";
import {
  entries,
  formatFrontmatter,
  parseFrontmatter,
  previewValue,
  setValueText,
  splitFrontmatter,
  valueText,
} from "../../webview/frontmatterModel";

const FRONT = "---\ntitle: Sample\naliases: [demo]\ntags:\n  - one\n  - two\n# a comment\n\nurl: https://x.dev/a:b\n---\n";

describe("frontmatter model", () => {
  it("finds the block at the start of a document only", () => {
    expect(splitFrontmatter(`${FRONT}# Doc\n`)).toBe(FRONT);
    expect(splitFrontmatter("# Doc\n\n---\nx: 1\n---\n")).toBe("");
    expect(splitFrontmatter("---\n---\nBody\n")).toBe("---\n---\n");
  });

  it("round-trips untouched, comments and blank lines included", () => {
    expect(formatFrontmatter(parseFrontmatter(FRONT))).toBe(FRONT);
    const crlf = FRONT.replace(/\n/g, "\r\n");
    expect(formatFrontmatter(parseFrontmatter(crlf))).toBe(crlf);
  });

  it("reads entries with inline and block values", () => {
    const list = entries(parseFrontmatter(FRONT));
    expect(list.map((e) => e.key)).toEqual(["title", "aliases", "tags", "url"]);
    expect(valueText(list[2]!)).toBe("  - one\n  - two");
    expect(previewValue(list[2]!)).toBe("one, two");
    expect(list[3]!.inline).toBe("https://x.dev/a:b");
  });

  it("edits only the lines of the entry that changed", () => {
    const fm = parseFrontmatter(FRONT);
    setValueText(entries(fm)[0]!, "New title");
    expect(formatFrontmatter(fm)).toBe(FRONT.replace("title: Sample", "title: New title"));
    setValueText(entries(fm)[1]!, "- a\n- b");
    expect(formatFrontmatter(fm)).toContain("aliases:\n- a\n- b\ntags:");
  });

  it("does not write a row that has no name yet", () => {
    const fm = parseFrontmatter(FRONT);
    fm.segments.push({ entry: { key: "", inline: "draft", continuation: [] } });
    expect(formatFrontmatter(fm)).toBe(FRONT);
  });
});
