// Comments end to end in Chromium, with real input: add, write, reply,
// resolve, and the edits that must not break the Markdown.
//   node harness/check-comments.mjs <theme.json>
import assert from "node:assert/strict";
import { openHarness } from "./harness.mjs";

const md = "# Report\n\nRevenue grew 12% in Q3.\n\n| Region | Q3 |\n| ------ | -- |\n| EU     | 4% |\n\nClosing remarks.\n";
const h = await openHarness({ themeFile: process.argv[2], markdown: md, width: 1200, height: 700 });
const { page } = h;
const last = () => page.evaluate(() => window.__lastText());
const settle = () => page.waitForTimeout(300);
const checks = [];
const check = async (name, fn) => {
  await fn();
  checks.push(name);
};
/** No marker ever starts a line except a whole-line block marker; pairs balance. */
function assertValid(text) {
  for (const line of text.split("\n")) {
    if (line.startsWith("<!--")) assert.match(line, /^<!-- (\/?ken:comment [\w-]+|ken:comments) -->$|^<!-- ken:comments$/, line);
  }
  const starts = [...text.matchAll(/<!-- ken:comment ([\w-]+) -->/g)].map((m) => m[1]);
  const ends = [...text.matchAll(/<!-- \/ken:comment ([\w-]+) -->/g)].map((m) => m[1]);
  assert.deepEqual(starts.sort(), ends.sort(), "every comment has both markers");
  const block = /<!-- ken:comments\n([\s\S]*?)\n-->/.exec(text);
  const ids = block ? Object.keys(JSON.parse(block[1])) : [];
  assert.deepEqual(ids.sort(), [...new Set(starts)].sort(), "threads block lists exactly the marked comments");
}
const point = (js) => page.evaluate(js);
/** Screen point at the left or right of the character at `offset` in the first text node containing `text`. */
const charPoint = (text, offset, side = "left") =>
  page.evaluate(([text, offset, side]) => {
    const walker = document.createTreeWalker(document.querySelector(".ProseMirror"), NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const i = n.textContent.indexOf(text);
      if (i < 0) continue;
      const r = document.createRange();
      r.setStart(n, i + offset);
      r.setEnd(n, i + offset + 1);
      const b = r.getBoundingClientRect();
      return [side === "left" ? b.left + 1 : b.right - 1, b.top + b.height / 2];
    }
    throw new Error("no text " + text);
  }, [text, offset, side]);

await check("comment a range from a paragraph into a table; write it and reply", async () => {
  const a = await point(() => { const p = [...document.querySelectorAll(".ProseMirror p")].find((e) => e.textContent.includes("Revenue")); const r = document.createRange(); r.setStart(p.firstChild, 13); r.setEnd(p.firstChild, 14); const b = r.getBoundingClientRect(); return [b.left, b.top + b.height / 2]; });
  const b = await point(() => { const td = [...document.querySelectorAll(".ProseMirror td")].find((e) => e.textContent.includes("4%")); const r = td.querySelector("p").getBoundingClientRect(); return [r.right - 2, r.top + r.height / 2]; });
  await page.mouse.click(a[0], a[1]);
  await page.keyboard.down("Shift");
  await page.mouse.click(b[0], b[1]);
  await page.keyboard.up("Shift");
  await page.click('.ken-toolbar-button[data-id="comment-add"]');
  await page.keyboard.type("Where do these numbers come from?");
  await page.keyboard.press("Meta+Enter");
  await settle();
  await page.fill(".ken-comment-card textarea", "From the Q3 deck.");
  await page.click(".ken-comment-card .ken-comment-send");
  await settle();
  const text = await last();
  assert.match(text, /Revenue grew <!-- ken:comment \w+ -->12% in Q3\./);
  assert.match(text, /\| EU +\| 4%<!-- \/ken:comment \w+ --> *\|/);
  assert.match(text, /"text":"From the Q3 deck\."/);
  assertValid(text);
});

await check("deleting the table that holds the end keeps the comment on what is left", async () => {
  await page.click(".ProseMirror td >> text=EU");
  await page.click('.ken-toolbar-button[data-id="delete-table"]');
  await settle();
  const text = await last();
  assert.doesNotMatch(text, /\| EU/);
  assert.match(text, /<!-- ken:comment \w+ -->12% in Q3\.(<!-- \/ken:comment \w+ -->|\n\n<!-- \/ken:comment \w+ -->)/);
  assertValid(text);
});

await check("Backspace through a marker deletes text, never the marker", async () => {
  // Caret right after "12% in Q3." (the end marker follows the paragraph).
  const [x, y] = await charPoint("Q3.", 2, "right");
  await page.mouse.click(x, y);
  await page.keyboard.press("Backspace");
  await page.keyboard.press("Backspace");
  await settle();
  const text = await last();
  assertValid(text);
  assert.match(text, /Revenue grew <!-- ken:comment \w+ -->12% in Q\n/);
  // And at the start of the range: Backspace removes the space before it.
  const [sx, sy] = await charPoint("12%", 0, "left");
  await page.mouse.click(sx, sy);
  await page.keyboard.press("Backspace");
  await settle();
  const after = await last();
  assertValid(after);
  assert.match(after, /Revenue grew<!-- ken:comment \w+ -->12% in Q\n/);
});

await check("deleting all the commented text removes the comment (and undo brings it back)", async () => {
  const [ax, ay] = await charPoint("12%", 0, "left");
  const [bx, by] = await charPoint("in Q", 3, "right");
  await page.mouse.click(ax, ay);
  await page.keyboard.down("Shift");
  await page.mouse.click(bx, by);
  await page.keyboard.up("Shift");
  await settle();
  await page.keyboard.press("Backspace");
  await settle();
  let text = await last();
  assert.doesNotMatch(text, /ken:comment/);
  assert.match(text, /Revenue grew\n/);
  await page.click('.ken-toolbar-button[data-id="undo"]');
  await settle();
  text = await last();
  assert.match(text, /<!-- ken:comment \w+ -->12% in Q/);
  assertValid(text);
});

await check("resolve hides the highlight; delete removes the markers but keeps the text", async () => {
  await page.click('.ken-comment-card button[aria-label="Resolve"]');
  await settle();
  assert.equal(await page.locator(".ProseMirror .ken-comment").count(), 0);
  assert.match(await last(), /"resolved":true/);
  await page.check(".ken-comments-resolved input");
  await page.click('.ken-comment-card button[aria-label="Delete comment"]');
  await settle();
  const text = await last();
  assert.doesNotMatch(text, /ken:comment/);
  assert.match(text, /Revenue grew12% in Q/);
});

assert.deepEqual(h.errors, []);
await h.close();
console.log(`ok: ${checks.length} checks\n- ${checks.join("\n- ")}`);
