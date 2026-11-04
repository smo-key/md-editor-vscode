import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "happy-dom",
    include: ["test/unit/**/*.test.ts"],
    // Milkdown's timers (@milkdown/ctx) leave a 3 s timeout behind even once resolved; when a
    // test file ends sooner it fires after happy-dom is torn down, without `removeEventListener`.
    // That is harmless (the editor is gone), so it must not fail the run; nothing else is ignored.
    onUnhandledError(error) {
      return !(error.name === "ReferenceError" && /removeEventListener is not defined/.test(error.message) && /@milkdown\/ctx/.test(error.stack ?? ""));
    },
  },
});
