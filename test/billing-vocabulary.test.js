import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { buildInterface } from "../src/interface/index.js";
import { inspect } from "../src/audit/index.js";
import { productHost } from "../src/interface/sources.js";

// Billing and agent-infrastructure products write about agents, customers, subscriptions and payments as things they
// manage for their own customers. None of that is an agent starting with the product. MarginFront (usage billing for
// AI-agent companies, recorded 2026-10-07) once read as "Agent is the customer" on "Link the plan to the agent via
// POST /v1/pricing-plans/:planId/agents", while its docs say a person gets the key from the dashboard.

const replayFrom = (responses) => async (url) => responses[url] || { ok: false, status: 0, url, contentType: "", headers: {}, text: "", error: "not recorded" };
const marginfront = () => replayFrom(JSON.parse(gunzipSync(readFileSync(new URL("../fixtures/onboarding/marginfront.com.json.gz", import.meta.url)))).responses);
const llmsOnly = (text) => {
  const pages = { "https://acme.dev/": "<html><head><title>Acme</title></head><body>Acme</body></html>", "https://acme.dev/llms.txt": `# Acme\n\n${text}\n` };
  return async (url) => (pages[url] ? { ok: true, status: 200, url, contentType: url.endsWith(".txt") ? "text/plain" : "text/html", headers: {}, text: pages[url] } : { ok: false, status: 404, url, contentType: "text/html", headers: {}, text: "" });
};
const AGENT_FIRST = ["try_then_claim", "limited_until_claimed", "agent_is_customer", "agent_identity", "pay_per_request"];

test("marginfront.com: a person gets the key, the API is documented in text, and its llms.txt has links", async () => {
  const { doc, funnel } = await inspect({ url: "https://marginfront.com/", version: "test", runId: "r", fetchSource: marginfront() });
  assert.deepEqual(doc.onboarding.patterns.filter((p) => AGENT_FIRST.includes(p.id)).map((p) => p.id), []);
  const existing = doc.onboarding.patterns.find((p) => p.id === "existing_account");
  assert.equal(existing.status, "documented");
  assert.ok(existing.evidence.some((e) => /API key \(`mf_sk_\*`\) from the dashboard/.test(e.quote)), JSON.stringify(existing.evidence));
  const steps = Object.fromEntries(funnel.steps.map((s) => [s.id, s]));
  assert.equal(steps.signup.state, "handoff");
  assert.match(steps.signup.reason, /A person creates the account and gives the agent a key/);
  assert.equal(steps.access.state, "handoff");
  assert.equal(doc.interfaces.api.exists.verdict, "partial");
  assert.equal(doc.interfaces.api.exists.rule, "api_base_url_and_endpoints_in_text");
  assert.equal(doc.interfaces.api.exists.baseUrl, "https://api.marginfront.com/v1");
  assert.equal(doc.interfaces.api.machineReadableSpec.verdict, "no");
  assert.equal(steps.use.state, "agent_can");
  assert.match(steps.use.reason, /base URL \(https:\/\/api\.marginfront\.com\/v1\) and list \d+ endpoints in page text\. No OpenAPI spec was found/);
  assert.match(steps.use.tip, /OpenAPI/);
  assert.match(steps.discover.reason, /\/llms\.txt with [1-9]\d* links/);
  // api.marginfront.com is the product's own domain; apiHosts lists only API hosts on other domains.
  assert.deepEqual(doc.onboarding.apiHosts, []);
});

