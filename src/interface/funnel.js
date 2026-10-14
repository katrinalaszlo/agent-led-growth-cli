import { STAGES, PILLAR } from "../schema/stages.js";
import { AGENTID_NEEDS } from "./onboarding.js";

// The seven-step answer for one public check: how far an agent can get, where it stops, and what to build.
// Rule-based over the interface document only. Public evidence can show a path is documented; only a live
// agent run can show it works, so nothing here is ever "agent_did".
export const FUNNEL_SCHEMA = "agent-ready/funnel@1";
// handoff: a person steps in at a documented point and the agent carries on. That is a working path, not a failure.
// agent_did: a live test proved the step. Only a live test sets it.
export const STEP_STATES = ["agent_did", "agent_can", "handoff", "needs_person", "blocked", "not_checked"];
const PASSING = new Set(["agent_did", "agent_can", "handoff"]);
// Kept under this name for callers; the order itself lives in schema/stages.js.
export const FUNNEL_ORDER = STAGES;

export const STEP_NAME = {
  discover: "Discover",
  understand: "Understand",
  signup: "Sign up",
  access: "Access",
  use: "Use",
  pay: "Pay",
  manage: "Manage",
};

export const STEP_QUESTION = {
  discover: "Can an agent find the product and its docs?",
  understand: "Can it tell what the product does and what it costs?",
  signup: "Can it create an account without a person?",
  access: "Can it get a key that works?",
  pay: "Can it pay without a browser checkout?",
  use: "Can it make a real call?",
  manage: "Can it change a plan or a limit?",
};

const FIX = {
  discover: "Allow AI agents in robots.txt and publish /llms.txt that links to your docs.",
  understand: "Publish every plan and price in /pricing.json, and keep \"contact us\" off plans an agent should be able to buy.",
  signup: "Add one API call that creates an account and returns a key, with no CAPTCHA or email loop. Let a person claim it later.",
  access: "Issue scoped API keys through the API and document how an agent authenticates, for example in /auth.md.",
  pay: "Let a person save a card once and the agent buy through the API. When it can't, answer 402 with a link the person can approve.",
  use: "Publish an OpenAPI spec for the actions customers need, with structured errors an agent can act on.",
  manage: "Expose plan changes, usage, and limits through the API so an agent can raise a cap without the dashboard.",
};

const SIGNUP_PATTERNS = new Set(["try_then_claim", "limited_until_claimed", "agent_is_customer", "agent_identity"]);

function step(id, state, reason, basedOn = [], tip = null) {
  const out = { id, name: STEP_NAME[id], area: PILLAR[id], question: STEP_QUESTION[id], state, reason, basedOn: [...new Set(basedOn.filter(Boolean))] };
  // Only a step known to fail gets a fix. An unchecked step needs a live test first.
  if (state === "needs_person" || state === "blocked") out.fix = FIX[id];
  // A passing step can still be easier for agents; that is a tip, not a fix.
  else if (tip) out.tip = tip;
  return out;
}

function discover(doc) {
  const home = doc.observations.find((o) => o.role === "homepage");
  const crawlers = doc.machineAccess?.aiCrawlersAllowed;
  const index = doc.machineAccess?.hasAgentReadableIndex;
  if (!home?.ok) return step("discover", "blocked", "The homepage did not load for an agent.", [home?.id]);
  if (crawlers?.verdict === "no") return step("discover", "blocked", `robots.txt keeps AI agents out: ${crawlers.reason}.`, crawlers.basedOn);
  if (index?.verdict === "yes") return step("discover", "agent_can", `The site is open to agents and has an index written for them (${index.reason}).`, [home.id, ...index.basedOn]);
  const s = step("discover", "needs_person", "The homepage loads, but there is no /llms.txt or agent.json, so an agent has to guess where the docs are.", [home.id]);
  return s;
}

function understand(doc) {
  const cost = doc.pricing?.agentCanDetermineCost;
  const ambiguities = doc.pricing?.ambiguities || [];
  const observed = doc.pricing?.observedPrices || [];
  const basedOn = [...(cost?.basedOn || []), ...ambiguities.flatMap((a) => a.basedOn), ...observed.flatMap((o) => (o.evidence || []).map((e) => e.obs))];
  if (cost?.verdict === "yes" && !ambiguities.length) return step("understand", "agent_can", `Prices are machine-readable: ${cost.reason}.`, basedOn);
  if (cost?.verdict === "yes") return step("understand", "agent_can", `Prices are machine-readable (${cost.reason}). Some plans say "contact us", and those need a person.`, basedOn);
  if (observed.length) return step("understand", "agent_can", "Prices are written in the page text, so an agent can read them, though it has to interpret prose to compare plans.", basedOn, "Publish every plan and price in /pricing.json so an agent can compare plans exactly.");
  if (cost?.verdict === "no") return step("understand", "blocked", `An agent cannot work out the price: ${cost.reason}.`, basedOn);
  return step("understand", "not_checked", "No prices were found in the pages read.", basedOn);
}

