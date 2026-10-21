import { beforeAll, describe, expect, it } from "vitest";
import { Editor, defaultValueCtx, editorViewCtx, rootCtx } from "@milkdown/kit/core";
import { commonmark } from "@milkdown/kit/preset/commonmark";
import { gfm } from "@milkdown/kit/preset/gfm";
import { callCommand, getMarkdown } from "@milkdown/kit/utils";
import { TextSelection } from "@milkdown/kit/prose/state";

import {
  githubAlertKinds,
  githubAlertPlugins,
  insertGithubAlertCommand,
} from "../../webview/markdown/githubAlert";

// happy-dom does not implement the layout APIs ProseMirror's view layer calls
// while rendering; stub the few we need so the editor can mount headlessly.
beforeAll(() => {
  const proto = globalThis.Range.prototype as unknown as {
    getClientRects?: () => DOMRect[];
    getBoundingClientRect?: () => DOMRect;
  };
  const emptyRect = () =>
    ({
      x: 0,
      y: 0,
      top: 0,
      left: 0,
      right: 0,
      bottom: 0,
      width: 0,
      height: 0,
      toJSON: () => ({}),
    }) as DOMRect;
  if (!proto.getClientRects) proto.getClientRects = () => [];
  if (!proto.getBoundingClientRect) proto.getBoundingClientRect = emptyRect;
  const el = globalThis.Element.prototype as unknown as {
    getClientRects?: () => DOMRect[];
  };
  if (!el.getClientRects) el.getClientRects = () => [];
});

async function makeEditor(markdown: string) {
  const root = document.createElement("div");
  document.body.appendChild(root);
  const editor = await Editor.make()
    .config((ctx) => {
      ctx.set(rootCtx, root);
      ctx.set(defaultValueCtx, markdown);
    })
    .use(commonmark)
    .use(gfm)
    .use(githubAlertPlugins)
    .create();
  return editor;
}

async function roundTrip(markdown: string): Promise<string> {
  const editor = await makeEditor(markdown);
  const out = editor.action(getMarkdown());
  await editor.destroy();
  return out;
}

