import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { shapeStandards, runStandards, aeoReadyVersion } from "../src/audit/standards.js";
import { makeStyle, renderStandards } from "../src/audit/render.js";
import { runAeoReady, killAeoReady, STANDARDS_TIMEOUT_MS } from "../src/scan/index.js";
import { AEO_RESULT, writeFakeAeoCli } from "./standards-fixtures.js";

const plain = makeStyle(false);
const ran = { result: AEO_RESULT, warnings: ["Warning: history.json not written"], error: null };

describe("standards: shaping aeo-ready's result", () => {
  it("one entry per benchmark with the benchmark's own score, passed/total without skips, warn counted as failed", () => {
    const s = shapeStandards(ran, "1.7.9");
    assert.deepEqual(s.generator, { name: "aeo-ready", version: "1.7.9" });
    assert.equal(s.averageScore, 59);
    assert.deepEqual(s.benchmarks.map((b) => b.id), ["agenticSeo", "cloudflare", "fern", "vercel", "agentgrade"]);
    const fern = s.benchmarks.find((b) => b.id === "fern");
    assert.deepEqual(fern, { id: "fern", name: "Fern", score: 70, maxScore: 100, grade: "C", passed: 1, total: 3, failed: ["llms-txt-size", "markdown-endpoint"], error: null, durationMs: null });
    const cloudflare = s.benchmarks.find((b) => b.id === "cloudflare");
    assert.deepEqual([cloudflare.score, cloudflare.maxScore, cloudflare.passed, cloudflare.total, cloudflare.failed], [1, 5, 2, 2, []]);
    const seo = s.benchmarks.find((b) => b.id === "agenticSeo");
    assert.deepEqual([seo.score, seo.passed, seo.total], [63, 0, 0]);
    assert.deepEqual(s.warnings, ran.warnings);
    assert.equal(s.error, null);
  });

  // aeo-ready's Cloudflare entry for composio.dev (2026-10-13), checks as aeo-ready 1.8.0 parsed them: only the PASS
  // and OK lines, since its pattern missed the "- FAIL id -- message" form. The categories are the report's own
  // "n/m passing" headings: 21 checks, 4 passing, at Level 1.
  const COMPOSIO_CLOUDFLARE = {
    score: 1, maxScore: 5, grade: "F", level: 1, available: true,
    checks: [{ id: "robotsTxt", status: "pass", message: "" }, { id: "sitemap", status: "pass", message: "" }, { id: "markdownNegotiation", status: "pass", message: "" }, { id: "robotsTxtAiRules", status: "pass", message: "" }, { id: "webBotAuth", status: "ok", message: "" }],
    categories: {
      discoverability: { name: "Discoverability", score: 2, maxScore: 4, percentage: 50 },
      "content-accessibility": { name: "Content Accessibility", score: 1, maxScore: 1, percentage: 100 },
      "bot-access-control": { name: "Bot Access Control", score: 1, maxScore: 2, percentage: 50 },
      "api-auth-mcp-a-a-discovery": { name: "API, Auth, MCP & A2A Discovery", score: 0, maxScore: 9, percentage: 0 },
      commerce: { name: "Commerce", score: 0, maxScore: 5, percentage: 0 },
    },
  };

  it("Cloudflare's counts are its category headings, so a Level 1 site no longer reads as all checks passed", () => {
    // The live leaderboard document for composio.dev read score 1, maxScore 5, passed 5, total 5, failed []: the five
    // lines aeo-ready parsed, all passing, next to Level 1 of 5.
    const old = shapeStandards({ result: { averageScore: 30, benchmarks: { cloudflare: COMPOSIO_CLOUDFLARE } }, warnings: [], error: null }, "1.8.0").benchmarks[1];
    assert.deepEqual([old.score, old.maxScore, old.grade, old.passed, old.total, old.failed], [1, 5, "F", 4, 21, []]);
    // With aeo-ready's parser fixed, the FAIL lines arrive too and name the failed checks; the counts do not change.
    const fixed = { ...COMPOSIO_CLOUDFLARE, checks: [...COMPOSIO_CLOUDFLARE.checks, { id: "linkHeaders", status: "fail", message: "" }, { id: "x402", status: "fail", message: "" }] };
    const now = shapeStandards({ result: { averageScore: 30, benchmarks: { cloudflare: fixed } }, warnings: [], error: null }, "1.8.1").benchmarks[1];
    assert.deepEqual([now.passed, now.total, now.failed], [4, 21, ["linkHeaders", "x402"]]);
    // The terminal says level, not score, for Cloudflare, and marks it failed by its counts, not by the names it has.
    const text = renderStandards(shapeStandards({ result: { averageScore: 30, benchmarks: { cloudflare: COMPOSIO_CLOUDFLARE } }, warnings: [], error: null }, "1.8.0"), plain).join("\n");
    assert.match(text, /✗ Cloudflare {4}4\/21 checks passed {6}level 1\/5 F/);
  });

  it("scores from the catalog's JSON become numbers or null, grades and check ids strings", () => {
    const odd = { result: { averageScore: "59", benchmarks: { fern: { score: "<b>70</b>", maxScore: 100, grade: 7, checks: [{ id: 42, status: "fail" }] }, cloudflare: { score: "4", maxScore: "5", grade: "B", checks: [] } } }, warnings: [], error: null };
    const s = shapeStandards(odd, "1.7.9");
    assert.equal(s.averageScore, 59);
    const fern = s.benchmarks.find((b) => b.id === "fern");
    assert.deepEqual([fern.score, fern.maxScore, fern.grade, fern.failed], [null, 100, "7", ["42"]]);
    const cloudflare = s.benchmarks.find((b) => b.id === "cloudflare");
    assert.deepEqual([cloudflare.score, cloudflare.maxScore], [4, 5]);
  });

  it("a benchmark that did not run keeps aeo-ready's reason", () => {
    const vercel = shapeStandards(ran, "1.7.9").benchmarks.find((b) => b.id === "vercel");
    assert.deepEqual(vercel, { id: "vercel", name: "Vercel", score: null, maxScore: null, grade: null, passed: 0, total: 0, failed: [], error: "@vercel/agent-readability timed out after 60s", durationMs: null });
  });

  it("durationMs is the benchmark's own, when aeo-ready reports it (1.8.0), null before", () => {
    const timed = { result: { averageScore: 59, benchmarks: { fern: { ...AEO_RESULT.benchmarks.fern, durationMs: 4139 }, vercel: { available: false, reason: "did not finish within 720s", durationMs: 720004 }, cloudflare: { ...AEO_RESULT.benchmarks.cloudflare, durationMs: "oops" } } }, warnings: [], error: null };
    const s = shapeStandards(timed, "1.8.0");
    assert.equal(s.benchmarks.find((b) => b.id === "fern").durationMs, 4139);
    assert.equal(s.benchmarks.find((b) => b.id === "vercel").durationMs, 720004);
    assert.equal(s.benchmarks.find((b) => b.id === "cloudflare").durationMs, null);
    assert.equal(s.benchmarks.find((b) => b.id === "agentgrade").durationMs, null);
  });

  it("when the stderr shows local ports or DNS ran out, the error says to run checks one at a time", () => {
    const stderr = ["Warning: history.json not written", "Error: connect EADDRNOTAVAIL 104.18.3.2:443 - Local (0.0.0.0:0)"];
    const s = shapeStandards({ result: null, warnings: stderr, error: "aeo-ready exited 1 without JSON: Error: connect EADDRNOTAVAIL 104.18.3.2:443 - Local (0.0.0.0:0)" }, "1.8.0");
    assert.equal(s.error, "aeo-ready exited 1 without JSON: Error: connect EADDRNOTAVAIL 104.18.3.2:443 - Local (0.0.0.0:0). local ports or DNS exhausted; run checks one at a time");
    const dns = shapeStandards({ result: null, warnings: ["getaddrinfo EAI_AGAIN acme.dev"], error: "aeo-ready exited 1 without JSON: getaddrinfo EAI_AGAIN acme.dev" }, "1.8.0");
    assert.match(dns.error, /EAI_AGAIN acme\.dev\. local ports or DNS exhausted; run checks one at a time$/);
    const other = shapeStandards({ result: null, warnings: ["Warning: no network"], error: "aeo-ready exited 1 without JSON: Warning: no network" }, "1.8.0");
    assert.equal(other.error, "aeo-ready exited 1 without JSON: Warning: no network");
    const fine = shapeStandards({ result: AEO_RESULT, warnings: ["EAI_AGAIN once, then it recovered"], error: null }, "1.8.0");
    assert.equal(fine.error, null);
  });

  it("when aeo-ready gives no JSON, the error is kept and there are no benchmarks", () => {
    const s = shapeStandards({ result: null, warnings: ["Warning: no network"], error: "aeo-ready exited 1 without JSON: Warning: no network" }, "1.7.9");
    assert.deepEqual(s.benchmarks, []);
    assert.equal(s.averageScore, null);
    assert.match(s.error, /exited 1 without JSON/);
  });
});

