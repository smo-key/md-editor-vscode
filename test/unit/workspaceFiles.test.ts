// Path logic for linking (not copying) files that are already in the workspace.
import { describe, expect, it } from "vitest";
import {
  byCloseness,
  insideFolder,
  isImageName,
  nameGlob,
  sameBytes,
  workspaceFilesMode,
} from "../../src/workspaceFiles";

describe("workspaceFilesMode", () => {
  it("links by default and copies only when asked", () => {
    expect(workspaceFilesMode(undefined)).toBe("link");
    expect(workspaceFilesMode("link")).toBe("link");
    expect(workspaceFilesMode("bogus")).toBe("link");
    expect(workspaceFilesMode("copy")).toBe("copy");
  });
});

describe("insideFolder", () => {
  it("accepts files below the folder, at any depth", () => {
    expect(insideFolder("/ws", "/ws/a.png", false)).toBe(true);
    expect(insideFolder("/ws/", "/ws/docs/img/a b.png", false)).toBe(true);
  });

  it("refuses the folder itself, siblings sharing a prefix and files outside", () => {
    expect(insideFolder("/ws", "/ws", false)).toBe(false);
    expect(insideFolder("/ws", "/ws-other/a.png", false)).toBe(false);
    expect(insideFolder("/ws", "/elsewhere/a.png", false)).toBe(false);
    expect(insideFolder("/ws", "/ws/../etc/a.png", false)).toBe(false);
  });

  it("ignores drive-letter case, and all case when asked (Windows)", () => {
    expect(insideFolder("/C:/Users/me/ws", "/c:/Users/me/ws/a.png", false)).toBe(true);
    expect(insideFolder("/c:/Users/me/WS", "/c:/users/me/ws/a.png", false)).toBe(false);
    expect(insideFolder("/c:/Users/me/WS", "/c:/users/me/ws/a.png", true)).toBe(true);
  });
});

describe("nameGlob", () => {
  it("keeps plain names and turns glob characters into single-character wildcards", () => {
    expect(nameGlob("logo.png")).toBe("logo.png");
    expect(nameGlob("Shot [1] {a,b}*?!.png")).toBe("Shot ?1? ?a?b????.png");
  });
});

describe("sameBytes", () => {
  it("compares contents", () => {
    expect(sameBytes(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 3]))).toBe(true);
    expect(sameBytes(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 4]))).toBe(false);
    expect(sameBytes(new Uint8Array([1, 2]), new Uint8Array([1, 2, 3]))).toBe(false);
  });
});

describe("byCloseness", () => {
  it("orders candidates by how short the link from the document's folder is", () => {
    expect(byCloseness("/ws/docs", ["/ws/z/deep/a.png", "/ws/docs/_Images/a.png", "/ws/a.png"])).toEqual([
      "/ws/docs/_Images/a.png",
      "/ws/a.png",
      "/ws/z/deep/a.png",
    ]);
  });
});

describe("isImageName", () => {
  it("recognizes images (draw.io ones included) by extension", () => {
    expect(isImageName("a.PNG")).toBe(true);
    expect(isImageName("flow.drawio.svg")).toBe(true);
    expect(isImageName("flow.drawio.png")).toBe(true);
    expect(isImageName("notes.pdf")).toBe(false);
    expect(isImageName("png")).toBe(false);
  });
});
