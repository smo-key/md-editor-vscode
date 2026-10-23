import { describe, expect, it } from "vitest";

import { parseFrontmatter, propertyValue, rowsUnsupported, setProperty } from "../../webview/frontmatterModel";

const KEY = "ken-heading-numbering";

/** Lines that differ between two texts, as [before, after] pairs. */
function changedLines(a: string, b: string): { removed: string[]; added: string[] } {
  const x = a.split("\n");
  const y = b.split("\n");
  return { removed: x.filter((l) => !y.includes(l)), added: y.filter((l) => !x.includes(l)) };
}

// Odd but valid spacing the panel's own formatter would normalize.
const FRONT = ["---", "title:    Spaced  ", "tags :", "  - a", "  - b", "# a comment", "", `${KEY}: off`, "date: 2024-01-01", "---", ""].join("\n");

describe("propertyValue", () => {
  it("reads a property's value as written", () => {
    expect(propertyValue(FRONT, KEY)).toBe("off");
    expect(propertyValue('---\nken-heading-numbering: "1.a"\n---\n', KEY)).toBe('"1.a"');
  });

  it("is undefined when absent or with no frontmatter", () => {
    expect(propertyValue("---\ntitle: x\n---\n", KEY)).toBeUndefined();
    expect(propertyValue("", KEY)).toBeUndefined();
  });

  it("reads a block value as its YAML text", () => {
    expect(propertyValue(`---\n${KEY}:\n  - a\n---\n`, KEY)).toBe("  - a");
  });
});

describe("setProperty", () => {
  it("changes only the property's line", () => {
    const next = setProperty(FRONT, KEY, '"I-1"');
    expect(changedLines(FRONT, next)).toEqual({ removed: [`${KEY}: off`], added: [`${KEY}: "I-1"`] });
    expect(next.split("\n")).toHaveLength(FRONT.split("\n").length);
  });

  it("adds the property as one line before the closing ---", () => {
    const front = "---\ntitle:    Spaced  \n---\n";
    expect(setProperty(front, KEY, "on")).toBe(`---\ntitle:    Spaced  \n${KEY}: on\n---\n`);
  });

  it("creates the frontmatter when there is none", () => {
    expect(setProperty("", KEY, "off")).toBe(`---\n${KEY}: off\n---\n`);
  });

  it("removes only the property's line", () => {
    const next = setProperty(FRONT, KEY, null);
    expect(changedLines(FRONT, next)).toEqual({ removed: [`${KEY}: off`], added: [] });
  });

  it("removes a block value with its lines", () => {
    expect(setProperty(`---\n${KEY}:\n  - a\ntitle: x\n---\n`, KEY, "on")).toBe(`---\n${KEY}: on\ntitle: x\n---\n`);
  });

  it("removes frontmatter it leaves empty", () => {
    expect(setProperty(`---\n${KEY}: off\n---\n`, KEY, null)).toBe("");
  });

  it("does nothing to remove an absent property", () => {
    expect(setProperty("---\ntitle: x\n---\n", KEY, null)).toBe("---\ntitle: x\n---\n");
    expect(setProperty("", KEY, null)).toBe("");
  });

  it("keeps CRLF line endings", () => {
    expect(setProperty("---\r\ntitle: x\r\n---\r\n", KEY, "off")).toBe(`---\r\ntitle: x\r\n${KEY}: off\r\n---\r\n`);
  });

  it("keeps the property rows flat (no YAML-only mode)", () => {
    for (const value of ["off", "on", '"1.a.i.1.a.i"', '"I / 1"', '"1\\"a"']) {
      expect(rowsUnsupported(parseFrontmatter(setProperty("---\ntitle: x\n---\n", KEY, value))), value).toBeNull();
    }
  });
});
