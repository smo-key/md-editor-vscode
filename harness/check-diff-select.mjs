// Removed (red) content can be selected and copied: in the diff view's
// combined and split layouts, and in a chat agent's edits shown in the editor.
// Drags across each kind of red area with the mouse, then copies.
// Usage: node harness/check-diff-select.mjs <theme.json>
import { chromium } from "playwright";
import { readFileSync } from "fs";
import { createServer } from "http";
import { extname, join, resolve } from "path";
import { openHarness } from "./harness.mjs";

const [themeFile] = process.argv.slice(2);
const theme = JSON.parse(readFileSync(themeFile, "utf8"));

const OLD = `---
title: Old title
---

# Guide

Kept paragraph one.

Removed paragraph alpha beta gamma.

The quick brown fox jumps.

| Name | Value |
| - | - |
| keep | 1 |
| dropped row | 2 |
| edited | old cell words |
`;
const NEW = `---
title: New title
---

# Guide

Kept paragraph one.

The slow brown fox jumps.

| Name | Value |
| - | - |
| keep | 1 |
| edited | new cell words |
`;

// What each red area holds, and where to find it.
const TARGETS = [
  { name: "removed paragraph", selector: ".ken-diff-widget p, .ken-diff-pane[data-side=old] p.ken-diff-removed", text: "Removed paragraph alpha beta gamma." },
  { name: "removed words", selector: ".ken-diff-removed-text", text: "quick" },
  { name: "removed table row", selector: "tr.ken-diff-widget-part td, .ken-diff-pane[data-side=old] tr.ken-diff-removed-part td", text: "dropped row" },
  { name: "old cell text", selector: ".ken-diff-cell-old, .ken-diff-pane[data-side=old] td .ken-diff-removed-text", text: "old" },
  { name: "old frontmatter", selector: ".ken-diff-front pre.ken-diff-removed", text: "title: Old title" },
];

