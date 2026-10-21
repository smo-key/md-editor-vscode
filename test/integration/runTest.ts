import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { runTests } from "@vscode/test-electron";

async function main() {
  const root = path.resolve(__dirname, "../../..");
  // A scratch workspace so the tests never touch the fixtures in the repo.
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "ken-md-test-"));
  fs.cpSync(path.join(root, "test/fixtures"), workspace, { recursive: true });
  try {
    await runTests({
      extensionDevelopmentPath: root,
      extensionTestsPath: path.join(__dirname, "suite", "index.js"),
      launchArgs: [workspace, "--disable-extensions", "--skip-welcome", "--skip-release-notes"],
      version: process.env.VSCODE_TEST_VERSION ?? "stable",
    });
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
