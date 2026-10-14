import test from "node:test";
import assert from "node:assert/strict";
import { buildFunnel } from "../src/interface/funnel.js";

const verdict = (v, reason = "because", basedOn = ["obs_1"]) => ({ verdict: v, reason, basedOn, rule: "r", method: "rule" });

function doc(overrides = {}) {
  return {
    observations: [{ id: "obs_1", role: "homepage", ok: true, status: 200 }],
    machineAccess: { aiCrawlersAllowed: verdict("yes"), hasAgentReadableIndex: verdict("yes", "/llms.txt with 3 links") },
    pricing: { agentCanDetermineCost: verdict("yes", "2 plan(s) with amounts in pricing.json"), ambiguities: [], plans: [{ id: "pro", amount: 20, evidence: [{ obs: "obs_1" }] }] },
    onboarding: { patterns: [] },
    authentication: { methods: [{ value: { type: "apiKey" } }], requirement: { value: "required", basedOn: [] } },
    capabilities: [{ name: "Create project", evidence: [{ obs: "obs_1" }] }],
    interfaces: { api: { exists: verdict("yes"), machineReadableSpec: verdict("yes") } },
    ...overrides,
  };
}

test("what a self-serve signup needs is a sentence, one per need, never a bare token", () => {
  const pattern = (needs) => ({ onboarding: { patterns: [{ id: "try_then_claim", name: "Try first, claim later", status: "documented", humanBoundary: "After the first job.", needs, evidence: [{ obs: "obs_1" }] }] } });
  const reason = (needs) => buildFunnel(doc(pattern(needs))).steps.find((s) => s.id === "signup").reason;
  assert.equal(reason(["inbox"]), "The docs describe an agent signing up on its own (Try first, claim later). Needs an inbox the agent can read.");
  assert.equal(reason(["inbox", "cli"]), "The docs describe an agent signing up on its own (Try first, claim later). Needs an inbox the agent can read. Needs a shell where the agent can run the product's CLI.");
  assert.match(reason(["wallet"]), /Needs a wallet the agent can pay from\.$/);
  assert.match(reason(["agent_identity"]), /Needs an identity provider the agent can sign in with\.$/);
  assert.doesNotMatch(reason(["inbox", "cli"]), /It needs:|\binbox\b\.|\bcli\b/);
  assert.throws(() => reason(["fax"]), /no sentence for need "fax"/);
});

test("a product with no agent signup stops at Sign up and says what to build", () => {
  const f = buildFunnel(doc());
  assert.equal(f.stopsAt, "signup");
  const signup = f.steps.find((s) => s.id === "signup");
  assert.equal(signup.state, "needs_person");
  assert.match(signup.fix, /one API call/);
  assert.equal(f.headline, `Your public pages document ${f.documented} of 7 steps. No step has been tested yet: a test runs a real agent.`);
  assert.equal(f.verified, 0);
  assert.equal(f.passed, 2, "passed still counts the steps before the first stop");
  assert.equal(f.stepsPassing, f.documented + f.verified);
});

test("try first, claim later counts as an agent signing up, and the funnel names the path", () => {
  const f = buildFunnel(doc({ onboarding: { patterns: [{ id: "try_then_claim", name: "Try first, claim later", status: "documented", humanBoundary: "After the first job.", needs: [], evidence: [{ obs: "obs_1" }] }] } }));
  assert.equal(f.steps.find((s) => s.id === "signup").state, "agent_can");
  assert.equal(f.steps.find((s) => s.id === "access").state, "agent_can");
  assert.deepEqual(f.path, { id: "try_then_claim", name: "Try first, claim later" });
  assert.equal(f.paths[0].followed, true);
});

test("a person handing the agent a key is a handoff, which passes", () => {
  const f = buildFunnel(doc({ onboarding: { patterns: [{ id: "existing_account", name: "Existing account", status: "documented", needs: [], evidence: [] }] } }));
  const signup = f.steps.find((s) => s.id === "signup");
  assert.equal(signup.state, "handoff");
  assert.equal(signup.fix, undefined);
  assert.notEqual(f.stopsAt, "signup");
});

test("steps public evidence cannot prove are not checked, and never count as a stop", () => {
  const f = buildFunnel(doc({ pricing: { agentCanDetermineCost: verdict("yes"), ambiguities: [], plans: [{ id: "free", amount: 0 }] }, onboarding: { patterns: [{ id: "agent_is_customer", name: "Agent is the customer", status: "documented", needs: [] }] } }));
  assert.equal(f.steps.find((s) => s.id === "manage").state, "not_checked");
  assert.equal(f.stopsAt, null);
  assert.match(f.headline, /^Your public pages document \d of 7 steps\. No step has been tested yet/);
});

