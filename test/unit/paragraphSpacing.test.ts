import { readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";

// kenMarkdown.paragraphSpacing is declared in package.json, read in
// src/provider.ts and defaulted in webview/styles.css; the three must agree.
const root = join(__dirname, "../..");
const read = (file: string) => readFileSync(join(root, file), "utf8");

describe("kenMarkdown.paragraphSpacing", () => {
  const setting = JSON.parse(read("package.json")).contributes.configuration.properties["kenMarkdown.paragraphSpacing"];
  const css = read("webview/styles.css");

  it("is a bounded number setting", () => {
    expect(setting.type).toBe("number");
    expect(setting.minimum).toBe(0);
    expect(setting.maximum).toBeGreaterThan(setting.default);
  });

  it("has the same default in the host and the stylesheet", () => {
    expect(read("src/provider.ts")).toContain(`c.get<number>("paragraphSpacing", ${setting.default})`);
    expect(css).toMatch(new RegExp(`--md-paragraph-spacing: ${setting.default}em;`));
  });

  it("spaces paragraphs, not the lines of a list", () => {
    expect(css).toMatch(/\.ProseMirror p \{[^}]*padding: calc\(var\(--md-paragraph-spacing\) \/ 2\) 0;/);
    // List items keep their own padding and line height.
    const list = css.match(/li \.content-dom > p \{([^}]*)\}/)?.[1] ?? "";
    expect(list).toContain("line-height: var(--md-list-line-height)");
    expect(list).not.toContain("--md-paragraph-spacing");
    expect(css).not.toMatch(/--md-list-line-height:[^;]*paragraph-spacing/);
  });
});
