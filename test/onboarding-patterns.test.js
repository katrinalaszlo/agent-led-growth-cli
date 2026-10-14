import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { buildInterface } from "../src/interface/index.js";
import { inspect } from "../src/audit/index.js";

// Each agent-first product, recorded from its live public pages (scripts/record-onboarding-fixtures.mjs), must be
// recognised as the onboarding pattern its own docs describe. The expected labels come from reading those docs, not
// from this detector: see docs/onboarding-models-research.md.
const EXPECTED = {
  "neon.com": { primary: "try_then_claim" },
  "mem0.ai": { primary: "try_then_claim", needs: ["cli"] },
  "www.cloudflare.com": { primary: "try_then_claim", needs: ["cli"] },
  "app.tansohq.com": { primary: "try_then_claim" },
  "tansohq.com": { primary: "try_then_claim" },
  "www.cosmicjs.com": { primary: "limited_until_claimed" },
  "agentmail.to": { primary: "limited_until_claimed", also: ["pay_per_request"] },
  "inkbox.ai": { primary: "limited_until_claimed" },
  "telnyx.com": { primary: "agent_is_customer", also: ["pay_per_request"] },
  "aisend.app": { primary: "agent_is_customer" },
  "moltbook.com": { primary: "limited_until_claimed" },
  "projects.dev": { primary: "existing_account", needs: ["cli"] },
  "x402.org": { primary: "pay_per_request" },
  "archil.com": { primary: "agent_identity", also: ["existing_account"] },
  "keenable.ai": { primary: "agent_identity", also: ["pay_per_request"] },
  "paywithlocus.com": { primary: "try_then_claim", also: ["agent_identity", "pay_per_request"] },
  // AgentLine's skill.md documents an OTP signup and AgentID; its only expiry words were "GET /v1/events (auto-deletes
  // after read)", an event queue, which read as an account expiring until 2026-10-14.
  "agentline.cloud": { primary: "agent_is_customer", also: ["agent_identity"] },
  // A usage-billing product for AI-agent companies: its agents and customers are records it bills, and a person gets
  // the key from the dashboard. test/billing-vocabulary.test.js checks the funnel it produces.
  "marginfront.com": { primary: "existing_account" },
  // POST https://www.firecrawl.dev/agent/auth exchanges an agent platform's ID-JAG for an API key, over HTTP.
  "firecrawl.dev": { primary: "agent_is_customer", also: ["existing_account"] },
};

const replayFrom = (responses) => async (url) => responses[url] || { ok: false, status: 0, url, contentType: "", headers: {}, text: "", error: "not recorded" };

async function inspectFixture(host) {
  const { responses } = JSON.parse(gunzipSync(readFileSync(new URL(`../fixtures/onboarding/${host}.json.gz`, import.meta.url))));
  return buildInterface({ url: `https://${host}/`, version: "test", fetchSource: replayFrom(responses) });
}

for (const [host, expected] of Object.entries(EXPECTED)) {
  test(`${host} is recognised as ${expected.primary}`, async () => {
    const { onboarding, observations } = await inspectFixture(host);
    assert.equal(onboarding.primary, expected.primary, onboarding.patterns.map((p) => p.id).join(", "));
    const ids = onboarding.patterns.map((p) => p.id);
    for (const id of expected.also || []) assert.ok(ids.includes(id), `${host} also supports ${id}`);
    const primary = onboarding.patterns.find((p) => p.id === expected.primary);
    for (const need of expected.needs || []) assert.ok(primary.needs.includes(need), `${host} needs ${need}`);
    // A pattern is a claim the docs make, so each one carries the quote that makes it.
    const ok = new Set(observations.filter((o) => o.ok).map((o) => o.id));
    for (const p of onboarding.patterns) {
      assert.ok(p.evidence.length, `${host} ${p.id} has evidence`);
      for (const e of p.evidence) assert.ok(ok.has(e.obs) && e.quote.length > 0, `${host} ${p.id} quotes a page that was read`);
    }
  });
}