describe("standards: terminal section", () => {
  it("one line per benchmark, then the failed checks by benchmark, and a sentence that the steps are not changed", () => {
    const text = renderStandards(shapeStandards(ran, "1.7.9"), plain).join("\n");
    // What it sends is said before it runs (renderStandardsStart); the results say what the scores are.
    assert.match(text, /Scores from aeo-ready 1\.7\.9; they do not change the seven steps\./);
    assert.match(text, /agentic-seo, Fern and Vercel fetched your pages from here\./);
    assert.match(text, /✓ Cloudflare {4}2\/2 checks passed {7}level 1\/5 F/);
    assert.match(text, /✗ Fern {10}1\/3 checks passed {7}score 70\/100 C/);
    assert.match(text, /· agentic-seo {3}no individual checks {4}score 63\/100 C/);
    assert.match(text, /· Vercel {8}did not run: @vercel\/agent-readability timed out after 60s/);
    assert.match(text, /Failed checks {2}4\n {4}Fern {10}2 {2}llms-txt-size, markdown-endpoint\n {4}AgentGrade {4}2 {2}MCP endpoint responds, A2A agent card\n/);
    assert.doesNotMatch(text, /Tools listed/, "passing checks are not listed");
    for (const line of renderStandards(shapeStandards(ran, "1.7.9"), plain)) assert.ok(line.length <= 80, line);
  });

  it("failed checks: one line per benchmark, the first names that fit and +N, and where all of them are", () => {
    const standards = shapeStandards(ran, "1.7.9");
    const fern = standards.benchmarks.find((b) => b.id === "fern");
    fern.failed = Array.from({ length: 18 }, (_, i) => `a-long-check-name-${i + 1}`);
    const lines = renderStandards(standards, plain, ".alg/acme.com/run/aeo-ready.json");
    const text = lines.join("\n");
    assert.match(text, /Failed checks {2}20, the first names shown\. All of them:\n {4}\.alg\/acme\.com\/run\/aeo-ready\.json\n/);
    assert.match(text, /\n {4}Fern {9}18 {2}a-long-check-name-1, a-long-check-name-2, \+16\n/);
    for (const line of lines) assert.ok(line.length <= 80, line);
  });

  it("prints aeo-ready's error when it did not run, and says so when it was skipped", () => {
    const failed = renderStandards(shapeStandards({ result: null, warnings: [], error: "aeo-ready exited 1 without JSON" }, "1.7.9"), plain).join("\n");
    assert.match(failed, /^ {14}aeo-ready did not run\. aeo-ready exited 1 without JSON/);
    assert.equal(renderStandards(null, plain)[0], "  Benchmarks  add --standards for five third-party scores (1-3 min)");
  });
});

