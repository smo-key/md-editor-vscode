// Collaboration: the hub's bookkeeping (seeding, writers, presence) and real
// editors sharing one document through it.
import { readFileSync } from "fs";
import { describe, expect, it } from "vitest";
import { editorViewCtx } from "@milkdown/kit/core";
import { TextSelection } from "@milkdown/kit/prose/state";
import type { EditorView } from "@milkdown/kit/prose/view";

import { Hub } from "../../src/collab/hub";
import { fromBase64, toBase64, type Connection, type FromHub } from "../../src/collab/wire";
import { Collab, initials, sharedHistory, type Person } from "../../webview/collab";
import { isRemoteChange } from "../../webview/remoteChange";
import { ySyncPluginKey } from "y-prosemirror";
import { normalizeTrailingNewlines } from "../../webview/markdown/gfmFidelity";
import { mountEditor, stubLayout } from "./editorEnv";

stubLayout();

/** A connection that records what the hub sent it. */
function recorder(): Connection & { got: FromHub[] } {
  const got: FromHub[] = [];
  return { got, send: (m) => got.push(m) };
}

const join = (hub: Hub, conn: Connection, room: string, peer: string, store = "s") =>
  hub.receive(conn, { t: "join", room, peer, name: peer, store });

describe("hub", () => {
  it("asks the first peer to fill the room and holds the rest until it has", () => {
    const hub = new Hub();
    const a = recorder();
    const b = recorder();
    join(hub, a, "doc.md", "A");
    expect(a.got).toMatchObject([{ t: "welcome", to: "A", seed: true }]);
    join(hub, b, "doc.md", "B");
    expect(b.got).toEqual([]);
    hub.receive(a, { t: "update", room: "doc.md", peer: "A", data: toBase64(new Uint8Array([0, 0])) });
    expect(b.got[0]).toMatchObject({ t: "welcome", to: "B", seed: false });
    // One store: the first to have the document writes it.
    expect(a.got.filter((m) => m.t === "writer")).toMatchObject([{ writer: true }]);
    expect(b.got.filter((m) => m.t === "writer")).toEqual([]);
  });

  it("passes the job of filling the room on if the first peer leaves first", () => {
    const hub = new Hub();
    const a = recorder();
    const b = recorder();
    join(hub, a, "r", "A");
    join(hub, b, "r", "B");
    hub.receive(a, { t: "leave", room: "r", peer: "A" });
    expect(b.got).toMatchObject([{ t: "welcome", to: "B", seed: true }]);
  });

  it("elects one writer per copy of the file, preferring the hub's own machine", () => {
    const hub = new Hub();
    const guest = recorder();
    const local = recorder();
    const other = recorder();
    hub.attach(local, true);
    join(hub, guest, "r", "G", "host");
    hub.receive(guest, { t: "update", room: "r", peer: "G", data: toBase64(new Uint8Array([0, 0])) });
    expect(guest.got.filter((m) => m.t === "writer").at(-1)).toMatchObject({ writer: true });
    // The host's own editor arrives: it holds the real file, so it takes over.
    join(hub, local, "r", "L", "host");
    expect(local.got.filter((m) => m.t === "writer").at(-1)).toMatchObject({ writer: true });
    expect(guest.got.filter((m) => m.t === "writer").at(-1)).toMatchObject({ writer: false });
    // Someone with their own checkout writes their own copy.
    join(hub, other, "r", "O", "elsewhere");
    expect(other.got.filter((m) => m.t === "writer").at(-1)).toMatchObject({ writer: true });
    // The host's editor closes: the guest writes again.
    hub.detach(local);
    expect(guest.got.filter((m) => m.t === "writer").at(-1)).toMatchObject({ writer: true });
  });

  it("relays updates to everyone else in the room only", () => {
    const hub = new Hub();
    const [a, b, c] = [recorder(), recorder(), recorder()];
    join(hub, a, "one", "A");
    hub.receive(a, { t: "update", room: "one", peer: "A", data: toBase64(new Uint8Array([0, 0])) });
    join(hub, b, "one", "B");
    join(hub, c, "two", "C");
    hub.receive(b, { t: "update", room: "one", peer: "B", data: "AAA=" });
    expect(a.got.filter((m) => m.t === "update")).toMatchObject([{ to: "A", data: "AAA=" }]);
    expect(b.got.filter((m) => m.t === "update")).toEqual([]);
    expect(c.got.filter((m) => m.t === "update")).toEqual([]);
    // Messages for a peer this connection does not own are ignored.
    hub.receive(c, { t: "update", room: "one", peer: "A", data: "AAA=" });
    expect(b.got.filter((m) => m.t === "update")).toEqual([]);
  });

  it("forgets empty rooms", () => {
    const hub = new Hub();
    const a = recorder();
    join(hub, a, "r", "A");
    expect(hub.stats()).toEqual([{ room: "r", peers: 1 }]);
    hub.detach(a);
    expect(hub.stats()).toEqual([]);
  });
});

