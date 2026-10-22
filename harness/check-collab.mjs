// Collaboration end to end in Chromium: two real editors (two browsers)
// joined through the real hub, typing with real input.
//   node harness/check-collab.mjs <theme.json> [screenshot.png]
import assert from "node:assert/strict";
import { build } from "esbuild";
import { mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { pathToFileURL } from "url";
import { openHarness } from "./harness.mjs";

// The hub as it ships (TypeScript), bundled for Node.
const dir = mkdtempSync(join(tmpdir(), "ken-hub-"));
await build({ entryPoints: ["src/collab/hub.ts"], bundle: true, platform: "node", format: "esm", outfile: join(dir, "hub.mjs"), logLevel: "error" });
const { Hub } = await import(pathToFileURL(join(dir, "hub.mjs")).href);
const hub = new Hub();

const md = "# Plan\n\nWe ship on Friday.\n\n- Write docs\n- Test it\n";
const ROOM = "doc.md";

/** One editor joined to the hub: the harness page plus the host's relay role. */
async function editor(name, markdown, store) {
  const peer = name;
  let page;
  const writes = [];
  const conn = {
    send(m) {
      if (m.to !== peer) return;
      const msg =
        m.t === "welcome"
          ? { type: "collabStart", seed: m.seed, state: m.state, awareness: m.awareness, name }
          : m.t === "update"
            ? { type: "collabUpdate", data: m.data }
            : m.t === "awareness"
              ? { type: "collabAwareness", data: m.data }
              : { type: "collabWriter", writer: m.writer };
      void page.evaluate((msg) => {
        const bytes = (b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
        for (const k of ["state", "awareness", "data"]) if (typeof msg[k] === "string") msg[k] = bytes(msg[k]);
        window.postMessage(msg, "*");
      }, msg);
    },
  };
  const h = await openHarness({
    themeFile: process.argv[2],
    markdown,
    width: 1000,
    height: 560,
    beforeLoad: async (p) => {
      page = p;
      await p.exposeFunction("__hostHook", (type, data, writer) => {
        if (type === "collabUpdate") hub.receive(conn, { t: "update", room: ROOM, peer, data });
        else if (type === "collabAwareness") hub.receive(conn, { t: "awareness", room: ROOM, peer, data });
        else if (type === "collabStopped") writes.push({ stopped: true, writer });
      });
    },
  });
  return {
    ...h,
    name,
    join: () => hub.receive(conn, { t: "join", room: ROOM, peer, name, store }),
    leave: () => {
      hub.receive(conn, { t: "leave", room: ROOM, peer });
      return h.page.evaluate(() => window.postMessage({ type: "collabStop" }, "*"));
    },
    text: () => h.page.evaluate(() => document.querySelector(".ProseMirror").innerText),
    state: () =>
      h.page.evaluate(() => {
        const sent = window.__sent;
        return { edits: sent.filter((m) => m.type === "edit").length, last: window.__lastText(), stopped: sent.filter((m) => m.type === "collabStopped") };
      }),
  };
}

const checks = [];
const check = async (name, fn) => {
  if (process.env.KEN_DEBUG) console.log("…", name);
  await fn();
  checks.push(name);
};
const settle = (ms = 400) => new Promise((r) => setTimeout(r, ms));
const clickEndOf = async (page, text) => {
  const [x, y] = await page.evaluate((text) => {
    const el = [...document.querySelectorAll(".ProseMirror p, .ProseMirror h1")].find((e) => e.textContent.includes(text));
    const r = document.createRange();
    r.selectNodeContents(el);
    const b = r.getBoundingClientRect();
    return [b.right - 1, b.top + b.height / 2];
  }, text);
  await page.mouse.click(x, y);
  await page.keyboard.press("End");
};

const ada = await editor("Ada Lovelace", md, "host");
// Bob's copy is stale: the shared document replaces it.
const bob = await editor("Bob Byte", "# Old notes\n", "host");
try {
  await check("the first editor fills the room; the second gets the shared document", async () => {
    ada.join();
    await settle();
    bob.join();
    await settle(700);
    assert.match(await bob.text(), /We ship on Friday\./);
    assert.doesNotMatch(await bob.text(), /Old notes/);
  });

  await check("typing in either editor shows up in the other", async () => {
    await clickEndOf(ada.page, "We ship on Friday.");
    await ada.page.keyboard.type(" Maybe Monday.");
    await clickEndOf(bob.page, "Plan");
    await bob.page.keyboard.type(" v2");
    await settle(700);
    for (const e of [ada, bob]) {
      const t = await e.text();
      assert.match(t, /Plan v2/, e.name);
      assert.match(t, /We ship on Friday\. Maybe Monday\./, e.name);
    }
  });

  await check("one writer per file: only Ada's editor writes, and it writes Bob's edits too", async () => {
    await settle(400);
    const a = await ada.state();
    const b = await bob.state();
    assert.equal(b.edits, 0, "Bob's editor shares the file Ada writes");
    assert.equal(a.last, "# Plan v2\n\nWe ship on Friday. Maybe Monday.\n\n- Write docs\n- Test it\n");
  });

  await check("each sees the other's caret, name and avatar", async () => {
    // Bob's caret sits after "v2" in Ada's editor, labelled with his name.
    assert.equal(await ada.page.locator(".ken-collab-caret").count(), 1);
    assert.equal(await ada.page.locator(".ken-collab-name").textContent(), "Bob Byte");
    assert.equal(await bob.page.locator(".ken-collab-name").textContent(), "Ada Lovelace");
    assert.equal(await ada.page.locator(".ken-presence .ken-avatar").textContent(), "BB");
    assert.equal(await ada.page.locator(".ken-presence .ken-avatar").getAttribute("title"), "Bob Byte");
    // Coloured by the theme's chart colours.
    const color = await ada.page.locator(".ken-collab-caret").evaluate((el) => getComputedStyle(el).borderLeftColor);
    assert.notEqual(color, "rgba(0, 0, 0, 0)");
    // A selection shows as a tinted range.
    await bob.page.keyboard.press("Shift+Home");
    await settle();
    assert.ok((await ada.page.locator(".ken-collab-selection").count()) > 0, "Bob's selection is shown");
    await bob.page.keyboard.press("End");
    if (process.argv[3]) {
      await settle();
      await ada.page.screenshot({ path: process.argv[3] });
    }
  });

  await check("undo takes back only your own typing", async () => {
    // The shortcut runs the editor's undo command (VS Code keybinding → command).
    await bob.page.evaluate(() => window.postMessage({ type: "command", id: "undo" }, "*"));
    await settle(600);
    for (const e of [ada, bob]) {
      const t = await e.text();
      assert.doesNotMatch(t, /Plan v2/, e.name);
      assert.match(t, /Maybe Monday\./, e.name);
    }
  });

  await check("leaving: presence goes, the editor keeps working alone", async () => {
    await bob.leave();
    await settle(600);
    assert.equal(await ada.page.locator(".ken-collab-caret").count(), 0);
    assert.equal(await ada.page.locator(".ken-presence .ken-avatar").count(), 0);
    assert.equal(await bob.page.locator(".ken-presence").isHidden(), true);
    const b = await bob.state();
    assert.deepEqual(b.stopped.map((m) => m.writer), [false]);
    // Bob's later typing stays his own.
    await clickEndOf(bob.page, "Test it");
    await bob.page.keyboard.type(" solo");
    await settle(600);
    assert.doesNotMatch(await ada.text(), /solo/);
  });

  assert.deepEqual([...ada.errors, ...bob.errors], []);
  console.log(`collab: ${checks.length} checks passed`);
  for (const c of checks) console.log(`  ✓ ${c}`);
} finally {
  await ada.close();
  await bob.close();
}
// The hub's presence timers would keep Node alive.
process.exit(0);