// Each would make an agent-first pattern before these rules; all from billing or agent-infra wording.
const NOT_AGENT_FIRST = [
  "6. Link the plan to the agent via `POST /v1/pricing-plans/:planId/agents`.\n7. Create a subscription tying the customer to the plan via `POST /v1/subscriptions`.",
  "Agents:\n  POST   /v1/agents: create agent\n  GET    /v1/agents: list agents",
  "Missing? Create one: `POST /v1/agents {\"name\": \"My Agent\"}`. Save the returned ID.",
  "Your customers can check out without an account.",
  "Add end users with POST /v1/end-users/register before their first invoice.",
  "Charge for API requests, tool calls, and content via x402.",
  "Accept x402 payments for your API in one line.",
  "Monetize your MCP server with x402.",
  "Receive OTP codes so your agent can sign up and verify.",
  "An agent signs up with its owner's email, reads the verification mail, and carries on.",
];
for (const quote of NOT_AGENT_FIRST) {
  test(`"${quote.slice(0, 40)}…" is not an agent starting with the product`, async () => {
    const { onboarding } = await buildInterface({ url: "https://acme.dev/", version: "test", fetchSource: llmsOnly(quote) });
    assert.deepEqual(onboarding.patterns.filter((p) => AGENT_FIRST.includes(p.id)).map((p) => p.id), []);
  });
}

// What still counts: the docs say the agent signs up here, or show the signup call.
const AGENT_SIGNS_UP = [
  "Your agent can sign up.",
  "Agents create their own API keys.",
  "POST /v1/signup returns a key, with no person.",
  "```http\nPOST https://api.acme.dev/v1/agent/identity\n```",
  "Your customers pay by invoice. Agents: POST /v1/agents/register returns a key.",
];
for (const quote of AGENT_SIGNS_UP) {
  test(`"${quote.slice(0, 40)}…" still reads as an agent signing up`, async () => {
    const { onboarding } = await buildInterface({ url: "https://acme.dev/", version: "test", fetchSource: llmsOnly(quote) });
    assert.equal(onboarding.primary, "agent_is_customer", onboarding.patterns.map((p) => p.id).join(", "));
  });
}

test("a seller's x402 sentence does not hide a paying one further down", async () => {
  const quote = "Charge for API requests via x402.\n\nCall search with no account: each request pays $0.01 over x402.";
  const { onboarding } = await buildInterface({ url: "https://acme.dev/", version: "test", fetchSource: llmsOnly(quote) });
  const p = onboarding.patterns.find((x) => x.id === "pay_per_request");
  assert.ok(p, onboarding.patterns.map((x) => x.id).join(", "));
  assert.match(p.evidence[0].quote, /each request pays/);
});

test("\"Get a secret API key from the dashboard\" is a person setting up access, and the funnel hands off", async () => {
  const { doc, funnel } = await inspect({ url: "https://acme.dev/", version: "test", runId: "r", fetchSource: llmsOnly("1. Get a secret API key (`ak_sk_*`) from the dashboard under Build > API keys.") });
  assert.deepEqual(doc.onboarding.patterns.map((p) => p.id), ["existing_account"]);
  assert.equal(funnel.steps.find((s) => s.id === "signup").state, "handoff");
});

const API_TEXT = "Base URL: https://api.acme.dev/v1\nAuth: x-api-key header\n\nGET /v1/verify: check the key\nPOST /v1/usage/record: record usage\n";
test("a base URL on the product's domain and listed endpoints are an API documented in text", async () => {
  const { doc, funnel } = await inspect({ url: "https://acme.dev/", version: "test", runId: "r", fetchSource: llmsOnly(API_TEXT) });
  assert.equal(doc.interfaces.api.exists.verdict, "partial");
  assert.equal(doc.interfaces.api.exists.endpointCount, 2);
  const use = funnel.steps.find((s) => s.id === "use");
  assert.equal(use.state, "agent_can");
  assert.ok(use.basedOn.length);
});

for (const [label, text] of [
  ["a base URL on another company's domain", API_TEXT.replace("https://api.acme.dev/v1", "https://api.openai.com/v1")],
  ["a single endpoint", "Base URL: https://api.acme.dev/v1\n\nGET /v1/verify\n"],
  ["endpoints with no base URL", "GET /v1/verify\nPOST /v1/usage/record\n"],
]) {
  test(`${label} is not an API documented in text`, async () => {
    const { doc, funnel } = await inspect({ url: "https://acme.dev/", version: "test", runId: "r", fetchSource: llmsOnly(text) });
    assert.equal(doc.interfaces.api.exists.verdict, "unknown");
    assert.notEqual(funnel.steps.find((s) => s.id === "use").state, "agent_can");
  });
}

