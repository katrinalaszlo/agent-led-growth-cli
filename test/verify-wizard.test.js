import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { askVerifyCall, DEFAULT_HEADER } from "../src/verify/wizard.js";
import { buildVerifyTask, classify, describeSpec, networkFor } from "../src/verify/index.js";
import { renderPlan } from "../src/verify/render.js";
import { makeStyle } from "../src/audit/render.js";

const CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "bin", "cli.js");

// A scripted terminal: each ask() takes the next line; everything said is kept.
function terminal(lines) {
  const said = [];
  const queue = [...lines];
  return { ask: async () => queue.shift() ?? "", say: (l) => said.push(l), said };
}

describe("verify: wizard (no OpenAPI document)", () => {
  it("Enter with nothing skips verification", async () => {
    const t = terminal([""]);
    const r = await askVerifyCall({ ...t, url: "https://acme.dev", reason: "no OpenAPI document found" });
    assert.deepEqual(r, { skip: true });
    assert.match(t.said.join("\n"), /We couldn't find an OpenAPI spec to figure out how to test your API key/);
    assert.match(t.said.join("\n"), /GET https:\/\/api\.example\.com\/v1\/me/);
    assert.match(t.said.join("\n"), /Press Enter with nothing to skip verification/);
  });

  it("a bad call is explained and asked again; a bare URL becomes a GET; the header defaults", async () => {
    const t = terminal(["PUT https://api.acme.dev/me", "not a url", "https://api.acme.dev/v1/me", ""]);
    const r = await askVerifyCall({ ...t, url: "https://acme.dev", reason: null });
    assert.equal(r.call, "GET https://api.acme.dev/v1/me");
    assert.equal(r.header, DEFAULT_HEADER);
    assert.equal(r.apiHost, "api.acme.dev");
    assert.equal(r.offSite, false);
    assert.equal(t.said.filter((l) => /must be "GET <full URL>" or "POST <full URL>"/.test(l)).length, 2);
  });

  it("a custom header is validated; an off-site API host is flagged", async () => {
    const t = terminal(["GET https://api.other.example/v1/me", "X-Api-Key", "X-Api-Key: {key}"]);
    const r = await askVerifyCall({ ...t, url: "https://acme.dev", reason: null });
    assert.equal(r.header, "X-Api-Key: {key}");
    assert.equal(r.offSite, true);
    assert.ok(t.said.some((l) => /verify_header must look like/.test(l)));
  });
});

describe("verify: skipped verification", () => {
  it("a null spec reaches only the product's own hosts and describes itself as skipped", () => {
    assert.ok(networkFor("https://acme.dev", null).includes("api.acme.dev"));
    assert.match(describeSpec(null), /verification skipped/);
  });

  it("the task counts a saved key without calling anything, and classify says it was not checked", async () => {
    const { task, evaluate } = buildVerifyTask({ url: "https://acme.dev", task: "Sign up", spec: null, fetchImpl: () => assert.fail("no call expected") });
    assert.equal(task.apiHost, "acme.dev");
    const files = { read: (n) => (n === "PLAN.md" ? "Use the API: https://acme.dev/docs" : null), readRaw: (n) => (n === "CREDENTIAL.env" ? "AGENT_READY_KEY=ar_live_abcdef123456\n" : null) };
    const evaluation = await evaluate({ runId: "r1", files, mode: "signup" });
    assert.equal(evaluation.success, true);
    assert.equal(evaluation.objects.skipped, true);
    const verdict = classify({ evaluation, execution: { stoppedBecause: "success" } }, "try_then_claim");
    assert.equal(verdict.outcome, "passed");
    assert.match(verdict.reason, /not checked: verification was skipped/);
  });

  it("the plan renders without a checker call", () => {
    const plan = { target: { host: "acme.dev" }, task: "Sign up", ready: true, claudeCode: { ok: true, detail: "Claude Code 9.9.9" }, agent: { hosts: ["acme.dev"], inbox: "none", maxTurns: 40, maxBudgetUsd: 5, saves: ["AGENT_READY_KEY"] }, checker: { call: describeSpec(null), calls: ["none: a key the agent saves counts, unchecked"], inferred: false, inferredFrom: null, skipped: true } };
    const out = renderPlan(plan, makeStyle(false)).join("\n");
    assert.match(out, /verification skipped/);
    assert.match(out, /READY/);
  });
});

describe("verify: command without a verify_call", () => {
  const fakeClaude = () => {
    const bin = mkdtempSync(join(tmpdir(), "fake-claude-"));
    writeFileSync(join(bin, "claude"), `#!/usr/bin/env node\nif (process.argv[2] === "--version") console.log("9.9.9 (Claude Code)");\nelse console.log(JSON.stringify({ loggedIn: true }));\n`);
    chmodSync(join(bin, "claude"), 0o755);
    return bin;
  };
  const runCli = (args, cwd) => {
    const env = { ...process.env, NO_COLOR: "1", PATH: `${fakeClaude()}:${process.env.PATH}` };
    delete env.ANTHROPIC_API_KEY;
    return spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: "utf8", env });
  };

  // Nothing listens on port 9, so no OpenAPI document is found without leaving this machine.
  it("without a terminal it exits 2 and names --skip-verify as the way on", () => {
    const cwd = mkdtempSync(join(tmpdir(), "verify-wizard-"));
    writeFileSync(join(cwd, "alg.yml"), "url: 127.0.0.1:9\ntask: Sign up\nonboarding: try_then_claim\n");
    const r = runCli(["test", "--check"], cwd);
    assert.equal(r.status, 2, r.stderr);
    assert.match(r.stderr, /verify_call: GET https:\/\/api\.example\.com\/v1\/me/);
    assert.match(r.stderr, /--skip-verify/);
  });

  it("--skip-verify plans a run with no checker and asks the docs for nothing", () => {
    const cwd = mkdtempSync(join(tmpdir(), "verify-wizard-"));
    writeFileSync(join(cwd, "alg.yml"), "url: 127.0.0.1:9\ntask: Sign up\nonboarding: try_then_claim\n");
    const before = readFileSync(join(cwd, "alg.yml"), "utf8");
    const r = runCli(["test", "--check", "--json", "--skip-verify"], cwd);
    assert.equal(r.status, 0, r.stderr);
    const plan = JSON.parse(r.stdout);
    assert.equal(plan.checker.skipped, true);
    assert.match(plan.checker.call, /verification skipped/);
    assert.deepEqual(plan.agent.saves, ["AGENT_READY_KEY"]);
    assert.equal(readFileSync(join(cwd, "alg.yml"), "utf8"), before);
    const text = runCli(["test", "--check", "--skip-verify"], cwd);
    assert.equal(text.status, 0, text.stderr);
    assert.match(text.stderr, /Verification skipped \(--skip-verify\)/);
  });

  it("--skip-verify works with no alg.yml at all", () => {
    const cwd = mkdtempSync(join(tmpdir(), "verify-wizard-"));
    const r = runCli(["test", "127.0.0.1:9", "--check", "--json", "--skip-verify"], cwd);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(JSON.parse(r.stdout).checker.skipped, true);
    assert.equal(existsSync(join(cwd, "alg.yml")), false);
  });
});
