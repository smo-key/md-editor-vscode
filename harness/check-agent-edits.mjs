// A chat agent's pending edits in the editor (webview/agentEdits.ts) stay
// steady while the user edits near them: no Keep/Undo boxes or marks that come
// and go, no removed blocks rebuilt, nothing kept that comes back. The page
// stands in for VS Code: like its chat editing, it copies the user's edits
// outside the agent's changes into the original, a little later (`LATENCY`).
// Usage: node harness/check-agent-edits.mjs <theme.json>
import { openHarness } from "./harness.mjs";

const [themeFile] = process.argv.slice(2);
const LATENCY = Number(process.env.KEN_LATENCY ?? 250);

const ORIGINAL = `# Guide

Intro paragraph that stays.

Removed by the agent, first.

Middle paragraph that stays.

The agent changed this line.

Closing paragraph that stays.

Removed by the agent, last.
`;
const MODIFIED = `# Guide

Intro paragraph that stays.

Middle paragraph that stays.

The agent rewrote this line entirely.

A paragraph the agent added.

Closing paragraph that stays.
`;

const h = await openHarness({ themeFile, markdown: MODIFIED, width: 1100, height: 1000 });
const { page } = h;
await page.waitForTimeout(600);

// The stand-in host: VS Code's original, and its copying of the user's edits
// into it, as VS Code 1.145's chat editing does (_mirrorEdits): the user's edit
// is rebased over the inverse of the agent's edit (StringEdit.tryRebase, same
// conflict rules); if that works it goes into the original, else it becomes
// part of the agent's change. The agent's edit is taken as whole changed lines.
await page.evaluate(
  ({ original, modified, latency }) => {
    let O = original;
    let M = modified;
    window.__hostOriginal = () => O;
    /** The agent's edit O → M: one replacement (in O's offsets) per run of changed lines. */
    const agentEdit = () => {
      const a = O.split("\n").map((l) => l + "\n"), b = M.split("\n").map((l) => l + "\n");
      const L = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
      for (let x = a.length - 1; x >= 0; x--) for (let y = b.length - 1; y >= 0; y--) L[x][y] = a[x] === b[y] ? L[x + 1][y + 1] + 1 : Math.max(L[x + 1][y], L[x][y + 1]);
      const out = [];
      let x = 0, y = 0, oa = 0, open = null;
      const close = () => { if (open) out.push(open), (open = null); };
      while (x < a.length || y < b.length) {
        if (x < a.length && y < b.length && a[x] === b[y]) { close(); oa += a[x].length; x++; y++; continue; }
        open ??= { start: oa, end: oa, newText: "" };
        // On a tie, the original's line goes first, so unchanged lines after it stay matched.
        if (x < a.length && (y >= b.length || L[x + 1][y] >= L[x][y + 1])) { oa += a[x].length; open.end = oa; x++; }
        else { open.newText += b[y]; y++; }
      }
      close();
      return out;
    };
    /** E's inverse on O: replacements in M's offsets back to O's text. */
    const inverse = (E) => {
      let t = 0;
      return E.map((r) => {
        const inv = { start: r.start + t, end: r.start + t + r.newText.length, newText: O.slice(r.start, r.end) };
        t += r.newText.length - (r.end - r.start);
        return inv;
      });
    };
    const empty = (r) => r.start === r.end;
    const intersects = (p, q) => Math.max(p.start, q.start) < Math.min(p.end, q.end);
    const inside = (p, q) => empty(p) && q.start < p.start && p.start < q.end;
    /** VS Code's StringEdit._tryRebase(base, noOverlap = true). */
    const tryRebase = (user, base) => {
      const out = [];
      let i = 0, n = 0, r = 0;
      while (n < user.length || i < base.length) {
        const a = base[i], c = user[n];
        if (!c) break;
        if (!a) { out.push({ ...c, start: c.start + r, end: c.end + r }); n++; continue; }
        if (intersects(c, a) || (empty(c) && empty(a) && c.start === a.start) || inside(c, a) || inside(a, c)) return undefined;
        if (c.start < a.start || (empty(c) && c.start === a.start)) { out.push({ ...c, start: c.start + r, end: c.end + r }); n++; }
        else { i++; r += a.newText.length - (a.end - a.start); }
      }
      return out;
    };
    const apply = (text, edits) => {
      let out = "", at = 0;
      for (const e of edits) (out += text.slice(at, e.start) + e.newText), (at = e.end);
      return out + text.slice(at);
    };
    /** The file changed by the user (a minimal edit, as the host applies it). */
    const userEdit = (text) => {
      let p = 0;
      while (p < M.length && p < text.length && M[p] === text[p]) p++;
      let q = 0;
      while (q < M.length - p && q < text.length - p && M[M.length - 1 - q] === text[text.length - 1 - q]) q++;
      const user = [{ start: p, end: M.length - q, newText: text.slice(p, text.length - q) }];
      const rebased = tryRebase(user, inverse(agentEdit()));
      if (rebased) O = apply(O, rebased);
      M = text;
    };
    window.__userEdit = userEdit;
    window.__onEdit = (text) => {
      userEdit(text);
      setTimeout(() => window.postMessage({ type: "agentEdits", original: O, text }, "*"), latency);
    };
  },
  { original: ORIGINAL, modified: MODIFIED, latency: LATENCY },
);
// Hook the page's posted edits (the harness records them in __sent).
await page.evaluate(() => {
  const push = window.__sent.push.bind(window.__sent);
  window.__sent.push = (m) => {
    if (m.type === "edit") window.__onEdit(m.text);
    if (m.type === "agentAction") window.__actions = [...(window.__actions ?? []), m];
    return push(m);
  };
});
await page.evaluate((o) => window.postMessage({ type: "agentEdits", original: o }, "*"), ORIGINAL);
await page.waitForSelector(".ken-agent-hunk", { state: "attached" });
await page.waitForTimeout(300);

