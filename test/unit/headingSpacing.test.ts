import { readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";

// kenMarkdown.headingSpacingBefore/After are declared in package.json, read in
// src/provider.ts, applied by webview/main.ts and defaulted in
// webview/styles.css; they must agree.
const root = join(__dirname, "../..");
const read = (file: string) => readFileSync(join(root, file), "utf8");
const settings = JSON.parse(read("package.json")).contributes.configuration.properties;
const css = read("webview/styles.css");
const levels = ["h1", "h2", "h3", "h4", "h5", "h6"];

describe.each([
  ["headingSpacingBefore", "--md-heading-spacing-before"],
  ["headingSpacingAfter", "--md-heading-spacing-after"],
])("kenMarkdown.%s", (name, variable) => {
  const setting = settings[`kenMarkdown.${name}`];

  it("is a bounded number setting, like paragraphSpacing", () => {
    expect(setting.type).toBe("number");
    expect(setting.minimum).toBe(0);
    expect(setting.maximum).toBeGreaterThan(setting.default);
    expect(setting.markdownDescription).toMatch(/multiple of the font size/);
  });

  it("has the same default in the host and the stylesheet", () => {
    expect(read("src/provider.ts")).toContain(`${name}: c.get<number>("${name}", ${setting.default})`);
    expect(css).toMatch(new RegExp(`${variable}: ${setting.default}em;`));
  });

  it("is applied live as a CSS variable, falling back to the stylesheet", () => {
    const main = read("webview/main.ts");
    expect(main).toContain(`root.setProperty("${variable}", \`\${config.${name}}em\`)`);
    expect(main).toContain(`root.removeProperty("${variable}")`);
    expect(read("src/protocol.ts")).toMatch(new RegExp(`${name}: number;`));
  });
});

describe("heading spacing in the stylesheet", () => {
  it("keeps the space below headings at 0.55em of each heading", () => {
    expect(settings["kenMarkdown.headingSpacingAfter"].default).toBe(0.55);
    expect(css).toMatch(/\.measure \.milkdown :is\(h1, h2, h3, h4, h5, h6\) \{[^}]*margin-bottom: var\(--md-heading-spacing-after\);/);
  });

  it("grows the space above headings by about a third", () => {
    // Before this setting a body-size heading had 1.5em above it.
    const before = settings["kenMarkdown.headingSpacingBefore"].default;
    expect(before / 1.5).toBeGreaterThanOrEqual(1.25);
    expect(before / 1.5).toBeLessThanOrEqual(1.5);
  });

  it("scales the space above each level from the setting", () => {
    for (const h of levels) {
      const rule = css.match(new RegExp(`\\.measure \\.milkdown ${h} \\{([^}]*font-size[^}]*)\\}`))?.[1] ?? "";
      expect(rule, h).toMatch(/--ken-heading-before-scale: [\d.]+;/);
    }
    expect(css).toMatch(
      /margin-top: calc\(var\(--md-heading-spacing-before\) \* var\(--ken-heading-before-scale\)\);/,
    );
  });

  it("doesn't add a paragraph's own spacing on top of the space above a heading", () => {
    expect(css).toMatch(/@property --ken-paragraph-half \{[^}]*syntax: "<length>";/);
    expect(css).toMatch(
      /p \+ :is\(h1, h2, h3, h4, h5, h6\) \{[^}]*margin-top: max\(\s*0px,\s*calc\(var\(--md-heading-spacing-before\) \* var\(--ken-heading-before-scale\) - var\(--ken-paragraph-half\)\)\s*\);/,
    );
  });

  it("keeps the first heading (and the one under Properties) where it was", () => {
    // ProseMirror's widgets and the virtual cursor sit before the first block,
    // so the first heading is the one with nothing but those before it.
    const first = css.match(/:is\(h1, h2, h3, h4, h5, h6\):not\(:not\(\.ProseMirror-widget, \.prosemirror-virtual-cursor\) ~ \*\) \{([^}]*)\}/)?.[1];
    expect(first).toContain("margin-top: calc(1.5em * var(--ken-heading-before-scale));");
  });
});
