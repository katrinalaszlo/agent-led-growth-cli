import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { shapeStandards, runStandards, aeoReadyVersion } from "../src/audit/standards.js";
import { makeStyle, renderStandards } from "../src/audit/render.js";
import { AEO_RESULT } from "./standards-fixtures.js";

const plain = makeStyle(false);
const ran = { result: AEO_RESULT, warnings: ["Warning: history.json not written"], error: null };

describe("standards: shaping aeo-ready's result", () => {
  it("one entry per benchmark with the benchmark's own score, passed/total without skips, warn counted as failed", () => {
    const s = shapeStandards(ran, "1.7.9");
    assert.deepEqual(s.generator, { name: "aeo-ready", version: "1.7.9" });
    assert.equal(s.averageScore, 59);
    assert.deepEqual(s.benchmarks.map((b) => b.id), ["agenticSeo", "cloudflare", "fern", "vercel", "agentgrade"]);
    const fern = s.benchmarks.find((b) => b.id === "fern");
    assert.deepEqual(fern, { id: "fern", name: "Fern", score: 70, maxScore: 100, grade: "C", passed: 1, total: 3, failed: ["llms-txt-size", "markdown-endpoint"], error: null });
    const cloudflare = s.benchmarks.find((b) => b.id === "cloudflare");
    assert.deepEqual([cloudflare.score, cloudflare.maxScore, cloudflare.passed, cloudflare.total, cloudflare.failed], [1, 5, 2, 2, []]);
    const seo = s.benchmarks.find((b) => b.id === "agenticSeo");
    assert.deepEqual([seo.score, seo.passed, seo.total], [63, 0, 0]);
    assert.deepEqual(s.warnings, ran.warnings);
    assert.equal(s.error, null);
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
    assert.deepEqual(vercel, { id: "vercel", name: "Vercel", score: null, maxScore: null, grade: null, passed: 0, total: 0, failed: [], error: "@vercel/agent-readability timed out after 60s" });
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
    assert.match(text, /Standards {2}5 third-party benchmarks of your public surface \(aeo-ready 1\.7\.9\)/);
    assert.match(text, /they do not change the seven steps above\./);
    assert.match(text, /✓ Cloudflare {4}2\/2 checks passed {7}score 1\/5 F/);
    assert.match(text, /✗ Fern {10}1\/3 checks passed {7}score 70\/100 C/);
    assert.match(text, /· agentic-seo {3}no individual checks {4}score 63\/100 C/);
    assert.match(text, /· Vercel {8}did not run: @vercel\/agent-readability timed out after 60s/);
    assert.match(text, /Failed checks {2}names as each benchmark reports them\n {4}Fern\n {6}✗ llms-txt-size\n {6}✗ markdown-endpoint\n {4}AgentGrade\n {6}✗ MCP endpoint responds\n {6}✗ A2A agent card/);
    assert.doesNotMatch(text, /Tools listed/, "passing checks are not listed");
    for (const line of renderStandards(shapeStandards(ran, "1.7.9"), plain)) assert.ok(line.length <= 80, line);
  });

  it("prints aeo-ready's error when it did not run, and says so when it was skipped", () => {
    const failed = renderStandards(shapeStandards({ result: null, warnings: [], error: "aeo-ready exited 1 without JSON" }, "1.7.9"), plain).join("\n");
    assert.match(failed, /Standards {2}aeo-ready did not run\. aeo-ready exited 1 without JSON/);
    assert.equal(renderStandards(null, plain)[0], "  Standards  skipped (--no-standards)");
  });
});

describe("standards: runStandards", () => {
  it("runs aeo-ready for the url in the run folder, writes its JSON there and returns the shaped field", async () => {
    const out = join(mkdtempSync(join(tmpdir(), "standards-")), "run");
    const calls = [];
    const { standards, raw } = await runStandards({ url: "https://acme.dev/", out, env: { AGENT_READY_AEO_CLI: "/x/cli.js" }, runAeoReady: async (args) => (calls.push(args), ran) });
    assert.deepEqual(calls, [{ url: "https://acme.dev/", cwd: join(out, "vendor"), cli: "/x/cli.js" }]);
    assert.equal(raw, join(out, "aeo-ready.json"));
    assert.deepEqual(JSON.parse(readFileSync(raw, "utf8")), AEO_RESULT);
    assert.equal(standards.generator.version, aeoReadyVersion());
    assert.equal(standards.benchmarks.length, 5);
  });

  it("with no result nothing is written and the error is returned, not thrown away", async () => {
    const out = join(mkdtempSync(join(tmpdir(), "standards-")), "run");
    const { standards, raw } = await runStandards({ url: "https://acme.dev/", out, env: {}, runAeoReady: async () => ({ result: null, warnings: ["w"], error: "aeo-ready exited 1 without JSON: w" }) });
    assert.equal(raw, null);
    assert.ok(!existsSync(join(out, "aeo-ready.json")));
    assert.equal(standards.error, "aeo-ready exited 1 without JSON: w");
  });
});
