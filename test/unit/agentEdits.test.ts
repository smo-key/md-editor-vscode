import { describe, expect, it } from "vitest";
import { parserCtx, serializerCtx } from "@milkdown/kit/core";
import type { Node as ProseNode } from "@milkdown/kit/prose/model";
import { editorViewCtx } from "@milkdown/kit/core";
import { hunksForBlock, lineHunks, revertHunks } from "../../src/agentEdits";
import { agentEdits, agentEditsPlugin, installAgentEdits, setAgentOriginal } from "../../webview/agentEdits";
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
  it("shows each run of changes with Keep/Undo and undoes one exactly", async () => {
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
    expect(root.querySelectorAll(".ken-diff-widget.ken-diff-removed")).toHaveLength(2);
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

    setAgentOriginal(null);
    expect(agentEdits.pending()).toBe(false);
    expect(root.querySelectorAll(".ken-agent-hunk")).toHaveLength(0);
    expect(document.querySelector<HTMLElement>(".ken-agent-bar")!.hidden).toBe(true);
    await crepe.destroy();
    root.remove();
  });
});