/** Drags across `text` in the first element matching `selector` (that contains it); returns the selection and what a copy puts on the clipboard. */
async function dragAndCopy(page, selector, text) {
  const box = await page.evaluate(
    ({ selector, text }) => {
      for (const el of document.querySelectorAll(selector)) {
        const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
        for (let n = walker.nextNode(); n; n = walker.nextNode()) {
          const at = n.data.indexOf(text);
          if (at < 0) continue;
          n.parentElement.scrollIntoView({ block: "center" });
          const r = document.createRange();
          r.setStart(n, at);
          r.setEnd(n, at + text.length);
          const rects = r.getClientRects();
          const first = rects[0], last = rects[rects.length - 1];
          return { x1: first.left + 1, y1: first.top + first.height / 2, x2: last.right - 1, y2: last.top + last.height / 2 };
        }
      }
      return null;
    },
    { selector, text },
  );
  if (!box) return { missing: true };
  await page.mouse.move(box.x1, box.y1);
  await page.mouse.down();
  await page.mouse.move(box.x2, box.y2, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(150);
  // Copy with the keyboard, then read the real clipboard.
  const selected = await page.evaluate(() => getSelection().toString());
  await page.evaluate(() => navigator.clipboard.writeText(""));
  await page.keyboard.press("ControlOrMeta+c");
  await page.waitForTimeout(100);
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  return { selected, copied };
}

/** The text of every editable editor: keys pressed with red text selected must not change it. */
const editorText = (page) => page.evaluate(() => [...document.querySelectorAll(".ProseMirror[contenteditable=true]")].map((e) => e.textContent).join("|"));

let failures = 0;
async function check(page, label) {
  for (const t of TARGETS) {
    const before = await editorText(page);
    const r = await dragAndCopy(page, t.selector, t.text);
    if (!r.missing) {
      await page.keyboard.type("Z");
      await page.keyboard.press("Backspace");
      await page.keyboard.press("Enter");
      await page.waitForTimeout(100);
      r.unchanged = (await editorText(page)) === before;
    }
    const ok = !r.missing && r.selected.includes(t.text) && (r.copied ?? "").includes(t.text) && r.unchanged;
    if (!ok) failures++;
    console.log(`${ok ? "ok  " : "FAIL"} ${label}: ${t.name}`, r.missing ? "(not shown)" : JSON.stringify(r));
    await page.mouse.click(5, 5);
  }
}

// --- Diff view --------------------------------------------------------------------
const types = { ".js": "text/javascript", ".css": "text/css", ".woff2": "font/woff2", ".woff": "font/woff" };
function diffPage(layout) {
  const init = {
    type: "diffInit", layout, base: { old: "", new: "" }, readOnly: { old: true, new: false }, shortcuts: {}, keys: {},
    oldText: OLD, newText: NEW, oldLabel: "HEAD", newLabel: "Working Tree",
    config: { fontSize: 16, bodyFontFamily: "", headingFontFamily: "", codeFontFamily: "", lineHeight: 1.85, maxWidth: 720, toolbar: "hidden", tabSize: 4 },
  };
  return `<!doctype html><html style='${theme.style.replace(/'/g, "&#39;")}'><head><meta charset="utf-8">
<link rel="stylesheet" href="/dist/webview/diff.css"></head><body class="${theme.bodyClass.replace(/\bready\b/, "")}">
<script>window.__sent = []; window.acquireVsCodeApi = () => ({ postMessage(m) {
  window.__sent.push(m);
  if (m.type === "diffReady") setTimeout(() => window.postMessage(${JSON.stringify(init)}, "*"));
}});</script><script type="module" src="/dist/webview/diff.js"></script></body></html>`;
}
const root = resolve(".");
let layout = "combined";
const server = createServer((req, res) => {
  const url = decodeURIComponent(req.url.split("?")[0]);
  if (url === "/") return res.end(diffPage(layout));
  try {
    const body = readFileSync(join(root, url));
    res.writeHead(200, { "content-type": types[extname(url)] ?? "application/octet-stream" });
    res.end(body);
  } catch {
    res.writeHead(404).end();
  }
}).listen(0);
const browser = await chromium.launch();
for (const l of ["combined", "split"]) {
  layout = l;
  const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: `http://localhost:${server.address().port}` });
  const page = await context.newPage();
  await page.goto(`http://localhost:${server.address().port}/`);
  await page.waitForSelector("body.ready .milkdown .ProseMirror");
  // The view scrolls to its first change once open: drag only once that has settled.
  await page.waitForFunction(
    () =>
      new Promise((done) => {
        const at = () => [...document.querySelectorAll(".editor-scroll")].map((e) => e.scrollTop).join();
        const first = at();
        setTimeout(() => done(at() === first), 300);
      }),
    null,
    { timeout: 10000 },
  );
  await check(page, `diff ${l}`);
  await page.waitForTimeout(700);
  const edits = await page.evaluate(() => window.__sent.filter((m) => m.type === "diffEdit").length);
  if (edits) {
    failures++;
    console.log(`FAIL diff ${l}: selecting or keys wrote the document (${edits} edits)`);
  }
  await context.close();
}
await browser.close();
server.close();

// --- A chat agent's edits in the editor -------------------------------------------------
const h = await openHarness({ themeFile, markdown: NEW, width: 1100, height: 900 });
await h.page.context().grantPermissions(["clipboard-read", "clipboard-write"], { origin: new URL(h.page.url()).origin });
await h.page.waitForTimeout(800);
await h.page.evaluate((original) => window.postMessage({ type: "agentEdits", original }, "*"), OLD);
await h.page.waitForSelector(".ken-agent-mark, .ken-diff-widget");
await h.page.waitForTimeout(400);
await check(h.page, "agent edits");
// Selecting there must not have touched the document.
const edited = await h.page.evaluate(() => window.__lastText());
if (edited !== null) {
  failures++;
  console.log("FAIL agent edits: selecting wrote the document", JSON.stringify(edited.slice(0, 80)));
}
await h.close();

console.log(failures ? `${failures} failing` : "all passing");
process.exit(failures ? 1 : 0);
