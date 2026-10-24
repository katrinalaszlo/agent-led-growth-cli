import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { inspect, buildAudit } from "../src/audit/index.js";
import { makeStyle, renderSteps, renderVerdict, renderNext, latestTestOutcome } from "../src/audit/render.js";
import { applyEvidence } from "../src/interface/evidence.js";

// A finding that says a product requires something (an inbox, a payment, a plan change, a person setting access up)
// is the worst thing Score can get wrong. Track (alg.katrinalaszlo.com, recorded 2026-10-24) is free, needs no email and
// read as all three: "The docs mention paying per request" (x402 named as a task Score tests), "Needs an inbox the agent
// can read" (a customer-example "such as opening a verification email") and Manage "can only be proven by a test run"
// with one free plan. These tests pin the real pages, and contrasting products where each rule must still fire.

const replayFrom = (responses) => async (url) => responses[url] || { ok: false, status: 0, url, contentType: "", headers: {}, text: "", error: "not recorded" };
const recorded = (dir, file) => JSON.parse(gunzipSync(readFileSync(new URL(`../fixtures/${dir}/${file}`, import.meta.url))));
const pagesFrom = (pages) => async (url) => (pages[url] ? { ok: true, status: 200, url, contentType: url.endsWith("/") ? "text/html" : url.endsWith(".json") ? "application/json" : "text/plain", headers: {}, text: pages[url] } : { ok: false, status: 404, url, contentType: "text/html", headers: {}, text: "" });
const home = "<html><head><title>Acme</title></head><body>Acme</body></html>";
const answers = (funnel) => ({ onboarding: { value: funnel.path?.id || "try_then_claim", source: "from the docs" }, abuse_cost: { value: "low", source: "default" }, human_before: { value: "never", source: "default" } });
async function check(fetchSource, url = "https://acme.dev/") {
  const { doc, funnel } = await inspect({ url, version: "test", runId: "r", fetchSource });
  const audit = buildAudit({ doc, funnel, answers: answers(funnel), task: "t", runId: "r", version: "test" });
  const steps = Object.fromEntries(audit.steps.map((s) => [s.id, s]));
  return { doc, funnel, audit, steps };
}
const track = () => replayFrom(recorded("onboarding", "alg.katrinalaszlo.com.json.gz").responses);
const plain = makeStyle(false);

