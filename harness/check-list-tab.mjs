// Real Tab / Shift+Tab presses in lists, in Chromium against the real webview
// bundle: they indent / outdent an item or do nothing, never insert spaces or
// a tab, and keep focus in the editor. Code blocks keep their own Tab.
//   node harness/check-list-tab.mjs <theme.json>
import assert from "node:assert/strict";
import { openHarness } from "./harness.mjs";

const themeFile = process.argv[2];
const md = [
  "- one",
  "  - two",
  "  - three",
  "- four",
  "",
  "1. first",
  "2. second",
  "",
  "- [ ] task a",
  "- [ ] task b",
  "",
  "- code",
  "",
  "  ```js",
  "  x",
  "  ```",
  "",
].join("\n");
const h = await openHarness({ themeFile, markdown: md, width: 900, height: 900 });
const { page } = h;
const settle = () => page.waitForTimeout(250);
const text = async () => (await page.evaluate(() => window.__lastText())) ?? md;
const focused = () => page.evaluate(() => !!document.activeElement?.closest(".ProseMirror"));
const checks = [];
const check = async (name, fn) => {
  await fn();
  checks.push(name);
};
async function caretIn(label) {
  await page.click(`.ProseMirror li p:text-is('${label}')`);
  await page.keyboard.press("End");
}
async function refused(label, key) {
  await caretIn(label);
  const before = await text();
  await page.keyboard.press(key);
  await settle();
  assert.equal(await text(), before, `${key} on "${label}" changed the document`);
  assert.doesNotMatch(await text(), /\t| +$/m);
  assert.ok(await focused(), `${key} on "${label}" moved focus out of the editor`);
}

await check("Tab on the first child of a nested list does nothing", () => refused("two", "Tab"));
await check("Tab on the first top-level item does nothing", () => refused("one", "Tab"));
await check("Shift+Tab on a top-level item does nothing", () => refused("four", "Shift+Tab"));
await check("Tab on the first ordered / task item does nothing", async () => {
  await refused("first", "Tab");
  await refused("task a", "Tab");
});

await check("Tab indents an item with a previous sibling; a second Tab does nothing", async () => {
  await caretIn("three");
  await page.keyboard.press("Tab");
  await settle();
  assert.match(await text(), /^- one\n {2}- two\n {4}- three\n- four\n/);
  await refused("three", "Tab");
});

await check("Shift+Tab outdents a nested item, then stops at the top level", async () => {
  await caretIn("three");
  await page.keyboard.press("Shift+Tab");
  await page.keyboard.press("Shift+Tab");
  await settle();
  assert.match(await text(), /^- one\n {2}- two\n- three\n- four\n/);
  await refused("three", "Shift+Tab");
});

await check("Tab in a task list and an ordered list indents the second item", async () => {
  await caretIn("task b");
  await page.keyboard.press("Tab");
  await caretIn("second");
  await page.keyboard.press("Tab");
  await settle();
  assert.match(await text(), /\n1\. first\n {3}- second\n/);
  assert.match(await text(), /\n- \[ \] task a\n {2}- \[ \] task b\n/);
});

await check("Tab in a code block inside a list item indents the code", async () => {
  await page.click(".ProseMirror li .cm-content");
  await page.keyboard.press("End");
  await page.keyboard.press("Tab");
  await settle();
  // CodeMirror's indentWithTab indents the code line; the list is unchanged.
  assert.match(await text(), /\n- code\n\n {2}```js\n {2}[ \t]+x\n {2}```\n/);
});

assert.deepEqual(h.errors, []);
await h.close();
console.log(`ok: ${checks.length} checks\n- ${checks.join("\n- ")}`);
