import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const read = (path) => JSON.parse(readFileSync(new URL(`../${path}`, import.meta.url), "utf8"));

// Claude Code installs the plugin by its own version, so it must move with the package.
test("the Claude Code plugin's version matches the package's", () => {
  assert.equal(read(".claude-plugin/plugin.json").version, read("package.json").version);
});

test("the test skill runs only when the user asks for it", () => {
  const skill = readFileSync(new URL("../skills/agent-ready-test/SKILL.md", import.meta.url), "utf8");
  assert.match(skill, /^disable-model-invocation: true$/m);
});

// iCloud Desktop sync leaves "<name> 2.<ext>" copies in the tree; 0.4.11 and 0.4.12 shipped src/report/format 2.js.
// The built package carries this test file but not the build script, so there it has nothing to check.
test("the built package carries no iCloud sync duplicate", { skip: !existsSync(new URL("../scripts/build-cli-package.mjs", import.meta.url)) }, () => {
  const root = fileURLToPath(new URL("..", import.meta.url));
  execFileSync(process.execPath, ["scripts/build-cli-package.mjs"], { cwd: root, stdio: "pipe" });
  const files = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(join(dir, e.name)) : [join(dir, e.name)]));
  const duplicates = files(join(root, "dist", "cli")).filter((f) => / \d+\.[^./]+$/.test(f));
  assert.deepEqual(duplicates, []);
});
