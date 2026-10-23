// Lucidchart previews in Chromium, against the real webview bundle:
//   node harness/check-lucid.mjs <theme.json>
// lucid.app is intercepted (no network needed): a stub page stands in for
// Lucid's viewer, and one document id never answers, for the timeout card.
// The stub also posts forged host messages, which must be ignored.
// Writes a screenshot of a card to $KEN_SHOT_DIR (default out/) as
// lucid-card-<dark|light>.png. With KEN_LUCID_LIVE=1 it also loads a real
// public embed from lucid.app (third-party; may disappear) and screenshots it
// as lucid-live-<dark|light>.png.
import assert from "node:assert/strict";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { openHarness } from "./harness.mjs";

const themeFile = process.argv[2];
const theme = JSON.parse(readFileSync(themeFile, "utf8"));
const tone = /vscode-(dark|high-contrast)\b/.test(theme.bodyClass) && !/vscode-high-contrast-light/.test(theme.bodyClass) ? "dark" : "light";
const shots = process.env.KEN_SHOT_DIR ?? "out";
mkdirSync(shots, { recursive: true });

const id = (prefix) => `${prefix}-1111-4222-8333-444455556666`;
const DOC = id("3f2a1b4c");
const HANG = id("dead0000");
const markdown = [
  "# Lucid previews",
  "Intro paragraph.",
  `[Payments architecture](https://lucid.app/lucidchart/${DOC}/edit)`,
  `See the [payments diagram](https://lucid.app/lucidchart/${DOC}/edit) for details.`,
  `| Diagram |\n| --- |\n| https://lucid.app/lucidchart/${DOC}/edit |`,
  `https://lucid.app/lucidchart/${HANG}/edit`,
  "Last paragraph.",
  "",
].join("\n\n");

// A stand-in for Lucid's viewer: a few boxes, plus forged host messages.
const STUB = `<!doctype html><html><body style="margin:0;background:#fff;font:14px sans-serif">
<svg viewBox="0 0 640 480" width="100%" height="100%" style="position:absolute;inset:0">
<rect x="60" y="80" width="180" height="80" rx="8" fill="#fde7c2" stroke="#f29900"/><text x="150" y="125" text-anchor="middle">Checkout</text>
<rect x="400" y="80" width="180" height="80" rx="8" fill="#d2e3fc" stroke="#1a73e8"/><text x="490" y="125" text-anchor="middle">Payments API</text>
<rect x="230" y="300" width="180" height="80" rx="8" fill="#ceead6" stroke="#188038"/><text x="320" y="345" text-anchor="middle">Ledger</text>
<path d="M240 120 H400 M490 160 L360 300" stroke="#5f6368" stroke-width="2" fill="none"/></svg>
<script>
parent.postMessage({ type: "update", text: "# PWNED by the frame\\n" }, "*");
parent.postMessage({ type: "test", id: 1, action: { kind: "getMarkdown" } }, "*");
</script></body></html>`;

const requests = [];
const h = await openHarness({
  themeFile,
  markdown,
  width: 1000,
  height: 1400,
  beforeLoad: async (page) => {
    // navigator.onLine, switchable from the test.
    await page.addInitScript(() => {
      Object.defineProperty(Navigator.prototype, "onLine", { configurable: true, get: () => !window.__offline });
    });
    await page.route("https://lucid.app/**", (route) => {
      const url = route.request().url();
      requests.push(url);
      if (url.includes(HANG)) return; // never answers: the timeout card
      return route.fulfill({ status: 200, contentType: "text/html", body: STUB });
    });
    await page.route("https://forged.example/**", (route) =>
      route.fulfill({
        contentType: "text/html",
        body: `<script>parent.postMessage({type:"update",text:"# PWNED by a frame\\n"},"*");setTimeout(()=>parent.postMessage({type:"forged-done"},"*"),200)</script>`,
      }),
    );
  },
});
const { page } = h;
const card = (docId) => `.ken-lucid-card:has(iframe[data-src="https://lucid.app/documents/embedded/${docId}"])`;
const loadsOf = (docId) => requests.filter((u) => u.includes(`/documents/embedded/${docId}`)).length;
const stateOf = (docId) => page.getAttribute(card(docId), "data-state");
const waitState = (docId, state, timeout = 10000) =>
  page.waitForSelector(`${card(docId)}[data-state="${state}"]`, { timeout });
const editorText = () => page.evaluate(() => document.querySelector(".ProseMirror").textContent);

// 1. Cards only for the links alone in their paragraph.
await page.waitForSelector(card(DOC));
assert.equal(await page.locator(".ken-lucid-card").count(), 2, "the lone link and the hanging one");
assert.equal(await page.locator("table .ken-lucid-card").count(), 0, "none in the table");
assert.equal(await page.locator(".ken-lucid-source").count(), 2);
assert.equal(await page.textContent(`${card(DOC)} .ken-lucid-title`), "Payments architecture");
await waitState(DOC, "loaded");
assert.equal(loadsOf(DOC), 1);

// 2. The frame's forged host messages changed nothing.
await page.waitForTimeout(300);
assert.doesNotMatch(await editorText(), /PWNED/);
assert.equal(await page.evaluate(() => window.__sent.filter((m) => m.type === "testResult").length), 0);