test("bare URLs in llms.txt count as links; URLs in code do not", async () => {
  const text = "- Website: https://acme.dev\n- Docs: https://docs.acme.dev\n- [API](https://acme.dev/api)\n\n```bash\ncurl https://api.acme.dev/v1/verify\n```\nRun `curl https://api.acme.dev/v1/x` to test.";
  const doc = await buildInterface({ url: "https://acme.dev/", version: "test", fetchSource: llmsOnly(text) });
  assert.equal(doc.machineAccess.hasAgentReadableIndex.reason, "/llms.txt with 3 links");
});

test("firecrawl.dev's agent/auth call is an HTTP signup, so the agent needs no CLI", async () => {
  const responses = JSON.parse(gunzipSync(readFileSync(new URL("../fixtures/onboarding/firecrawl.dev.json.gz", import.meta.url)))).responses;
  const { onboarding } = await buildInterface({ url: "https://firecrawl.dev/", version: "test", fetchSource: replayFrom(responses) });
  const p = onboarding.patterns.find((x) => x.id === "agent_is_customer");
  assert.ok(p, onboarding.patterns.map((x) => x.id).join(", "));
  assert.ok(!p.needs.includes("cli"), p.needs.join(", "));
});

// Signup calls by path: what ends the path decides, and a call under the signup path is something else.
for (const [quote, signsUp] of [
  ["```http\nPOST https://www.acme.dev/agent/auth\n```", true],
  ["Agents call POST /v1/agents/sign_up and get a key.", true],
  ["Call POST /v1/agents/onboard with a name; it returns a key.", true],
  ["A person approves with POST /v1/signup/{signup_id}/approve.", false],
  ["Templates: POST /v1/signup{?invite} is reserved.", false],
]) {
  test(`"${quote.slice(0, 40)}…" ${signsUp ? "is" : "is not"} a signup call`, async () => {
    const { onboarding } = await buildInterface({ url: "https://acme.dev/", version: "test", fetchSource: llmsOnly(quote) });
    assert.equal(onboarding.patterns.some((p) => AGENT_FIRST.includes(p.id)), signsUp, onboarding.patterns.map((p) => p.id).join(", "));
  });
}

// "Agent(s) can sign up" counts when it says the agent signs up here; QA's cases, each from live wording.
for (const [quote, signsUp] of [
  ["Your agent can sign up in one API call.", true],
  ["Agents can sign up and get an API key.", true],
  ["An agent can sign up, get a key, and start calling the API.", true],
  ["Your agent can sign up — no forms.", true],
  ["**Agents can sign up** (beta).", true],
  ["Agents can sign up for an account.", true],
  ["An agent creates its own account.", true],
  ["No agent can sign up.", false],
  ["Find apps where agents can sign up.", false],
  ["Where agents can sign up: AgentID, Clerk and more.", false],
  ["Agents can sign up: Clerk, Neon and Turso take AgentID.", false],
  ["Receive OTP codes so your agent can sign up and verify.", false],
]) {
  test(`"${quote.slice(0, 40)}…" ${signsUp ? "reads" : "does not read"} as an agent signing up here`, async () => {
    const { onboarding } = await buildInterface({ url: "https://acme.dev/", version: "test", fetchSource: llmsOnly(quote) });
    assert.equal(onboarding.primary === "agent_is_customer", signsUp, onboarding.patterns.map((p) => p.id).join(", "));
  });
}