// The near-misses found while building this against real pages. Each would have mislabelled a product.
const pages = (text) => replayFrom({
  "https://example.com/": { ok: true, status: 200, url: "https://example.com/", contentType: "text/plain", headers: {}, text },
});

test("an expiring quote is not an expiring account", async () => {
  const doc = await buildInterface({ url: "https://example.com/", version: "test", fetchSource: pages("Agent signup: POST /v2/agents/sign-up returns a key. Quotes expire after 5 minutes.") });
  assert.equal(doc.onboarding.primary, "agent_is_customer");
});

test("a bare 402 is not pay-per-request, and an agentId field is not agent identity", async () => {
  const doc = await buildInterface({ url: "https://example.com/", version: "test", fetchSource: pages("Agent signup is available. Over the cap, sends fail with HTTP 402 Payment Required. GET /v3/agents/:agentId/messages") });
  const ids = doc.onboarding.patterns.map((p) => p.id);
  assert.ok(!ids.includes("pay_per_request"));
  assert.ok(!ids.includes("agent_identity"));
});

test("no onboarding language means no pattern, and says so without claiming there is none", async () => {
  const doc = await buildInterface({ url: "https://example.com/", version: "test", fetchSource: pages("We make great widgets. Contact sales.") });
  assert.equal(doc.onboarding.primary, null);
  assert.match(doc.onboarding.reason, /not evidence that none exists/);
});

// Products whose pages use agent words for features that are not an agent signing itself up: Postman's and Copilot's
// Agent Mode (Linear, GitHub), Twilio's WhatsApp sender self sign-up. Recorded 2026-10-05; each once read as agent signup.
const AGENT_FIRST = ["try_then_claim", "limited_until_claimed", "agent_is_customer", "agent_identity", "pay_per_request"];
for (const host of ["linear.app", "github.com", "twilio.com"]) {
  test(`${host} is not read as an agent signing itself up`, async () => {
    const { onboarding } = await inspectFixture(host);
    const agentFirst = onboarding.patterns.filter((p) => AGENT_FIRST.includes(p.id)).map((p) => p.id);
    assert.deepEqual(agentFirst, [], agentFirst.join(", "));
  });
}

// The quotes that fooled the detector on live pages, served from an agent-facing page (llms.txt).
const MISLEADING = [
  "Postman Agent Mode Integration – Linear. Connect Linear to Postman Agent Mode.",
  "Once you complete that flow, toggle Agent mode (located by the Copilot Chat text input) and the server will start.",
  "Register WhatsApp senders using Self Sign-up: Learn how to register a WhatsApp sender using the Self Sign-up in the console.",
];
for (const quote of MISLEADING) {
  test(`"${quote.slice(0, 40)}…" is not agent signup`, async () => {
    const pages = { "https://acme.dev/": "<html><head><title>Acme</title></head><body>Acme</body></html>", "https://acme.dev/llms.txt": `# Acme\n\n${quote}\n` };
    const fetchSource = async (url) => (pages[url] ? { ok: true, status: 200, url, contentType: url.endsWith(".txt") ? "text/plain" : "text/html", headers: {}, text: pages[url] } : { ok: false, status: 404, url, contentType: "text/html", headers: {}, text: "" });
    const { onboarding } = await buildInterface({ url: "https://acme.dev/", version: "test", fetchSource });
    assert.deepEqual(onboarding.patterns.filter((p) => AGENT_FIRST.includes(p.id)).map((p) => p.id), []);
  });
}

