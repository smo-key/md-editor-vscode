// The diff view (webview/diff.ts) against a fake host: an update the host read
// before the view's latest edit (its `seen` is behind) must not undo what was
// typed; an update that has seen it, and a change from elsewhere, still apply.
// Usage: npm run build && node harness/check-diff-sync.mjs
import { chromium } from "playwright";
import { readFileSync } from "fs";
import { createServer } from "http";
import { extname, join, resolve } from "path";

const types = { ".js": "text/javascript", ".css": "text/css", ".woff2": "font/woff2", ".woff": "font/woff" };
const oldText = "# Notes\n\nFirst line.\n\nSecond line.\n";
const newText = "# Notes\n\nFirst line changed.\n\nSecond line.\n";
const content = { oldText, newText, oldLabel: "HEAD", newLabel: "Working Tree" };
const init = {
  type: "diffInit",
  layout: "combined",
  base: { old: "", new: "" },
  readOnly: { old: true, new: false },
  shortcuts: {},
  keys: {},
  ...content,
  config: { fontSize: 16, bodyFontFamily: "", headingFontFamily: "", codeFontFamily: "", lineHeight: 1.85, maxWidth: 720, toolbar: "hidden", tabSize: 4 },
};
const html = `<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/dist/webview/diff.css"></head><body>
<script>
  window.__sent = [];
  window.acquireVsCodeApi = () => ({ postMessage(m) {
    window.__sent.push(m);
    if (m.type === "diffReady") setTimeout(() => window.postMessage(${JSON.stringify(init)}, "*"));
  }});
</script>
<script type="module" src="/dist/webview/diff.js"></script></body></html>`;
const root = resolve(".");
const server = createServer((req, res) => {
  const url = decodeURIComponent(req.url.split("?")[0]);
  if (url === "/") return res.end(html);
  try {
    const body = readFileSync(join(root, url));
    res.writeHead(200, { "content-type": types[extname(url)] ?? "application/octet-stream" });
    res.end(body);
  } catch {
    res.writeHead(404).end();
  }
}).listen(0);
const browser = await chromium.launch();
const page = await browser.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
let failed = 0;
const check = (ok, what) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
  if (!ok) failed++;
};
try {
  await page.goto(`http://localhost:${server.address().port}/`);
  await page.waitForSelector("body.ready .milkdown .ProseMirror");
  await page.waitForTimeout(500);
  const text = () => page.locator(".ken-diff-pane").first().innerText();
  const lastEdit = () => page.evaluate(() => window.__sent.filter((m) => m.type === "diffEdit").pop());
  const update = (m) => page.evaluate((m) => window.postMessage({ type: "diffUpdate", ...m }, "*"), m);

  await page.locator(".ken-diff-pane .ProseMirror > p").last().click();
  await page.keyboard.press("End");
  await page.keyboard.type(" ONE");
  await page.waitForTimeout(600);
  const one = await lastEdit();
  await page.keyboard.type(" TWO");
  await page.waitForTimeout(600);
  const two = await lastEdit();
  check(one?.seq === 1 && two?.seq === 2, `edits counted (${one?.seq}, ${two?.seq})`);

  // The host read the file after the first edit, before the second landed.
  await update({ ...content, newText: one.text, seen: { old: 0, new: 1 } });
  await page.waitForTimeout(300);
  check((await text()).includes("ONE TWO"), "an update from before the latest edit leaves the typing alone");

  // The host has the second edit now.
  await update({ ...content, newText: two.text, seen: { old: 0, new: 2 } });
  await page.waitForTimeout(300);
  check((await text()).includes("ONE TWO"), "an update with the latest edit keeps it");

  // Changed elsewhere since: shown.
  await update({ ...content, newText: `${two.text}\nAdded elsewhere.\n`, seen: { old: 0, new: 2 } });
  await page.waitForTimeout(300);
  check((await text()).includes("Added elsewhere."), "a change from elsewhere is shown");
  check(errors.length === 0, `no page errors ${errors.join("; ")}`);
} finally {
  await browser.close();
  server.close();
}
process.exit(failed ? 1 : 0);