// Live wording, read 2026-10-07, that set or hid a pattern before these rules.
for (const [label, quote, expected] of [
  ["Browser Use: signup turned off", "Agent signup is off. Create an API key in Cloud.", null],
  ["fly.io: a person without an account", "`fly auth signup` is the same flow for a human without an account.", null],
  ["fly.io: OAuth client registration, hard-wrapped", "Your client follows that to the authorization server, registers itself\ndynamically, and runs the browser flow; the human approves in the browser.", null],
  ["Browser Use: x402 without a human is paying, not signing up", "Or use x402 without a human.", "pay_per_request"],
  ["Cosmic: \"your client\" is an HTTP client", "Point your client at POST /v3/agents/sign-up to create a project.", "agent_is_customer"],
  ["Browser Use: the product accepts x402", "Browser Use Cloud now accepts payment in USDC over the x402 protocol.", "pay_per_request"],
  ["Stripe: paying at another site", "Agents can now contribute directly to Acme Climate at [climate.acme.org](https://climate.acme.org) using [MPP](https://mpp.dev) or [x402](https://x402.org).", null],
  ["Stripe: describing the protocol", "x402 is the internet's payment standard for agentic payments at scale.", null],
  ["E2B: access through Stripe Projects is the developer's account", "Now, the agent can use Stripe Projects to discover, provision, and authenticate a secure Acme sandbox, getting credentials in its environment so it can immediately start running code, without a human touching a dashboard.", null],
  ["paying on the product's own site", "Agents pay per request at api.acme.dev with x402.", "pay_per_request"],
]) {
  test(`${label}`, async () => {
    const { onboarding } = await buildInterface({ url: "https://acme.dev/", version: "test", fetchSource: llmsOnly(quote) });
    assert.equal(onboarding.primary, expected, onboarding.patterns.map((p) => p.id).join(", "));
  });
}

test("pay-per-request words in a sitemap or on a template page are not the product taking payment", async () => {
  const pages = {
    "https://acme.dev/": "<html><head><title>Acme</title></head><body><a href=\"/templates/next.js/x402-ai-starter\">Starter</a></body></html>",
    "https://acme.dev/sitemap.xml": "<urlset><url><loc>https://acme.dev/blog/x402-launch</loc></url></urlset>",
    "https://acme.dev/templates/next.js/x402-ai-starter": "<html><body>x402 AI Starter. A fullstack template for using x402 with MCP.</body></html>",
  };
  const fetchSource = async (url) => (pages[url] ? { ok: true, status: 200, url, contentType: url.endsWith(".xml") ? "application/xml" : "text/html", headers: {}, text: pages[url] } : { ok: false, status: 404, url, contentType: "text/html", headers: {}, text: "" });
  const doc = await buildInterface({ url: "https://acme.dev/", version: "test", fetchSource });
  assert.ok(doc.observations.some((o) => o.ok && /templates/.test(o.url)), "the template page was read");
  assert.ok(!doc.onboarding.patterns.some((p) => p.id === "pay_per_request"));
});

test("one endpoint written three ways counts once, and other companies' endpoints do not count", async () => {
  const one = await inspect({ url: "https://acme.dev/", version: "test", runId: "r", fetchSource: llmsOnly("REST API\n\nBase URL: https://api.acme.dev/v1\n\nPOST /emails\nPOST /v1/emails\ncurl -X POST https://api.acme.dev/v1/emails\nGET /v1/verify\n") });
  assert.equal(one.doc.interfaces.api.exists.endpointCount, 2);
  const other = await inspect({ url: "https://acme.dev/", version: "test", runId: "r", fetchSource: llmsOnly("REST API\n\nBase URL: https://api.acme.dev/v1\n\nGET /v1/verify\nGET https://api.openai.com/v1/models\nPOST https://api.openai.com/v1/chat/completions\n") });
  assert.equal(other.doc.interfaces.api.exists.verdict, "unknown");
});

for (const [label, text] of [
  ["a tutorial's app URL", "Deploy it. The base URL is https://my-app.acme.dev\n\nGET /health\nGET /weather\n"],
  ["the reader's own base URL", "Set your base URL: https://api.acme.dev/v1 and add routes.\n\nGET /v1/weather\nGET /v1/forecast\n"],
  ["a config variable", "BASE_URL: https://acme.dev\n\nAdd a paywall to 'GET /weather' and 'GET /forecast'.\n"],
]) {
  test(`${label} is not the product's API base URL`, async () => {
    const { doc } = await inspect({ url: "https://acme.dev/", version: "test", runId: "r", fetchSource: llmsOnly(text) });
    assert.equal(doc.interfaces.api.exists.verdict, "unknown");
  });
}

