import * as esbuild from "esbuild";
import { rmSync } from "fs";

const production = process.argv.includes("--production");
const watch = process.argv.includes("--watch");

// Stale chunks and source maps from dev builds must not end up in a package.
rmSync("dist", { recursive: true, force: true });

const shared = {
  bundle: true,
  minify: production,
  sourcemap: !production,
  logLevel: "info",
};

const contexts = await Promise.all([
  esbuild.context({
    ...shared,
    entryPoints: ["src/extension.ts"],
    outfile: "dist/extension.js",
    platform: "node",
    format: "cjs",
    target: "node18",
    external: ["vscode", "bufferutil", "utf-8-validate"],
  }),
  esbuild.context({
    ...shared,
    entryPoints: { main: "webview/main.ts" },
    outdir: "dist/webview",
    platform: "browser",
    format: "esm",
    target: "chrome114",
    // Mermaid is split out and only loaded for the first ```mermaid block.
    splitting: true,
    chunkNames: "chunks/[name]-[hash]",
    loader: { ".woff": "file", ".woff2": "file", ".ttf": "file", ".svg": "dataurl" },
    assetNames: "assets/[name]-[hash]",
  }),
]);

if (watch) {
  await Promise.all(contexts.map((c) => c.watch()));
} else {
  await Promise.all(contexts.map((c) => c.rebuild()));
  await Promise.all(contexts.map((c) => c.dispose()));
}
