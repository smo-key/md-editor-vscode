import { readFileSync } from "fs";
import { describe, expect, it } from "vitest";

import {
  compareVersions,
  parseChangelog,
  parseVersion,
  renderInline,
  renderMarkdown,
  sectionsFor,
  shouldShowWhatsNew,
  whatsNewHtml,
} from "../../src/whatsNew";

describe("versions", () => {
  it("parses semver, with or without a v and a pre-release tag", () => {
    expect(parseVersion("0.4.0")).toEqual({ major: 0, minor: 4, patch: 0 });
    expect(parseVersion("v1.2.3")).toEqual({ major: 1, minor: 2, patch: 3 });
    expect(parseVersion("1.2.3-beta.1")).toEqual({ major: 1, minor: 2, patch: 3 });
    expect(parseVersion("Unreleased")).toBeUndefined();
    expect(parseVersion("1.2")).toBeUndefined();
  });

  it("compares versions", () => {
    expect(compareVersions("0.4.0", "0.3.2")).toBeGreaterThan(0);
    expect(compareVersions("0.3.2", "0.4.0")).toBeLessThan(0);
    expect(compareVersions("0.10.0", "0.9.9")).toBeGreaterThan(0);
    expect(compareVersions("1.0.0", "1.0.0")).toBe(0);
  });

  it.each([
    [undefined, "0.4.0", false], // first install: nothing to announce
    ["0.3.2", "0.4.0", true], // minor update
    ["0.3.0", "0.3.2", false], // patch update
    ["0.4.0", "0.4.0", false], // same version
    ["0.4.0", "1.0.0", true], // major update
    ["1.9.3", "2.0.1", true],
    ["0.4.0", "0.3.2", false], // downgrade
    ["1.0.0", "0.9.0", false],
    ["garbage", "0.4.0", false],
    ["0.3.2", "garbage", false],
  ] as const)("previous %s → current %s: show = %s", (previous, current, show) => {
    expect(shouldShowWhatsNew(previous, current)).toBe(show);
  });
});

const SAMPLE = `# Changelog

Intro text.

## [Unreleased]

### Changed

- Not released yet.

## [0.4.0] - 2026-10-22

### Added
- Math.

## [0.3.2] - 2026-10-22

### Fixed
- A caret bug.

## 0.3.0

### Added
- Comments.

[0.4.0]: https://example.com/compare
`;

describe("changelog", () => {
  it("parses version sections and skips Unreleased", () => {
    const sections = parseChangelog(SAMPLE);
    expect(sections.map((s) => [s.version, s.date])).toEqual([
      ["0.4.0", "2026-10-22"],
      ["0.3.2", "2026-10-22"],
      ["0.3.0", undefined],
    ]);
    expect(sections[0].body).toBe("### Added\n- Math.");
    expect(sections[2].body).toBe("### Added\n- Comments.");
  });

  it("picks the versions after the previous one, up to the current one", () => {
    const sections = parseChangelog(SAMPLE);
    expect(sectionsFor(sections, "0.3.2", "0.4.0").map((s) => s.version)).toEqual(["0.4.0"]);
    expect(sectionsFor(sections, "0.2.0", "0.4.0").map((s) => s.version)).toEqual(["0.4.0", "0.3.2", "0.3.0"]);
    expect(sectionsFor(sections, "0.2.0", "0.3.2").map((s) => s.version)).toEqual(["0.3.2", "0.3.0"]);
  });

  it("without a previous version, picks the current major.minor line", () => {
    const sections = parseChangelog(SAMPLE);
    expect(sectionsFor(sections, undefined, "0.3.2").map((s) => s.version)).toEqual(["0.3.2", "0.3.0"]);
  });

  it("parses the real CHANGELOG.md", () => {
    const sections = parseChangelog(readFileSync("CHANGELOG.md", "utf8"));
    expect(sections.length).toBeGreaterThan(3);
    expect(sectionsFor(sections, "0.3.2", "0.4.0").map((s) => s.version)).toEqual(["0.4.0"]);
  });
});

describe("markdown rendering", () => {
  it("escapes HTML", () => {
    expect(renderInline(`<script>alert("x")</script> & 'q'`)).toBe(
      "&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; &#39;q&#39;",
    );
    expect(renderMarkdown("- <img src=x onerror=alert(1)>")).not.toContain("<img");
  });

  it("renders inline code, bold, italic and kbd", () => {
    expect(renderInline("**Bold** and *it* with `a <b>` code")).toBe(
      "<strong>Bold</strong> and <em>it</em> with <code>a &lt;b&gt;</code> code",
    );
    expect(renderInline("fences ```` ```math ```` here")).toBe("fences <code>```math</code> here");
    expect(renderInline("`**not bold**`")).toBe("<code>**not bold**</code>");
    expect(renderInline("<kbd>⌘/</kbd>")).toBe("<kbd>⌘/</kbd>");
  });

  it("renders only safe links", () => {
    expect(renderInline("[Keep](https://keepachangelog.com/en/1.1.0/)")).toBe(
      '<a href="https://keepachangelog.com/en/1.1.0/">Keep</a>',
    );
    expect(renderInline("[x](javascript:alert(1))")).not.toContain("href");
    expect(renderInline('[x](https://a.b/"onmouseover="y)')).not.toContain('"onmouseover');
  });

  it("renders headings, lists with continuation lines and paragraphs", () => {
    expect(renderMarkdown("### Added\n- One\n  more\n- Two\n\nText.")).toBe(
      '<h3 data-kind="added">Added</h3>\n<ul>\n<li>One more</li>\n<li>Two</li>\n</ul>\n<p>Text.</p>',
    );
  });
});

describe("whatsNewHtml", () => {
  const sections = parseChangelog(SAMPLE);
  const html = whatsNewHtml({ version: "0.4.0", previous: "0.3.2", sections: sectionsFor(sections, "0.3.2", "0.4.0"), nonce: "abc123" });

  it("has a strict CSP using the nonce", () => {
    expect(html).toMatch(/Content-Security-Policy" content="default-src 'none'; style-src 'nonce-abc123'; script-src 'nonce-abc123';"/);
    expect(html).toContain('<script nonce="abc123">');
  });

  it("shows the title, the sections and both buttons", () => {
    expect(html).toContain("What’s New in Ken Markdown Editor 0.4.0");
    expect(html).toContain("<h2>0.4.0");
    expect(html).toContain("<li>Math.</li>");
    expect(html).not.toContain("A caret bug");
    expect(html).toContain('id="changelog"');
    expect(html).toContain('id="close"');
  });

  it("says so when there are no notes", () => {
    expect(whatsNewHtml({ version: "0.5.0", sections: [], nonce: "n" })).toContain("No release notes");
  });

  it("escapes the version strings", () => {
    expect(whatsNewHtml({ version: "<x>", previous: "<y>", sections: [], nonce: "n" })).not.toMatch(/<x>|<y>/);
  });
});
