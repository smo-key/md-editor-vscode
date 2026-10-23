// Real mouse and keys across images, tables and code blocks: what a selection
// highlights and what deleting it writes. Usage:
//   node harness/check-block-selection.mjs <theme.json> [screenshot.png]
import assert from "node:assert/strict";
import { openHarness } from "./harness.mjs";

const md = "Intro text\n\n| a | b |\n| - | - |\n| 1 | 2 |\n\nMiddle\n\n```js\ncode();\n```\n\n![logo](logo.svg)\n\nEnd\n";
const h = await openHarness({ themeFile: process.argv[2], markdown: md, width: 900, height: 900 });
const { page } = h;
const settle = () => page.waitForTimeout(250);
const lastText = () => page.evaluate(() => window.__lastText());
const highlighted = () =>
  page.evaluate(() => [...document.querySelectorAll(".ken-block-selected")].map((e) => e.className.split(" ")[0] || e.tagName));
const caretAtEnd = async (text) => {
  await page.click(`.ProseMirror p:has-text('${text}')`);
  await page.keyboard.press("End");
};
const checks = [];
const check = async (name, fn) => {
  await fn();
  checks.push(name);
};

try {
  await check("Shift+Down from text over a table selects the whole table", async () => {
    await caretAtEnd("Intro text");
    await page.keyboard.press("Shift+ArrowDown");
    await page.keyboard.press("Shift+ArrowDown");
    await settle();
    const hl = await highlighted();
    assert.ok(hl.some((c) => /table/.test(c)), `highlighted: ${hl}`);
    const cells = await page.evaluate(() => document.querySelectorAll(".selectedCell").length);
    assert.equal(cells, 0, "not a cell selection");
  });

  await check("Shift+click on a code block from text takes the table and the code", async () => {
    await caretAtEnd("Intro text");
    await page.click(".milkdown-code-block .cm-content", { modifiers: ["Shift"] });
    await settle();
    const hl = await highlighted();
    assert.ok(hl.some((c) => /table/.test(c)) && hl.some((c) => /code/.test(c)), `highlighted: ${hl}`);
  });

  await check("Shift+click on the image after selecting from text takes every block between", async () => {
    await caretAtEnd("Intro text");
    await page.click(".milkdown-image-block img", { modifiers: ["Shift"] });
    await settle();
    const hl = await highlighted();
    assert.ok(hl.some((c) => /table/.test(c)) && hl.some((c) => /code/.test(c)) && hl.some((c) => /image/.test(c)), `highlighted: ${hl}`);
    assert.equal(await page.evaluate(() => !!document.querySelector(".ken-lightbox")), false, "no lightbox on shift+click");
    if (process.argv[3]) await page.screenshot({ path: process.argv[3] });
  });

  await check("Backspace deletes them and the Markdown is clean", async () => {
    await page.keyboard.press("Backspace");
    await settle();
    const text = await lastText();
    assert.doesNotMatch(text, /\|/);
    assert.doesNotMatch(text, /code\(\)/);
    assert.doesNotMatch(text, /logo/);
    assert.equal(text.trim(), "Intro text\n\nEnd");
  });

  await check("Select all, then Backspace, empties the document", async () => {
    await page.click(".ProseMirror p:has-text('Intro')");
    await page.keyboard.press(process.platform === "darwin" ? "Meta+a" : "Control+a");
    await settle();
    await page.keyboard.press("Backspace");
    await settle();
    assert.equal((await lastText()).trim(), "");
  });
  assert.deepEqual(h.errors, []);
  console.log(checks.map((c) => `ok  ${c}`).join("\n"));
} finally {
  await h.close();
}