// A person handing an agent a key, as Buttondown's docs put it, is the person-first pattern, not "no way in".
test("\"manage your API keys at …\" reads as a person setting up access first", async () => {
  const pages = { "https://acme.dev/": "<html><head><title>Acme</title></head><body>Acme</body></html>", "https://acme.dev/llms.txt": "# Acme\n\nYou can manage your API keys at acme.dev/keys. Send the key as Authorization: Token KEY.\n" };
  const fetchSource = async (url) => (pages[url] ? { ok: true, status: 200, url, contentType: url.endsWith(".txt") ? "text/plain" : "text/html", headers: {}, text: pages[url] } : { ok: false, status: 404, url, contentType: "text/html", headers: {}, text: "" });
  const { onboarding } = await buildInterface({ url: "https://acme.dev/", version: "test", fetchSource });
  assert.ok(onboarding.patterns.some((p) => p.id === "existing_account"), onboarding.patterns.map((p) => p.id).join(", "));
});

// A product whose CLI takes a token a person made: the agent runs it unattended. The quotes are from the live docs,
// read 2026-10-05: Vercel's CLI page, GitHub's Copilot CLI setup and `gh auth login` manual.
const llmsOnly = (text) => {
  const pages = { "https://acme.dev/": "<html><head><title>Acme</title></head><body>Acme</body></html>", "https://acme.dev/llms.txt": `# Acme\n\n${text}\n` };
  return async (url) => (pages[url] ? { ok: true, status: 200, url, contentType: url.endsWith(".txt") ? "text/plain" : "text/html", headers: {}, text: pages[url] } : { ok: false, status: 404, url, contentType: "text/html", headers: {}, text: "" });
};
const CLI_TOKEN = [
  "In an environment where manual input is not possible, you can create a token on your tokens page and then authenticate using one of these methods: Set the VERCEL_TOKEN environment variable Pass the --token option to the command",
  "Use the COPILOT_GITHUB_TOKEN , GH_TOKEN , or GITHUB_TOKEN environment variable (in order of precedence).",
  "The default authentication mode is a web-based browser flow. Alternatively, use --with-token to pass in a personal access token (classic) on standard input.",
];
for (const quote of CLI_TOKEN) {
  test(`"${quote.slice(0, 40)}…" reads as a person making a token the agent's CLI uses`, async () => {
    const { onboarding } = await buildInterface({ url: "https://acme.dev/", version: "test", fetchSource: llmsOnly(quote) });
    const existing = onboarding.patterns.find((p) => p.id === "existing_account");
    assert.ok(existing, onboarding.patterns.map((p) => p.id).join(", "));
    assert.equal(existing.cli, "token");
    assert.match(existing.reason, /flag or an environment variable/);
  });
}

// Expiry wording about stored things is not an account awaiting an owner. The quotes are the two sentences that made
// supermemory.ai read as "try first, claim later" on the live leaderboard (its OpenAPI document's `forgetReason`
// example, and docs/concepts/graph-memory), read from the leaderboard document 2026-10-14.
const SUPERMEMORY_TTL = [
  `"forgetReason":{"description":"Optional reason for the scheduled forgetting. Only meaningful when forgetAfter is set.","example":"temporary project deadline","type":["string","null"]},"temporalContext":{"description":"Structured temporal metadata. Merged into the metadata JSON column.","type":"object"}`,
  "Automatic forgetting Time-based — temporary facts drop after they expire (“exam tomorrow”, “meeting at 3pm today”). Contradiction — updates win for “what’s true now.”",
];
test("a memory's TTL is not an agent signing up or an account expiring", async () => {
  const { onboarding } = await buildInterface({ url: "https://acme.dev/", version: "test", fetchSource: llmsOnly(SUPERMEMORY_TTL.join("\n\n")) });
  assert.deepEqual(onboarding.patterns.filter((p) => AGENT_FIRST.includes(p.id)).map((p) => p.id), [], onboarding.patterns.map((p) => p.id).join(", "));
});

