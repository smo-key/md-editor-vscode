// Drives the real webview bundle in Chromium with real keystrokes and clicks,
// and checks the editing UI end to end. Usage:
//   node harness/check-editing.mjs <theme.json>
import assert from "node:assert/strict";
import { openHarness } from "./harness.mjs";

const themeFile = process.argv[2];
const md = "# Notes\n\nSome text here.\n\n- [ ] First task\n- [x] Second task\n\n| A | B |\n| - | - |\n| 1 | 2 |\n";
const h = await openHarness({ themeFile, markdown: md, width: 900, height: 700 });
const { page } = h;
const lastText = () => page.evaluate(() => window.__lastText());
const settle = () => page.waitForTimeout(250);
const menuOpen = () => page.evaluate(() => !document.querySelector(".ken-slash-menu").hidden);
const mode = () => page.evaluate(() => document.querySelector(".ken-toolbar").dataset.mode);
const checks = [];
const check = async (name, fn) => {
  await fn();
  checks.push(name);
};

await check("slash menu opens on the / keystroke", async () => {
  await page.click(".ProseMirror p:has-text('Some text here.')");
  await page.keyboard.press("End");
  await page.keyboard.press("Enter");
  await page.keyboard.type("/");
  assert.equal(await menuOpen(), true);
  const box = await page.evaluate(() => document.querySelector(".ken-slash-menu").getBoundingClientRect().height);
  assert.ok(box <= 220, `menu height ${box}`);
  const row = await page.evaluate(() => document.querySelector(".ken-slash-item").getBoundingClientRect().height);
  assert.ok(row <= 24, `row height ${row}`);
});

await check("slash menu filters and runs with Enter", async () => {
  await page.keyboard.type("h2");
  await page.keyboard.press("Enter");
  await page.keyboard.type("Section");
  await settle();
  assert.match(await lastText(), /\n## Section\n/);
});

await check("slash menu works in list items; Escape closes it", async () => {
  await page.click(".ProseMirror li:has-text('First task') p");
  await page.keyboard.press("End");
  await page.keyboard.type(" /");
  assert.equal(await menuOpen(), true);
  await page.keyboard.press("Escape");
  assert.equal(await menuOpen(), false);
  await page.keyboard.press("Backspace");
  await page.keyboard.press("Backspace");
});

await check("drag handle only on checklist items; no + button", async () => {
  await page.hover(".ProseMirror li:has-text('Second task')");
  await settle();
  assert.equal(await page.evaluate(() => document.querySelector(".ken-task-handle").dataset.show), "true");
  await page.hover(".ProseMirror h1");
  await settle();
  assert.equal(await page.evaluate(() => document.querySelector(".ken-task-handle").dataset.show), "false");
  assert.equal(await page.evaluate(() => document.querySelectorAll(".milkdown-block-handle, .operation-item").length), 0);
});

await check("toolbar formats and converts", async () => {
  await page.click(".ProseMirror p:has-text('Some text here.')");
  await page.keyboard.press("End");
  await page.keyboard.down("Shift");
  for (let i = 0; i < 5; i++) await page.keyboard.press("ArrowLeft");
  await page.keyboard.up("Shift");
  await page.click('.ken-toolbar-button[data-id="bold"]');
  await settle();
  assert.match(await lastText(), /Some text \*\*here\.\*\*/);
  assert.equal(await page.evaluate(() => document.querySelector('[data-id="bold"]').classList.contains("active")), true);
  await page.click('.ken-toolbar-button[data-id="code-block"]');
  await settle();
  assert.match(await lastText(), /```\nSome text here\.\n```/);
  await page.click('.ken-toolbar-button[data-id="code-block"]');
  await settle();
  assert.match(await lastText(), /\n\nSome text here\.\n\n/);
});

await check("clicking a cell places the caret; toolbar switches to table mode", async () => {
  await page.click(".ProseMirror td >> text=1");
  await settle();
  assert.equal(await mode(), "table");
  await page.keyboard.press("End");
  await page.keyboard.type("0");
  await settle();
  assert.match(await lastText(), /\| 10 \| 2 +\|/);
});

await check("table toolbar: insert, move, align, delete", async () => {
  await page.click('.ken-toolbar-button[data-id="col-right"]');
  await page.keyboard.type("new");
  await page.click('.ken-toolbar-button[data-id="col-left-move"]');
  await page.click('.ken-toolbar-button[data-id="align-right"]');
  await settle();
  const text = await lastText();
  // The new column was moved left of "A", then right-aligned.
  assert.match(text, /\| +\| A +\| B \|\n\| -+: \| -+ \| -+ \|\n\| new \| 10 \| 2 \|/, text);
  await page.click('.ken-toolbar-button[data-id="delete-col"]');
  await settle();
  assert.doesNotMatch(await lastText(), /new/);
});

await check("Tab in the last cell adds a row; Enter at the bottom leaves the table", async () => {
  await page.click(".ProseMirror td >> text=2");
  await page.keyboard.press("End");
  await page.keyboard.press("Tab");
  await page.keyboard.type("3");
  await page.keyboard.press("Enter");
  await page.keyboard.type("after");
  await settle();
  const text = await lastText();
  assert.match(text, /\| 3 +\| +\|\n\nafter\n$/, text);
  assert.doesNotMatch(text, /<br/);
});

await check("right-click a cell opens the full table menu", async () => {
  await page.click(".ProseMirror td >> text=3", { button: "right" });
  const labels = await page.evaluate(() => [...document.querySelectorAll(".ken-context-menu-item")].map((b) => b.textContent));
  assert.ok(labels.includes("Move row up") && labels.includes("Delete table"), labels.join(", "));
  await page.keyboard.press("Escape");
});

assert.deepEqual(h.errors, []);
await h.close();
console.log(`ok: ${checks.length} checks\n- ${checks.join("\n- ")}`);