// The path the funnel follows: an agent-led signup when the docs describe one, else a person-led one.
function choosePath(doc) {
  const patterns = doc.onboarding?.patterns || [];
  return patterns.find((p) => SIGNUP_PATTERNS.has(p.id) && p.status === "documented") || patterns.find((p) => SIGNUP_PATTERNS.has(p.id)) || patterns.find((p) => p.id === "existing_account") || null;
}

function signup(doc) {
  const patterns = doc.onboarding?.patterns || [];
  const self = patterns.find((p) => SIGNUP_PATTERNS.has(p.id));
  const existing = patterns.find((p) => p.id === "existing_account");
  const refs = (p) => (p?.evidence || []).map((e) => e.obs);
  // The pattern's reason already names AgentID, what the agent needs, and whether the owner is shared.
  if (self?.provider === "AgentID") return step("signup", "agent_can", self.reason, refs(self));
  if (self && self.needs.length) return step("signup", "agent_can", `The docs describe an agent signing up on its own (${self.name}). It needs: ${self.needs.join(", ")}.`, refs(self));
  // "Agent is the customer" has no person step, and its boundary text says so ("None documented. ..."), which does
  // not read after "A person steps in".
  const boundary = !self?.humanBoundary ? "" : /^None\b/.test(self.humanBoundary) ? " No person step is documented: the agent holds the account itself." : ` A person steps in ${self.humanBoundary.charAt(0).toLowerCase()}${self.humanBoundary.slice(1)}`;
  if (self) return step("signup", "agent_can", `The docs describe an agent signing up on its own (${self.name}).${boundary}`, refs(self));
  if (existing?.cli === "token") return step("signup", "handoff", "A person creates the account and a token. The agent's CLI takes the token from a flag or an environment variable, with no browser.", refs(existing));
  if (existing?.cli === "browser") return step("signup", "handoff", "A person creates the account and signs the CLI in through a browser; no token option was found in the pages read. The agent carries on from there.", refs(existing));
  if (existing) return step("signup", "handoff", "A person creates the account and gives the agent a key. The agent carries on from there.", refs(existing));
  return step("signup", "needs_person", "No way for an agent to sign up was found in the pages read. A person may have to create the account; only a real agent run can confirm.");
}

function access(doc, signupStep) {
  const auth = doc.authentication || {};
  const methods = auth.methods || [];
  const terms = [...new Set((auth.mentions || []).map((m) => m.term))];
  const requirement = auth.requirement?.value;
  const refs = [...(auth.requirement?.basedOn || []), ...(auth.agentCanUnderstandSetup?.basedOn || []), ...(auth.mentions || []).flatMap((m) => (m.evidence || []).map((e) => e.obs))];
  if (requirement === "none") return step("access", "agent_can", "The documented actions need no key.", refs);
  if (signupStep.state === "handoff") return step("access", "handoff", "The agent uses the key a person gives it.", [...refs, ...signupStep.basedOn]);
  const self = (doc.onboarding?.patterns || []).find((p) => SIGNUP_PATTERNS.has(p.id));
  if (signupStep.state === "agent_can" && self?.provider === "AgentID") return step("access", "agent_can", "Signed in with AgentID, the agent holds its own account and gets its key or session from it, not from a person.", [...refs, ...signupStep.basedOn]);
  if (signupStep.state === "agent_can") return step("access", "agent_can", "The agent signup path hands back a key the agent can use.", [...refs, ...signupStep.basedOn]);
  if (methods.length || terms.length) return step("access", "needs_person", `The docs describe ${describeAuth(methods, terms)}, but the pages read do not show how an agent gets one.`, refs);
  return step("access", "not_checked", "The docs read do not say how an agent authenticates.", refs);
}

const AUTH_TERM = { api_key: "API keys", bearer_token: "bearer tokens", oauth2: "OAuth", basic: "basic auth" };
function describeAuth(methods, terms) {
  const names = [...new Set([...methods.map((m) => AUTH_TERM[m.value?.type] || m.value?.type), ...terms.map((t) => AUTH_TERM[t] || t)].filter(Boolean))];
  return names.length ? listNames(names) : "a key";
}

