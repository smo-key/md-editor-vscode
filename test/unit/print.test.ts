// Print: a standalone page of the document as shown, without the editor's controls.
import { expect, it } from "vitest";

import { flatRule, printablePage } from "../../webview/print";

it("keeps the rendered document, drops editor controls, and prints on load", async () => {
  const measure = document.createElement("div");
  measure.className = "measure";
  measure.innerHTML =
    '<div class="milkdown"><div class="ProseMirror" contenteditable="true"><h1>Title &amp; more</h1>' +
    '<p class="ProseMirror-selectednode">Body<img class="ProseMirror-separator"></p>' +
    '<div class="milkdown-table-block"><button class="ken-table-width-toggle">x</button><table><tr><td>cell</td></tr></table></div></div></div>';
  document.documentElement.setAttribute("style", "--vscode-editor-background: #fff");
  const html = await printablePage(measure, "notes <1>.md");
  expect(html).toContain("<title>notes &lt;1&gt;.md</title>");
  expect(html).toContain("<h1>Title &amp; more</h1>");
  expect(html).toContain("<td>cell</td>");
  expect(html).not.toContain("ken-table-width-toggle");
  expect(html).not.toContain("ProseMirror-separator");
  expect(html).not.toMatch(/contenteditable=/);
  expect(html).not.toContain("ProseMirror-selectednode");
  expect(html).toContain('style="--vscode-editor-background: #fff"');
  expect(html).toContain("window.print()");
});

it("leaves out the Properties panel, and a rendered diagram's source", async () => {
  const measure = document.createElement("div");
  measure.className = "measure";
  measure.innerHTML =
    '<div class="ken-frontmatter">title: x</div><div class="milkdown"><div class="ProseMirror">' +
    '<div class="milkdown-code-block"><div class="codemirror-host hidden">graph TD</div><div class="preview"><svg id="d"></svg></div></div>' +
    '<div class="milkdown-code-block"><div class="codemirror-host">plain code</div><div class="preview"></div></div></div></div>';
  const html = await printablePage(measure, "x");
  expect(html).not.toContain("ken-frontmatter");
  expect(html).not.toContain("graph TD");
  expect(html).toContain('<svg id="d">');
  expect(html).toContain("plain code");
});

it("writes nested CSS out flat", () => {
  const child = { selectorText: "& .hidden", style: { cssText: "display: none;" } } as unknown as CSSRule;
  const media = { conditionText: "print", cssText: "@media print { … }", cssRules: [{ selectorText: "p", style: { cssText: "color: red;" } }] } as unknown as CSSRule;
  const rule = { selectorText: ".milkdown .block, .other", style: { cssText: "margin: 0;" }, cssRules: [child, media] } as unknown as CSSRule;
  expect(flatRule(rule).split("\n")).toEqual([
    ".milkdown .block, .other { margin: 0; }",
    ":is(.milkdown .block, .other) .hidden { display: none; }",
    "@media print {",
    ":is(.milkdown .block, .other) p { color: red; }",
    "}",
  ]);
});

it("turns a table's pixel column widths into proportions, so it fits any page", async () => {
  const measure = document.createElement("div");
  measure.className = "measure";
  measure.innerHTML =
    '<div class="milkdown"><div class="ProseMirror"><div class="milkdown-table-block" data-full-width="true"><table class="children" style="width: 1200px">' +
    '<colgroup class="ken-table-cols"><col style="width: 300px"><col style="width: 900px"></colgroup><tbody><tr><td>a</td><td>b</td></tr></tbody></table></div>' +
    '<div class="milkdown-table-block"><table class="children"><colgroup class="ken-table-cols"><col style="width: 40px"><col style="width: 60px"></colgroup><tbody><tr><td>c</td><td>d</td></tr></tbody></table></div></div></div>';
  const html = await printablePage(measure, "x");
  expect(html).toContain('<col style="width: 25.000%;">');
  expect(html).toContain('<col style="width: 75.000%;">');
  expect(html).toMatch(/<table class="children" style="width: 100%; max-width: 100%; min-width: 0(px)?;?">/);
  // (happy-dom can't hold `min(100px, 100%)`: the cap is what is checked.)
  expect(html).toContain('<col style="width: 40.000%;"><col style="width: 60.000%;">');
});