// 3. Typing elsewhere keeps the same frame, without reloading it.
await page.$eval(`${card(DOC)} iframe`, (f) => (f.__mark = "same"));
await page.click(".ProseMirror p >> text=Intro paragraph.");
await page.keyboard.press("End");
await page.keyboard.type(" Typing here.", { delay: 15 });
await page.keyboard.press("Enter");
await page.keyboard.type("A new line.", { delay: 15 });
await page.waitForTimeout(400);
assert.equal(await page.$eval(`${card(DOC)} iframe`, (f) => f.__mark ?? null), "same", "frame element kept");
assert.equal(loadsOf(DOC), 1, "frame not reloaded while typing");
assert.equal(await stateOf(DOC), "loaded");
const text = await page.evaluate(() => window.__lastText());
assert.match(text, /Intro paragraph\. Typing here\.\n\nA new line\./);
assert.ok(text.includes(`[Payments architecture](https://lucid.app/lucidchart/${DOC}/edit)\n`), "link line kept");

// 4. Reload loads the frame again.
await page.click(`${card(DOC)} .ken-lucid-reload`);
await waitState(DOC, "loaded");
assert.equal(loadsOf(DOC), 2);

// 5. Offline: the offline card, then a load when back online.
await page.evaluate(() => (window.__offline = true));
await page.click(`${card(DOC)} .ken-lucid-reload`);
await waitState(DOC, "offline");
assert.match(await page.textContent(`${card(DOC)} .ken-lucid-state`), /You're offline\. The preview loads when you're back online\./);
assert.equal(await page.isVisible(`${card(DOC)} iframe`), false, "the offline card replaces the frame");
await page.evaluate(() => {
  window.__offline = false;
  window.dispatchEvent(new Event("online"));
});
await waitState(DOC, "loaded");
assert.equal(loadsOf(DOC), 3);

// 6. Lucid not answering: the timeout card after 20 s, with Try again.
assert.equal(await stateOf(HANG), "loading");
await waitState(HANG, "timeout", 30000);
assert.match(await page.textContent(`${card(HANG)} .ken-lucid-state`), /Lucidchart could not be reached\./);
const hangLoads = loadsOf(HANG);
await page.click(`${card(HANG)} .ken-lucid-state button:text-is("Try again")`);
assert.equal(await stateOf(HANG), "loading");
await page.waitForTimeout(300);
assert.equal(loadsOf(HANG), hangLoads + 1);

// 7. A forged frame of another origin can't replace the document either.
await page.evaluate(
  () =>
    new Promise((resolve) => {
      addEventListener("message", (e) => e.data?.type === "forged-done" && resolve());
      const f = document.createElement("iframe");
      f.src = "https://forged.example/";
      document.body.append(f);
    }),
);
await page.waitForTimeout(300);
assert.doesNotMatch(await editorText(), /PWNED/);
assert.match(await editorText(), /Intro paragraph\. Typing here\./);
// Control: the page itself (the harness's host) still drives the editor.
await page.evaluate(() => window.postMessage({ type: "update", text: "# Host\n\nFrom the host.\n" }, "*"));
await page.waitForFunction(() => document.querySelector(".ProseMirror").textContent.includes("From the host."));

assert.deepEqual(h.errors, []);
await h.close();

// 8. Screenshots of a card (fresh page, nothing typed), caption included.
async function shoot(md, file, ready, route = true) {
  const s = await openHarness({
    themeFile,
    markdown: md,
    width: 900,
    height: 1000,
    beforeLoad: route
      ? (p) => p.route("https://lucid.app/**", (r) => r.fulfill({ status: 200, contentType: "text/html", body: STUB }))
      : undefined,
  });
  await ready(s.page);
  const box = await s.page.evaluate(() => {
    const src = document.querySelector(".ken-lucid-source").getBoundingClientRect();
    const c = document.querySelector(".ken-lucid-card").getBoundingClientRect();
    return { x: Math.min(src.left, c.left) - 12, y: src.top - 12, width: Math.max(src.right, c.right) - Math.min(src.left, c.left) + 24, height: c.bottom - src.top + 24 };
  });
  await s.page.screenshot({ path: file, clip: box });
  const result = await ready.after?.(s.page);
  await s.close();
  return result;
}
const shot = join(shots, `lucid-card-${tone}.png`);
await shoot(`# Doc\n\n[Payments architecture](https://lucid.app/lucidchart/${DOC}/edit)\n\nAfter.\n`, shot, (p) =>
  p.waitForSelector(`${card(DOC)}[data-state="loaded"]`),
);
console.log(`ok: Lucid previews (${tone}); screenshot ${shot}`);

// 9. Optional: a real public embed from lucid.app.
if (process.env.KEN_LUCID_LIVE === "1") {
  const LIVE = "09e9dac9-f285-4e83-9eef-e6fe8f33f8ea"; // climate-tech-handbook on GitHub
  const live = join(shots, `lucid-live-${tone}.png`);
  const ready = async (p) => {
    await p.waitForSelector(`${card(LIVE)}[data-state="loaded"]`, { timeout: 30000 }).catch(() => {});
    await p.waitForTimeout(10000);
  };
  ready.after = async (p) => {
    const frame = p.frames().find((f) => f.url().startsWith("https://lucid.app/"));
    const state = await p.getAttribute(card(LIVE), "data-state");
    const inner = frame ? await frame.evaluate(() => document.body?.innerText.slice(0, 300) ?? "").catch((e) => `(unreadable: ${e})`) : "(no frame)";
    return { state, url: frame?.url(), inner };
  };
  const info = await shoot(`# Doc\n\nhttps://lucid.app/documents/embedded/${LIVE}\n\nAfter.\n`, live, ready, false);
  console.log(`live embed: ${JSON.stringify(info)}; screenshot ${live}`);
}
