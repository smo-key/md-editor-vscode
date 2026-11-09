import { describe, expect, it } from "vitest";
import { parserCtx, serializerCtx } from "@milkdown/kit/core";
import type { Node as ProseNode } from "@milkdown/kit/prose/model";
import { editorViewCtx } from "@milkdown/kit/core";
import { hunksForBlock, lineHunks, revertHunks } from "../../src/agentEdits";
import { agentEdits, agentEditsPlugin, agentHunks, installAgentEdits, rebaseOriginal, setAgentOriginal } from "../../webview/agentEdits";
import { diffBlocks } from "../../webview/diffModel";
import { buildEditor } from "../../webview/editorSetup";
import { printablePage } from "../../webview/print";
import { stubLayout } from "./editorEnv";

stubLayout();

const ORIGINAL = "# Title\n\nAlpha one.\n\nBeta two.\n\nGamma.\n";
const CURRENT = "# Title\n\nAlpha one changed.\n\nGamma.\n\nDelta new.\n";

describe("agent edit hunks (src/agentEdits.ts)", () => {
  it("finds changed line runs and puts chosen ones back", () => {
    const hunks = lineHunks(ORIGINAL, CURRENT);
    expect(hunks).toEqual([
      { oStart: 2, oEnd: 5, mStart: 2, mEnd: 3 },
      { oStart: 7, oEnd: 7, mStart: 5, mEnd: 7 },
    ]);
    expect(revertHunks(ORIGINAL, CURRENT, [hunks[1]!])).toBe("# Title\n\nAlpha one changed.\n\nGamma.\n");
    expect(revertHunks(ORIGINAL, CURRENT, hunks)).toBe(ORIGINAL);
  });

  it("places an editor block in a file whose Markdown the editor would write differently", () => {
    const original = "Intro\n\n* one\n* two\n\nOld end\n";
    const current = "Intro\n\n* one\n* two\n* three\n\nNew end\n";
    // The editor writes "-" bullets: the block is still found by its neighbours.
    const editor = "Intro\n\n- one\n- two\n- three\n\nNew end\n";
    const reverted = "Intro\n\n- one\n- two\n- three\n\nOld end\n";
    const hunks = hunksForBlock(original, current, editor, reverted);
    expect(revertHunks(original, current, hunks)).toBe("Intro\n\n* one\n* two\n* three\n\nOld end\n");
  });

  it("finds nothing when the block is unchanged", () => {
    expect(hunksForBlock(ORIGINAL, CURRENT, CURRENT, CURRENT)).toEqual([]);
  });
});

describe("agent edits in the editor (webview/agentEdits.ts)", () => {
  it("shows each run of changes with Keep/Undo and undoes one exactly", { timeout: 10000 }, async () => {
    const root = document.createElement("div");
    document.body.append(root);
    const crepe = buildEditor({ root, markdown: CURRENT });
    crepe.editor.use(agentEditsPlugin);
    await crepe.create();
    const view = crepe.editor.action((ctx) => ctx.get(editorViewCtx));
    const posted: { scope: string; current?: string; reverted?: string }[] = [];
    const serialize = (doc: ProseNode) => crepe.editor.action((ctx) => ctx.get(serializerCtx)(doc));
    installAgentEdits(view, {
      parse: (md) => crepe.editor.action((ctx) => ctx.get(parserCtx)(md)) ?? null,
      split: (text) => ({ front: "", gap: "", markdown: text }),
      front: () => "",
      fullText: (doc) => serialize(doc),
      flush: () => undefined,
      post: (m) => posted.push(m),
    });

    setAgentOriginal(ORIGINAL);
    expect(agentEdits.pending()).toBe(true);
    expect(root.querySelectorAll(".ken-agent-hunk")).toHaveLength(2);
    expect(root.querySelectorAll(".ken-diff-widget .ken-diff-removed")).toHaveLength(2);
    expect(root.querySelectorAll(".ken-diff-added")).toHaveLength(2);
    expect(document.querySelector(".ken-agent-count")?.textContent).toBe("1 of 2");

    // Printing shows the document as it is, unmarked.
    const page = await printablePage(root, "doc");
    expect(page).toContain("Delta new.");
    expect(page).not.toContain("Beta two.");
    expect(page).not.toMatch(/ken-agent|ken-diff-added/);

    root.querySelector<HTMLButtonElement>('.ken-agent-hunk[data-hunk="0"] button:not(.primary)')!.click();
    expect(posted).toHaveLength(1);
    const { current, reverted } = posted[0]!;
    expect(reverted).toBe("# Title\n\nAlpha one.\n\nBeta two.\n\nGamma.\n\nDelta new.\n");
    // The host puts back exactly the file's lines for that block.
    expect(revertHunks(ORIGINAL, CURRENT, hunksForBlock(ORIGINAL, CURRENT, current!, reverted!))).toBe(
      "# Title\n\nAlpha one.\n\nBeta two.\n\nGamma.\n\nDelta new.\n",
    );

    // A file the agent created: shown as it is under a banner, kept or undone whole.
    setAgentOriginal("");
    expect(root.querySelector(".ken-agent-banner")?.textContent).toBe("This file was added.");
    expect(root.querySelectorAll(".ken-agent-hunk, .ken-diff-added")).toHaveLength(0);
    expect(agentEdits.pending()).toBe(true);
    await new Promise((r) => setTimeout(r, 3100));
    document.querySelector<HTMLButtonElement>(".ken-agent-bar button:not(.primary)")!.click();
    expect(posted.at(-1)).toMatchObject({ scope: "file", action: "undo" });

    setAgentOriginal(null);
    expect(agentEdits.pending()).toBe(false);
    expect(root.querySelectorAll(".ken-agent-hunk")).toHaveLength(0);
    expect(document.querySelector<HTMLElement>(".ken-agent-bar")!.hidden).toBe(true);
    await crepe.destroy();
    root.remove();
  });
});

