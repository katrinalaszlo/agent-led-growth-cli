import test from "node:test";
import assert from "node:assert/strict";
import { buildFunnel } from "../src/interface/funnel.js";
import { applyEvidence } from "../src/interface/evidence.js";
import { stripHtml, who, label } from "../src/dashboard/strip.js";

const verdict = (v, reason = "because", basedOn = ["obs_1"]) => ({ verdict: v, reason, basedOn, rule: "r", method: "rule" });
const doc = () => ({
  observations: [{ id: "obs_1", role: "homepage", ok: true, status: 200 }],
  machineAccess: { aiCrawlersAllowed: verdict("yes"), hasAgentReadableIndex: verdict("yes", "/llms.txt with 3 links") },
  pricing: { agentCanDetermineCost: verdict("yes", "2 plan(s)"), ambiguities: [], plans: [{ id: "pro", amount: 20, evidence: [{ obs: "obs_1" }] }] },
  onboarding: { patterns: [] },
  authentication: { methods: [{ value: { type: "apiKey" } }], requirement: { value: "required", basedOn: [] } },
  capabilities: [{ name: "Create project", evidence: [{ obs: "obs_1" }] }],
  interfaces: { api: { exists: verdict("yes"), machineReadableSpec: verdict("yes") } },
});
const step = (f, id) => f.steps.find((s) => s.id === id);

test("a paid payment run sets Pay to agent_did and says what was paid", () => {
  const f = applyEvidence(buildFunnel(doc()), { pay: { outcome: "paid", paidUsd: 2, protocol: "x402", verifiedAt: "2026-10-14T06:52:51Z" } });
  const pay = step(f, "pay");
  assert.equal(pay.state, "agent_did");
  assert.match(pay.reason, /paid \$2\.00 over x402/);
  assert.equal(pay.evidence[0].kind, "pay");
  assert.equal(f.verified, 1);
});

test("a stopped payment run attaches but changes nothing", () => {
  const base = buildFunnel(doc());
  const f = applyEvidence(base, { pay: { outcome: "stopped", at: "2026-10-14T00:00:00Z" } });
  assert.equal(step(f, "pay").state, step(base, "pay").state);
  assert.equal(step(f, "pay").evidence.length, 1);
  assert.equal(step(f, "pay").evidence[0].reason, "The agent stopped before paying.");
});

test("the product's own signals from agents prove Sign up, Use and Pay, with counts", () => {
  const signals = {
    a1: { source: "agent", signupAt: "2026-10-01T00:00:00Z", firstCallAt: "2026-10-01T00:05:00Z", purchaseAt: null },
    a2: { source: "agent", signupAt: "2026-10-02T00:00:00Z", firstCallAt: null, purchaseAt: null },
    h1: { source: "human", signupAt: "2026-10-03T00:00:00Z", firstCallAt: "2026-10-03T00:01:00Z", purchaseAt: "2026-10-03T00:02:00Z" },
  };
  const f = applyEvidence(buildFunnel(doc()), { signals });
  assert.equal(step(f, "signup").state, "agent_did");
  assert.equal(step(f, "signup").evidence[0].count, 2);
  assert.equal(step(f, "signup").reason, "Your server saw 2 agent accounts sign up.");
  assert.equal(step(f, "use").state, "agent_did");
  assert.equal(step(f, "use").evidence[0].count, 1);
  assert.equal(step(f, "pay").evidence, undefined, "a human's purchase says nothing about an agent");
});

test("stuck reports attach to their step and never change its state", () => {
  const base = buildFunnel(doc());
  const f = applyEvidence(base, { stuck: [{ step: "signup", at: "2026-10-10T00:00:00Z" }, { step: "signup", at: "2026-10-11T00:00:00Z" }, { step: "nowhere", at: "2026-10-12T00:00:00Z" }] });
  const signup = step(f, "signup");
  assert.equal(signup.state, step(base, "signup").state);
  assert.deepEqual(signup.evidence.map((e) => [e.kind, e.count, e.at]), [["stuck", 2, "2026-10-11T00:00:00Z"]]);
  assert.equal(signup.reason, step(base, "signup").reason);
});

test("the latest state-bearing evidence decides; an inconclusive test and a stuck report sit beside it", () => {
  const runs = [
    { id: "r1", kind: "usability", step: "access", outcome: "passed", flowName: "Get a key", completedAt: "2026-10-01T00:00:00Z" },
    { id: "r2", kind: "usability", step: "access", outcome: "inconclusive", flowName: "Get a key", completedAt: "2026-10-05T00:00:00Z", summary: "Spending cap hit." },
  ];
  const f = applyEvidence(buildFunnel(doc()), { runs, stuck: [{ step: "access", at: "2026-10-06T00:00:00Z" }] });
  const access = step(f, "access");
  assert.equal(access.state, "agent_did", "the inconclusive run does not undo the pass");
  assert.equal(access.live.runId, "r1");
  assert.deepEqual(access.evidence.map((e) => e.kind), ["stuck", "test", "test"], "newest first, every kind kept");
  assert.equal(access.evidence[1].reason, "Spending cap hit.");
});

test("a later blocked test outranks an earlier signal, and vice versa", () => {
  const signals = { a1: { source: "agent", signupAt: "2026-10-01T00:00:00Z", firstCallAt: null, purchaseAt: null } };
  const blocked = { id: "r", kind: "usability", step: "signup", outcome: "blocked", summary: "CAPTCHA.", completedAt: "2026-10-02T00:00:00Z" };
  assert.equal(step(applyEvidence(buildFunnel(doc()), { runs: [blocked], signals }), "signup").state, "blocked");
  const later = { ...signals, a2: { source: "agent", signupAt: "2026-10-03T00:00:00Z", firstCallAt: null, purchaseAt: null } };
  assert.equal(step(applyEvidence(buildFunnel(doc()), { runs: [blocked], signals: later }), "signup").state, "agent_did");
});

test("nothing to apply returns the funnel untouched", () => {
  const base = buildFunnel(doc());
  assert.equal(applyEvidence(base, {}), base);
  assert.equal(applyEvidence(base, { runs: [{ id: "x", kind: "inspection", step: "use", outcome: "passed" }] }), base);
});

test("the strip reads who acted and marks the stopped step", () => {
  const f = applyEvidence(buildFunnel(doc()), { runs: [{ id: "r", kind: "usability", step: "use", outcome: "blocked", summary: "500", completedAt: "2026-10-02T00:00:00Z" }] });
  const html = stripHtml(f, { stoppedAt: "use" });
  assert.match(html, /<li class="funnel-dot funnel-blocked who-blocked funnel-stopped" title="Use: Blocked \(Test with a real agent\)"/);
  assert.equal((html.match(/<li /g) || []).length, 7);
  assert.equal(who("handoff"), "person");
  assert.equal(label("not_checked"), "Needs a test");
});
