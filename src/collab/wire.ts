/**
 * The collaboration wire protocol between editors (peers) and the hub that
 * relays between them. A peer is one open editor; a room is one document,
 * named by its workspace-relative path. Y.js updates travel as base64 so the
 * same JSON messages work in-process and over a WebSocket.
 */

export type ToHub =
  | {
      t: "join";
      room: string;
      peer: string;
      name: string;
      /**
       * Which copy of the file this peer would write: peers sharing a store
       * (two editors on one file, or Live Share guests and their host) elect
       * a single writer so the file is not written twice.
       */
      store: string;
    }
  | { t: "leave"; room: string; peer: string }
  | { t: "update"; room: string; peer: string; data: string }
  | { t: "awareness"; room: string; peer: string; data: string };

export type FromHub =
  | {
      t: "welcome";
      room: string;
      to: string;
      /** Fill the empty shared document from your copy of the file. */
      seed: boolean;
      state: string;
      awareness: string;
    }
  | { t: "update"; room: string; to: string; data: string }
  | { t: "awareness"; room: string; to: string; data: string }
  /** Whether `to` writes the shared document to its copy of the file. */
  | { t: "writer"; room: string; to: string; writer: boolean };

/** Something the hub sends to: one window's connection, carrying any number of peers. */
export interface Connection {
  send(message: FromHub): void;
}

export const toBase64 = (data: Uint8Array): string => Buffer.from(data).toString("base64");
export const fromBase64 = (data: string): Uint8Array => new Uint8Array(Buffer.from(data, "base64"));