// The same expiry words about a project are the claim pattern: Neon's auth.md and Cosmic's agent-signup page, from
// their leaderboard documents 2026-10-14.
const PROJECT_EXPIRY = [
  "Create and claim a temporary Neon project without an account. The unclaimed project dies at `expires_at` (72 hours today).",
  "The one-curl signup flow (`POST /v3/agents/sign-up`) creates a free-tier project + bucket. The project starts unclaimed: 50 objects, 5 MB of media, no AI credits, and it is deleted after 14 days unless the human verifies.",
];
for (const quote of PROJECT_EXPIRY) {
  test(`"${quote.slice(0, 40)}…" still reads as try first, claim later`, async () => {
    const { onboarding } = await buildInterface({ url: "https://acme.dev/", version: "test", fetchSource: llmsOnly(quote) });
    assert.equal(onboarding.primary, "try_then_claim", onboarding.patterns.map((p) => p.id).join(", "));
  });
}

// An auth scheme in the OpenAPI document says how a request is signed, not that a person makes the key. Turso's
// openapi.json declares `bearerAuth` and its llms.txt names API tokens and OAuth; nothing on the pages read says who
// creates the token, so no onboarding pattern is inferred and the funnel says what the pages read document.
test("bearer auth alone is not a person setting up access first", async () => {
  const spec = JSON.stringify({ openapi: "3.1.0", info: { title: "Turso" }, security: [{ bearerAuth: [] }], components: { securitySchemes: { bearerAuth: { type: "http", scheme: "bearer" } } }, paths: { "/v1/organizations": { get: { summary: "List organizations", responses: { 200: {} } } } } });
  const pages = {
    "https://acme.dev/": ["text/html", "<html><head><title>Acme</title></head><body>Acme</body></html>"],
    "https://acme.dev/llms.txt": ["text/plain", "# Acme\n\nAuthentication: API tokens via `turso auth api-tokens mint`, or OAuth 2.0 (authorization code + PKCE, dynamic client registration). Turso uses Bearer authentication, and requires your API token to be passed with a request.\n"],
    "https://acme.dev/openapi.json": ["application/json", spec],
  };
  const fetchSource = async (url) => (pages[url] ? { ok: true, status: 200, url, contentType: pages[url][0], headers: {}, text: pages[url][1] } : { ok: false, status: 404, url, contentType: "text/html", headers: {}, text: "" });
  const { doc, funnel } = await inspect({ url: "https://acme.dev/", version: "test", runId: "r", fetchSource });
  assert.deepEqual(doc.onboarding.patterns.map((p) => p.id), []);
  const steps = Object.fromEntries(funnel.steps.map((s) => [s.id, s]));
  assert.equal(steps.signup.state, "needs_person");
  assert.equal(steps.signup.reason, "The pages read document no way for an agent to sign up. A person may have to create the account; only a real agent run can confirm.");
  assert.equal(steps.access.state, "needs_person");
  assert.equal(steps.access.reason, "The docs describe bearer tokens and OAuth, but the pages read do not show how an agent gets one.");
  assert.ok(doc.limits.includes("purchase paths documented on another company's site (a payments provider's catalog) are not read"), JSON.stringify(doc.limits));
});

// A key from the console is a person setting access up: Supermemory's llms.txt, from its leaderboard document 2026-10-14.
test("\"require an API key from the console\" reads as a person setting up access first", async () => {
  const { onboarding } = await buildInterface({ url: "https://acme.dev/", version: "test", fetchSource: llmsOnly("API requests require an API key from the console, sent as Authorization: Bearer <SUPERMEMORY_API_KEY>. Keep keys out of browser code.") });
  assert.deepEqual(onboarding.patterns.map((p) => p.id), ["existing_account"]);
  assert.equal(onboarding.patterns[0].status, "documented");
});

test("a CLI that signs in only through a browser is a handoff that says so", async () => {
  const quote = "The command launches a browser window where you authorize the Neon CLI to access your Neon account. You can also authenticate with a Neon API key instead.";
  const { onboarding } = await buildInterface({ url: "https://acme.dev/", version: "test", fetchSource: llmsOnly(quote) });
  assert.equal(onboarding.patterns.find((p) => p.id === "existing_account")?.cli, "browser");
});

