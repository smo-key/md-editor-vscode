import { describe, expect, it } from "vitest";
import { classifyHref, minimalChange, toEOL, toLF, uniqueName } from "../../src/sync";

function apply(before: string, after: string): string {
  const c = minimalChange(before, after);
  if (!c) return before;
  return before.slice(0, c.start) + c.text + before.slice(c.end);
}

describe("minimalChange", () => {
  it("returns null for equal texts", () => {
    expect(minimalChange("abc", "abc")).toBeNull();
  });

  it("finds a single insertion", () => {
    expect(minimalChange("# Title\n\nbody\n", "# Title\n\nmore body\n")).toEqual({
      start: 9,
      end: 9,
      text: "more ",
    });
  });

  it("finds a deletion and a replacement", () => {
    expect(minimalChange("hello world", "hello")).toEqual({ start: 5, end: 11, text: "" });
    expect(minimalChange("a-b-c", "a+b-c")).toEqual({ start: 1, end: 2, text: "+" });
  });

  it("handles repeated characters without overlapping prefix and suffix", () => {
    for (const [a, b] of [
      ["aaa", "aaaa"],
      ["aaaa", "aa"],
      ["abab", "ab"],
      ["", "x"],
      ["x", ""],
    ]) {
      expect(apply(a, b)).toBe(b);
    }
  });

  it("never splits a surrogate pair", () => {
    const c = minimalChange("x😀y", "x😃y")!;
    expect(c.text).toBe("😃");
    expect(apply("x😀y", "x😃y")).toBe("x😃y");
  });

  it("round-trips random edits", () => {
    const alphabet = "ab\n#-😀";
    const rand = (n: number) =>
      Array.from({ length: n }, () => alphabet[Math.floor(Math.random() * alphabet.length)]).join("");
    for (let i = 0; i < 500; i++) {
      const a = rand(Math.floor(Math.random() * 12));
      const b = rand(Math.floor(Math.random() * 12));
      expect(apply(a, b)).toBe(b);
    }
  });
});

describe("line endings", () => {
  it("normalises and restores", () => {
    expect(toLF("a\r\nb\rc\n")).toBe("a\nb\nc\n");
    expect(toEOL("a\nb", true)).toBe("a\r\nb");
    expect(toEOL("a\nb", false)).toBe("a\nb");
  });
});

describe("uniqueName", () => {
  it("dedupes and sanitises", async () => {
    const taken = new Set(["shot.png", "shot-1.png"]);
    expect(await uniqueName("shot.png", async (n) => taken.has(n))).toBe("shot-2.png");
    expect(await uniqueName("a/b:c.png", async () => false)).toBe("a-b-c.png");
    expect(await uniqueName("...", async () => false)).toBe("file");
  });
});

describe("classifyHref", () => {
  it("classifies links", () => {
    expect(classifyHref("https://x.dev")).toEqual({ kind: "external", url: "https://x.dev" });
    expect(classifyHref("#intro")).toEqual({ kind: "anchor", anchor: "intro" });
    expect(classifyHref("../Team%20Notes.md#roles")).toEqual({
      kind: "file",
      path: "../Team Notes.md",
      fragment: "roles",
    });
  });
});

describe("imageFolder", () => {
  it("keeps the folder below the document", async () => {
    const { imageFolder } = await import("../../src/sync");
    expect(imageFolder("_Images")).toBe("_Images");
    expect(imageFolder("assets\\img/")).toBe("assets/img");
    expect(imageFolder("../../etc")).toBe("etc");
    expect(imageFolder("/abs/./x")).toBe("abs/x");
    expect(imageFolder("")).toBe("");
    expect(imageFolder(undefined)).toBe("");
  });
});