describe("standards: runAeoReady", () => {
  // Two separate facts, tested apart because together they raced: whether a kill is reported as a kill, and whether the
  // child's stderr reaches the message. One test cannot check both by timing a write against a deadline, because the
  // child has to boot an interpreter first (229-310 ms idle here, past 1200 ms with the suite running alongside), and
  // then the deadline lands before the write and the message is correctly empty. The stderr tests let the child write
  // and then have it kill itself, so nothing depends on how fast it starts.
  it("kills aeo-ready after timeoutMs and says so, instead of reporting an exit code", async () => {
    const dir = mkdtempSync(join(tmpdir(), "standards-"));
    const cli = join(dir, "hang.mjs");
    writeFileSync(cli, "setTimeout(() => {}, 60000);\n");
    const r = await runAeoReady({ url: "https://acme.dev/", cwd: join(dir, "vendor"), cli, timeoutMs: 1200 });
    assert.equal(r.result, null);
    assert.equal(r.error, "aeo-ready killed after 1 s without JSON");
  });

  it("carries the child's last stderr line when it dies without JSON", async () => {
    const dir = mkdtempSync(join(tmpdir(), "standards-"));
    const cli = join(dir, "dies.mjs");
    writeFileSync(cli, "process.stderr.write('Warning: slow\\n', () => process.kill(process.pid, 'SIGKILL'));\n");
    const r = await runAeoReady({ url: "https://acme.dev/", cwd: join(dir, "vendor"), cli, timeoutMs: 5000 });
    assert.equal(r.result, null);
    assert.deepEqual(r.warnings, ["Warning: slow"]);
    assert.equal(r.error, "aeo-ready killed by SIGKILL without JSON: Warning: slow");
  });

  it("stderr of only whitespace leaves the sentence ending on 'without JSON', not on undefined", async () => {
    const dir = mkdtempSync(join(tmpdir(), "standards-"));
    const cli = join(dir, "blank.mjs");
    writeFileSync(cli, "process.stderr.write('\\n', () => process.kill(process.pid, 'SIGKILL'));\n");
    const r = await runAeoReady({ url: "https://acme.dev/", cwd: join(dir, "vendor"), cli, timeoutMs: 5000 });
    assert.equal(r.result, null);
    assert.deepEqual(r.warnings, [], "whitespace is not a warning");
    assert.equal(r.error, "aeo-ready killed by SIGKILL without JSON");
  });

  it("a child that exits with no JSON reports its exit code", async () => {
    const dir = mkdtempSync(join(tmpdir(), "standards-"));
    const r = await runAeoReady({ url: "https://acme.dev/", cwd: join(dir, "vendor"), cli: writeFakeAeoCli(dir, "fail"), timeoutMs: 5000 });
    assert.equal(r.error, "aeo-ready exited 1 without JSON: Warning: no network");
  });

  it("with onChild, killAeoReady stops aeo-ready and the processes it started, as check does on Ctrl+C", { skip: process.platform === "win32" }, async () => {
    const dir = mkdtempSync(join(tmpdir(), "standards-"));
    const pidFile = join(dir, "grandchild.pid");
    const cli = join(dir, "spawns.mjs");
    // Stands in for aeo-ready running npx: a grandchild that would outlive a kill of its parent alone.
    writeFileSync(cli, `import { spawn } from "node:child_process"; import { writeFileSync } from "node:fs";
const g = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore" });
writeFileSync(${JSON.stringify(pidFile)}, String(g.pid)); setTimeout(() => {}, 60000);\n`);
    let child = null;
    const run = runAeoReady({ url: "https://acme.dev/", cwd: join(dir, "vendor"), cli, timeoutMs: 20000, onChild: (c) => (child = c) });
    while (!existsSync(pidFile)) await new Promise((r) => setTimeout(r, 20));
    const grandchild = Number(readFileSync(pidFile, "utf8"));
    killAeoReady(child);
    const r = await run;
    assert.match(r.error, /killed by SIGTERM/);
    await new Promise((r) => setTimeout(r, 100));
    assert.throws(() => process.kill(grandchild, 0), { code: "ESRCH" }, "the grandchild was stopped too");
  });

  it("the default kill is 15 minutes", () => {
    assert.equal(STANDARDS_TIMEOUT_MS, 900_000);
  });
});

