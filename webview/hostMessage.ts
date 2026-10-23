// Who may talk to the webview through `window` `message` events.
//
// VS Code runs the editor page in an iframe inside its own host frame
// (workbench/contrib/webview/browser/pre/index.html). Both share one origin
// (`vscode-webview://<id>`, or `https://<id>.vscode-cdn.net` on the web), and
// the host delivers every extension message with
// `frame.contentWindow.postMessage(message, window.origin)`. So `event.source`
// is the host frame's window and `event.origin` is our own origin.
//
// We can't compare `event.source` with `window.parent`: since VS Code 1.143
// the script VS Code injects before ours runs `window.parent = window;
// window.top = window; window.frameElement = null`, hiding the host frame.
// The origin is therefore the boundary. Embedded third-party pages (draw.io,
// Lucid previews) are child frames that always post with their own origin,
// and any child frame, or a frame nested in one, is refused outright.

/** The draw.io embed's origin (see drawio.ts `EDITOR`). */
export const DRAWIO_ORIGIN = "https://embed.diagrams.net";

type Source = Pick<MessageEvent, "origin" | "source">;
type Win = Pick<Window, "origin" | "frames" | "length">;

/**
 * True for messages from the VS Code host: any window but our own frames,
 * at our own origin. Messages the page posts to itself are accepted too; the
 * Playwright harness stands in for the host that way.
 */
export function isHostMessage(event: Source, win: Win & Partial<Pick<Window, "document">>): boolean {
  if (event.origin !== win.origin || event.origin === "null") return false;
  if (event.source == null) return false;
  return !isOwnFrame(event.source, win);
}

/** True when `source` is one of `win`'s frames, at any depth, or an iframe element's window in its document. */
function isOwnFrame(source: MessageEventSource, win: Win & Partial<Pick<Window, "document">>): boolean {
  const seen = new Set<unknown>();
  const walk = (w: Win, depth: number): boolean => {
    if (depth > 8) return false;
    let n = 0;
    try {
      n = w.length;
    } catch {
      return false;
    }
    for (let i = 0; i < n; i++) {
      let child: Win | undefined;
      try {
        child = (w.frames as unknown as ArrayLike<Win>)[i];
      } catch {
        continue;
      }
      if (!child || seen.has(child)) continue;
      seen.add(child);
      if (child === (source as unknown)) return true;
      if (walk(child, depth + 1)) return true;
    }
    return false;
  };
  if (walk(win, 0)) return true;
  for (const el of win.document?.querySelectorAll("iframe, frame, object, embed") ?? []) {
    const cw = (el as HTMLIFrameElement).contentWindow;
    if (cw && cw === (source as unknown)) return true;
    if (cw && walk(cw, 1)) return true;
  }
  return false;
}

/** True for messages from one embedded frame: its own window, at its expected origin. */
export function isFrameMessage(event: Source, frame: Window | null | undefined, origin: string): boolean {
  return frame != null && event.source === frame && event.origin === origin;
}