test("Track: free, no email, one plan. Pay and Manage don't apply, no inbox, no per-request price", async () => {
  const { doc, funnel, audit, steps } = await check(track(), "https://alg.katrinalaszlo.com/");
  assert.equal(steps.signup.state, "agent_can");
  assert.equal(steps.access.state, "agent_can");
  assert.equal(steps.pay.state, "not_applicable");
  assert.equal(steps.pay.reason, "Nothing to buy: every plan is free (pricing.json).");
  assert.equal(steps.pay.basis, "observed");
  assert.equal(steps.manage.state, "not_applicable");
  assert.equal(steps.manage.reason, "One free plan: no plan or limit to change.");
  for (const s of audit.steps) {
    assert.doesNotMatch(s.reason, /inbox|per request|paying|can only be proven/i, `${s.id}: ${s.reason}`);
    assert.equal(s.quotes, undefined, `${s.id} claims a requirement`);
  }
  const ids = doc.onboarding.patterns.map((p) => p.id);
  assert.deepEqual(ids, ["try_then_claim"], "no x402 pattern and no person-first pattern from a negated sentence");
  assert.deepEqual(doc.onboarding.patterns[0].needs, []);
  assert.equal(audit.findings.length, 0);
  assert.equal(audit.applicable, 5);
  assert.equal(audit.documented, 5);
  assert.equal(audit.headline, "Your public pages document 5 of 5 applicable steps; Pay and Manage don't apply. No step has been tested yet: a test runs a real agent.");
  assert.equal(audit.schema, "agent-ready/audit-report@1");
  assert.equal(funnel.stopsAt, null);
  const rows = renderSteps(audit, plain).join("\n");
  assert.match(rows, /^ {2}- Pay +Nothing to buy: every plan is free/m);
  assert.match(rows, /^ {2}- Manage +One free plan: no plan or limit to change\./m);
  assert.doesNotMatch(rows, /needs a test run/);
  assert.match(renderVerdict(audit, plain)[0], /document 5 of 5 applicable steps; Pay and Manage don't/);
});

test("Track after a passing test: Next says what is left instead of the same test again", async () => {
  const base = await check(track(), "https://alg.katrinalaszlo.com/");
  const runs = [{ kind: "usability", id: "run1", name: "Your test", completedAt: "2026-10-24T03:35:43.400Z", step: "signup", outcome: "passed" }, { kind: "usability", id: "run1", name: "Your test", completedAt: "2026-10-24T03:35:43.400Z", step: "access", outcome: "passed" }];
  const funnel = applyEvidence(base.funnel, { runs });
  assert.equal(latestTestOutcome(funnel), "passed");
  const audit = buildAudit({ doc: base.doc, funnel, answers: answers(funnel), task: "t", runId: "r", version: "test" });
  assert.equal(audit.headline, "2 of 5 applicable steps verified by a test; Pay and Manage don't apply. Your public pages document 3 more.");
  const next = renderNext(audit, { promptsDir: "p" }, plain, (p) => p, latestTestOutcome(funnel)).join("\n");
  assert.doesNotMatch(next, /Step 3 of 3/);
  assert.match(next, /Your latest test passed\. Nothing left to fix or test\. Pay and Manage\s+don't apply\./);
  assert.match(next, /npx agent-led-growth test alg\.katrinalaszlo\.com --yes --json/);
  for (const line of next.split("\n")) assert.ok([...line].length <= 80, line);
  // A newer inconclusive run is the latest: Next goes back to the test.
  const later = applyEvidence(base.funnel, { runs: [...runs, { kind: "usability", id: "run2", name: "Your test", completedAt: "2026-10-25T00:00:00.000Z", step: "signup", outcome: "inconclusive" }] });
  assert.equal(latestTestOutcome(later), "inconclusive");
  assert.match(renderNext(audit, { promptsDir: "p" }, plain, (p) => p, latestTestOutcome(later)).join("\n"), /Step 3 of 3: test/);
});

test("a paid per-request product still reads as paid: x402 on its own API, and a per-request price in prose", async () => {
  const x402 = await check(pagesFrom({
    "https://acme.dev/": home,
    "https://acme.dev/llms.txt": "# Acme\n\nSearch costs $0.01 per request, paid over x402: GET https://acme.dev/v1/search answers 402 with the price, and the agent retries with an X-PAYMENT header.\n",
    "https://acme.dev/pricing.json": JSON.stringify({ plans: [{ id: "per-request", name: "Per request", price: { amount: 0.01, currency: "USD", period: "request" } }] }),
  }));
  assert.notEqual(x402.steps.pay.state, "not_applicable");
  assert.equal(x402.steps.manage.state, "not_checked");
  assert.ok(x402.doc.onboarding.patterns.some((p) => p.id === "pay_per_request"));

  const prose = await check(pagesFrom({
    "https://acme.dev/": "<html><head><title>Acme</title></head><body>Acme search. $0.01 per request, billed monthly.</body></html>",
    "https://acme.dev/llms.txt": "# Acme\n\nGet an API key from the dashboard settings and send it as a bearer token.\n",
  }));
  assert.equal(prose.steps.pay.state, "needs_person");
  assert.match(prose.steps.pay.quotes[0].quote, /\$0\.01 per request/);
});

test("\"per request\" with no price beside it is a limit, not a price", async () => {
  const { doc, steps } = await check(pagesFrom({
    "https://acme.dev/": "<html><head><title>Acme</title></head><body>Acme. At most 4 KB per request. What it sends, per request: the route.</body></html>",
    "https://acme.dev/llms.txt": "# Acme\n\nAt most 4 KB per request.\n",
  }));
  assert.equal(doc.pricing.ambiguities.length, 0, JSON.stringify(doc.pricing.ambiguities));
  assert.doesNotMatch(steps.pay.reason, /per request/);
  const priced = await check(pagesFrom({ "https://acme.dev/": home, "https://acme.dev/pricing": "<html><body>Search is priced per request. Contact us for volume.</body></html>" }));
  assert.ok(priced.doc.pricing.ambiguities.some((a) => /priced per request/.test(a.text)), JSON.stringify(priced.doc.pricing.ambiguities));
});

test("an email-gated signup still needs an inbox, with the sentence that says so", async () => {
  const gated = {
    "https://acme.dev/": home,
    "https://acme.dev/llms.txt": "# Acme\n\n## Sign up\n\nAn agent can sign up in one API call: POST https://acme.dev/v1/agents/signup with an email address.\nWe send a verification code to that address; POST it to https://acme.dev/v1/agents/verify to get your API key.\n",
  };
  const { steps, doc } = await check(pagesFrom(gated));
  assert.equal(steps.signup.state, "agent_can");
  assert.match(steps.signup.reason, /Needs an inbox the agent can read\./);
  assert.equal(steps.signup.quotes.length, 1);
  assert.equal(steps.signup.quotes[0].for, "inbox");
  assert.match(steps.signup.quotes[0].quote, /verification code to that address/);
  assert.equal(steps.signup.quotes[0].url, "https://acme.dev/llms.txt");
  assert.ok(doc.onboarding.patterns[0].needs.includes("inbox"));
  const rows = renderSteps(buildAudit({ doc, funnel: (await inspect({ url: "https://acme.dev/", version: "test", runId: "r", fetchSource: pagesFrom(gated) })).funnel, answers: answers({}), task: "t", runId: "r", version: "test" }), plain).join("\n");
  assert.match(rows, /"[^"]*verification code[^"]*"\s+\(\/llms\.txt\)/, rows);
  for (const line of rows.split("\n")) assert.ok([...line].length <= 80, line);
});

test("Track-like text: a negative and a customer example never make an inbox requirement", async () => {
  const negative = await check(pagesFrom({
    "https://acme.dev/": home,
    "https://acme.dev/llms.txt": "# Acme\n\nPOST https://acme.dev/v1/signup returns a key with no account, email or browser. Acme needs no inbox verification.\n\nFor a step your API never sees, such as opening a verification email, send an onboarding_step event.\n",
  }));
  assert.doesNotMatch(negative.steps.signup.reason, /inbox/);
  assert.equal(negative.steps.signup.quotes, undefined);
  // The negative is authoritative over a sign-up sentence elsewhere on the site.
  const both = await check(pagesFrom({
    "https://acme.dev/": home,
    "https://acme.dev/llms.txt": "# Acme\n\nPOST https://acme.dev/v1/signup takes no email and sends nothing to confirm.\n",
    "https://acme.dev/docs.md": "# Docs\n\nTo sign up as a person, enter the verification code we email you.\n",
  }));
  assert.doesNotMatch(both.steps.signup.reason, /inbox/);
  // An example alone, with a real signup and no negative, is still not a requirement.
  const example = await check(pagesFrom({
    "https://acme.dev/": home,
    "https://acme.dev/llms.txt": "# Acme\n\nAn agent can sign up in one API call: POST https://acme.dev/v1/signup.\n\nTrack your own onboarding steps, such as a verification email your users open after they sign up.\n",
  }));
  assert.equal(example.steps.signup.state, "agent_can");
  assert.doesNotMatch(example.steps.signup.reason, /inbox/);
});

// The rule, over every recorded real product: a step that says the product needs or requires something shows the
// sentence it came from. "The pages read document no way for an agent to sign up. A person may have to create the
// account" is about what was not found, so there is no sentence to quote; it says so and is left out here.
const REQUIREMENT = /\b[Nn]eeds an?\b|\b[Rr]equires?\b|\bmention paying\b|\bmay have to check out\b/;
const FIXTURES = ["onboarding", "pay"].flatMap((dir) => readdirSync(new URL(`../fixtures/${dir}/`, import.meta.url)).filter((f) => f.endsWith(".json.gz")).map((f) => [dir, f]));
for (const [dir, file] of FIXTURES) {
  test(`${dir}/${file.replace(".json.gz", "")}: every requirement a step states carries a quote`, async () => {
    const data = recorded(dir, file);
    const { audit } = await check(replayFrom(data.responses), data.url || `https://${data.host}/`);
    for (const s of audit.steps) {
      if (!REQUIREMENT.test(s.reason) || s.basis === "tested") continue;
      assert.ok(s.quotes?.length, `${s.id} says "${s.reason}" with no quote`);
      for (const q of s.quotes) assert.ok(q.quote && q.url, JSON.stringify(q));
    }
  });
}

// Each rule that can read a mention as a requirement, with the mention and with the real thing.
test("expiry: \"never deleted\" is not an account that expires", async () => {
  const kept = await check(pagesFrom({ "https://acme.dev/": home, "https://acme.dev/llms.txt": "# Acme\n\nAn agent can sign up in one API call: POST https://acme.dev/v1/signup.\nAnonymous accounts are never deleted or removed.\n" }));
  assert.deepEqual(kept.doc.onboarding.patterns.map((p) => p.id), ["agent_is_customer"]);
  const expires = await check(pagesFrom({ "https://acme.dev/": home, "https://acme.dev/llms.txt": "# Acme\n\nAn agent can sign up in one API call: POST https://acme.dev/v1/signup.\nAnonymous accounts are deleted after 7 days.\n" }));
  assert.deepEqual(expires.doc.onboarding.patterns.map((p) => p.id), ["try_then_claim"]);
});

test("restricted: \"not restricted until verified\" is not limited access", async () => {
  const open = await check(pagesFrom({ "https://acme.dev/": home, "https://acme.dev/llms.txt": "# Acme\n\nAn agent can sign up in one API call: POST https://acme.dev/v1/signup.\nNew accounts are not restricted until verified.\n" }));
  assert.ok(!open.doc.onboarding.patterns.some((p) => p.id === "limited_until_claimed"));
  const limited = await check(pagesFrom({ "https://acme.dev/": home, "https://acme.dev/llms.txt": "# Acme\n\nAn agent can sign up in one API call: POST https://acme.dev/v1/signup.\nThe agent can only send email to its owner until verified.\n" }));
  assert.ok(limited.doc.onboarding.patterns.some((p) => p.id === "limited_until_claimed"));
});

test("person-first access: \"cannot sign in to the dashboard\" is not a person creating the key", async () => {
  const negated = await check(pagesFrom({ "https://acme.dev/": home, "https://acme.dev/llms.txt": "# Acme\n\nAn agent can sign up in one API call: POST https://acme.dev/v1/signup.\nNo project key can sign in to the dashboard.\n" }));
  assert.ok(!negated.doc.onboarding.patterns.some((p) => p.id === "existing_account"));
  const real = await check(pagesFrom({ "https://acme.dev/": home, "https://acme.dev/llms.txt": "# Acme\n\nIf you don't have one, create an API key in the dashboard.\n" }));
  assert.ok(real.doc.onboarding.patterns.some((p) => p.id === "existing_account"));
});

test("x402: a free product that names x402 is not paid per request; a negated mention is not either", async () => {
  const free = await check(pagesFrom({
    "https://acme.dev/": home,
    "https://acme.dev/llms.txt": "# Acme\n\nAn agent can sign up in one API call: POST https://acme.dev/v1/signup.\nThe x402 and Stripe Projects runs settle a real payment.\n",
    "https://acme.dev/pricing.json": JSON.stringify({ plans: [{ id: "free", price: { amount: 0, currency: "USD" } }] }),
  }));
  assert.ok(!free.doc.onboarding.patterns.some((p) => p.id === "pay_per_request"));
  assert.equal(free.steps.pay.state, "not_applicable");
  const negated = await check(pagesFrom({ "https://acme.dev/": home, "https://acme.dev/llms.txt": "# Acme\n\nAn agent can sign up in one API call: POST https://acme.dev/v1/signup. No x402 payment is needed.\n" }));
  assert.ok(!negated.doc.onboarding.patterns.some((p) => p.id === "pay_per_request"));
});

test("CLI signup: a command followed by prose about signup is not a CLI signup", async () => {
  const prose = await check(pagesFrom({ "https://acme.dev/": home, "https://acme.dev/llms.txt": "# Acme\n\nAn agent can sign up in one API call.\nTest it first: npx acme-cli check <url> runs a real agent through signup, key and first call.\n" }));
  assert.ok(!prose.doc.onboarding.patterns.some((p) => p.needs.includes("cli")), JSON.stringify(prose.doc.onboarding.patterns));
  const real = await check(pagesFrom({ "https://acme.dev/": home, "https://acme.dev/llms.txt": "# Acme\n\nAn agent can sign up in one API call.\nRun `npx acme-cli init --agent` to get a key.\n" }));
  assert.ok(real.doc.onboarding.patterns.some((p) => p.needs.includes("cli")), JSON.stringify(real.doc.onboarding.patterns));
  assert.equal(real.steps.signup.quotes[0].for, "cli");
});

test("Manage keeps needing a test when there is more than one plan or a paid one", async () => {
  const two = await check(pagesFrom({ "https://acme.dev/": home, "https://acme.dev/pricing.json": JSON.stringify({ plans: [{ id: "free", price: { amount: 0 } }, { id: "team", price: { amount: 0 } }] }) }));
  assert.equal(two.steps.pay.state, "not_applicable");
  assert.equal(two.steps.manage.state, "not_checked");
  const paid = await check(pagesFrom({ "https://acme.dev/": home, "https://acme.dev/pricing.json": JSON.stringify({ plans: [{ id: "pro", price: { amount: 20, currency: "USD", period: "month" } }] }) }));
  assert.equal(paid.steps.pay.state, "needs_person");
  assert.equal(paid.steps.manage.state, "not_checked");
});

// The inbox need counts only when the sentence's subject is the product's own signup. AgentID's llms-full.txt tells the
// general problem ("An agent signs up with its owner's email, reads the verification code out of the owner's inbox")
// and read as AgentID's signup needing an inbox; its llms.txt names `npx @agentmail/agentid-cli init`, a CLI app
// developers run to register an app, which read as a CLI signup.
test("www.agentid.com: no inbox and no CLI from text about the general problem or about integrating AgentID", async () => {
  const data = recorded("onboarding", "www.agentid.com.json.gz");
  const { doc, steps } = await check(replayFrom(data.responses), "https://www.agentid.com/");
  for (const p of doc.onboarding.patterns) assert.deepEqual(p.needs, [], `${p.id} needs ${p.needs}`);
  assert.doesNotMatch(steps.signup.reason, /inbox|shell/);
  assert.equal(steps.signup.quotes, undefined);
});

// AgentID read as "Try first, claim later" from a blog slug (/blog/can-an-ai-agent-sign-up-for-a-saas, in a sitemap and
// in a link) and from "owner claim", which on AgentID is an OpenID Connect field in a token, not a person claiming.
test("www.agentid.com: no claim pattern from a URL slug or an OIDC owner claim", async () => {
  const data = recorded("onboarding", "www.agentid.com.json.gz");
  const { doc } = await check(replayFrom(data.responses), "https://www.agentid.com/");
  const ids = doc.onboarding.patterns.map((p) => p.id);
  assert.ok(!ids.includes("try_then_claim") && !ids.includes("limited_until_claimed"), ids.join(", "));
  for (const p of doc.onboarding.patterns) for (const e of p.evidence) assert.doesNotMatch(e.quote, /<loc>|owner claim\b|sign-up-for/, `${p.id}: ${e.quote}`);
});

// AgentID's own llms-full.txt says the agent makes its account alone: "The agent creates and uses the account without a
// human present." That is the evidence, and nothing else: not a blog link, a token claim or a question.
test("www.agentid.com: Agent is the customer, from its own sentence about the agent creating the account", async () => {
  const data = recorded("onboarding", "www.agentid.com.json.gz");
  const { doc, steps } = await check(replayFrom(data.responses), "https://www.agentid.com/");
  assert.deepEqual(doc.onboarding.patterns.map((p) => p.id), ["agent_is_customer"]);
  assert.deepEqual(doc.onboarding.patterns[0].evidence.map((e) => e.quote), ["The agent creates and uses the account without a human present."]);
  assert.equal(steps.signup.state, "agent_can");
});

// A product whose agent-facing pages send the agent to sign up on another company's site, which is not read: Sign up
// and Access are unknown, not a person's job and not proven.
test("signup on another company's site: Sign up and Access need a test run", async () => {
  const { doc, steps } = await check(pagesFrom({ "https://acme.dev/": home, "https://acme.dev/llms.txt": "# Acme\n\n- [Get started](https://console.other.example/sign-up): Create an Other inbox to get an Acme identity\n" }));
  assert.equal(doc.onboarding.signupElsewhere.domain, "other.example");
  assert.equal(steps.signup.state, "not_checked");
  assert.match(steps.signup.reason, /other\.example, another company's site/);
  assert.equal(steps.access.state, "not_checked");
});

test("claim: \"the owner claims the workspace\" counts; an OIDC \"owner claim\" in a token does not", async () => {
  const signup = "POST https://acme.dev/v1/agents/signup creates an account and returns a key.\n\n";
  const real = await check(pagesFrom({ "https://acme.dev/": home, "https://acme.dev/llms.txt": `# Acme\n\n${signup}Later the owner claims the workspace from a link.\n` }));
  assert.ok(real.doc.onboarding.patterns.some((p) => p.id === "try_then_claim"));
  const oidc = await check(pagesFrom({ "https://acme.dev/": home, "https://acme.dev/llms.txt": `# Acme\n\n${signup}Your app never receives a sign-in with the requested owner claim quietly missing.\n` }));
  assert.ok(!oidc.doc.onboarding.patterns.some((p) => p.id === "try_then_claim"));
});

test("signup: an agent-sign-up URL slug or a question is not a way in; an FAQ answer is", async () => {
  const slug = await check(pagesFrom({ "https://acme.dev/": home, "https://acme.dev/llms.txt": "# Acme\n\nRead [the post](/blog/can-an-ai-agent-sign-up-for-a-saas) on agents.\n" }));
  assert.ok(!slug.doc.onboarding.patterns.some((p) => ["try_then_claim", "agent_is_customer", "limited_until_claimed"].includes(p.id)));
  const question = await check(pagesFrom({ "https://acme.dev/": home, "https://acme.dev/llms.txt": "# Acme\n\n## How can you tell an agent signup from a human one?\n\nLook at the user agent.\n" }));
  assert.ok(!question.doc.onboarding.patterns.some((p) => p.id === "agent_is_customer"));
  const faq = await check(pagesFrom({ "https://acme.dev/": home, "https://acme.dev/llms.txt": "# Acme\n\n## Can an agent sign up?\n\nYes. Agents can sign up in one API call.\n" }));
  assert.ok(faq.doc.onboarding.patterns.some((p) => p.id === "agent_is_customer"));
});

// Products whose signup really sends a code or link keep the need, each with its own sentence. The ones 0.8.3 cleared
// stay cleared.
const INBOX = {
  "telnyx.com": "Step 4 of the signup flow requires retrieving a session token from a magic link sent to an email address.",
  "inkbox.ai": "The human receives a verification email with a 6-digit code.",
  "agentmail.to": "An OTP will be sent to that email.",
  "aisend.app": "Click the link in the verification email \u2014 sending is blocked until you do",
  "www.cosmicjs.com": "The project starts in **restricted mode** (\"unclaimed\") with conservative limits, an OTP is emailed to the human, and the human paste the code back to the agent to claim full free-tier access.",
  "agentline.cloud": "**Headless fallback** (no browser tool and no human): `POST /v1/auth/otp` → `POST /v1/auth/verify` → write `api_key` from the raw HTTP body.",
};
for (const [host, sentence] of Object.entries(INBOX)) {
  test(`${host}: still needs an inbox, quoting its own signup`, async () => {
    const data = recorded("onboarding", `${host}.json.gz`);
    const { steps } = await check(replayFrom(data.responses), `https://${host}/`);
    assert.match(steps.signup.reason, /Needs an inbox the agent can read\./);
    const q = steps.signup.quotes.find((x) => x.for === "inbox");
    assert.equal(q.quote, sentence);
  });
}
for (const host of ["firecrawl.dev", "mem0.ai", "moltbook.com", "neon.com", "paywithlocus.com", "www.agentid.com", "alg.katrinalaszlo.com", "resend.com"]) {
  test(`${host}: no inbox need`, async () => {
    const data = recorded("onboarding", `${host}.json.gz`);
    const { doc } = await check(replayFrom(data.responses), `https://${host}/`);
    for (const p of doc.onboarding.patterns) assert.ok(!p.needs.includes("inbox"), `${p.id}: ${JSON.stringify(p.needsEvidence?.inbox)}`);
  });
}

test("inbox: a generic \"an agent signs up\" narrative is not the product's signup; \"Sign up for Acme\" and \"we email\" are", async () => {
  const signup = "POST https://acme.dev/v1/agents/signup creates an account and returns a key.\n\n";
  const story = await check(pagesFrom({
    "https://acme.dev/": home,
    "https://acme.dev/llms.txt": `# Acme\n\n${signup}## Why Acme\n\nAn agent signs up with its owner's email, reads the verification code out of the owner's inbox, and sometimes types in the owner's card.\n`,
  }));
  assert.doesNotMatch(story.steps.signup.reason, /inbox/);
  const named = await check(pagesFrom({ "https://acme.dev/": home, "https://acme.dev/llms.txt": `# Acme\n\n${signup}To sign up for Acme as a person, enter the verification code from your inbox.\n` }));
  assert.match(named.steps.signup.reason, /inbox/);
  const we = await check(pagesFrom({ "https://acme.dev/": home, "https://acme.dev/llms.txt": `# Acme\n\n${signup}After that call we email the owner a verification code.\n` }));
  assert.match(we.steps.signup.reason, /inbox/);
  const section = await check(pagesFrom({ "https://acme.dev/": home, "https://acme.dev/llms.txt": `# Acme\n\n${signup}## Quick start\n\n1. Call the signup endpoint.\n2. Click the link in the verification email.\n` }));
  assert.match(section.steps.signup.reason, /inbox/);
  assert.deepEqual({ quote: section.steps.signup.quotes[0].quote, label: section.steps.signup.quotes[0].label }, { quote: "Click the link in the verification email.", label: undefined });
});
