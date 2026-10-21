// Presses real keys in VS Code (trusted input over the Chrome DevTools
// Protocol, as VS Code's own smoke tests do) against the interactive
// "routes real key presses" integration test, and checks VS Code's side of
// it: Cmd+B must not toggle the sidebar while editing, Cmd+K must not start a
// chord, and Cmd+B outside the editor must still toggle the sidebar.
//   node harness/real-keys.mjs
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { chromium } from "playwright";

const PORT = 9339;
const LOG = "/tmp/ken-keys.log";
rmSync(LOG, { force: true });
rmSync(`${LOG}.finished`, { force: true });

const run = spawn("node", ["out/test/integration/runTest.js"], {
  env: { ...process.env, KEN_TEST_REAL_KEYS: "1", KEN_TEST_REAL_KEYS_LOG: LOG, KEN_CDP_PORT: String(PORT), MOCHA_GREP: "real key presses" },
  stdio: ["ignore", "pipe", "pipe"],
});
let output = "";
run.stdout.on("data", (d) => (output += d));
run.stderr.on("data", (d) => (output += d));
const exited = new Promise((r) => run.on("exit", r));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const step = () => (existsSync(LOG) ? readFileSync(LOG, "utf8") : "");
async function waitStep(prefix, timeout = 60000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (step().startsWith(prefix)) return;
    await sleep(100);
  }
  throw new Error(`timed out waiting for step "${prefix}" (at "${step()}")\n${output}`);
}

const results = [];
try {
  await waitStep("1 ", 120000);
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`);
  const page = browser.contexts().flatMap((c) => c.pages()).find((p) => p.url().includes("workbench"));
  assert.ok(page, "workbench page");

  // The editor lives in a nested webview iframe.
  let frame;
  for (let i = 0; i < 100 && !frame; i++) {
    for (const f of page.frames()) {
      if (await f.$(".ProseMirror").catch(() => null)) frame = f;
    }
    if (!frame) await sleep(100);
  }
  assert.ok(frame, "editor frame");

  // Focus the editor with a real double-click on "me" (selects the word).
  const box = await frame.evaluate(() => {
    const p = document.querySelector(".ProseMirror p");
    const text = p.firstChild;
    const i = text.textContent.indexOf("me");
    const range = document.createRange();
    range.setStart(text, i);
    range.setEnd(text, i + 2);
    const r = range.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  });
  const frameBox = await (await frame.frameElement()).boundingBox();
  await page.mouse.dblclick(frameBox.x + box.x, frameBox.y + box.y);
  await sleep(300);

  const sidebarVisible = () => page.isVisible(".part.sidebar");
  const chordWaiting = async () => /waiting for second key of chord/i.test((await page.textContent(".part.statusbar").catch(() => "")) ?? "");
  const sidebarBefore = await sidebarVisible();

  await page.keyboard.press("Meta+b");
  await waitStep("2 ");
  assert.equal(await sidebarVisible(), sidebarBefore, "Cmd+B in the editor must not toggle the sidebar");
  results.push("⌘B bolds; the sidebar stays put");

  await page.keyboard.press("Meta+Alt+2");
  await waitStep("3 ");
  results.push("⌥⌘2 makes a heading");

  await page.keyboard.press("Meta+z");
  await waitStep("4 ");
  results.push("⌘Z undoes exactly one step");

  await page.keyboard.press("Meta+/");
  await waitStep("5 ");
  results.push("⌘/ opens the shortcut list");

  await page.keyboard.press("Escape");
  await waitStep("6 ");
  results.push("Esc closes it");

  await page.keyboard.press("Meta+Alt+9");
  await waitStep("7 ");
  results.push("⌥⌘9 makes a checklist");

  await page.keyboard.press("Meta+k");
  await waitStep("8 ");
  assert.equal(await chordWaiting(), false, "Cmd+K must not start a VS Code chord");
  results.push("⌘K opens the link editor, no chord");
  await page.keyboard.press("Escape");

  // Outside the editor, Cmd+B is VS Code's again.
  // Focus the Explorer with a real click on its file list.
  if (!(await sidebarVisible())) await page.keyboard.press("Meta+Shift+e");
  await page.click(".part.sidebar .monaco-list-row");
  await sleep(500);
  assert.ok(
    await page.evaluate(() => !!document.activeElement?.closest(".part.sidebar")),
    "focus is in the Explorer",
  );
  const before = await sidebarVisible();
  await page.keyboard.press("Meta+b");
  await sleep(800);
  assert.notEqual(await sidebarVisible(), before, "Cmd+B outside the editor toggles the sidebar");
  results.push("⌘B in the Explorer toggles the sidebar (VS Code's own binding)");
  writeFileSync(`${LOG}.finished`, "1");
  await waitStep("done");
  await browser.close().catch(() => undefined);
} finally {
  writeFileSync(`${LOG}.finished`, "1");
  const code = await Promise.race([exited, sleep(60000).then(() => "timeout")]);
  if (code !== 0) {
    console.error(output);
    console.error(`test run exited with ${code}`);
    process.exitCode = 1;
  }
}
console.log(`real keys: ${results.length} checks\n- ${results.join("\n- ")}`);