// Names in code samples are not the product's CLI reading a token, and "log in" in prose is not a browser login.
test("an _API_KEY in a code sample or a mention of logging in is not read as CLI access", async () => {
  const quote = "export OPENAI_API_KEY=sk-test-123\nnode index.js\n\nYou will need to log in to see your projects.";
  const { onboarding } = await buildInterface({ url: "https://acme.dev/", version: "test", fetchSource: llmsOnly(quote) });
  assert.deepEqual(onboarding.patterns.map((p) => p.id), []);
});

test("the audit's Sign up and Access steps say the agent's CLI takes the token", async () => {
  const { funnel } = await inspect({ url: "https://acme.dev/", version: "test", runId: "r", fetchSource: llmsOnly(CLI_TOKEN[0]) });
  const steps = Object.fromEntries(funnel.steps.map((s) => [s.id, s]));
  assert.equal(steps.signup.state, "handoff");
  assert.match(steps.signup.reason, /CLI takes the token from a flag or an environment variable/);
  assert.equal(steps.access.state, "handoff");
});

test("an agent-is-the-customer signup reads as a sentence, with no person step", async () => {
  const quote = "Agents sign up with POST /api/v1/agents/register and hold the account themselves. No human required.";
  const { funnel } = await inspect({ url: "https://acme.dev/", version: "test", runId: "r", fetchSource: llmsOnly(quote) });
  const signup = funnel.steps.find((s) => s.id === "signup");
  assert.match(signup.reason, /No person step is documented: the agent holds the account itself\.$/);
  assert.doesNotMatch(signup.reason, /steps in none/i);
});

// AgentID (auth.agentid.com) lets an agent sign in as itself from its AgentMail inbox. A product accepts it when its
// own pages say an agent signs in or up with it there, as Archil's llms.txt does (recorded 2026-10-06).
test("archil.com's \"Sign up with AgentID\" reads as agent identity through AgentID, cited from its llms.txt", async () => {
  const { onboarding, observations } = await inspectFixture("archil.com");
  const p = onboarding.patterns.find((x) => x.id === "agent_identity");
  assert.equal(p.provider, "AgentID");
  assert.equal(p.status, "documented");
  assert.match(p.reason, /AgentID/);
  assert.match(p.reason, /AgentMail inbox/);
  const llms = observations.find((o) => o.role === "llms_txt" && o.ok);
  assert.ok(p.evidence.some((e) => e.obs === llms.id && /Sign up with AgentID/.test(e.quote)), JSON.stringify(p.evidence));
});

// AgentID's own site teaches other apps to accept it, in every phrase a product would use. It is not one of them.
test("www.agentid.com, the issuer's own site, is not read as accepting AgentID", async () => {
  const { onboarding } = await inspectFixture("www.agentid.com");
  assert.ok(!onboarding.patterns.some((p) => p.id === "agent_identity"), onboarding.patterns.map((p) => p.id).join(", "));
});

// AgentMail makes AgentID; its pages link "New product AgentID" and tell agents to "sign in with AgentID where apps
// accept it". Neither says an agent signs in to AgentMail with it. Before this rule the bare name read as agent identity.
test("agentmail.to's AgentID mentions are not read as accepting AgentID", async () => {
  const { onboarding } = await inspectFixture("agentmail.to");
  assert.ok(!onboarding.patterns.some((p) => p.id === "agent_identity"), onboarding.patterns.map((p) => p.id).join(", "));
  assert.equal(onboarding.primary, "limited_until_claimed");
});

