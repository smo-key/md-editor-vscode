import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { editorViewCtx } from "@milkdown/kit/core";
import type { EditorView } from "@milkdown/kit/prose/view";
import { TextSelection } from "@milkdown/kit/prose/state";
import { mountEditor, stubLayout } from "./editorEnv";
import { findLucidBlocks, lucidRefreshKey, type LucidMode, type LucidOptions } from "../../webview/markdown/lucid";

stubLayout();
// Frames must not reach lucid.app from the tests: happy-dom would fetch them.
beforeAll(() => {
  (window as unknown as { happyDOM: { settings: { disableIframePageLoading: boolean } } }).happyDOM.settings.disableIframePageLoading = true;
});

const ID = "3f2a1b4c-1111-4222-8333-444455556666";
const PID = "9c1e0000-aaaa-4bbb-8ccc-dddddddddddd";
const EDIT = `https://lucid.app/lucidchart/${ID}/edit`;
const EMBED = `https://lucid.app/documents/embedded/${ID}`;
const IMAGE = `https://lucid.app/publicSegments/view/${PID}/image.png`;

// IntersectionObserver: records what is observed; `intersect()` fires it.
let observed: { cb: IntersectionObserverCallback; el: Element; io: IntersectionObserver }[] = [];
let autoIntersect = true;
class FakeIO {
  constructor(private cb: IntersectionObserverCallback) {}
  observe(el: Element) {
    const entry = { cb: this.cb, el, io: this as unknown as IntersectionObserver };
    observed.push(entry);
    if (autoIntersect) fire(entry);
  }
  unobserve(el: Element) {
    observed = observed.filter((o) => o.el !== el);
  }
  disconnect() {
    observed = observed.filter((o) => o.io !== (this as unknown as IntersectionObserver));
  }
}
function fire(o: (typeof observed)[number]) {
  o.cb([{ isIntersecting: true, target: o.el } as unknown as IntersectionObserverEntry], o.io);
}
const intersect = () => [...observed].forEach(fire);