/** Records, from now, every change in what the agent's edits show. */
const watch = () =>
  page.evaluate(() => {
    const pm = document.querySelector(".ProseMirror");
    const ids = new WeakMap();
    let next = 0;
    const id = (el) => (ids.has(el) ? ids.get(el) : (ids.set(el, ++next), next));
    const snap = () => ({
      hunks: pm.querySelectorAll(".ken-agent-hunk").length,
      marks: [...pm.querySelectorAll(".ken-agent-mark")].map((e) => e.textContent.slice(0, 30)).join(" | "),
      widgets: [...pm.querySelectorAll(":scope > .ken-diff-widget")].map(id).join(","),
    });
    window.__trace = [snap()];
    window.__observer?.disconnect();
    window.__observer = new MutationObserver(() => {
      const s = snap();
      const last = window.__trace[window.__trace.length - 1];
      if (s.hunks !== last.hunks || s.marks !== last.marks || s.widgets !== last.widgets) window.__trace.push(s);
    });
    window.__observer.observe(pm, { childList: true, subtree: true, attributes: true, attributeFilter: ["class"] });
  });
const trace = () => page.evaluate(() => window.__trace);

let failures = 0;
/**
 * Flicker: what is shown (the runs and their marks) going back to an earlier
 * state after another, or the removed blocks rebuilt more than once. One
 * settled change is not flicker: VS Code's original may differ from the
 * editor's guess of it (see rebaseOriginal) and is then shown once it comes.
 */
function expectSteady(label, t) {
  const shown = t.map((s) => `${s.hunks}|${s.marks}`).filter((v, i, all) => i === 0 || v !== all[i - 1]);
  const back = shown.some((v, i) => shown.indexOf(v) < i);
  const widgets = t.map((s) => s.widgets).filter((v, i, all) => i === 0 || v !== all[i - 1]);
  const ok = !back && widgets.length <= 2;
  if (!ok) failures++;
  console.log(`${ok ? "ok  " : "FAIL"} ${label}${ok ? "" : ":\n  " + t.map((s) => JSON.stringify(s)).join("\n  ")}`);
}

async function caretAtEndOf(text) {
  await page.evaluate((text) => {
    const p = [...document.querySelectorAll(".ProseMirror > p")].find((e) => e.textContent.includes(text));
    p.scrollIntoView({ block: "center" });
  }, text);
  const box = await page.locator(".ProseMirror > p", { hasText: text }).first().boundingBox();
  await page.mouse.click(box.x + box.width - 2, box.y + box.height / 2);
  await page.keyboard.press("End");
}

// 1. Typing in a paragraph the agent didn't touch, next to its changes.
await caretAtEndOf("Middle paragraph that stays.");
await watch();
await page.keyboard.type(" More words here", { delay: 60 });
await page.waitForTimeout(LATENCY + 900);
expectSteady("typing beside the agent's changes", await trace());

// 2. A new paragraph between two untouched ones.
await caretAtEndOf("Intro paragraph that stays.");
await watch();
await page.keyboard.press("Enter");
await page.keyboard.type("A line of my own", { delay: 60 });
await page.waitForTimeout(LATENCY + 900);
expectSteady("adding a paragraph beside the agent's changes", await trace());

// 3. Typing in the agent's own paragraph: it stays one change, its box stays.
await caretAtEndOf("A paragraph the agent added.");
await watch();
await page.keyboard.type(" Tweaked", { delay: 60 });
await page.waitForTimeout(LATENCY + 900);
expectSteady("typing in the agent's change", await trace());

// 4. Keep one change, then type beside where it was.
await watch();
const before = await page.evaluate(() => document.querySelectorAll(".ken-agent-hunk").length);
await page.evaluate(() => {
  const hunk = document.querySelector('.ken-agent-hunk[data-hunk="1"] button');
  hunk.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
  hunk.click();
});
await page.waitForTimeout(50);
const action = await page.evaluate(() => (window.__actions ?? []).pop());
// The host keeps it: the file is unchanged, VS Code's original takes the agent's lines.
await page.waitForTimeout(400);
await page.evaluate(({ current, reverted }) => {
  // src/agentEditsHost.ts keep(): the agent's lines restored, then written again as the user's.
  window.__userEdit(reverted);
  window.__userEdit(current);
  window.postMessage({ type: "agentEdits", original: window.__hostOriginal(), text: current }, "*");
}, action);
await page.waitForTimeout(500);
const t4 = await trace();
const after = t4[t4.length - 1].hunks;
const keptOnce = after === before - 1 && t4.every((s, i) => i === 0 || s.hunks <= t4[i - 1].hunks);
if (!keptOnce) failures++;
console.log(`${keptOnce ? "ok  " : "FAIL"} keeping a change removes its box once (${before} → ${after})${keptOnce ? "" : ":\n  " + t4.map((s) => JSON.stringify(s)).join("\n  ")}`);

console.log(failures ? `${failures} failing` : "all passing");
await h.close();
process.exit(failures ? 1 : 0);