const AGENTID_DOCS = [
  // Live wording, read 2026-10-06: Keenable's llms.txt and agent-api-key.md, AgentLine's skill.md, Locus's auth.md.
  "- [Getting a key as an agent](https://app.keenable.ai/agent-api-key.md): for an agent that signed in with AgentID and holds a session but no key.",
  "You are reading this because you signed in to Keenable with AgentID. That sign-in already made your account.",
  "1. **`ACME_API_KEY`** — required. Missing? Get one via **AgentID** (if enabled) or OTP to any inbox you can read.",
  "**AgentID path** (needs a waiting-page user-agent + AgentMail signing material):\n1. POST /v1/auth/agentid/start",
  "The MCP OAuth authorization screen is public. An agent-owned account chooses AgentID and proves the same subject bound during signup.",
  "## Native MCP path: Agent-owned signup\n\n- Identity provider: AgentID OpenID Connect\n- Issuer: `https://auth.agentid.com`",
  "Agents: Sign-in with AgentID is on the login page.",
  "Agents: Signup with **AgentID** at acme.dev/agents.",
  "Agents can sign in with\n[AgentID](https://www.agentid.com) at acme.dev/login.",
  "Sign in with AgentID, then open your application settings to create a key.",
  "Our products that agents use most are search and fetch. Sign in with AgentID to get a key.",
  "Agents: Sign in using AgentID at acme.dev/login.",
  "It supports AgentID: an agent signs in at acme.dev/login and gets its own account.",
  "- [Agent keys](https://acme.dev/agent-key.md): for an agent that signed in with AgentID and holds a session but no key. - [Integrations directory](https://acme.dev/integrations.md): LangChain and more.",
  "Agents authenticate with AgentID; the first sign-in creates the account.",
  "Acme now supports AgentID: agents sign in at acme.dev/login.",
  "## Agents\n\nIf you are an AI agent, sign in with AgentID at acme.dev/login. Your account and API key are your own.",
  "Acme accepts [AgentID](https://www.agentid.com), an OIDC identity provider for agents: choose \"Sign up with AgentID\" on the login page.",
  "AI agents can click Continue with AgentID on the sign-in page to get their own Acme workspace.",
  "Acme supports AgentID: an agent gets its own account from its AgentMail inbox, with no password.",
];
for (const quote of AGENTID_DOCS) {
  test(`"${quote.slice(0, 40)}…" reads as an agent signing in with AgentID`, async () => {
    const { onboarding } = await buildInterface({ url: "https://acme.dev/", version: "test", fetchSource: llmsOnly(quote) });
    const p = onboarding.patterns.find((x) => x.id === "agent_identity");
    assert.ok(p, onboarding.patterns.map((x) => x.id).join(", "));
    assert.equal(p.provider, "AgentID");
    assert.equal(onboarding.primary, "agent_identity");
    assert.ok(p.evidence.every((e) => /AgentID/.test(e.quote)));
  });
}