test("bare URLs count once, without trailing punctuation, and templated URLs are not links", async () => {
  const text = "- Site: https://acme.dev.\n- Again: https://acme.dev\n- Workspace: https://{workspace}.acme.dev\n- Docs: https://docs.acme.dev,";
  const doc = await buildInterface({ url: "https://acme.dev/", version: "test", fetchSource: llmsOnly(text) });
  assert.equal(doc.machineAccess.hasAgentReadableIndex.reason, "/llms.txt with 2 links");
});

// Pages that once took quadratic time: every match rescanned the page for its sentence, and every unclosed "[" the
// rest of the file for its "]". The bound is loose on purpose: 80-90 ms on an idle machine, past a second with the
// whole suite running alongside, and a quadratic rescan takes far longer than either. It guards the shape of the
// work, not the speed of the machine it runs on.
test("a 2 MB page on one line with thousands of guarded matches does not rescan it", async () => {
  const text = "Your customers can check out without an account; ".repeat(42_000);
  const started = Date.now();
  const doc = await buildInterface({ url: "https://acme.dev/", version: "test", fetchSource: llmsOnly(text) });
  assert.ok(Date.now() - started < 2500, `${Date.now() - started} ms`);
  assert.deepEqual(doc.onboarding.patterns.filter((p) => AGENT_FIRST.includes(p.id)), []);
});

test("80 KB of unclosed \"[\" in llms.txt is read in under a second", async () => {
  const started = Date.now();
  await buildInterface({ url: "https://acme.dev/", version: "test", fetchSource: llmsOnly("[".repeat(80_000)) });
  assert.ok(Date.now() - started < 1000, `${Date.now() - started} ms`);
});

test("a guard phrase hard-wrapped across lines still guards", async () => {
  const { onboarding } = await buildInterface({ url: "https://acme.dev/", version: "test", fetchSource: llmsOnly("Your\ncustomers can check out without an account.") });
  assert.deepEqual(onboarding.patterns.filter((p) => AGENT_FIRST.includes(p.id)).map((p) => p.id), []);
});

test("a BASE_URL config variable is not the API base URL, even on an api. host", async () => {
  const { doc } = await inspect({ url: "https://acme.dev/", version: "test", runId: "r", fetchSource: llmsOnly("REST API config\n\nBASE_URL: https://api.acme.dev\n\nGET /weather\nGET /forecast\n") });
  assert.equal(doc.interfaces.api.exists.verdict, "unknown");
});

test("/api/v1/emails and its unversioned alias /emails are one endpoint", async () => {
  const { doc } = await inspect({ url: "https://acme.dev/", version: "test", runId: "r", fetchSource: llmsOnly("REST API Reference Base URL: https://api.acme.dev\n\nPOST /api/v1/emails\nPOST /emails\nGET /api/v1/domains\n") });
  assert.equal(doc.interfaces.api.exists.endpointCount, 2);
});

// The cost bound, stated as behaviour: a page gets 200 tries per signal, so a real phrase after 200 skipped ones on the
// same page is not read from it.
test("guarded matches are tried at most 200 times a page", async () => {
  const skipped = "Your customers can check out without an account.\n";
  const near = await buildInterface({ url: "https://acme.dev/", version: "test", fetchSource: llmsOnly(`${skipped.repeat(199)}No account is needed: your agent signs itself up.\n`) });
  assert.equal(near.onboarding.primary, "agent_is_customer");
  const far = await buildInterface({ url: "https://acme.dev/", version: "test", fetchSource: llmsOnly(`${skipped.repeat(200)}No account is needed: your agent signs itself up.\n`) });
  assert.equal(far.onboarding.primary, null);
});

