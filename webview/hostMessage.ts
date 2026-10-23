// Who may talk to the webview through `window` `message` events.
//
// VS Code runs the editor page in an iframe inside its own host frame
// (workbench/contrib/webview/browser/pre/index.html). Both frames share one
// origin (`vscode-webview://<id>`, or `https://<id>.vscode-cdn.net` on the
// web), and the host delivers every extension message with
// `contentWindow.postMessage(message, window.origin)`. So a host message
// arrives with `source === window.parent` and `origin === window.origin`.
//
// Embedded third-party pages (draw.io today, Lucid previews) are child frames
// with their own origin: they must never reach the host-message handler, or
// one could post `{type: "update"}` and replace the document.

/** The draw.io embed's origin (see drawio.ts `EDITOR`). */
export const DRAWIO_ORIGIN = "https://embed.diagrams.net";

type Source = Pick<MessageEvent, "origin" | "source">;

/**
 * True for messages from the VS Code host: the parent frame, at our own
 * origin. Messages the page posts to itself (`source === window`) are also
 * accepted; the Playwright harness stands in for the host that way. Only
 * script running in this page can produce that source, and a child frame's
 * messages always carry its own window as `source`, so neither path can be
 * spoofed by an embedded page.
 */
export function isHostMessage(event: Source, win: Pick<Window, "origin" | "parent">): boolean {
  if (event.origin !== win.origin || event.origin === "null") return false;
  return event.source != null && (event.source === win.parent || event.source === (win as unknown));
}

/** True for messages from one embedded frame: its own window, at its expected origin. */
export function isFrameMessage(event: Source, frame: Window | null | undefined, origin: string): boolean {
  return frame != null && event.source === frame && event.origin === origin;
}
