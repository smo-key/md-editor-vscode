/**
 * Collaboration sessions in VS Code: hosting a hub (in this window, reachable
 * over a WebSocket on this machine, through Live Share's server sharing, or on
 * the network) or joining someone else's, and the endpoint editors use to talk
 * to it. No server of our own: whoever starts the session runs the hub.
 */
import * as vscode from "vscode";
import * as http from "http";
import * as os from "os";
import { randomBytes } from "crypto";
import { WebSocket, WebSocketServer } from "ws";
import { Hub } from "./hub";
import type { Connection, FromHub, ToHub } from "./wire";

/** How editors reach the hub, wherever it runs. */
export interface Endpoint {
  send(message: ToHub): void;
  readonly onMessage: vscode.Event<FromHub>;
}

/** Editors in the window running the hub talk to it directly. */
class LocalEndpoint implements Endpoint {
  private readonly emitter = new vscode.EventEmitter<FromHub>();
  readonly onMessage = this.emitter.event;
  private readonly conn: Connection = { send: (m) => this.emitter.fire(m) };
  constructor(
    private readonly hub: Hub,
    private readonly onActivity: () => void,
  ) {
    hub.attach(this.conn, true);
  }
  send(message: ToHub) {
    this.hub.receive(this.conn, message);
    if (message.t === "join" || message.t === "leave") this.onActivity();
  }
  dispose() {
    this.hub.detach(this.conn);
    this.emitter.dispose();
  }
}

/** Editors in another window (or machine) reach the hub over a WebSocket. */
class SocketEndpoint implements Endpoint {
  private readonly emitter = new vscode.EventEmitter<FromHub>();
  readonly onMessage = this.emitter.event;
  private readonly closed = new vscode.EventEmitter<string | undefined>();
  readonly onClose = this.closed.event;
  private readonly queue: string[] = [];
  private disposed = false;

  constructor(private readonly socket: WebSocket) {
    socket.on("message", (data) => {
      try {
        this.emitter.fire(JSON.parse(String(data)) as FromHub);
      } catch {
        // Not ours.
      }
    });
    socket.on("open", () => {
      for (const m of this.queue.splice(0)) socket.send(m);
    });
    socket.on("close", (_code, reason) => {
      if (!this.disposed) this.closed.fire(String(reason) || undefined);
    });
    socket.on("error", (err) => {
      if (!this.disposed) this.closed.fire(err.message);
    });
  }

  /** Resolves once connected; rejects if the connection fails. */
  opened(): Promise<void> {
    if (this.socket.readyState === WebSocket.OPEN) return Promise.resolve();
    return new Promise((resolve, reject) => {
      this.socket.once("open", () => resolve());
      this.socket.once("error", (err) => reject(err));
      this.socket.once("close", (_code, reason) => reject(new Error(String(reason) || "connection closed")));
    });
  }

  send(message: ToHub) {
    const text = JSON.stringify(message);
    if (this.socket.readyState === WebSocket.OPEN) this.socket.send(text);
    else this.queue.push(text);
  }

  dispose() {
    this.disposed = true;
    this.socket.close();
    this.emitter.dispose();
    this.closed.dispose();
  }
}

interface Hosting {
  hub: Hub;
  server: http.Server;
  wss: WebSocketServer;
  local: LocalEndpoint;
  port: number;
  token: string;
  network: boolean;
  liveShare?: vscode.Disposable;
}

const LIVE_SHARE_ID = "ms-vsliveshare.vsliveshare";