test("robots.txt that blocks AI agents stops the funnel at Discover", () => {
  const f = buildFunnel(doc({ machineAccess: { aiCrawlersAllowed: verdict("no", "GPTBot is disallowed"), hasAgentReadableIndex: verdict("yes") } }));
  assert.equal(f.steps[0].state, "blocked");
  assert.equal(f.stopsAt, "discover");
});

test("a passed live test proves its step; a blocked one overrides public evidence; inconclusive changes nothing", async () => {
  const { applyLiveTests } = await import("../src/interface/funnel.js");
  const base = buildFunnel(doc());
  const runs = [
    { id: "run_a", kind: "usability", step: "signup", outcome: "blocked", summary: "CAPTCHA on the signup form.", completedAt: "2026-09-01T00:00:00Z" },
    { id: "run_b", kind: "usability", step: "signup", outcome: "passed", flowName: "Sign up as an agent", completedAt: "2026-09-02T00:00:00Z" },
    { id: "run_c", kind: "usability", step: "use", outcome: "blocked", summary: "The call returned 500.", completedAt: "2026-09-02T00:00:00Z" },
    { id: "run_d", kind: "usability", step: "discover", outcome: "inconclusive", completedAt: "2026-09-03T00:00:00Z" },
  ];
  const f = applyLiveTests(base, runs);
  const signup = f.steps.find((s) => s.id === "signup");
  assert.equal(signup.state, "agent_did");
  assert.equal(signup.live.runId, "run_b");
  assert.equal(signup.fix, undefined);
  const use = f.steps.find((s) => s.id === "use");
  assert.equal(use.state, "blocked");
  assert.match(use.reason, /500/);
  assert.ok(use.fix);
  assert.equal(f.steps.find((s) => s.id === "discover").state, base.steps[0].state);
  assert.equal(f.stopsAt, "access", "public evidence still decides steps no live test covered");
  assert.equal(f.verified, 1);
  assert.equal(f.stepsPassing, f.documented + 1, "stepsPassing counts the verified step too");
  assert.equal(f.documented, f.steps.filter((s) => ["agent_can", "handoff"].includes(s.state)).length);
  assert.equal(f.headline, `1 of 7 steps verified by a test. Your public pages document ${f.documented} more. Use failed a test.`);
});

test("Use counts API operations, not OpenAPI tag groups", () => {
  const caps = [{ name: "Emails", evidence: [{ obs: "obs_1" }], operationDetails: [{}, {}, {}] }, { name: "Domains", evidence: [{ obs: "obs_1" }], operationDetails: [{}, {}] }];
  const f = buildFunnel(doc({ capabilities: caps }));
  assert.match(f.steps.find((s) => s.id === "use").reason, /^5 API operations/);
});

test("the headline counts every passing step and names a step a live test failed", async () => {
  const { applyLiveTests } = await import("../src/interface/funnel.js");
  const base = buildFunnel(doc({ onboarding: { patterns: [{ id: "try_then_claim", name: "Try first, claim later", status: "documented", humanBoundary: "After the first job.", needs: [], evidence: [{ obs: "obs_1" }] }] } }));
  const f = applyLiveTests(base, [{ id: "run_u", kind: "usability", step: "understand", outcome: "blocked", summary: "No price for Pro.", completedAt: "2026-09-02T00:00:00Z" }]);
  const passing = f.steps.filter((s) => ["agent_did", "agent_can", "handoff"].includes(s.state)).length;
  assert.equal(f.headline, `0 of 7 steps verified by a test. Your public pages document ${passing} more. Understand failed a test.`);
  assert.equal(f.stepsPassing, passing);
  assert.ok(passing > f.passed, "a stop early in the order no longer hides the steps after it");
});

test("the funnel and the schema walk the seven steps in one order, Use before Pay", async () => {
  const { FUNNEL_ORDER } = await import("../src/interface/funnel.js");
  const { STAGES } = await import("../src/schema/stages.js");
  assert.deepEqual(FUNNEL_ORDER, STAGES);
  assert.deepEqual(STAGES, ["discover", "understand", "signup", "access", "use", "pay", "manage"]);
  assert.deepEqual(buildFunnel(doc()).steps.map((s) => s.id), STAGES);
});

test("stepsPassing is the count the headline says; passed stays the steps before the first stop", async () => {
  const { applyLiveTests } = await import("../src/interface/funnel.js");
  const f = applyLiveTests(buildFunnel(doc()), [{ id: "r", kind: "usability", step: "understand", outcome: "blocked", summary: "x", completedAt: "2026-09-02T00:00:00Z" }]);
  assert.equal(f.stepsPassing, f.documented + f.verified);
  assert.ok(f.headline.startsWith(`${f.verified} of 7 steps verified by a test. Your public pages document ${f.documented} more.`));
  assert.equal(f.passed, 1);
  assert.ok(f.stepsPassing > f.passed);
});
