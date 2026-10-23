import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { localJourney, localTestRuns, runsFromVerify } from "../src/verify/journey.js";
import { makeStyle, renderStrip } from "../src/audit/render.js";

const verdict = (v, reason = "because") => ({ verdict: v, reason, basedOn: ["obs_1"], rule: "r", method: "rule" });
const doc = {
  schema: "agent-ready/interface@1", target: { url: "https://example.com/", host: "example.com" },
  observations: [{ id: "obs_1", role: "homepage", ok: true, status: 200 }],
  machineAccess: { aiCrawlersAllowed: verdict("yes"), hasAgentReadableIndex: verdict("yes", "/llms.txt with 3 links") },
  pricing: { agentCanDetermineCost: verdict("yes", "2 plans"), ambiguities: [], plans: [{ id: "pro", amount: 20, evidence: [{ obs: "obs_1" }] }] },
  onboarding: { patterns: [] },
  authentication: { methods: [{ value: { type: "apiKey" } }], requirement: { value: "required", basedOn: [] } },
  capabilities: [{ name: "Create project", evidence: [{ obs: "obs_1" }] }],
  interfaces: { api: { exists: verdict("yes"), machineReadableSpec: verdict("yes") } },
};

async function workspace(t, runs) {
  const cwd = await mkdtemp(join(tmpdir(), "agent-ready-journey-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const host = join(cwd, ".alg", "example.com");
  await mkdir(join(host, "2026-10-01T10-00-00-check1"), { recursive: true });
  await writeFile(join(host, "2026-10-01T10-00-00-check1", "interface.json"), JSON.stringify(doc));
  for (const [folder, summary] of runs) {
    await mkdir(join(host, folder), { recursive: true });
    await writeFile(join(host, folder, "verify.json"), JSON.stringify(summary));
  }
  return cwd;
}
const step = (f, id) => f.steps.find((s) => s.id === id);

test("a passed test proves Sign up and Access; a failed one stops at the step the checker named", () => {
  assert.deepEqual(runsFromVerify({ runId: "a", outcome: "passed" }, "t").map((r) => [r.step, r.outcome]), [["signup", "passed"], ["access", "passed"]]);
  assert.deepEqual(runsFromVerify({ runId: "b", outcome: "handoff" }, "t").map((r) => [r.step, r.outcome]), [["signup", "handoff"], ["access", "passed"]]);
  assert.deepEqual(runsFromVerify({ runId: "c", outcome: "failed", step: "access" }, "t").map((r) => [r.step, r.outcome]), [["access", "blocked"]]);
  assert.deepEqual(runsFromVerify({ runId: "d", outcome: "failed" }, "t").map((r) => r.step), ["signup"], "a verify.json from before 0.4.16 has no step");
  assert.deepEqual(runsFromVerify({ runId: "e", outcome: "inconclusive" }, "t").map((r) => [r.step, r.outcome]), [["signup", "inconclusive"]]);
});

test("the local journey is the newest check with every test on this machine applied, latest first", async (t) => {
  const cwd = await workspace(t, [
    ["2026-10-02T09-00-00-run1", { runId: "run1", outcome: "failed", step: "access", reason: "The key was refused." }],
    ["2026-10-03T09-00-00-run2", { runId: "run2", outcome: "passed", reason: "Got a key that works." }],
  ]);
  assert.equal(localTestRuns(cwd, "https://example.com/").length, 3);
  const f = localJourney(cwd, "https://example.com/");
  assert.equal(step(f, "signup").state, "agent_did");
  assert.equal(step(f, "access").state, "agent_did", "the later pass outranks the earlier failure");
  assert.deepEqual(step(f, "access").evidence.map((e) => e.outcome), ["passed", "blocked"]);
  assert.equal(step(f, "access").evidence[1].at, "2026-10-02T09:00:00Z", "the folder name gives the time when verify.json has none");
  assert.equal(f.verified, 2);
});

test("no check on this machine, no journey", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "agent-ready-journey-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  assert.equal(localJourney(cwd, "https://example.com/"), null);
});

test("the strip prints seven marks within 80 columns, the proved steps, and where it stops", async (t) => {
  const cwd = await workspace(t, [["2026-10-02T09-00-00-run1", { runId: "run1", outcome: "failed", step: "access", reason: "The key was refused." }]]);
  const lines = renderStrip(localJourney(cwd, "https://example.com/"), makeStyle(false), { stoppedAt: "access" });
  assert.equal(lines[1], "  Your product, seven steps");
  const marks = lines.slice(2).join("  ");
  for (const name of ["Discover", "Understand", "Sign up", "Access", "Use", "Pay", "Manage"]) assert.match(marks, new RegExp(`[✓✗·] ${name}`));
  assert.match(marks, /✗ Access/);
  assert.ok(lines.every((l) => l.length <= 80), lines.find((l) => l.length > 80));
  assert.match(lines.join("\n"), /Stops at Access: blocked\. The agent was stopped here: The key was refused\./);
  assert.doesNotMatch(lines.join("\n"), /A test proved/, "a failed test proves nothing");
  const passed = await workspace(t, [["2026-10-03T09-00-00-run2", { runId: "run2", outcome: "passed", reason: "ok" }]]);
  assert.match(renderStrip(localJourney(passed, "https://example.com/"), makeStyle(false)).join("\n"), /A test proved: Sign up, Access\./);
});