// A platform-hosted product's docs on a sibling tenant are another site, so they are not read, and the reason says so.
test("when docs on another host were skipped and no way to start was found, the reason says links to other hosts were not read", async () => {
  const pages = { "https://foo.vercel.app/": "<html><head><title>Foo</title></head><body><a href=\"https://foo-docs.vercel.app/docs\">Docs</a> <a href=\"https://foo-docs.vercel.app/docs/authentication\">Auth</a> <a href=\"https://x.com/foo\">X</a></body></html>" };
  const fetched = [];
  const fetchSource = async (url) => {
    fetched.push(url);
    return pages[url] ? { ok: true, status: 200, url, contentType: "text/html", headers: {}, text: pages[url] } : { ok: false, status: 404, url, contentType: "text/html", headers: {}, text: "" };
  };
  const doc = await buildInterface({ url: "https://foo.vercel.app/", version: "test", fetchSource });
  assert.ok(!fetched.some((url) => url.startsWith("https://foo-docs.vercel.app/")), "the sibling tenant was not fetched");
  // x.com is skipped too, but a profile link is not one the inspection would have followed, so it is not counted.
  assert.equal(doc.otherHostsSkipped, 1);
  assert.equal(doc.onboarding.primary, null);
  assert.match(doc.onboarding.reason, /^No way for an agent to start was found in the sources read\. Links to other hosts were not read\. This is not evidence that none exists\.$/);
});

test("with nothing skipped, the no-way-in reason does not mention other hosts", async () => {
  const doc = await buildInterface({ url: "https://acme.dev/", version: "test", fetchSource: llmsOnly("We make widgets.") });
  assert.equal(doc.otherHostsSkipped, 0);
  assert.doesNotMatch(doc.onboarding.reason, /other hosts/);
});

// Third-party docs a product links (Render's and Exa's pages link nextjs.org, docker.com, raw.githubusercontent.com)
// are someone else's, so skipping them is no gap in reading the product.
test("skipped third-party docs links do not count or add the note", async () => {
  const links = ["https://nextjs.org/docs", "https://docs.docker.com/get-started", "https://raw.githubusercontent.com/acme/sdk/main/docs/api.md", "https://developer.mozilla.org/en-US/docs/Web/HTTP"].map((href) => `<a href="${href}">Docs</a>`).join(" ");
  const pages = { "https://acme.dev/": `<html><head><title>Acme</title></head><body>${links}</body></html>` };
  const fetchSource = async (url) => (pages[url] ? { ok: true, status: 200, url, contentType: "text/html", headers: {}, text: pages[url] } : { ok: false, status: 404, url, contentType: "text/html", headers: {}, text: "" });
  const doc = await buildInterface({ url: "https://acme.dev/", version: "test", fetchSource });
  assert.equal(doc.otherHostsSkipped, 0);
  assert.doesNotMatch(doc.onboarding.reason, /other hosts/);
});

for (const [target, host, own] of [
  ["https://acme.dev/", "docs.acme.io", true],
  ["https://acme.dev/", "acmedocs.com", true],
  ["https://acme.dev/", "acme-api.com", true],
  ["https://foo.vercel.app/", "foo-docs.vercel.app", true],
  ["https://foo.vercel.app/", "bar-docs.vercel.app", false],
  ["https://acme.dev/", "acmelabs.com", false],
  ["https://vercel.com/", "nextjs.org", false],
  ["https://github.com/", "raw.githubusercontent.com", false],
]) {
  test(`${host} ${own ? "looks like" : "is not"} ${new URL(target).hostname}'s own host`, () => {
    assert.equal(productHost(host, target), own);
  });
}

test("\"Agents can sign up and get an API key instantly.\" reads as an agent signing up", async () => {
  const { onboarding } = await buildInterface({ url: "https://acme.dev/", version: "test", fetchSource: llmsOnly("Agents can sign up and get an API key instantly.") });
  assert.equal(onboarding.primary, "agent_is_customer");
});

for (const quote of ["Clients register with POST /oauth/register before the browser flow.", "curl -X POST https://auth.acme.dev/oauth2/register -d '{\"client_name\":\"x\"}'", "POST /connect/register returns a client_id."]) {
  test(`"${quote.slice(0, 40)}…" (OAuth client registration) is not agent signup`, async () => {
    const { onboarding } = await buildInterface({ url: "https://acme.dev/", version: "test", fetchSource: llmsOnly(quote) });
    assert.deepEqual(onboarding.patterns.filter((p) => AGENT_FIRST.includes(p.id)).map((p) => p.id), []);
  });
}
