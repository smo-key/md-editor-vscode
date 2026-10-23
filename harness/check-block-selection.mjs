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
  await check("a plain click on an image opens the lightbox", async () => {
    await page.click(".milkdown-image-block img");
    await settle();
    assert.equal(await page.evaluate(() => !!document.querySelector(".ken-lightbox")), true);
    await page.click(".ken-lightbox");
    await settle();
    assert.equal(await page.evaluate(() => !!document.querySelector(".ken-lightbox")), false);
  });

  await check("dragging across text, a table, code and an image: stable, growing selection", async () => {
    await page.evaluate(() => {
      window.__flaps = { on: 0, off: 0, removed: 0 };
      new MutationObserver((ms) => {
        for (const m of ms) {
          const was = String(m.oldValue).includes("ken-block-selected"), is = m.target.classList.contains("ken-block-selected");
          if (m.type === "attributes" && was !== is) window.__flaps[is ? "on" : "off"]++;
          if (m.type === "childList") for (const n of m.removedNodes) if (n instanceof Element && /milkdown-(table|image|code)-block/.test(n.className)) window.__flaps.removed++;
        }
      }).observe(document.querySelector(".ProseMirror"), { attributes: true, attributeFilter: ["class"], attributeOldValue: true, childList: true, subtree: true });
    });
    const intro = await page.locator(".ProseMirror p", { hasText: "Intro text" }).boundingBox();
    const img = await page.locator(".milkdown-image-block img").boundingBox();
    const end = await page.locator(".ProseMirror p", { hasText: "End" }).boundingBox();
    // Diagonally from the start of the text, over the table, the code and
    // the middle of the image, then on to the last paragraph.
    const path = [
      [intro.x + 2, intro.y + intro.height / 2],
      [img.x + img.width / 2, img.y + img.height / 2],
      [end.x + 20, end.y + end.height / 2],
    ];
    await page.mouse.move(...path[0]);
    await page.mouse.down();
    await page.evaluate(() => (window.__flaps = { on: 0, off: 0, removed: 0 }));
    const counts = [];
    let zoomMidDrag = null;
    for (let leg = 0; leg < 2; leg++) {
      const [[xa, ya], [xb, yb]] = [path[leg], path[leg + 1]];
      for (let i = 1; i <= 40; i++) {
        const x = xa + ((xb - xa) * i) / 40, y = ya + ((yb - ya) * i) / 40;
        await page.mouse.move(x, y);
        counts.push(await page.evaluate(() => document.querySelectorAll(".ken-block-selected").length));
        if (leg === 0 && i === 40) zoomMidDrag = await page.evaluate(([x, y]) => getComputedStyle(document.elementFromPoint(x, y)).cursor, [x, y]);
      }
    }
    assert.notEqual(zoomMidDrag, "zoom-in", "no zoom-in cursor over the image mid-drag");
    const flaps = await page.evaluate(() => window.__flaps);
    assert.equal(flaps.removed, 0, "no block re-rendered");
    // Mousedown clears the image's earlier selection; past that, highlights only come on.
    await page.waitForTimeout(0);
    assert.ok(flaps.off <= 1 && flaps.on <= 3, `highlights only come on, once per block: ${JSON.stringify(flaps)}`);

    // Back over the image to let go there.
    await page.mouse.move(...path[1]);
    for (let i = 1; i < counts.length; i++) assert.ok(counts[i] >= counts[i - 1], `highlight shrank mid-drag: ${counts.join(",")}`);
    assert.ok(counts.at(-1) >= 3, `table, code and image highlighted: ${counts.at(-1)}`);
    await page.mouse.up();
    await settle();
    assert.equal(await page.evaluate(() => !!document.querySelector(".ken-lightbox")), false, "no lightbox on release over the image");
    assert.equal(await page.evaluate(() => document.body.classList.contains("ken-drag-selecting")), false);
    const cursorAfter = await page.evaluate(([x, y]) => getComputedStyle(document.elementFromPoint(x, y)).cursor, path[1]);
    assert.equal(cursorAfter, "zoom-in", "zoom-in again once the drag is over");
  });

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

  await check("Shift+click into a table cell ends the range in that cell", async () => {
    await caretAtEnd("Intro text");
    await page.click(".ProseMirror td:has-text('2')", { modifiers: ["Shift"] });
    await settle();
    const inCell = await page.evaluate(() => !!getSelection().focusNode?.parentElement?.closest("td"));
    assert.equal(inCell, true, "selection ends inside the cell");
    const hl = await highlighted();
    assert.ok(hl.some((c) => /table/.test(c)), `table shown as included: ${hl}`);
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
} finally {
  await h.close();
}

// Drags that start in a table, each in a fresh document.
const TABLE = "| a | b |\n| - | - |\n| 1 | 2 |";
async function withDoc(markdown, fn) {
  const d = await openHarness({ themeFile: process.argv[2], markdown, width: 900, height: 900 });
  try {
    await fn(d.page);
    assert.deepEqual(d.errors, []);
  } finally {
    await d.close();
  }
}
/** Press in the middle of `from`, drag in steps to `to` ({x, y}), release. */
async function drag(p, from, to, steps = 20) {
  await p.mouse.move(from.x, from.y);
  await p.mouse.down();
  for (let i = 1; i <= steps; i++) await p.mouse.move(from.x + ((to.x - from.x) * i) / steps, from.y + ((to.y - from.y) * i) / steps);
  await p.mouse.up();
  await p.waitForTimeout(250);
}
const centre = async (p, selector) => {
  const b = await p.locator(selector).first().boundingBox();
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
};
/** The point just before "text" in "Tail text". */
const beforeText = (p) =>
  p.evaluate(() => {
    const t = [...document.querySelectorAll(".ProseMirror p")].find((e) => e.textContent === "Tail text").firstChild;
    const r = document.createRange();
    r.setStart(t, 5);
    r.setEnd(t, 6);
    const b = r.getBoundingClientRect();
    return { x: b.left + 1, y: b.top + b.height / 2 };
  });
const saved = (p) => p.evaluate(() => window.__lastText());

await check("a drag from one cell into a cell in another row works (it used to crash the page)", () =>
  withDoc(`Intro\n\n${TABLE}\n\nTail text\n`, async (p) => {
    await drag(p, await centre(p, ".ProseMirror th"), await centre(p, ".ProseMirror td:has-text('1')"));
    assert.equal(await p.evaluate(() => !!document.querySelector(".ProseMirror")), true);
    const inTable = await p.evaluate(() => !!getSelection().focusNode?.parentElement?.closest("td, th") || document.querySelectorAll(".selectedCell").length > 0);
    assert.equal(inTable, true, "the selection stays in the table");
  }),
);

for (const [name, above] of [["", ""], [" (image above)", "![logo](logo.svg)\n\n"], [" (rule above)", "---\n\n"]]) {
  for (const [how, key] of [["a drag", "X"], ["a drag", "Backspace"], ["Shift+click", "X"], ["Shift+click", "Backspace"]]) {
    await check(`${how} from a cell to the text below, then ${key}${name}, removes just the table`, () =>
      withDoc(`Intro\n\n${above}${TABLE}\n\nTail text\n`, async (p) => {
        if (how === "a drag") await drag(p, await centre(p, ".ProseMirror td:has-text('1')"), await beforeText(p));
        else {
          const c = await centre(p, ".ProseMirror td:has-text('1')");
          await p.mouse.click(c.x, c.y);
          await p.waitForTimeout(250);
          const t = await beforeText(p);
          await p.keyboard.down("Shift");
          await p.mouse.click(t.x, t.y);
          await p.keyboard.up("Shift");
          await p.waitForTimeout(250);
        }
        const hl = await p.evaluate(() => [...document.querySelectorAll(".ken-block-selected")].map((e) => e.className));
        assert.ok(hl.some((c) => /table/.test(c)), `the table shows as included: ${hl}`);
        await p.keyboard.press(key);
        await p.waitForTimeout(250);
        const text = (await saved(p)).trim();
        const kept = above ? `Intro\n\n${above.trim().replace("---", "***")}\n\n` : "Intro\n\n";
        assert.equal(text, `${kept}${key === "X" ? "X" : ""}text`);
      }),
    );
  }
}

console.log(checks.map((c) => `ok  ${c}`).join("\n"));