beforeEach(() => {
  observed = [];
  autoIntersect = true;
  vi.stubGlobal("IntersectionObserver", FakeIO);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

let mode: LucidMode = "auto";
async function mount(md: string, extra: Partial<LucidOptions> = {}) {
  const open = vi.fn();
  const openLink = vi.fn();
  const ed = await mountEditor(md, { lucid: { mode: () => mode, open, openLink, ...extra } });
  let view!: EditorView;
  ed.crepe.editor.action((ctx) => (view = ctx.get(editorViewCtx)));
  const cards = () => [...ed.root.querySelectorAll<HTMLElement>(".ken-lucid-card")];
  const refresh = () => view.dispatch(view.state.tr.setMeta(lucidRefreshKey, true));
  return { ...ed, view, open, openLink, cards, refresh };
}

describe("which links become previews", () => {
  beforeEach(() => (mode = "auto"));

  it.each([
    ["a bare link", EDIT],
    ["an autolink", `<https://lucid.app/lucidchart/${ID}/view>`],
    ["an inline link", `[Payments](${EDIT})`],
    ["an embedded link", EMBED],
    ["a legacy host", `https://www.lucidchart.com/documents/view/${ID}`],
    ["a Lucidspark board", `https://lucid.app/lucidspark/${ID}/edit`],
  ])("%s alone in its paragraph gets one framed card", async (_name, md) => {
    const ed = await mount(md);
    const cards = ed.cards();
    expect(cards).toHaveLength(1);
    const frame = cards[0].querySelector("iframe")!;
    expect(frame.getAttribute("data-src")).toBe(EMBED);
    expect(frame.getAttribute("sandbox")).toBe("allow-scripts allow-same-origin");
    expect(frame.getAttribute("referrerpolicy")).toBe("strict-origin");
    expect(frame.getAttribute("src")).toBe(EMBED);
    expect(cards[0].getAttribute("contenteditable")).toBe("false");
    await ed.destroy();
  });

  it("keeps an invitation in the embed URL", async () => {
    const ed = await mount(`${EDIT}?invitationId=inv_x`);
    expect(ed.cards()[0].querySelector("iframe")!.getAttribute("data-src")).toBe(`${EMBED}?invitationId=inv_x`);
    await ed.destroy();
  });

  it("titles the card with the link text, or a fallback", async () => {
    const ed = await mount(`[Payments architecture](${EDIT})\n\n${EDIT}`);
    const [a, b] = ed.cards();
    expect(a.querySelector(".ken-lucid-title")!.textContent).toBe("Payments architecture");
    expect(a.getAttribute("aria-label")).toBe("Lucidchart diagram: Payments architecture");
    expect(b.querySelector(".ken-lucid-title")!.textContent).toBe("Lucidchart diagram");
    await ed.destroy();
  });

  it("previews links in list items and alerts", async () => {
    const ed = await mount(`- ${EDIT}\n\n> [!NOTE]\n> ${EDIT}\n\n> ${EDIT}`);
    expect(ed.cards()).toHaveLength(3);
    await ed.destroy();
  });

  it.each([
    ["a link inside a sentence", `See [the diagram](${EDIT}) for details.`],
    ["two links in one paragraph", `${EDIT} ${EDIT}`],
    ["a link in a table cell", `| a |\n| - |\n| ${EDIT} |`],
    ["a non-Lucid link", "https://example.com/lucidchart/x/edit"],
    ["a look-alike host", `https://lucid.app.evil.com/lucidchart/${ID}/edit`],
    ["a non-document Lucid link", "https://lucid.app/invitations/accept/inv_x"],
  ])("%s gets none", async (_name, md) => {
    const ed = await mount(md);
    expect(ed.cards()).toHaveLength(0);
    await ed.destroy();
  });

  it("gives a linked published image a toolbar, not a frame", async () => {
    const ed = await mount(`[![Payments](${IMAGE})](${EDIT})`);
    const bars = ed.root.querySelectorAll(".ken-lucid-toolbar");
    expect(bars).toHaveLength(1);
    expect(ed.root.querySelector(".ken-lucid-card iframe, .ken-lucid-toolbar iframe")).toBeNull();
    const labels = [...bars[0].querySelectorAll("button")].map((b) => b.textContent);
    expect(labels).toEqual(["Edit", "Open in Lucidchart", "Reload"]);
    await ed.destroy();
  });

  it("offers only Open image on a bare published image", async () => {
    const ed = await mount(`![Payments](${IMAGE})`);
    const bars = ed.root.querySelectorAll(".ken-lucid-toolbar");
    expect(bars).toHaveLength(1);
    expect([...bars[0].querySelectorAll("button")].map((b) => b.textContent)).toEqual(["Open image"]);
    (bars[0].querySelector("button") as HTMLButtonElement).click();
    expect(ed.open).toHaveBeenCalledWith(IMAGE, "open");
    await ed.destroy();
  });

  it("finds blocks with the pure walker", async () => {
    const ed = await mount(`intro\n\n[T](${EDIT})\n\nSee ${EDIT} here.`);
    const blocks = findLucidBlocks(ed.view.state.doc);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({ form: "frame", title: "T", key: `lucid:frame:${ID}:0` });
    await ed.destroy();
  });

  it("marks the link paragraph as the card's source caption", async () => {
    const ed = await mount(EDIT);
    expect(ed.root.querySelectorAll("p.ken-lucid-source")).toHaveLength(1);
    await ed.destroy();
  });
});

describe("the document", () => {
  beforeEach(() => (mode = "auto"));

  it("is unchanged by previews and config refreshes", async () => {
    const md = `# Title\n\n${EDIT}\n\n[T](${EDIT})\n\n[![P](${IMAGE})](${EDIT})\n`;
    mode = "off";
    const plain = await mount(md);
    const expected = plain.markdown();
    await plain.destroy();
    mode = "auto";
    const ed = await mount(md);
    expect(ed.markdown()).toBe(expected);
    const before = ed.view.state.doc;
    const dispatched: boolean[] = [];
    const orig = ed.view.dispatch.bind(ed.view);
    ed.view.dispatch = (tr) => {
      dispatched.push(tr.docChanged);
      orig(tr);
    };
    ed.refresh();
    window.dispatchEvent(new Event("focus"));
    (ed.cards()[0].querySelector(".ken-lucid-reload") as HTMLButtonElement).click();
    expect(dispatched.every((c) => !c)).toBe(true);
    expect(ed.view.state.doc.eq(before)).toBe(true);
    expect(ed.markdown()).toBe(expected);
    await ed.destroy();
  });

  it("keeps the same frame while typing elsewhere", async () => {
    const ed = await mount(`para one\n\n${EDIT}\n\nafter`);
    const card = ed.cards()[0];
    const frame = card.querySelector("iframe")!;
    frame.dispatchEvent(new Event("load"));
    for (const ch of "hello") ed.view.dispatch(ed.view.state.tr.insertText(ch, 1));
    ed.view.dispatch(ed.view.state.tr.insertText("x", ed.view.state.doc.content.size - 1));
    expect(ed.cards()).toHaveLength(1);
    expect(ed.cards()[0]).toBe(card);
    expect(ed.cards()[0].querySelector("iframe")).toBe(frame);
    expect(card.dataset.state).toBe("loaded");
    await ed.destroy();
  });

  it("removes the card with its paragraph", async () => {
    const ed = await mount(`one\n\n${EDIT}\n\ntwo`);
    const p = ed.view.state.doc.child(1);
    const from = ed.view.state.doc.child(0).nodeSize;
    ed.view.dispatch(ed.view.state.tr.delete(from, from + p.nodeSize));
    expect(ed.cards()).toHaveLength(0);
    await ed.destroy();
  });

  it("follows remote (collab) transactions the same way", async () => {
    const ed = await mount("one");
    const { schema } = ed.view.state;
    const link = schema.marks.link.create({ href: EDIT });
    const para = schema.nodes.paragraph.create(null, schema.text(EDIT, [link]));
    ed.view.dispatch(ed.view.state.tr.insert(ed.view.state.doc.content.size, para).setMeta("y-sync$", { isChangeOrigin: true }));
    expect(ed.cards()).toHaveLength(1);
    await ed.destroy();
  });

  it("outlines the card while the selection covers its link", async () => {
    const ed = await mount(`one\n\n${EDIT}`);
    const card = ed.cards()[0];
    expect(card.classList.contains("ken-lucid-selected")).toBe(false);
    const start = ed.view.state.doc.child(0).nodeSize;
    const end = start + ed.view.state.doc.child(1).nodeSize;
    ed.view.dispatch(ed.view.state.tr.setSelection(TextSelection.create(ed.view.state.doc, start + 1, end - 1)));
    expect(card.classList.contains("ken-lucid-selected")).toBe(true);
    ed.view.dispatch(ed.view.state.tr.setSelection(TextSelection.create(ed.view.state.doc, 1)));
    expect(card.classList.contains("ken-lucid-selected")).toBe(false);
    await ed.destroy();
  });
});

describe("modes and loading", () => {
  beforeEach(() => (mode = "auto"));

  it("loads only once the card nears the viewport", async () => {
    autoIntersect = false;
    const ed = await mount(EDIT);
    const frame = ed.cards()[0].querySelector("iframe")!;
    expect(frame.getAttribute("src")).toBeNull();
    intersect();
    expect(frame.getAttribute("src")).toBe(EMBED);
    await ed.destroy();
  });

  it("off: no cards, and a refresh brings them back", async () => {
    mode = "off";
    const ed = await mount(EDIT);
    expect(ed.cards()).toHaveLength(0);
    expect(ed.root.querySelector(".ken-lucid-source")).toBeNull();
    mode = "auto";
    ed.refresh();
    expect(ed.cards()).toHaveLength(1);
    mode = "off";
    ed.refresh();
    expect(ed.cards()).toHaveLength(0);
    await ed.destroy();
  });

  it("onClick: loads only after Load preview", async () => {
    mode = "onClick";
    const ed = await mount(EDIT);
    const card = ed.cards()[0];
    const frame = card.querySelector("iframe")!;
    expect(frame.getAttribute("src")).toBeNull();
    expect(card.textContent).toContain("Lucidchart preview");
    expect(card.textContent).toContain("Loads from lucid.app.");
    const load = [...card.querySelectorAll("button")].find((b) => b.textContent === "Load preview")!;
    expect(load).toBeTruthy();
    load.click();
    expect(frame.getAttribute("src")).toBe(EMBED);
    await ed.destroy();
  });

  it("shows the offline card and loads when back online", async () => {
    vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
    const ed = await mount(EDIT);
    const card = ed.cards()[0];
    const frame = card.querySelector("iframe")!;
    expect(frame.getAttribute("src")).toBeNull();
    expect(card.dataset.state).toBe("offline");
    expect(card.textContent).toContain("You're offline. The preview loads when you're back online.");
    vi.spyOn(navigator, "onLine", "get").mockReturnValue(true);
    window.dispatchEvent(new Event("online"));
    expect(frame.getAttribute("src")).toBe(EMBED);
    vi.restoreAllMocks();
    await ed.destroy();
  });

  it("shows the timeout card after 20 s, and a late load restores the frame", async () => {
    autoIntersect = false;
    const ed = await mount(EDIT);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    intersect();
    const card = ed.cards()[0];
    vi.advanceTimersByTime(19_000);
    expect(card.dataset.state).toBe("loading");
    vi.advanceTimersByTime(1_500);
    expect(card.dataset.state).toBe("timeout");
    expect(card.textContent).toContain("Lucidchart could not be reached.");
    const labels = [...card.querySelectorAll(".ken-lucid-state button")].map((b) => b.textContent);
    expect(labels).toEqual(["Try again", "Open in Lucidchart"]);
    card.querySelector("iframe")!.dispatchEvent(new Event("load"));
    expect(card.dataset.state).toBe("loaded");
    vi.useRealTimers();
    await ed.destroy();
  });

  it("shows the hint, whose link opens Lucid's help", async () => {
    const ed = await mount(EDIT);
    const hint = ed.cards()[0].querySelector(".ken-lucid-hint")!;
    expect(hint.textContent).toBe(
      "Blank, or asking you to sign in? The owner can turn on More › Embed › Activate Embed Code in Lucid, or publish it as an image and link that here.",
    );
    const a = hint.querySelector("a")!;
    expect(a.textContent).toBe("publish it as an image");
    a.click();
    expect(ed.openLink).toHaveBeenCalledWith("https://help.lucid.co/hc/en-us/articles/16181914460692");
    await ed.destroy();
  });
});

describe("actions", () => {
  beforeEach(() => (mode = "auto"));

  it("Edit and Open post the link as written; focus reloads afterwards", async () => {
    const href = `${EDIT}?invitationId=inv_x`;
    const ed = await mount(`[T](${href})`);
    const card = ed.cards()[0];
    const frame = card.querySelector("iframe")!;
    frame.dispatchEvent(new Event("load"));
    expect(card.dataset.state).toBe("loaded");
    const buttons = [...card.querySelectorAll(".ken-lucid-header button")] as HTMLButtonElement[];
    expect(buttons.map((b) => b.textContent)).toEqual(["Edit", "Open in Lucidchart", "Reload"]);
    expect(buttons[0].title).toBe("Edit in your browser");
    buttons[0].click();
    expect(ed.open).toHaveBeenCalledWith(href, "edit");
    buttons[1].click();
    expect(ed.open).toHaveBeenCalledWith(href, "open");
    window.dispatchEvent(new Event("focus"));
    expect(card.dataset.state).toBe("loading");
    frame.dispatchEvent(new Event("load"));
    window.dispatchEvent(new Event("focus"));
    expect(card.dataset.state).toBe("loaded");
    await ed.destroy();
  });

  it("Reload reloads the frame", async () => {
    const ed = await mount(EDIT);
    const card = ed.cards()[0];
    card.querySelector("iframe")!.dispatchEvent(new Event("load"));
    (card.querySelector(".ken-lucid-reload") as HTMLButtonElement).click();
    expect(card.dataset.state).toBe("loading");
    await ed.destroy();
  });

  it("image Edit uses the wrapping link and Reload busts only the DOM image", async () => {
    const ed = await mount(`[![P](${IMAGE})](${EDIT})`);
    const bar = ed.root.querySelector(".ken-lucid-toolbar")!;
    const [edit, open, reload] = [...bar.querySelectorAll("button")] as HTMLButtonElement[];
    edit.click();
    expect(ed.open).toHaveBeenCalledWith(EDIT, "edit");
    open.click();
    expect(ed.open).toHaveBeenCalledWith(EDIT, "open");
    const md = ed.markdown();
    reload.click();
    const img = ed.root.querySelector<HTMLImageElement>(".ken-lucid-source img:not(.ProseMirror-separator)")!;
    expect(img.getAttribute("src")).toMatch(new RegExp(`^${IMAGE.replace(/[.?]/g, "\\$&")}\\?v=\\d+$`));
    expect(ed.markdown()).toBe(md);
    await ed.destroy();
  });

  it("clicks in the card never reach the editor", async () => {
    const ed = await mount(`one\n\n${EDIT}`);
    const sel = ed.view.state.selection.from;
    const title = ed.cards()[0].querySelector(".ken-lucid-title")!;
    title.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    expect(ed.view.state.selection.from).toBe(sel);
    await ed.destroy();
  });
});
