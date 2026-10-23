import { describe, expect, it } from "vitest";
import { DRAWIO_ORIGIN, isFrameMessage, isHostMessage } from "../../webview/hostMessage";

// VS Code's webview: the host frame (pre/index.html) and the editor page
// share one origin, and the host posts with `contentWindow.postMessage(msg,
// window.origin)`. Since 1.143 the page's `window.parent` is overwritten with
// `window`, so the host's window is reachable only as `event.source`.
const ORIGIN = "vscode-webview://abc123";
type FakeWin = { origin: string; parent: FakeWin; frames: FakeWin[]; length: number };
function fake(origin: string, children: FakeWin[] = []): FakeWin {
  const w = { origin, frames: children, length: children.length } as unknown as FakeWin;
  w.parent = w;
  return w;
}
function webview(children: FakeWin[] = []) {
  const host = fake(ORIGIN);
  const self = fake(ORIGIN, children);
  return { self: self as unknown as Window, host, children };
}
const ev = (origin: string, source: unknown) => ({ origin, source }) as unknown as MessageEvent;

describe("isHostMessage", () => {
  it("accepts the VS Code host at our origin (1.143: window.parent === window)", () => {
    const { self, host } = webview();
    expect(isHostMessage(ev(ORIGIN, host), self)).toBe(true);
  });

  it("accepts the host when window.parent still points at it (older VS Code)", () => {
    const { self, host } = webview();
    (self as unknown as FakeWin).parent = host;
    expect(isHostMessage(ev(ORIGIN, host), self)).toBe(true);
  });

  it("accepts messages the page posts to itself (the harness)", () => {
    const { self } = webview();
    expect(isHostMessage(ev(ORIGIN, self), self)).toBe(true);
  });

  it("ignores a forged message from a cross-origin iframe", () => {
    const frame = fake("https://embed.diagrams.net");
    const { self } = webview([frame]);
    expect(isHostMessage(ev("https://embed.diagrams.net", frame), self)).toBe(false);
    expect(isHostMessage(ev("https://lucid.app", frame), self)).toBe(false);
  });

  it("ignores a child frame, or a frame nested in one, even at our origin", () => {
    const grandchild = fake(ORIGIN);
    const child = fake(ORIGIN, [grandchild]);
    const { self } = webview([child]);
    expect(isHostMessage(ev(ORIGIN, child), self)).toBe(false);
    expect(isHostMessage(ev(ORIGIN, grandchild), self)).toBe(false);
  });

  it("ignores a wrong origin, an opaque origin, or no source", () => {
    const { self, host } = webview();
    expect(isHostMessage(ev("https://evil.example", host), self)).toBe(false);
    expect(isHostMessage(ev(ORIGIN, null), self)).toBe(false);
    expect(isHostMessage(ev("null", host), fake("null") as unknown as Window)).toBe(false);
  });

  it("works on a real window: a same-origin iframe can't pass as the host", () => {
    const frame = document.createElement("iframe");
    document.body.append(frame);
    try {
      const child = frame.contentWindow;
      expect(child).toBeTruthy();
      expect(isHostMessage(ev(window.origin, child), window)).toBe(false);
      expect(isHostMessage(ev(window.origin, window), window)).toBe(true);
    } finally {
      frame.remove();
    }
  });
});

describe("isFrameMessage", () => {
  it("accepts the embedded frame's own window at its own origin", () => {
    const frame = {} as Window;
    expect(isFrameMessage(ev(DRAWIO_ORIGIN, frame), frame, DRAWIO_ORIGIN)).toBe(true);
  });

  it("ignores another window, another origin, or a frame that is gone", () => {
    const frame = {} as Window;
    expect(isFrameMessage(ev(DRAWIO_ORIGIN, {} as Window), frame, DRAWIO_ORIGIN)).toBe(false);
    expect(isFrameMessage(ev("https://evil.example", frame), frame, DRAWIO_ORIGIN)).toBe(false);
    expect(isFrameMessage(ev(DRAWIO_ORIGIN, null), null, DRAWIO_ORIGIN)).toBe(false);
  });
});
