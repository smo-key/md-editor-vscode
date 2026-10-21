import { describe, expect, it } from "vitest";

import { headingSlug, headingSlugs, normalizeAnchorHref } from "../../webview/markdown/anchors";

describe("headingSlug", () => {
  it("lower-cases and hyphenates words", () => {
    expect(headingSlug("Getting Started")).toBe("getting-started");
  });

  it("drops punctuation", () => {
    expect(headingSlug("What's new?")).toBe("whats-new");
    expect(headingSlug("Setup (macOS)")).toBe("setup-macos");
    expect(headingSlug("A/B testing")).toBe("ab-testing");
    expect(headingSlug("`code` spans")).toBe("code-spans");
  });

  it("keeps hyphens, underscores and digits", () => {
    expect(headingSlug("v1.2 release_notes - part 3")).toBe(
      "v12-release_notes---part-3",
    );
  });

  it("collapses runs of whitespace into one hyphen", () => {
    expect(headingSlug("Too   many\tspaces")).toBe("too-many-spaces");
  });

  it("trims surrounding whitespace", () => {
    expect(headingSlug("  Padded  ")).toBe("padded");
  });

  it("keeps non-latin letters", () => {
    expect(headingSlug("Café déjà vu")).toBe("café-déjà-vu");
    expect(headingSlug("日本語 の 見出し")).toBe("日本語-の-見出し");
  });

  it("returns an empty slug for punctuation-only headings", () => {
    expect(headingSlug("!!!")).toBe("");
  });
});

describe("headingSlugs", () => {
  it("numbers duplicates the way GitHub does", () => {
    expect(headingSlugs(["Setup", "Setup", "Setup"])).toEqual([
      "setup",
      "setup-1",
      "setup-2",
    ]);
  });

  it("numbers each base independently", () => {
    expect(headingSlugs(["A", "B", "A", "B", "A"])).toEqual([
      "a",
      "b",
      "a-1",
      "b-1",
      "a-2",
    ]);
  });

  it("treats headings that slugify the same as duplicates", () => {
    expect(headingSlugs(["Set up!", "Set up?"])).toEqual(["set-up", "set-up-1"]);
  });

  it("returns an empty list for no headings", () => {
    expect(headingSlugs([])).toEqual([]);
  });
});

describe("normalizeAnchorHref", () => {
  it("strips the leading hash", () => {
    expect(normalizeAnchorHref("#setup")).toBe("setup");
  });

  it("percent-decodes the target", () => {
    expect(normalizeAnchorHref("#a%20b")).toBe("a b");
  });

  it("rejects non-anchor and empty hrefs", () => {
    expect(normalizeAnchorHref("https://example.com")).toBeNull();
    expect(normalizeAnchorHref("mailto:a@b.c")).toBeNull();
    expect(normalizeAnchorHref("#")).toBeNull();
    expect(normalizeAnchorHref("")).toBeNull();
  });

  it("falls back to the raw target when it is not valid encoding", () => {
    expect(normalizeAnchorHref("#100%")).toBe("100%");
  });
});