test("a product that names AgentID's owner claims near the sign-in says so, with the condition", async () => {
  const quote = "Agents sign in with AgentID. We request the owner_email scope and record the verified owner on the account.";
  const { onboarding } = await buildInterface({ url: "https://acme.dev/", version: "test", fetchSource: llmsOnly(quote) });
  const p = onboarding.patterns.find((x) => x.id === "agent_identity");
  assert.match(p.reason, /mention AgentID's owner claims near the sign-in/);
  assert.match(p.reason, /only if the agent's key has App: Share Owner or the owner approves/);
});

// owner_sub comes with the plain profile scope and is an opaque id; owner claims far from the sign-in are about
// something else on the page.
for (const [label, quote] of [
  ["owner_sub alone", "Agents sign in with AgentID. We key rate limits on owner_sub."],
  ["owner_email far from the sign-in", `Agents sign in with AgentID.\n\n${"Unrelated text about plans and limits. ".repeat(30)}\n\nWebhook payloads carry owner_email for the workspace.`],
]) {
  test(`${label} does not read as the owner being shared`, async () => {
    const { onboarding } = await buildInterface({ url: "https://acme.dev/", version: "test", fetchSource: llmsOnly(quote) });
    assert.match(onboarding.patterns.find((x) => x.id === "agent_identity").reason, /do not say whether the product asks who owns the agent/);
  });
}

test("without owner claims in the docs, the reason says the owner is not stated", async () => {
  const { onboarding } = await buildInterface({ url: "https://acme.dev/", version: "test", fetchSource: llmsOnly(AGENTID_DOCS[0]) });
  assert.match(onboarding.patterns.find((x) => x.id === "agent_identity").reason, /do not say whether the product asks who owns the agent/);
});

test("the audit's Sign up and Access steps name AgentID and what the agent needs", async () => {
  const { funnel } = await inspect({ url: "https://acme.dev/", version: "test", runId: "r", fetchSource: llmsOnly(AGENTID_DOCS[1]) });
  const steps = Object.fromEntries(funnel.steps.map((s) => [s.id, s]));
  assert.equal(steps.signup.state, "agent_can");
  assert.match(steps.signup.reason, /signing in with AgentID/);
  assert.match(steps.signup.reason, /AgentMail inbox/);
  assert.match(steps.signup.reason, /app_connect/);
  assert.match(steps.signup.reason, /usually with no person at each sign-in/);
  assert.match(steps.signup.reason, /usually a browser \(or the owner finishes the sign-in in the AgentMail console, or the agent's software registers its own signing key with AgentMail\)/);
  assert.ok(steps.signup.basedOn.length);
  assert.equal(steps.access.state, "agent_can");
  assert.match(steps.access.reason, /AgentID/);
  assert.equal(funnel.path.id, "agent_identity");
});

// Mentions that name AgentID without the product accepting it, and "agent ID" as a plain identifier.
const NOT_AGENTID = [
  "Blog: AgentMail launched AgentID today, a sign-in button for AI agents backed by an email inbox. Read the announcement.",
  "New product AgentID → A sign-in button for AI agents. Start for free.",
  "Your agent can create an inbox, read verification mail, reply, and sign in with AgentID where apps accept it.",
  "Paste this prompt to your coding agent to add Sign in with AgentID to your app in minutes.",
  "Authorize a sign-in that a browser already started at an app: when the app’s Sign in with AgentID page says it is waiting for your agent.",
  "Each agent has an agent ID. Pass agent_id in the body, or GET /v1/agents/:agentId. The Agent ID field is shown in the dashboard.",
  "Production: AgentID is configured and GitHub human sign-in has completed successfully.",
  "Release notes arrive via AgentID's changelog feed every week.",
  "Docs / Add AgentID to Clerk. Copy this to put a Sign in with AgentID button on the page: signIn.sso({ strategy: 'oauth_agentid' })",
  "Find apps that accept AgentID. Explore services where agents can sign up and sign in with AgentID.",
  // Third-party news and integration notes, as they would read on a changelog or partner page.
  "Clerk now supports AgentID as a social connection.",
  "Descope accepts AgentID through its OIDC connector.",
  "Turso added Sign in with AgentID last week.",
  "Your app's users can't Sign in with AgentID yet.",
  "The Better Auth plugin lets you sign in with AgentID.",
];
for (const quote of NOT_AGENTID) {
  test(`"${quote.slice(0, 40)}…" is not an agent signing in with AgentID`, async () => {
    const { onboarding } = await buildInterface({ url: "https://acme.dev/", version: "test", fetchSource: llmsOnly(quote) });
    assert.deepEqual(onboarding.patterns.filter((p) => p.id === "agent_identity").map((p) => p.id), []);
  });
}

test("a mention of AgentID at other apps does not hide the product's own sign-in further down the page", async () => {
  const quote = "Your agent can sign in with AgentID where apps accept it.\n\n## Signing in to Acme\n\nIf you are an AI agent, sign in with AgentID at acme.dev/login and create an API key there.";
  const { onboarding } = await buildInterface({ url: "https://acme.dev/", version: "test", fetchSource: llmsOnly(quote) });
  const p = onboarding.patterns.find((x) => x.id === "agent_identity");
  assert.ok(p, onboarding.patterns.map((x) => x.id).join(", "));
  assert.match(p.evidence[0].quote, /acme\.dev\/login/);
});

// Declaring AgentID as the identity provider counts only on a page written for agents; a general docs page that names
// the issuer may be teaching integration.
const docsOnly = (text) => {
  const pages = { "https://acme.dev/": "<html><head><title>Acme</title></head><body>Acme</body></html>", "https://acme.dev/docs": text };
  return async (url) => (pages[url] ? { ok: true, status: 200, url, contentType: "text/plain", headers: {}, text: pages[url] } : { ok: false, status: 404, url, contentType: "text/html", headers: {}, text: "" });
};
test("an issuer line on a general docs page is not agent sign-in; on llms.txt it is", async () => {
  const quote = "Identity provider: AgentID OpenID Connect. Issuer: https://auth.agentid.com";
  const docs = await buildInterface({ url: "https://acme.dev/", version: "test", fetchSource: docsOnly(quote) });
  assert.ok(!docs.onboarding.patterns.some((p) => p.provider === "AgentID"));
  const llms = await buildInterface({ url: "https://acme.dev/", version: "test", fetchSource: llmsOnly(quote) });
  assert.ok(llms.onboarding.patterns.some((p) => p.provider === "AgentID"));
});

test("the product's own AgentID route in its OpenAPI document counts", async () => {
  const spec = JSON.stringify({ openapi: "3.1.0", info: { title: "Acme" }, paths: { "/v1/auth/agentid/start": { post: { summary: "Agentid Start", responses: { 200: { description: "ok" } } } } } });
  const pages = { "https://acme.dev/": "<html><head><title>Acme</title></head><body>Acme</body></html>", "https://acme.dev/openapi.json": spec };
  const fetchSource = async (url) => (pages[url] ? { ok: true, status: 200, url, contentType: url.endsWith(".json") ? "application/json" : "text/html", headers: {}, text: pages[url] } : { ok: false, status: 404, url, contentType: "text/html", headers: {}, text: "" });
  const { onboarding } = await buildInterface({ url: "https://acme.dev/", version: "test", fetchSource });
  assert.ok(onboarding.patterns.some((p) => p.provider === "AgentID"), onboarding.patterns.map((p) => p.id).join(", "));
});

// When another agent-first path leads (Locus, AgentLine: try first, claim later), Sign up and Access still say AgentID.
for (const [host, primary, name] of [["paywithlocus.com", "try_then_claim", "Try first, claim later"], ["agentline.cloud", "agent_is_customer", "Agent is the customer"]]) {
  test(`${host}'s Sign up and Access name the AgentID path beside the primary one`, async () => {
    const { funnel } = await inspect({ url: `https://${host}/`, version: "test", runId: "r", fetchSource: replayFrom(JSON.parse(gunzipSync(readFileSync(new URL(`../fixtures/onboarding/${host}.json.gz`, import.meta.url)))).responses) });
    const steps = Object.fromEntries(funnel.steps.map((s) => [s.id, s]));
    assert.equal(funnel.path.id, primary);
    assert.equal(steps.signup.state, "agent_can");
    assert.match(steps.signup.reason, new RegExp(name));
    assert.match(steps.signup.reason, /also describe the agent signing in with AgentID/);
    assert.match(steps.access.reason, /Signed in with AgentID/);
  });
}

test("keenable.ai's Sign up and Access pass through AgentID, not a person", async () => {
  const { funnel } = await inspect({ url: "https://keenable.ai/", version: "test", runId: "r", fetchSource: replayFrom(JSON.parse(gunzipSync(readFileSync(new URL("../fixtures/onboarding/keenable.ai.json.gz", import.meta.url)))).responses) });
  const steps = Object.fromEntries(funnel.steps.map((s) => [s.id, s]));
  assert.equal(steps.signup.state, "agent_can");
  assert.match(steps.signup.reason, /signing in with AgentID/);
  assert.equal(steps.access.state, "agent_can");
  assert.match(steps.access.reason, /AgentID/);
});