/** What a peer is: its id within the session and which copy of the file it writes. */
export class CollabManager implements vscode.Disposable {
  private hosting: Hosting | undefined;
  private joined: { endpoint: SocketEndpoint; url: string } | undefined;
  private readonly changed = new vscode.EventEmitter<void>();
  /** The session started, ended, or changed hands. */
  readonly onDidChange = this.changed.event;
  private readonly status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);

  constructor() {
    this.status.command = "kenMarkdown.collaboration.menu";
    this.render();
  }

  /** How editors reach the session's hub, if there is a session. */
  get endpoint(): Endpoint | undefined {
    return this.hosting?.local ?? this.joined?.endpoint;
  }

  get role(): "host" | "guest" | undefined {
    return this.hosting ? "host" : this.joined ? "guest" : undefined;
  }

  /**
   * Which copy of a document an editor writes: the host's files (its own
   * editors, and Live Share guests editing them over `vsls:`) are one copy;
   * every other machine's checkout is its own.
   */
  storeFor(uri: vscode.Uri): string {
    if (uri.scheme === "vsls" || this.hosting) return "host";
    return `${vscode.env.machineId}:${uri.toString()}`;
  }

  /** The address guests join with. */
  invite(): string | undefined {
    const h = this.hosting;
    if (!h) return undefined;
    const host = h.network ? (lanAddress() ?? "localhost") : "localhost";
    return `ws://${host}:${h.port}/?token=${h.token}`;
  }

  async start(): Promise<void> {
    if (this.hosting) {
      await this.showInvite();
      return;
    }
    if (this.joined) this.leave(false);
    const config = vscode.workspace.getConfiguration("kenMarkdown.collaboration");
    const network = config.get<boolean>("allowNetwork", false);
    const wantPort = config.get<number>("port", 0);
    const token = randomBytes(12).toString("base64url");
    const hub = new Hub();
    const server = http.createServer((_req, res) => {
      res.writeHead(426, { "content-type": "text/plain" });
      res.end("Ken Markdown collaboration: open with Ken Markdown: Join Collaboration Session.\n");
    });
    const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 * 1024 });
    server.on("upgrade", (req, socket, head) => {
      const url = new URL(req.url ?? "/", "ws://localhost");
      if (url.searchParams.get("token") !== token) {
        socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
        socket.destroy();
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws) => {
        const conn: Connection = {
          send: (m) => {
            if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(m));
          },
        };
        hub.attach(conn, false);
        ws.on("message", (data) => {
          let m: ToHub;
          try {
            m = JSON.parse(String(data)) as ToHub;
          } catch {
            return;
          }
          try {
            hub.receive(conn, m);
          } catch {
            return;
          }
          if (m.t === "join" || m.t === "leave") this.render();
        });
        ws.on("close", () => {
          hub.detach(conn);
          this.render();
        });
      });
    });
    const port = await new Promise<number>((resolve, reject) => {
      server.once("error", reject);
      server.listen(wantPort, network ? "0.0.0.0" : "127.0.0.1", () => {
        const addr = server.address();
        resolve(typeof addr === "object" && addr ? addr.port : wantPort);
      });
    });
    const local = new LocalEndpoint(hub, () => this.render());
    this.hosting = { hub, server, wss, local, port, token, network };
    this.hosting.liveShare = await shareOverLiveShare(port);
    this.render();
    this.changed.fire();
    await this.showInvite();
  }

  async join(address?: string): Promise<void> {
    const url =
      address ??
      (await vscode.window.showInputBox({
        title: "Join a collaboration session",
        prompt: "The invite from whoever started the session (ws://…/?token=…)",
        placeHolder: "ws://localhost:PORT/?token=…",
        ignoreFocusOut: true,
        validateInput: (v) => (/^wss?:\/\/[^\s]+$/.test(v.trim()) ? undefined : "An invite starts with ws://"),
      }));
    if (!url) return;
    if (this.hosting) this.stopHosting();
    if (this.joined) this.leave(false);
    const endpoint = new SocketEndpoint(new WebSocket(url.trim()));
    try {
      await endpoint.opened();
    } catch (err) {
      endpoint.dispose();
      void vscode.window.showErrorMessage(`Could not join the collaboration session: ${(err as Error).message}`);
      return;
    }
    endpoint.onClose((reason) => {
      if (this.joined?.endpoint !== endpoint) return;
      this.joined = undefined;
      this.render();
      this.changed.fire();
      void vscode.window.showWarningMessage(
        `The collaboration session ended${reason ? ` (${reason})` : ""}. Your edits are kept in your editor.`,
      );
    });
    this.joined = { endpoint, url: url.trim() };
    this.render();
    this.changed.fire();
    void vscode.window.showInformationMessage("Joined the collaboration session: Markdown files open in Ken Markdown are shared live.");
  }

  /** End the session (host) or leave it (guest). */
  leave(notify = true): void {
    if (this.hosting) this.stopHosting();
    if (this.joined) {
      const { endpoint } = this.joined;
      this.joined = undefined;
      endpoint.dispose();
    }
    this.render();
    this.changed.fire();
    if (notify) void vscode.window.showInformationMessage("Left the collaboration session.");
  }

  async menu(): Promise<void> {
    type Item = vscode.QuickPickItem & { run: () => unknown };
    const items: Item[] = [];
    if (this.hosting) {
      items.push({ label: "$(copy) Copy invite", description: this.invite(), run: () => this.copyInvite() });
      items.push({ label: "$(debug-stop) End session", run: () => this.leave() });
    } else if (this.joined) {
      items.push({ label: "$(debug-disconnect) Leave session", description: this.joined.url, run: () => this.leave() });
    } else {
      items.push({ label: "$(broadcast) Start a session", run: () => this.start() });
      items.push({ label: "$(plug) Join a session…", run: () => this.join() });
    }
    const pick = await vscode.window.showQuickPick(items, { title: "Ken Markdown collaboration" });
    await pick?.run();
  }

  async copyInvite(): Promise<void> {
    const invite = this.invite();
    if (!invite) return;
    await vscode.env.clipboard.writeText(invite);
    void vscode.window.showInformationMessage("Invite copied. Guests run “Ken Markdown: Join Collaboration Session” and paste it.");
  }

  /** Test hook: hub state. */
  stats() {
    return { role: this.role, invite: this.invite(), rooms: this.hosting?.hub.stats() ?? [] };
  }

  private async showInvite() {
    const invite = this.invite()!;
    await vscode.env.clipboard.writeText(invite);
    const how = this.hosting?.liveShare
      ? "Shared with your Live Share guests."
      : this.hosting?.network
        ? "Reachable on your network."
        : "Reachable from this machine; share the port with Live Share (or enable kenMarkdown.collaboration.allowNetwork) for others.";
    void vscode.window
      .showInformationMessage(`Collaboration session started; invite copied to the clipboard. ${how}`, "Copy invite")
      .then((choice) => choice && this.copyInvite());
  }

  private stopHosting() {
    const h = this.hosting;
    if (!h) return;
    this.hosting = undefined;
    h.liveShare?.dispose();
    for (const client of h.wss.clients) client.close(1001, "the host ended the session");
    h.wss.close();
    h.server.close();
    h.local.dispose();
  }

  private render() {
    if (this.hosting) {
      const n = this.hosting.hub.peerCount;
      this.status.text = `$(broadcast) Collaborating${n ? ` · ${n}` : ""}`;
      this.status.tooltip = `Hosting a Markdown collaboration session (${n} editor${n === 1 ? "" : "s"} open). Click for options.`;
      this.status.show();
    } else if (this.joined) {
      this.status.text = "$(broadcast) Collaborating";
      this.status.tooltip = `Joined ${this.joined.url.replace(/token=[^&]+/, "token=…")}. Click for options.`;
      this.status.show();
    } else {
      this.status.hide();
    }
  }

  dispose() {
    this.leave(false);
    this.status.dispose();
    this.changed.dispose();
  }
}

/** Forward the hub's port to Live Share guests, when hosting a Live Share session. */
async function shareOverLiveShare(port: number): Promise<vscode.Disposable | undefined> {
  const ext = vscode.extensions.getExtension(LIVE_SHARE_ID);
  if (!ext) return undefined;
  try {
    const exports = ext.isActive ? ext.exports : await ext.activate();
    const api = await exports?.getApi?.("1.0.4753", "ArthurPachachura.ken-markdown-editor");
    // Role 1 is Host in vsls.Role.
    if (!api?.session || api.session.role !== 1) return undefined;
    return await api.shareServer({ port, displayName: "Ken Markdown collaboration" });
  } catch {
    return undefined;
  }
}

function lanAddress(): string | undefined {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list ?? []) if (a.family === "IPv4" && !a.internal) return a.address;
  }
  return undefined;
}