it("initials", () => {
  expect(initials("Ada Lovelace")).toBe("AL");
  expect(initials("grace")).toBe("GR");
  expect(initials("  ")).toBe("?");
});

// --- Real editors through the hub ------------------------------------------------

interface Editor {
  view: EditorView;
  markdown(): string;
  collab: Collab | null;
  people: Person[];
  front: string;
  threads: string[];
  destroy(): Promise<void>;
}

async function share(hub: Hub, name: string, markdown: string, room = "doc.md"): Promise<Editor> {
  const ed = await mountEditor(markdown);
  const view: EditorView = ed.crepe.editor.action((ctx) => ctx.get(editorViewCtx));
  const peer = name;
  const editor: Editor = {
    view,
    markdown: () => normalizeTrailingNewlines(ed.markdown()),
    collab: null,
    people: [],
    front: "",
    threads: [],
    destroy: async () => {
      editor.collab?.stop();
      hub.detach(conn);
      await ed.destroy();
    },
  };
  const conn: Connection = {
    send(m) {
      if (m.to !== peer) return;
      if (m.t === "welcome") {
        const collab = new Collab(
          view,
          {
            send: (data) => hub.receive(conn, { t: "update", room, peer, data: toBase64(data) }),
            sendAwareness: (data) => hub.receive(conn, { t: "awareness", room, peer, data: toBase64(data) }),
            onFront: (f) => (editor.front = f),
            onThreads: (t) => (editor.threads = t),
            onPeople: (p) => (editor.people = p),
          },
          name,
        );
        editor.collab = collab;
        collab.start(m.seed, fromBase64(m.state), fromBase64(m.awareness), editor.front, editor.threads);
      } else if (m.t === "update") editor.collab?.apply(fromBase64(m.data));
      else if (m.t === "awareness") editor.collab?.applyAwareness(fromBase64(m.data));
    },
  };
  hub.receive(conn, { t: "join", room, peer, name, store: name });
  return editor;
}

function find(view: EditorView, text: string): number {
  let found = -1;
  view.state.doc.descendants((node, pos) => {
    if (found >= 0 || !node.isText) return found < 0;
    const i = node.text!.indexOf(text);
    if (i >= 0) found = pos + i;
    return false;
  });
  if (found < 0) throw new Error(`no text ${text}`);
  return found;
}

function typeAfter(view: EditorView, anchor: string, text: string) {
  const at = find(view, anchor) + anchor.length;
  view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, at)).insertText(text));
}

