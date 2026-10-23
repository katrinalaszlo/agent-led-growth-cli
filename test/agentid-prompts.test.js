import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildFunnel } from "../src/interface/funnel.js";
import { buildAudit, patternInfo, inspect } from "../src/audit/index.js";
import { defaultAnswers } from "../src/audit/questions.js";
import { renderPrompt, AGENTID_DOC_SENTENCE } from "../src/audit/prompts.js";

const verdict = (v, reason = "because", basedOn = ["obs_1"]) => ({ verdict: v, reason, basedOn, rule: "r", method: "rule" });

// A product with an API and prices but no agent signup in its pages: Sign up needs a person.
function doc(overrides = {}) {
  return {
    target: { url: "https://acme.dev/", host: "acme.dev" },
    product: { name: { value: "Acme" } },
    observations: [{ id: "obs_1", role: "homepage", ok: true, status: 200, url: "https://acme.dev/" }],
    machineAccess: { aiCrawlersAllowed: verdict("yes"), hasAgentReadableIndex: verdict("yes", "/llms.txt with 3 links") },
    pricing: { agentCanDetermineCost: verdict("yes", "2 plan(s) with amounts in pricing.json"), ambiguities: [], plans: [{ id: "pro", amount: 20, evidence: [{ obs: "obs_1" }] }] },
    onboarding: { patterns: [] },
    authentication: { methods: [{ value: { type: "apiKey" } }], requirement: { value: "required", basedOn: [] } },
    capabilities: [{ name: "Create project", evidence: [{ obs: "obs_1" }] }],
    interfaces: { api: { exists: verdict("yes"), machineReadableSpec: verdict("yes") } },
    limits: ["GET requests only"],
    ...overrides,
  };
}
const handoffDoc = () => doc({ onboarding: { patterns: [{ id: "existing_account", name: "Person sets up access first", status: "documented", needs: [], evidence: [{ obs: "obs_1" }] }] } });

const answers = (onboarding, human_before = "never") => ({ onboarding: { value: onboarding, source: "asked" }, abuse_cost: { value: "low", source: "default" }, human_before: { value: human_before, source: "default" } });

function signupPrompt(d, onboarding, human_before) {
  const funnel = buildFunnel(d);
  const a = answers(onboarding, human_before);
  const audit = buildAudit({ doc: d, funnel, answers: a, task: "t", runId: "r", version: "test" });
  const finding = audit.findings.find((f) => f.step === "signup");
  if (!finding) return { audit, body: null };
  return { audit, finding, body: renderPrompt({ finding, pattern: patternInfo(onboarding), answers: a, doc: d, product: "Acme", url: "https://acme.dev/" }) };
}

const section = (body, heading) => {
  const start = body.indexOf(`## ${heading}`);
  if (start < 0) return "";
  const next = body.indexOf("\n## ", start + 3);
  return body.slice(start, next < 0 ? body.length : next);
};

