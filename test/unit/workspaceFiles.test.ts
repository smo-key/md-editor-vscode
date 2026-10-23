// Path logic for linking (not copying) files that are already in the workspace.
import { describe, expect, it } from "vitest";
import {
  byCloseness,
  COPY_LIMIT,
  excludeGlob,
  expandBraces,
  mayCopyScheme,
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

describe("byCloseness ties", () => {
  it("breaks ties by path, so the order never depends on search order", () => {
    expect(byCloseness("/ws", ["/ws/public/logo.png", "/ws/dist/logo.png"])).toEqual(["/ws/dist/logo.png", "/ws/public/logo.png"]);
    expect(byCloseness("/ws", ["/ws/dist/logo.png", "/ws/public/logo.png"])).toEqual(["/ws/dist/logo.png", "/ws/public/logo.png"]);
  });

  it("puts files below the document before closer-looking ones above it", () => {
    expect(byCloseness("/ws/docs", ["/ws/logo.png", "/ws/docs/a/b/c/logo.png"])).toEqual(["/ws/docs/a/b/c/logo.png", "/ws/logo.png"]);
  });
});

describe("expandBraces", () => {
  it("expands brace alternatives, nested ones too", () => {
    expect(expandBraces("**/*.js")).toEqual(["**/*.js"]);
    expect(expandBraces("**/*.{js,map}")).toEqual(["**/*.js", "**/*.map"]);
    expect(expandBraces("{a,b{c,d}}/x")).toEqual(["a/x", "bc/x", "bd/x"]);
  });
});

describe("excludeGlob", () => {
  it("always excludes node_modules, and joins the enabled patterns of each setting", () => {
    expect(excludeGlob()).toBe("{**/node_modules,**/node_modules/**}");
    const glob = excludeGlob(
      { "**/.git": true, "**/off": false, "**/*.{js,map}": true, "**/when": { when: "$(basename).ts" } },
      { "**/node_modules": true, "out/": true },
    );
    expect(glob).toBe(
      "{**/node_modules,**/node_modules/**,**/.git,**/.git/**,**/*.js,**/*.js/**,**/*.map,**/*.map/**,out,out/**}",
    );
  });

  it("skips patterns a brace list cannot hold", () => {
    expect(excludeGlob({ "a,b": true, "": true })).toBe("{**/node_modules,**/node_modules/**}");
  });
});

describe("mayCopyScheme", () => {
  it("copies local files and files on the document's own (remote) file system only", () => {
    expect(mayCopyScheme({ scheme: "file", authority: "" }, { scheme: "file", authority: "" })).toBe(true);
    expect(mayCopyScheme({ scheme: "file", authority: "" }, { scheme: "vscode-remote", authority: "ssh+box" })).toBe(true);
    expect(mayCopyScheme({ scheme: "vscode-remote", authority: "ssh+box" }, { scheme: "vscode-remote", authority: "ssh+box" })).toBe(true);
    expect(mayCopyScheme({ scheme: "vscode-remote", authority: "other" }, { scheme: "vscode-remote", authority: "ssh+box" })).toBe(false);
    expect(mayCopyScheme({ scheme: "vscode-userdata", authority: "" }, { scheme: "file", authority: "" })).toBe(false);
    expect(mayCopyScheme({ scheme: "vscode-userdata", authority: "" }, { scheme: "vscode-userdata", authority: "" })).toBe(false);
    expect(mayCopyScheme({ scheme: "untitled", authority: "" }, { scheme: "untitled", authority: "" })).toBe(false);
  });

  it("has a copy limit of 50 MB", () => {
    expect(COPY_LIMIT).toBe(50 * 1024 * 1024);
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
