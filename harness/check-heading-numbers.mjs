// Heading numbers with real keystrokes: the label sits inline before the
// heading text, the caret never enters it, Home/arrows/Backspace at the
// heading start act on the text, a copy leaves the label out, and the
// copy-link button stays clear of it. Usage:
//   node harness/check-heading-numbers.mjs <theme.json>
import assert from "node:assert/strict";
import { openHarness } from "./harness.mjs";

const themeFile = process.argv[2];
const md = "---\nken-heading-numbering: legal-article-full\n---\n# Definitions\n\nIntro text.\n\n## Scope of the agreement\n\nBody.\n";
const h = await openHarness({ themeFile, markdown: md, width: 900, height: 700 });
const { page } = h;
const lastText = () => page.evaluate(() => window.__lastText());
const settle = () => page.waitForTimeout(250);
const checks = [];
const check = async (name, fn) => {
  await fn();
  checks.push(name);
};
/** Caret as [heading text before it, inside label?]. */
const caret = () =>
  page.evaluate(() => {
    const sel = getSelection();
    const node = sel.anchorNode;
    const el = node instanceof Element ? node : node?.parentElement;
    const block = el?.closest("h1, h2, h3, h4, h5, h6, p");
    const range = document.createRange();
    range.setStart(block, 0);
    range.setEnd(node, sel.anchorOffset);
    const frag = range.cloneContents();
    frag.querySelectorAll("[contenteditable=false]").forEach((w) => w.remove());
    return { tag: block?.tagName, before: frag.textContent, inLabel: false };
  });

/** The h2's label box (from its `::before`) and its text's first line. */
const geometry = () =>
  page.evaluate(() => {
    const h2 = document.querySelector(".ProseMirror h2");
    const text = [...h2.childNodes].find((n) => n.nodeType === 3);
    const r = document.createRange();
    r.selectNodeContents(text);
    const t = r.getClientRects()[0];
    const box = h2.getBoundingClientRect();
    const before = getComputedStyle(h2, "::before");
    // A probe in the label's own font, to measure it.
    const probe = document.createElement("span");
    probe.textContent = h2.getAttribute("data-heading-number");
    Object.assign(probe.style, { position: "absolute", whiteSpace: "nowrap", fontFamily: before.fontFamily, fontSize: before.fontSize, fontWeight: before.fontWeight, letterSpacing: before.letterSpacing, fontVariantNumeric: before.fontVariantNumeric });
    document.body.append(probe);
    const width = probe.getBoundingClientRect().width;
    probe.remove();
    return { label: before.content, labelWidth: width, gap: parseFloat(before.marginRight), color: before.color, userSelect: before.userSelect, headingColor: getComputedStyle(h2).color, h2Left: box.left, h2Right: box.right, textLeft: t.left, textTop: t.top, h2Top: box.top, fontSize: before.fontSize, headingFontSize: getComputedStyle(h2).fontSize };
  });

await check("labels render inline before the text, grey, unselectable", async () => {
  const g = await geometry();
  assert.equal(g.label, '"Section 1.01"');
  assert.equal(g.fontSize, g.headingFontSize);
  // The text starts right after the label and its space-wide gap.
  assert.ok(Math.abs(g.textLeft - (g.h2Left + g.labelWidth + g.gap)) < 2, JSON.stringify(g));
  assert.ok(g.gap > 4 && g.gap < 12, `gap ${g.gap}`);
  assert.ok(Math.abs(g.textTop - g.h2Top) < 10, "text on the first line");
  assert.equal(g.userSelect, "none");
  assert.notEqual(g.color, g.headingColor);
});

await check("clicking the label puts the caret at the text start", async () => {
  const g = await geometry();
  await page.mouse.click(g.h2Left + 8, g.textTop + 8);
  await settle();
  const c = await caret();
  assert.deepEqual(c, { tag: "H2", before: "", inLabel: false });
});

