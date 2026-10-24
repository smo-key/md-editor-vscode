import { describe, expect, it } from "vitest";
import { sameAsSaved, savedTextFor } from "../../src/savedText";

const bytes = (s: string) => new TextEncoder().encode(s);

describe("savedTextFor", () => {
  it("decodes UTF-8", () => {
    expect(savedTextFor(bytes("# Héllo\n"), false)).toBe("# Héllo\n");
  });

  it("drops a BOM, as VS Code does", () => {
    expect(savedTextFor(new Uint8Array([0xef, 0xbb, 0xbf, ...bytes("a\n")]), false)).toBe("a\n");
  });

  it("uses the document's line ending, even for mixed endings", () => {
    expect(savedTextFor(bytes("a\r\nb\nc\rd"), true)).toBe("a\r\nb\r\nc\r\nd");
    expect(savedTextFor(bytes("a\r\nb\nc"), false)).toBe("a\nb\nc");
  });
});

describe("sameAsSaved", () => {
  it("is false while the saved text is unknown", () => {
    expect(sameAsSaved("a", undefined)).toBe(false);
  });

  it("compares the whole text", () => {
    expect(sameAsSaved("abc", "abc")).toBe(true);
    expect(sameAsSaved("abd", "abc")).toBe(false);
    expect(sameAsSaved("abcd", "abc")).toBe(false);
    expect(sameAsSaved("", "")).toBe(true);
  });
});
