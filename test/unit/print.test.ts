// Print: a standalone page of the document as shown, without the editor's controls.
import { expect, it } from "vitest";

import { printablePage } from "../../webview/print";

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