function pay(doc) {
  const patterns = doc.onboarding?.patterns || [];
  const perRequest = patterns.find((p) => p.id === "pay_per_request");
  const plans = doc.pricing?.plans || [];
  const observed = doc.pricing?.observedPrices || [];
  const paidPlans = plans.filter((p) => typeof p.amount === "number" && p.amount > 0);
  const paidText = observed.filter((o) => (o.prices || []).some((price) => /[1-9]/.test(price)));
  const refs = [...plans.flatMap((p) => (p.evidence || []).map((e) => e.obs)), ...paidText.flatMap((o) => (o.evidence || []).map((e) => e.obs))];
  // A purchase the product's own pages document (src/interface/purchase.js). One approval by a person, then the agent
  // buys on its own, is a handoff: a person steps in at a documented point and the agent carries on. It is not
  // agent_can, which would say no person is needed, and not needs_person, which would say a person checks out each time.
  const purchase = doc.pricing?.agentPurchase;
  const purchaseRefs = (purchase?.evidence || []).map((e) => e.obs);
  const perRequestCall = purchase?.rule === "pay_per_request_own_api";
  const checkoutCall = purchase?.rule === "checkout_protocol_own_api";
  const call = purchase?.call ? ` (${purchase.call})` : "";
  const over = purchase?.protocol ? ` over ${purchase.protocol}` : "";
  if (purchase?.approval === "once") {
    const how = perRequestCall ? `pays over ${purchase.protocol || "x402 or MPP"}${call}` : checkoutCall ? `checks out over ${purchase.protocol}${call}` : purchase.call ? `buys through ${purchase.call}${over}` : `buys through the API${over}`;
    return step("pay", "handoff", `A person sets payment up once (an approval link, a spending cap, a saved card or a delegation), then the agent ${how}, with no browser checkout. The docs say so; a test shows whether it works.`, purchaseRefs);
  }
  if (purchase?.rule === "agent_buys_through_api") return step("pay", "agent_can", `The docs describe an agent buying through the API${call}${over}, and no person approving first. A test shows whether it works.`, purchaseRefs);
  if (perRequestCall) return step("pay", "agent_can", `The docs show a paid call over ${purchase.protocol || "x402 or MPP"} on the product's own API${call}, with no browser checkout. The agent needs a funded wallet; a test shows whether the payment goes through.`, purchaseRefs);
  if (checkoutCall && purchase.call) return step("pay", "agent_can", `The docs show a checkout an agent completes over ${purchase.protocol} on the product's own API${call}, with no browser checkout. A test shows whether a purchase goes through.`, purchaseRefs);
  if (checkoutCall) return step("pay", "agent_can", `The product publishes a UCP business profile at /.well-known/ucp, so an agent can check out over UCP, with no browser checkout. A test shows whether a purchase goes through.`, purchaseRefs);
  // Pay-per-request wording is easy to misread: a billing product describing its own
  // customers' metering reads the same as an agent paying. Only a live test settles it.
  if (perRequest) return step("pay", "not_checked", "The docs mention paying per request. A test with a real agent shows whether it can actually pay.", (perRequest.evidence || []).map((e) => e.obs));
  if (paidPlans.length || paidText.length) return step("pay", "needs_person", "Paid plans are published, but nothing documents a way for an agent to buy one, so a person has to check out.", refs);
  if (plans.length || observed.length) return step("pay", "not_checked", "Only free plans were found, so there is nothing to pay for yet.", refs);
  return step("pay", "not_checked", "No plans were found in the pages read.");
}

function use(doc) {
  const caps = doc.capabilities || [];
  const api = doc.interfaces?.api;
  const refs = [...caps.flatMap((c) => c.evidence.map((e) => e.obs)), ...(api?.exists?.basedOn || [])];
  // An OpenAPI capability is a tag group holding many operations; count the operations, which is what an agent calls.
  const operations = caps.reduce((n, c) => n + (c.operationDetails?.length || 0), 0);
  const actions = operations ? `${operations} API ${operations === 1 ? "operation" : "operations"}` : `${caps.length} documented ${caps.length === 1 ? "action" : "actions"}`;
  if (caps.length && api?.machineReadableSpec?.verdict === "yes") return step("use", "agent_can", `${actions} in a machine-readable API spec.`, refs);
  // No spec and no API reference page, but the docs give the base URL and list endpoints: an agent can call those.
  if (api?.exists?.rule === "api_base_url_and_endpoints_in_text") return step("use", "agent_can", `The docs give the API base URL (${api.exists.baseUrl}) and list ${api.exists.endpointCount} endpoints in page text. No OpenAPI spec was found, so an agent has to read prose to call them.`, refs, "Publish an OpenAPI spec so an agent can call each action without reading prose.");
  if (caps.length && ["yes", "partial"].includes(api?.exists?.verdict)) return step("use", "agent_can", `${actions} in the API docs.`, refs, "Publish an OpenAPI spec so an agent can call each action without reading prose.");
  if (caps.length) return step("use", "not_checked", `${actions}, but no API was found to call them through.`, refs);
  return step("use", "not_checked", "No API actions were found in the pages read.", refs);
}

