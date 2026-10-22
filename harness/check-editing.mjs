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

await check("heading control: menu of Text + H1–H6, remembers the pick; no selection bubble", async () => {
  await page.click(".ProseMirror p:has-text('Some text here.')");
  await page.click('[data-id="heading-menu"]');
  assert.equal(await page.locator(".ken-heading-item").count(), 7);
  await page.click('.ken-heading-item[data-id="heading5"]');
  await settle();
  assert.match(await lastText(), /\n##### Some text here\.\n/);
  assert.equal(await page.getAttribute('[data-id="heading"]', "data-level"), "5");
  // Inside an H2 the button shows that level.
  await page.click(".ProseMirror h2");
  await settle();
  assert.equal(await page.getAttribute('[data-id="heading"]', "data-level"), "2");
  await page.click(".ProseMirror h5");
  await settle();
  await page.click('[data-id="heading"]');
  await settle();
  assert.match(await lastText(), /\n\nSome text here\.\n/);
  await page.dblclick(".ProseMirror >> text=Some");
  await settle();
  assert.equal(await page.locator(".milkdown-toolbar").count(), 0);
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

await check("toolbar tooltips: bold action name, shortcut as a keycap", async () => {
  await page.keyboard.press("Escape");
  await page.click(".ProseMirror p >> text=after");
  await page.evaluate(() => window.postMessage({ type: "shortcuts", labels: { bold: "⌘B" } }, "*"));
  await settle();
  await page.hover('.ken-toolbar-button[data-id="bold"]');
  await page.waitForTimeout(700);
  const tip = await page.evaluate(() => {
    const t = document.querySelector(".ken-tooltip");
    return { shown: !t.hidden, label: t.querySelector("strong")?.textContent, key: t.querySelector("kbd")?.textContent };
  });
  assert.deepEqual(tip, { shown: true, label: "Bold", key: "⌘B" });
  await page.hover('.ken-toolbar-button[data-id="table"]');
  await page.waitForTimeout(100);
  const next = await page.evaluate(() => ({ label: document.querySelector(".ken-tooltip strong")?.textContent, key: document.querySelector(".ken-tooltip kbd") }));
  assert.deepEqual(next, { label: "Table", key: null }, "no keycap without a shortcut");
  await page.mouse.move(5, 5);
});

await check("columns resize by dragging, never under 40px, stored in the Markdown", async () => {
  const border = await page.evaluate(() => {
    const th = document.querySelector(".ProseMirror th");
    const r = th.getBoundingClientRect();
    return { x: r.right, y: r.top + r.height / 2 };
  });
  await page.mouse.move(border.x - 2, border.y);
  await page.waitForTimeout(100);
  await page.mouse.down();
  await page.mouse.move(border.x - 300, border.y, { steps: 4 });
  await page.mouse.up();
  await settle();
  const text = await lastText();
  const m = /<!-- ken:table widths=(\d+),/.exec(text);
  assert.ok(m, text);
  assert.equal(Number(m[1]), 40);
  // Double-click the handle: automatic widths again.
  await page.mouse.move(border.x - 2, border.y);
  const b2 = await page.evaluate(() => {
    const r = document.querySelector(".ProseMirror th").getBoundingClientRect();
    return { x: r.right, y: r.top + r.height / 2 };
  });
  await page.mouse.move(b2.x - 2, b2.y);
  await page.waitForTimeout(100);
  await page.mouse.dblclick(b2.x - 2, b2.y);
  await settle();
  assert.doesNotMatch(await lastText(), /ken:table widths/);
});

await check("a click below a final table puts the caret after it", async () => {
  // The document ends with "after" (typed earlier); add a table at the end.
  await page.click(".ProseMirror p >> text=after");
  await page.keyboard.press("End");
  await page.keyboard.press("Enter");
  await page.click('.ken-toolbar-button[data-id="table"]');
  await settle();
  const box = await page.evaluate(() => document.querySelector(".editor-scroll").getBoundingClientRect());
  await page.mouse.click(box.left + 300, box.bottom - 10);
  await page.keyboard.type("below");
  await settle();
  assert.match(await lastText(), /\|\n\nbelow\n$/);
});

await check("underline (⌘U) writes <ins>", async () => {
  await page.click(".ProseMirror p >> text=below");
  await page.keyboard.press("End");
  await page.keyboard.press("Shift+Home");
  await page.click('.ken-toolbar-button[data-id="underline"]');
  await settle();
  assert.match(await lastText(), /<ins>below<\/ins>\n$/);
});

await check("toolbar checklist on the last line keeps the caret in the new item", async () => {
  // A click below the document puts the caret at its very end.
  const box = await page.evaluate(() => document.querySelector(".editor-scroll").getBoundingClientRect());
  await page.mouse.click(box.left + 300, box.bottom - 10);
  await page.keyboard.press("Enter");
  await page.keyboard.type("todo");
  await page.click('.ken-toolbar-button[data-id="task-list"]');
  await settle();
  await page.keyboard.type(" item");
  await settle();
  assert.match(await lastText(), /\n- \[ \] (<ins>)?todo item(<\/ins>)?\n$/);
});

// LaTeX, in a document of its own.
{
  const m = await openHarness({ themeFile, markdown: "Intro\n", width: 900, height: 700 });
  const p = m.page;
  const text = () => p.evaluate(() => window.__lastText());
  /** Caret at the end of the paragraph containing `t` (through the DOM selection, as a click would). */
  const caretAtEnd = async (t) => {
    await p.focus(".ProseMirror");
    await p.evaluate((t) => {
      const el = [...document.querySelectorAll(".ProseMirror p")].find((e) => e.textContent.includes(t));
      const range = document.createRange();
      range.selectNodeContents(el.lastChild.nodeType === 3 ? el.lastChild : el);
      range.collapse(false);
      getSelection().removeAllRanges();
      getSelection().addRange(range);
    }, t);
    await p.waitForTimeout(100);
  };
  await check("LaTeX: typed $…$ renders with KaTeX and edits in place; prices stay text", async () => {
    await caretAtEnd("Intro");
    await p.keyboard.press("Enter");
    await p.keyboard.type("Costs $5 and $10, area $\\pi r^2$ ok");
    await p.waitForTimeout(250);
    assert.equal(await text(), "Intro\n\nCosts $5 and $10, area $\\pi r^2$ ok\n");
    await p.waitForSelector(".ken-math .katex");
    // Click: its source opens, selected, in place.
    await p.click(".ken-math");
    await p.keyboard.press("ArrowRight");
    await p.keyboard.type("+1");
    await p.keyboard.press("Enter");
    // The caret is after the formula; a $ typed there does not reach back across it.
    await p.keyboard.type(" $");
    await p.waitForTimeout(250);
    assert.equal(await text(), "Intro\n\nCosts $5 and $10, area $\\pi r^2+1$ $ ok\n");
  });
  await check("LaTeX: $$ and a space opens a block, previewed; its source shows only while editing", async () => {
    await p.keyboard.press("Backspace");
    await p.keyboard.press("Backspace");
    await caretAtEnd("Costs");
    await p.keyboard.press("Enter");
    await p.keyboard.type("$$ ");
    await p.keyboard.type("\\frac{a}{b}");
    await p.waitForTimeout(250);
    assert.match(await text(), /ok\n\n\$\$\n\\frac\{a\}\{b\}\n\$\$\n$/);
    await p.waitForSelector(".milkdown-code-block[data-math] .katex-display");
    const shown = () => p.evaluate(() => getComputedStyle(document.querySelector(".milkdown-code-block[data-math] .codemirror-host")).display);
    assert.equal(await shown(), "block");
    await p.click(".ProseMirror p >> text=Intro");
    await p.waitForTimeout(250);
    assert.equal(await shown(), "none");
    // A click on the formula edits it again.
    await p.click(".milkdown-code-block[data-math] .preview-panel");
    await p.waitForTimeout(250);
    assert.equal(await shown(), "block");
    assert.ok(await p.evaluate(() => !!document.activeElement?.closest(".cm-editor")));
  });
  assert.deepEqual(m.errors, []);
  await m.close();
}

assert.deepEqual(h.errors, []);
await h.close();
console.log(`ok: ${checks.length} checks\n- ${checks.join("\n- ")}`);
