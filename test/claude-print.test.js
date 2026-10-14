import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "../src/harness/executors/claude-print.js";

describe("claude-print run", () => {
  // A resumed run prints one result event per segment; a Stripe trace held 32 and 4 turns and final.json said 4.
  it("adds up num_turns over every result event and keeps the last, cumulative, cost", async () => {
    const workDir = mkdtempSync(join(tmpdir(), "ar-claude-print-"));
    const bin = mkdtempSync(join(tmpdir(), "ar-fake-claude-"));
    const lines = [
      { type: "system", subtype: "init" },
      { type: "result", subtype: "success", num_turns: 32, total_cost_usd: 3.01, duration_ms: 1000 },
      { type: "assistant", message: { content: [{ type: "text", text: "continuing" }] } },
      { type: "result", subtype: "success", num_turns: 4, total_cost_usd: 3.22, duration_ms: 1200 },
    ];
    writeFileSync(join(bin, "claude"), `#!/usr/bin/env node\nfor (const l of ${JSON.stringify(lines.map((l) => JSON.stringify(l)))}) console.log(l);\n`);
    chmodSync(join(bin, "claude"), 0o755);
    const events = [];
    const out = await run({ prompt: "hi", workDir, childEnv: { PATH: `${bin}:${process.env.PATH}` }, tools: ["Read"], network: [], maxTurns: 40, model: null, redact: (s) => s, onEvent: (e) => events.push(e) });
    assert.equal(out.turns, 36);
    assert.equal(out.costUsd, 3.22);
    assert.equal(out.stoppedBecause, "success");
    assert.equal(events.filter((e) => e.kind === "result").length, 2);
  });

  it("resolves as a failed run with the spawn error when claude is not on PATH", async () => {
    const workDir = mkdtempSync(join(tmpdir(), "ar-claude-print-"));
    const emptyBin = mkdtempSync(join(tmpdir(), "ar-empty-bin-"));
    const events = [];
    const out = await run({ prompt: "hi", workDir, childEnv: { PATH: emptyBin }, tools: ["Read"], network: [], maxTurns: 1, model: null, redact: (s) => s, onEvent: (e) => events.push(e) });
    assert.equal(out.exitCode, null);
    assert.equal(out.stoppedBecause, "spawn failed: ENOENT");
    assert.match(out.stderr, /could not start claude: .*ENOENT/);
    assert.equal(events.length, 0);
    // The trace stream was closed before run() returned, so the file exists and is complete.
    assert.equal(readFileSync(join(workDir, "trace.jsonl"), "utf8"), "");
  });
});
