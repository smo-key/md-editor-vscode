import { describe, expect, it } from "vitest";
import { DRAWIO_ORIGIN, isFrameMessage, isHostMessage } from "../../webview/hostMessage";

// VS Code's webview: the host frame (pre/index.html) and the editor frame
// share one origin, and the host posts with `contentWindow.postMessage(msg,
// window.origin)`, so host messages arrive from `window.parent` at our origin.
const ORIGIN = "vscode-webview://abc123";
function webview() {
  const parent = { name: "host" } as unknown as Window;
  const self = { origin: ORIGIN, parent } as unknown as Window & { parent: Window };
  return { self, parent };
}
const ev = (origin: string, source: unknown) => ({ origin, source }) as unknown as MessageEvent;

describe("isHostMessage", () => {
  it("accepts the VS Code host: the parent frame, at our origin", () => {
    const { self, parent } = webview();
    expect(isHostMessage(ev(ORIGIN, parent), self)).toBe(true);
  });

  it("accepts messages the page posts to itself (the harness)", () => {
    const { self } = webview();
    expect(isHostMessage(ev(ORIGIN, self), self)).toBe(true);
  });

  it("ignores a forged message from a cross-origin iframe", () => {
    const { self } = webview();
    const frame = {} as Window;
    expect(isHostMessage(ev("https://embed.diagrams.net", frame), self)).toBe(false);
    expect(isHostMessage(ev("https://lucid.app", frame), self)).toBe(false);
  });

  it("ignores a child frame even if it shares our origin", () => {
    const { self } = webview();
    expect(isHostMessage(ev(ORIGIN, {} as Window), self)).toBe(false);
  });

  it("ignores the parent's window when the origin is wrong, or no source", () => {
    const { self, parent } = webview();
    expect(isHostMessage(ev("https://evil.example", parent), self)).toBe(false);
    expect(isHostMessage(ev(ORIGIN, null), self)).toBe(false);
    expect(isHostMessage(ev("null", self), self)).toBe(false);
  });

  it("works on a real window: a sandboxed iframe can't pass as the host", () => {
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