await check("Home, End and arrows move cleanly at the heading start", async () => {
  await page.click(".ProseMirror h2", { position: { x: 400, y: 10 } });
  await page.keyboard.press("End");
  await page.keyboard.press("Home");
  let c = await caret();
  assert.deepEqual(c, { tag: "H2", before: "", inLabel: false });
  await page.keyboard.type("A ");
  await settle();
  assert.match(await lastText(), /\n## A Scope of the agreement\n/);
  await page.keyboard.press("Backspace");
  await page.keyboard.press("Backspace");
  await settle();
  assert.match(await lastText(), /\n## Scope of the agreement\n/);
  // One step right then back left lands at the text start again.
  await page.keyboard.press("ArrowRight");
  c = await caret();
  assert.equal(c.before, "S");
  await page.keyboard.press("ArrowLeft");
  c = await caret();
  assert.deepEqual(c, { tag: "H2", before: "", inLabel: false });
  // Left from the start leaves the heading for the end of the line above.
  await page.keyboard.press("ArrowLeft");
  c = await caret();
  assert.equal(c.tag, "P");
  assert.equal(c.before, "Intro text.");
  await page.keyboard.press("ArrowRight");
  c = await caret();
  assert.deepEqual(c, { tag: "H2", before: "", inLabel: false });
});

await check("Backspace at the heading start acts as without numbers", async () => {
  // Milkdown: Backspace at a heading's start turns it into a paragraph.
  await page.keyboard.press("Backspace");
  await settle();
  const text = await lastText();
  assert.doesNotMatch(text, /Section 1\.01/);
  assert.match(text, /Intro text\.\n\nScope of the agreement\n|Intro text\.Scope of the agreement/);
  // Back to a heading with the input rule, caret still at the text start.
  await page.keyboard.type("## ");
  await settle();
  assert.match(await lastText(), /\n## Scope of the agreement\n/);
});

await check("copying a heading leaves the label out", async () => {
  await page.click(".ProseMirror h2", { position: { x: 400, y: 10 } });
  await settle();
  await page.keyboard.press("Home");
  await settle();
  for (let i = 0; i < "Scope of the agreement".length; i++) await page.keyboard.press("Shift+ArrowRight");
  // ProseMirror reads the selection on selectionchange, asynchronously.
  await settle();
  // Catch the copy ProseMirror writes, without the system clipboard.
  const copied = await page.evaluate(() => {
    const out = {};
    const listener = (event) => {
      out.text = event.clipboardData.getData("text/plain");
      out.html = event.clipboardData.getData("text/html");
    };
    document.addEventListener("copy", listener);
    document.execCommand("copy");
    document.removeEventListener("copy", listener);
    out.native = getSelection().toString();
    return out;
  });
  assert.equal(copied.text.trim(), "Scope of the agreement", JSON.stringify(copied));
  assert.doesNotMatch(copied.html, /Section 1\.01/);
});

await check("copy-link button sits left of the label, clear of it", async () => {
  await page.hover(".ProseMirror h2");
  await settle();
  const g = await geometry();
  const b = await page.evaluate(() => {
    const r = document.querySelector(".ProseMirror h2 .ken-heading-link").getBoundingClientRect();
    return { right: r.right, mid: (r.top + r.bottom) / 2, opacity: getComputedStyle(document.querySelector(".ProseMirror h2 .ken-heading-link")).opacity };
  });
  assert.ok(b.right <= g.h2Left - 8, JSON.stringify({ b, g }));
  assert.ok(b.mid > g.h2Top && b.mid < g.h2Top + 40, JSON.stringify({ b, g }));
});

await check("a long label wraps with its heading in a narrow pane", async () => {
  await page.setViewportSize({ width: 280, height: 700 });
  await settle();
  const g = await geometry();
  const scroll = await page.evaluate(() => document.getElementById("scroll").scrollWidth - document.getElementById("scroll").clientWidth);
  assert.ok(g.labelWidth <= g.h2Right - g.h2Left, JSON.stringify(g));
  assert.ok(scroll <= 0, `horizontal scroll ${scroll}`);
  // The label stays on the first line; the text still starts after it or wraps below.
  assert.ok(g.textTop >= g.h2Top - 1, JSON.stringify(g));
});

assert.deepEqual(h.errors, []);
console.log(JSON.stringify({ ok: true, checks }, null, 1));
await h.close();