describe("shared editing", () => {
  it("gives a joiner the document and merges edits both ways", async () => {
    const hub = new Hub();
    const a = await share(hub, "Ada", "# Title\n\nHello world.\n");
    // Bob's own copy is stale: the shared document wins.
    const b = await share(hub, "Bob", "# Old\n");
    try {
      expect(b.markdown()).toBe("# Title\n\nHello world.\n");
      typeAfter(a.view, "Hello", " there");
      typeAfter(b.view, "world.", " Bye.");
      expect(a.markdown()).toBe("# Title\n\nHello there world. Bye.\n");
      expect(b.markdown()).toBe(a.markdown());
    } finally {
      await b.destroy();
      await a.destroy();
    }
  });

  it("keeps every GFM construct intact through the shared document", async () => {
    const gfm = normalizeTrailingNewlines(readFileSync("test/fixtures/gfm.md", "utf8"));
    const hub = new Hub();
    const a = await share(hub, "Ada", gfm);
    const b = await share(hub, "Bob", "");
    try {
      const original = a.markdown();
      expect(b.markdown()).toBe(original);
      typeAfter(b.view, "Bullet one", "!");
      expect(a.markdown()).toBe(b.markdown());
      expect(a.markdown().replace("Bullet one!", "Bullet one")).toBe(original);
    } finally {
      await b.destroy();
      await a.destroy();
    }
  });

  it("does not duplicate comment markers when others' edits arrive", async () => {
    const md =
      "Intro <!-- ken:comment c1 -->marked<!-- /ken:comment c1 --> text.\n\nMore.\n";
    const hub = new Hub();
    const a = await share(hub, "Ada", md);
    const b = await share(hub, "Bob", "");
    try {
      // Bob deletes across the end of the range; Ada's editor must not "repair" it again.
      const from = find(b.view, "ked");
      const to = find(b.view, " text") + 3;
      b.view.dispatch(b.view.state.tr.delete(from, to));
      const count = (s: string) => s.split("ken:comment c1").length - 1;
      expect(count(b.markdown())).toBe(2);
      expect(count(a.markdown())).toBe(2);
      expect(a.markdown()).toBe(b.markdown());
    } finally {
      await b.destroy();
      await a.destroy();
    }
  });

  it("shares frontmatter and comment threads beside the document", async () => {
    const hub = new Hub();
    const a = await share(hub, "Ada", "Text.\n");
    a.collab!.setFront("---\ntitle: Hi\n---\n");
    a.collab!.setThreads([JSON.stringify({ id: "c1", resolved: false, messages: [] })]);
    const b = await share(hub, "Bob", "");
    try {
      expect(b.front).toBe("---\ntitle: Hi\n---\n");
      expect(b.threads).toHaveLength(1);
      b.collab!.setFront("---\ntitle: Bye\n---\n");
      expect(a.front).toBe("---\ntitle: Bye\n---\n");
      b.collab!.setThreads([]);
      expect(a.threads).toEqual([]);
    } finally {
      await b.destroy();
      await a.destroy();
    }
  });

  it("undoes only your own changes", async () => {
    const hub = new Hub();
    const a = await share(hub, "Ada", "One two.\n");
    const b = await share(hub, "Bob", "");
    try {
      typeAfter(a.view, "One", " A");
      typeAfter(b.view, "two", " B");
      const shared = sharedHistory(a.view.state)!;
      expect(shared.undo(a.view.state)).toBeTruthy();
      shared.undo(a.view.state, a.view.dispatch);
      expect(a.markdown()).toBe("One two B.\n");
      expect(b.markdown()).toBe("One two B.\n");
    } finally {
      await b.destroy();
      await a.destroy();
    }
  });

  it("shows who else is here, and drops them when they leave", async () => {
    const hub = new Hub();
    const a = await share(hub, "Ada", "Text.\n");
    const b = await share(hub, "Bob", "");
    try {
      expect(a.people.map((p) => p.name)).toEqual(["Bob"]);
      expect(b.people.map((p) => p.name)).toEqual(["Ada"]);
      // Bob's caret is drawn in Ada's editor.
      typeAfter(b.view, "Text", "!");
      expect(a.view.dom.querySelectorAll(".ken-collab-caret")).toHaveLength(1);
      expect(a.view.dom.querySelector(".ken-collab-name")?.textContent).toBe("Bob");
    } finally {
      await b.destroy();
    }
    expect(a.people).toEqual([]);
    await a.destroy();
  });

  it("recognises others' changes by y-prosemirror's mark", async () => {
    const ed = await mountEditor("Text.\n");
    const view: EditorView = ed.crepe.editor.action((ctx) => ctx.get(editorViewCtx));
    try {
      const remote = view.state.tr.setMeta(ySyncPluginKey, { isChangeOrigin: true });
      expect(isRemoteChange([remote])).toBe(true);
      expect(isRemoteChange([view.state.tr])).toBe(false);
      expect(isRemoteChange([])).toBe(false);
    } finally {
      await ed.destroy();
    }
  });
});