describe("copying the user's edits into the original (rebaseOriginal)", () => {
  const ORIG = "# Guide\n\nIntro.\n\nRemoved first.\n\nMiddle.\n\nThe agent changed this.\n\nEnd.\n";
  const MOD = "# Guide\n\nIntro.\n\nMiddle.\n\nThe agent rewrote this.\n\nAdded by the agent.\n\nEnd.\n";

  async function setup() {
    const root = document.createElement("div");
    document.body.append(root);
    const crepe = buildEditor({ root, markdown: MOD });
    await crepe.create();
    const view = crepe.editor.action((ctx) => ctx.get(editorViewCtx));
    const parse = (md: string) => crepe.editor.action((ctx) => ctx.get(parserCtx)(md))!;
    const md = (doc: ProseNode) => crepe.editor.action((ctx) => ctx.get(serializerCtx)(doc));
    /** The end of the paragraph saying `text`, in the editor's document. */
    const endOf = (text: string) => {
      let at = -1;
      view.state.doc.descendants((n, pos) => {
        if (n.type.name === "paragraph" && n.textContent === text) at = pos + n.nodeSize - 1;
      });
      return at;
    };
    const runs = (original: ProseNode) => agentHunks(diffBlocks(original, view.state.doc));
    return { view, md, original: parse(ORIG), endOf, runs, done: () => crepe.destroy() };
  }

  it("copies an edit of a block the agent didn't change", async () => {
    const t = await setup();
    const tr = t.view.state.tr.insertText(", edited", t.endOf("Middle.") - 1);
    const next = rebaseOriginal(t.original, tr);
    expect(t.md(next)).toBe(ORIG.replace("Middle.", "Middle, edited."));
    await t.done();
  });

  it("puts a new paragraph on the side of a removed block where the editor shows it", async () => {
    const t = await setup();
    const before = t.runs(t.original);
    // Enter at the end of "Intro.": the removed block stays after the new paragraph.
    const at = t.endOf("Intro.");
    const tr = t.view.state.tr.split(at);
    tr.insertText("Mine", at + 2);
    const next = rebaseOriginal(t.original, tr);
    expect(t.md(next)).toBe(ORIG.replace("Intro.\n", "Intro.\n\nMine\n"));
    t.view.dispatch(tr);
    expect(t.runs(next).length).toBe(before.length);
    await t.done();
  });

  it("leaves an edit of the agent's own blocks to be the agent's change", async () => {
    const t = await setup();
    const tr = t.view.state.tr.insertText(" tweaked", t.endOf("Added by the agent.") - 1);
    expect(rebaseOriginal(t.original, tr)).toBe(t.original);
    await t.done();
  });
});