describe("fix prompts: Sign in with AgentID", () => {
  it("agent_identity with Sign up needing a person gets an AgentID integration prompt", () => {
    const d = doc();
    assert.equal(buildFunnel(d).steps.find((s) => s.id === "signup").state, "needs_person");
    const { finding, body } = signupPrompt(d, "agent_identity");
    assert.equal(finding.title, "Let agents sign up with AgentID");
    assert.match(body, /^# Let agents sign up with AgentID\n/);
    assert.match(body, /AgentID is AgentMail's OpenID Connect provider for agents \(issuer https:\/\/auth\.agentid\.com\)/);
    assert.match(body, /npx @agentmail\/agentid-cli init/);
    assert.match(body, /a person to approve it once in a browser/);
    assert.match(body, /It is free for apps/);
    const build = section(body, "Build");
    for (const provider of [
      /a person with an AgentMail account runs `npx @agentmail\/agentid-cli init` \(Node\.js 20 or later\)/,
      /leaves AgentID sign-in turned off until someone turns it on/,
      /`npx @agentmail\/agentid-cli doctor`/,
      /\n   - If you use Clerk: add the built-in AgentID connection \(strategy `oauth_agentid`\), not a custom provider/,
      /turn off Bot sign-up protection \(Configure › Protect\)/,
      /\n   - Supabase: add a custom provider with identifier `agentid`/,
      /signInWithOAuth\(\{ provider: 'custom:agentid' \}\)/,
      /`custom_claims_allowlist` \(`owner_sub`, `owner_name`, `owner_email`, `owner_email_verified`\)/,
      /\n   - Auth0: add the AgentID social connection/,
      /\n   - Better Auth 1\.7\.2 or later: add `@agentmail\/agentid-better-auth`.*ends in `\/callback\/agentid`/,
      /\n   - Auth\.js v4: an OAuth provider with `wellKnown: https:\/\/auth\.agentid\.com\/\.well-known\/openid-configuration`, `idToken: true`, `checks: \["pkce", "state", "nonce"\]` and `client: \{ id_token_signed_response_alg: "ES256" \}`/,
      /PKCE \(S256\)\. Tokens are signed with ES256 only; tell your JOSE library\./,
      /Initiate login URL in the AgentID console \(for example `\/login\/agentid`\)/,
    ]) assert.match(build, provider);
    assert.match(build, /request the `owner_email` \(and, if needed, `owner_profile`\) scopes; only registered apps can/);
    assert.match(build, /`https:\/\/auth\.agentid\.com\/v0\/userinfo`/);
    assert.match(build, /lacks the App: Share Owner permission cannot finish alone/);
    assert.match(section(body, "About AgentID"), /a browser \(headless works\); with no browser, its owner completes the sign-in in the AgentMail console/);
    const security = section(body, "Security");
    assert.match(security, /audience exactly this app's client ID, ES256 signature from https:\/\/auth\.agentid\.com\/v0\/jwks\.json, expiry, and `state` plus the PKCE verifier or `nonce`/);
    assert.match(security, /Clerk and Supabase can link identities with the same verified email automatically/);
    assert.match(security, /A verified owner is an `owner_email` claim \(with `owner_email_verified: true`\)/);
    assert.match(security, /per `owner_sub`, so one person's agents share one quota/);
    assert.match(section(body, "Acceptance tests"), /- If the app verifies the ID token itself, an ID token with another issuer/);
    assert.match(section(body, "Onboarding model"), /A person steps in: When the agent's owner sets up its identity or approves an app\./);
    assert.match(build, /Keep every existing way to sign in/);
    assert.match(section(body, "Acceptance tests"), /pages show "Sign in with AgentID"/);
    assert.match(section(body, "Check first"), /did not find a way for an agent to sign up on its own in the public pages.*Search the repo for how people sign in today/s);
    // Not the only path: the device flow is named as the other option, and nothing builds a signup endpoint.
    assert.match(section(body, "Another option"), /RFC 8628/);
    assert.doesNotMatch(build, /RFC 8628/);
    assert.doesNotMatch(body, /POST \/v1\/agent\/signup/);
    // How to verify: rerun check, which recognizes the sentence the prompt asks for.
    assert.match(section(body, "When done"), /npx agent-led-growth check https:\/\/acme\.dev\/` again/);
    assert.match(section(body, "When done"), /`check` recognizes "Sign in with AgentID" on the product's own pages/);
    assert.ok(body.includes(AGENTID_DOC_SENTENCE));
    assert.doesNotMatch(body, /—/);
  });

  it("agent_identity makes a person-handoff Sign up a gap and gets the AgentID prompt", () => {
    const d = handoffDoc();
    assert.equal(buildFunnel(d).steps.find((s) => s.id === "signup").state, "handoff");
    const { finding, body } = signupPrompt(d, "agent_identity");
    assert.equal(finding.severity, "medium");
    assert.match(finding.reason, /Your onboarding model is Agent identity/);
    assert.match(body, /^# Let agents sign up with AgentID/);
  });

  it("existing_account still passes a handoff and keeps the device flow without AgentID", () => {
    assert.equal(signupPrompt(handoffDoc(), "existing_account").body, null);
    const { body } = signupPrompt(doc(), "existing_account");
    assert.match(body, /RFC 8628/);
    assert.doesNotMatch(body, /AgentID/);
  });

  for (const id of ["try_then_claim", "limited_until_claimed", "agent_is_customer"]) {
    it(`${id} keeps its signup endpoint first and adds AgentID as another option with the tradeoffs`, () => {
      const { body } = signupPrompt(doc(), id);
      assert.match(section(body, "Build"), /POST \/v1\/agent\/signup/);
      assert.doesNotMatch(section(body, "Build"), /AgentID/);
      const other = section(body, "Another option");
      assert.match(other, /already has an OpenID Connect sign-in \(Clerk, Auth0, Supabase, Better Auth, Auth\.js, or its own\), it can accept AgentID instead of building the signup endpoint above/);
      assert.match(other, /the agent needs an AgentMail inbox and key/);
      assert.match(other, /a person approves the app's registration once in a browser/);
      assert.match(other, /AgentID is new \(launched 2026-10-06\)/);
      assert.match(other, /set `onboarding: agent_identity` in alg\.yml/);
      assert.ok(body.indexOf("## Another option") > body.indexOf("## Acceptance tests"));
    });
  }

  it("pay per request and other steps get no AgentID note", () => {
    const pay = { n: 1, step: "pay", name: "Pay", severity: "medium", reason: "No agent purchase path.", basedOn: ["obs_1"] };
    const body = renderPrompt({ finding: pay, pattern: patternInfo("pay_per_request"), answers: answers("pay_per_request"), doc: doc(), product: "Acme", url: "https://acme.dev/" });
    assert.doesNotMatch(body, /AgentID/);
    const access = { n: 1, step: "access", name: "Access", severity: "medium", reason: "No key path.", basedOn: ["obs_1"] };
    assert.doesNotMatch(renderPrompt({ finding: access, pattern: patternInfo("agent_identity"), answers: answers("agent_identity"), doc: doc(), product: "Acme", url: "https://acme.dev/" }), /AgentID/);
  });

  it("the outbound rule limits an AgentID account until a verified owner is on it", () => {
    assert.match(signupPrompt(doc(), "agent_identity", "outbound").body, /Until a verified owner is on the account, an agent signed in with AgentID cannot send/);
    assert.doesNotMatch(signupPrompt(doc(), "agent_identity", "never").body, /Until a verified owner/);
  });

  it("the default answers still recommend try first, claim later, never AgentID alone", () => {
    assert.equal(defaultAnswers(buildFunnel(doc())).onboarding.value, "try_then_claim");
  });

  // The sentence the prompt tells the product to publish is one `check` reads as an AgentID sign-in.
  for (const path of ["llms.txt", "auth.md"]) {
    it(`check recognizes the prompt's sentence on the product's own /${path}`, async () => {
      const pages = {
        "https://acme.dev/": `<html><head><title>Acme</title></head><body>Acme. <a href="/${path}">Agents</a></body></html>`,
        [`https://acme.dev/${path}`]: `# Acme\n\n${AGENTID_DOC_SENTENCE}\nThe agent needs an AgentMail inbox and an AgentMail API key.\n`,
      };
      const fetchSource = async (url) => (pages[url] ? { ok: true, status: 200, url, contentType: url.endsWith("/") ? "text/html" : "text/plain", headers: {}, text: pages[url] } : { ok: false, status: 404, url, contentType: "text/html", headers: {}, text: "" });
      const { doc: d, funnel } = await inspect({ url: "https://acme.dev/", version: "test", runId: "r", fetchSource });
      assert.ok(d.onboarding.patterns.some((p) => p.id === "agent_identity" && p.provider === "AgentID"), d.onboarding.patterns.map((p) => p.id).join(", "));
      const signup = funnel.steps.find((s) => s.id === "signup");
      assert.equal(signup.state, "agent_can");
      assert.match(signup.reason, /signing in with AgentID/);
      assert.equal(signupPrompt(d, "agent_identity").body, null);
    });
  }

  it("a Sign in with AgentID button on the product's own login page is recognized", async () => {
    const pages = { "https://acme.dev/": "<html><head><title>Acme</title></head><body><a href=\"/login\">Log in</a><button>Sign in with AgentID</button></body></html>" };
    const fetchSource = async (url) => (pages[url] ? { ok: true, status: 200, url, contentType: "text/html", headers: {}, text: pages[url] } : { ok: false, status: 404, url, contentType: "text/html", headers: {}, text: "" });
    const { doc: d } = await inspect({ url: "https://acme.dev/", version: "test", runId: "r", fetchSource });
    assert.ok(d.onboarding.patterns.some((p) => p.provider === "AgentID"), d.onboarding.patterns.map((p) => p.id).join(", "));
  });
});