function manage() {
  return step("manage", "not_checked", "Changing a plan or a limit can only be proven by a test run.");
}

const listNames = (names) => (names.length < 2 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`);

// A product can document AgentID beside another agent-first path that the funnel follows (Locus, AgentLine); the
// AgentID path is then said too, so a reader of Sign up and Access sees both ways in.
function withAgentId(doc, s, sentence) {
  const patterns = doc.onboarding?.patterns || [];
  const self = patterns.find((p) => SIGNUP_PATTERNS.has(p.id));
  const agentId = patterns.find((p) => p.provider === "AgentID");
  if (!agentId || agentId === self) return s;
  return { ...s, reason: `${s.reason} ${sentence}`, basedOn: [...new Set([...s.basedOn, ...agentId.evidence.map((e) => e.obs)])] };
}

export function buildFunnel(doc) {
  const d = discover(doc);
  const s = withAgentId(doc, signup(doc), `The docs also describe the agent signing in with AgentID as itself, which needs ${AGENTID_NEEDS}.`);
  const a = withAgentId(doc, access(doc, s), "Signed in with AgentID, the agent would hold its own account and get its key or session from it.");
  const byId = { discover: d, understand: understand(doc), signup: s, access: a, pay: pay(doc), use: use(doc), manage: manage() };
  const steps = FUNNEL_ORDER.map((id) => byId[id]);
  const chosen = choosePath(doc);
  const paths = (doc.onboarding?.patterns || []).map((p) => ({ id: p.id, name: p.name, status: p.status, humanBoundary: p.humanBoundary || null, needs: p.needs, followed: p === chosen }));
  return { schema: FUNNEL_SCHEMA, ...summarize(steps), path: chosen ? { id: chosen.id, name: chosen.name } : null, paths, steps };
}

// Read in order, as an agent would walk them: how far it gets before the first step
// that does not pass, and whether that step is a real stop or only unproven.
// The headline keeps two counts apart: steps the public pages document (agent_can, handoff) and steps a test with a
// real agent verified (agent_did). Reading pages is not running a task, so a check alone never says a step works.
function summarize(steps) {
  const firstOpen = steps.findIndex((x) => !PASSING.has(x.state));
  const passed = firstOpen === -1 ? steps.length : firstOpen;
  const stop = steps.find((x) => x.state === "blocked" || x.state === "needs_person") || null;
  const verified = steps.filter((x) => x.state === "agent_did").length;
  const documented = steps.filter((x) => x.state === "agent_can" || x.state === "handoff").length;
  // stepsPassing (from #78) is every passing step, the total the headline gives: documented plus verified.
  return { headline: headlineFor(steps, documented, verified), passed, stepsPassing: documented + verified, documented, verified, of: steps.length, stopsAt: stop?.id || null, fixes: steps.filter((x) => x.fix).map((x) => ({ step: x.id, name: x.name, fix: x.fix })) };
}

function headlineFor(steps, documented, verified) {
  if (!steps.some((x) => x.live)) return `Your public pages document ${documented} of ${steps.length} steps. No step has been tested yet: a test runs a real agent.`;
  const failed = steps.filter((x) => x.live && x.state === "blocked").map((x) => x.name);
  const parts = [`${verified} of ${steps.length} steps verified by a test.`];
  if (documented) parts.push(`Your public pages document ${documented} more.`);
  if (failed.length) parts.push(`${listNames(failed)} failed a test.`);
  return parts.join(" ");
}

// A live test outranks anything read from public pages: the latest passed or blocked
// test for a step decides it. Inconclusive tests and pauses for a person change nothing.
export function applyLiveTests(funnel, runs) {
  const latest = new Map();
  for (const run of runs || []) {
    if (!STAGES.includes(run.step) || !["passed", "blocked"].includes(run.outcome)) continue;
    const at = run.completedAt || run.updatedAt || "";
    const previous = latest.get(run.step);
    if (!previous || at > (previous.completedAt || previous.updatedAt || "")) latest.set(run.step, run);
  }
  if (!latest.size) return funnel;
  const steps = funnel.steps.map((step) => {
    const run = latest.get(step.id);
    if (!run) return step;
    const live = { runId: run.id, name: run.flowName || run.name || "Test", outcome: run.outcome, at: run.completedAt || run.updatedAt || null };
    const { fix, ...rest } = step;
    if (run.outcome === "passed") return { ...rest, state: "agent_did", reason: `The agent did this step: ${live.name} passed its check.`, live };
    return { ...rest, state: "blocked", reason: `The agent was stopped here: ${run.summary || live.name}`, fix: FIX[step.id], live };
  });
  return { ...funnel, ...summarize(steps), steps };
}