describe("github alerts", () => {
  it("exports the five kinds in GitHub's order", () => {
    expect(githubAlertKinds.map((k) => k.kind)).toEqual([
      "note",
      "tip",
      "important",
      "warning",
      "caution",
    ]);
    for (const k of githubAlertKinds) {
      expect(k.label.length).toBeGreaterThan(0);
      expect(k.icon).toContain("<svg");
    }
  });

  for (const { kind, label } of [
    { kind: "note", label: "Note" },
    { kind: "tip", label: "Tip" },
    { kind: "important", label: "Important" },
    { kind: "warning", label: "Warning" },
    { kind: "caution", label: "Caution" },
  ]) {
    it(`round trips a ${kind} alert`, async () => {
      const md = `> [!${kind.toUpperCase()}]\n> ${label} body text.\n`;
      expect(await roundTrip(md)).toBe(md);
    });
  }

  it("renders the alert as a div.github-alert with a title and a body", async () => {
    const editor = await makeEditor("> [!TIP]\n> Try this.\n");
    const dom = editor.action((ctx) => ctx.get(editorViewCtx).dom);
    const alert = dom.querySelector(".github-alert");
    expect(alert).not.toBeNull();
    expect(alert?.getAttribute("data-kind")).toBe("tip");
    const title = alert?.querySelector(".github-alert-title");
    expect(title?.getAttribute("contenteditable")).toBe("false");
    expect(title?.textContent).toContain("Tip");
    expect(title?.querySelector("svg")).not.toBeNull();
    const body = alert?.querySelector(".github-alert-body");
    expect(body?.textContent).toContain("Try this.");
    await editor.destroy();
  });

  // Milkdown serializes every list as a loose list (`* one\n\n* two`), inside
  // alerts exactly as it does at the top level, so the expected output below is
  // the milkdown-normalized form. The second round trip proves it is stable.
  it("round trips an alert containing a list and a code block", async () => {
    const md = [
      "> [!WARNING]",
      "> Watch out for:",
      ">",
      "> * one",
      "> * two",
      ">",
      "> ```ts",
      "> const a = 1",
      "> ```",
      "",
    ].join("\n");
    const expected = [
      "> [!WARNING]",
      "> Watch out for:",
      ">",
      "> * one",
      ">",
      "> * two",
      ">",
      "> ```ts",
      "> const a = 1",
      "> ```",
      "",
    ].join("\n");
    const out = await roundTrip(md);
    expect(out).toBe(expected);
    expect(await roundTrip(out)).toBe(expected);
  });

  it("round trips an alert whose first child is a list", async () => {
    const md = ["> [!NOTE]", ">", "> * one", "> * two", ""].join("\n");
    const expected = ["> [!NOTE]", ">", "> * one", ">", "> * two", ""].join(
      "\n",
    );
    const out = await roundTrip(md);
    expect(out).toBe(expected);
    expect(await roundTrip(out)).toBe(expected);
  });

  it("keeps trailing text on the marker line as the first paragraph", async () => {
    expect(await roundTrip("> [!NOTE] Inline text here.\n")).toBe(
      "> [!NOTE]\n> Inline text here.\n",
    );
  });

  it("normalizes a lowercase marker to upper case", async () => {
    expect(await roundTrip("> [!note]\n> Lower.\n")).toBe("> [!NOTE]\n> Lower.\n");
  });

  it("leaves a plain blockquote alone", async () => {
    const md = "> Just a quote.\n";
    expect(await roundTrip(md)).toBe(md);
  });

  it("leaves an unknown marker alone", async () => {
    const md = "> \\[!HINT]\n> Not an alert.\n";
    expect(await roundTrip(md)).toBe(md);
  });

  it("keeps inline marks inside an alert", async () => {
    const md = "> [!IMPORTANT]\n> Read **this** now.\n";
    expect(await roundTrip(md)).toBe(md);
  });

  it("round trips several alerts and surrounding content", async () => {
    const md = [
      "# Title",
      "",
      "> [!TIP]",
      "> First.",
      "",
      "Between.",
      "",
      "> [!CAUTION]",
      "> Second.",
      "",
    ].join("\n");
    expect(await roundTrip(md)).toBe(md);
  });

  it("inserts an alert into an empty paragraph", async () => {
    const editor = await makeEditor("");
    editor.action(callCommand(insertGithubAlertCommand.key, "warning"));
    const doc = editor.action((ctx) => ctx.get(editorViewCtx).state.doc);
    expect(doc.childCount).toBe(1);
    const alert = doc.child(0);
    expect(alert.type.name).toBe("github_alert");
    expect(alert.attrs.kind).toBe("warning");
    expect(alert.child(0).type.name).toBe("paragraph");
    expect(alert.child(0).content.size).toBe(0);
    // The selection lands inside the new alert so typing continues there.
    const sel = editor.action((ctx) => ctx.get(editorViewCtx).state.selection);
    expect(sel.$from.parent.type.name).toBe("paragraph");
    expect(sel.$from.node(sel.$from.depth - 1).type.name).toBe("github_alert");
    await editor.destroy();
  });

  it("serializes an alert typed into after insertion", async () => {
    const editor = await makeEditor("");
    editor.action(callCommand(insertGithubAlertCommand.key, "caution"));
    editor.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      view.dispatch(view.state.tr.insertText("Careful here."));
    });
    expect(editor.action(getMarkdown())).toBe("> [!CAUTION]\n> Careful here.\n");
    await editor.destroy();
  });

  it("wraps the current paragraph when it has text", async () => {
    const editor = await makeEditor("Hello there\n");
    editor.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      const { state } = view;
      view.dispatch(
        state.tr.setSelection(TextSelection.create(state.doc, 3)),
      );
    });
    editor.action(callCommand(insertGithubAlertCommand.key, "tip"));
    const out = editor.action(getMarkdown());
    expect(out).toBe("> [!TIP]\n> Hello there\n");
    await editor.destroy();
  });
});
