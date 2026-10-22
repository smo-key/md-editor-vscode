/**
 * The collaboration hub: one per session, run by whoever starts it. It keeps
 * each room's shared Y.js document (so late joiners get the current state),
 * relays document and presence (awareness) updates between peers, picks the
 * one peer that fills an empty room from its file, and elects one writer per
 * copy of the file. Pure logic, no VS Code: the transports live elsewhere.
 */
import * as Y from "yjs";
import {
  Awareness,
  applyAwarenessUpdate,
  encodeAwarenessUpdate,
  removeAwarenessStates,
} from "y-protocols/awareness";
import { fromBase64, toBase64, type Connection, type FromHub, type ToHub } from "./wire";

interface Peer {
  id: string;
  name: string;
  store: string;
  conn: Connection;
  /** Join order, for electing writers. */
  order: number;
  /** Awareness client ids this peer has announced. */
  clients: Set<number>;
  /** Has the document (welcomed); only those can write. */
  welcomed: boolean;
  writer: boolean;
}

class Room {
  readonly doc = new Y.Doc();
  readonly awareness = new Awareness(this.doc);
  readonly peers = new Map<string, Peer>();
  /** Someone has filled the shared document. */
  seeded = false;
  /** The peer asked to fill it, while it is still empty. */
  seeder: string | null = null;
  /** Joined while the room was being filled: welcomed once it is. */
  waiting: string[] = [];

  constructor(readonly name: string) {
    // The hub is not a participant.
    this.awareness.setLocalState(null);
    this.awareness.on("update", ({ added, updated }: { added: number[]; updated: number[] }, origin: unknown) => {
      const peer = typeof origin === "string" ? this.peers.get(origin) : undefined;
      if (!peer) return;
      for (const id of [...added, ...updated]) peer.clients.add(id);
    });
  }

  destroy() {
    this.awareness.destroy();
    this.doc.destroy();
  }
}

export class Hub {
  private readonly rooms = new Map<string, Room>();
  private readonly local = new WeakSet<Connection>();
  private order = 0;

  /**
   * Register a connection; `local` ones are on the hub's own machine and are
   * preferred as writers (they hold the real file, e.g. the Live Share host).
   */
  attach(conn: Connection, local = false) {
    if (local) this.local.add(conn);
  }

  /** A connection went away: all of its peers leave. */
  detach(conn: Connection) {
    for (const room of [...this.rooms.values()]) {
      for (const peer of [...room.peers.values()]) if (peer.conn === conn) this.leave(room, peer.id);
    }
  }

  receive(conn: Connection, m: ToHub) {
    if (m.t === "join") return this.join(conn, m);
    const room = this.rooms.get(m.room);
    const peer = room?.peers.get(m.peer);
    if (!room || !peer || peer.conn !== conn) return;
    switch (m.t) {
      case "leave":
        this.leave(room, m.peer);
        return;
      case "update": {
        const data = fromBase64(m.data);
        Y.applyUpdate(room.doc, data, m.peer);
        this.broadcast(room, m.peer, (to) => ({ t: "update", room: room.name, to, data: m.data }));
        if (!room.seeded && room.seeder === m.peer) {
          room.seeded = true;
          room.seeder = null;
          peer.welcomed = true;
          for (const id of room.waiting.splice(0)) this.welcome(room, id, false);
          this.elect(room);
        }
        return;
      }
      case "awareness":
        applyAwarenessUpdate(room.awareness, fromBase64(m.data), m.peer);
        this.broadcast(room, m.peer, (to) => ({ t: "awareness", room: room.name, to, data: m.data }));
        return;
    }
  }

  /** Rooms and their peer counts (status display, tests). */
  stats(): { room: string; peers: number }[] {
    return [...this.rooms.values()].map((r) => ({ room: r.name, peers: r.peers.size }));
  }

  /** Total distinct peers across rooms. */
  get peerCount(): number {
    return [...this.rooms.values()].reduce((n, r) => n + r.peers.size, 0);
  }

  private join(conn: Connection, m: Extract<ToHub, { t: "join" }>) {
    let room = this.rooms.get(m.room);
    if (!room) {
      room = new Room(m.room);
      this.rooms.set(m.room, room);
    }
    if (room.peers.has(m.peer)) return;
    room.peers.set(m.peer, {
      id: m.peer,
      name: m.name,
      store: m.store,
      conn,
      order: ++this.order,
      clients: new Set(),
      welcomed: false,
      writer: false,
    });
    if (room.seeded) {
      this.welcome(room, m.peer, false);
      this.elect(room);
    } else if (room.seeder === null) {
      room.seeder = m.peer;
      this.welcome(room, m.peer, true);
    } else {
      room.waiting.push(m.peer);
    }
  }

  private welcome(room: Room, id: string, seed: boolean) {
    const peer = room.peers.get(id);
    if (!peer) return;
    if (!seed) peer.welcomed = true;
    const clients = [...room.awareness.getStates().keys()];
    peer.conn.send({
      t: "welcome",
      room: room.name,
      to: id,
      seed,
      state: toBase64(Y.encodeStateAsUpdate(room.doc)),
      awareness: toBase64(encodeAwarenessUpdate(room.awareness, clients)),
    });
  }

  private leave(room: Room, id: string) {
    const peer = room.peers.get(id);
    if (!peer) return;
    room.peers.delete(id);
    room.waiting = room.waiting.filter((w) => w !== id);
    // Its cursors disappear for everyone else.
    const gone = [...peer.clients].filter((c) => room.awareness.getStates().has(c));
    if (gone.length) {
      removeAwarenessStates(room.awareness, gone, "hub");
      const data = toBase64(encodeAwarenessUpdate(room.awareness, gone));
      this.broadcast(room, id, (to) => ({ t: "awareness", room: room.name, to, data }));
    }
    if (room.peers.size === 0) {
      room.destroy();
      this.rooms.delete(room.name);
      return;
    }
    if (room.seeder === id) {
      // Left before filling the room: the next in line fills it instead.
      room.seeder = room.waiting.shift() ?? null;
      if (room.seeder) this.welcome(room, room.seeder, true);
    }
    this.elect(room);
  }

  /** One writer per store: the earliest local peer, else the earliest. */
  private elect(room: Room) {
    const byStore = new Map<string, Peer[]>();
    for (const p of room.peers.values()) {
      if (!p.welcomed) continue;
      const list = byStore.get(p.store) ?? [];
      list.push(p);
      byStore.set(p.store, list);
    }
    const writers = new Set<string>();
    for (const list of byStore.values()) {
      list.sort((a, b) => Number(this.local.has(b.conn)) - Number(this.local.has(a.conn)) || a.order - b.order);
      writers.add(list[0]!.id);
    }
    for (const p of room.peers.values()) {
      if (!p.welcomed) continue;
      const writer = writers.has(p.id);
      if (writer === p.writer) continue;
      p.writer = writer;
      p.conn.send({ t: "writer", room: room.name, to: p.id, writer });
    }
  }

  private broadcast(room: Room, from: string, build: (to: string) => FromHub) {
    for (const p of room.peers.values()) {
      // Peers still waiting for the document get it whole when welcomed.
      if (p.id === from || (!p.welcomed && room.seeder !== p.id)) continue;
      p.conn.send(build(p.id));
    }
  }
}