describe("standards: runStandards", () => {
  it("runs aeo-ready for the url in the run folder, writes its JSON there and returns the shaped field", async () => {
    const out = join(mkdtempSync(join(tmpdir(), "standards-")), "run");
    const calls = [];
    const { standards, raw } = await runStandards({ url: "https://acme.dev/", out, env: { AGENT_READY_AEO_CLI: "/x/cli.js" }, runAeoReady: async (args) => (calls.push(args), ran) });
    assert.deepEqual(calls, [{ url: "https://acme.dev/", cwd: join(out, "vendor"), cli: "/x/cli.js", onChild: null }]);
    assert.equal(raw, join(out, "aeo-ready.json"));
    assert.deepEqual(JSON.parse(readFileSync(raw, "utf8")), AEO_RESULT);
    assert.equal(standards.generator.version, aeoReadyVersion());
    assert.equal(standards.benchmarks.length, 5);
  });

  it("AGENT_READY_STANDARDS_TIMEOUT_MS sets the kill when no timeoutMs is passed; an explicit one wins", async () => {
    const out = join(mkdtempSync(join(tmpdir(), "standards-")), "run");
    const calls = [];
    const fake = async (args) => (calls.push(args.timeoutMs), ran);
    await runStandards({ url: "https://acme.dev/", out, env: {}, runAeoReady: fake });
    await runStandards({ url: "https://acme.dev/", out, env: { AGENT_READY_STANDARDS_TIMEOUT_MS: "1200000" }, runAeoReady: fake });
    await runStandards({ url: "https://acme.dev/", out, env: { AGENT_READY_STANDARDS_TIMEOUT_MS: "1200000" }, timeoutMs: 180_000, runAeoReady: fake });
    assert.deepEqual(calls, [undefined, 1200000, 180_000]);
  });

  it("with no result nothing is written and the error is returned, not thrown away", async () => {
    const out = join(mkdtempSync(join(tmpdir(), "standards-")), "run");
    const { standards, raw } = await runStandards({ url: "https://acme.dev/", out, env: {}, runAeoReady: async () => ({ result: null, warnings: ["w"], error: "aeo-ready exited 1 without JSON: w" }) });
    assert.equal(raw, null);
    assert.ok(!existsSync(join(out, "aeo-ready.json")));
    assert.equal(standards.error, "aeo-ready exited 1 without JSON: w");
  });
});
