export const SCHEMA_ID = "agent-ready/interface@1";
const VERDICTS = ["yes", "partial", "no", "unknown"];

// Field-level documentation served at GET /v1/schema so another agent can read the shape without the dashboard.
export const SCHEMA_DOC = {
  schema: SCHEMA_ID,
  conventions: {
    observation: "One HTTP fetch: id, role, url, status, contentType, bytes, sha256, fetchedAt, discoveredVia (well_known | link from another observation | sitemap), excerpt. Never judged.",
    fact: "{ value, method: 'extracted', evidence: [{ obs, quote }] }. Deterministically pulled from an observation. null when not found.",
    evaluation: "{ verdict: yes|partial|no|unknown, reason, rule, basedOn: [obs ids], method: 'rule' }. A named rule applied to facts. unknown = not enough observed. interfaces.api.exists with rule api_base_url_and_endpoints_in_text (no OpenAPI document, an API documented in page text) also has baseUrl (the stated base URL) and endpointCount (distinct endpoints listed on the product's domain).",
    interpretation: "Not present in this version. No model-generated text is included; every string is either fetched or produced by a named rule.",
  },
  fields: {
    generator: "tool name, version, and the run id",
    target: "url and host that was inspected",
    startedAt_finishedAt: "ISO timestamps for the run; each observation has its own fetchedAt",
    product: "name, description, category as facts or null",
    observations: "every fetch made, in order",
    otherHostsSkipped: "how many hosts that look like the product's own (the same registrable name, or it plus docs, api, dev, app or hq: acme.io or acmedocs.com for acme.dev, foo-docs.vercel.app for foo.vercel.app) had docs, auth or similar links that were not followed because they are another site by the Public Suffix List; third-party hosts are not counted; when no way to start was found and this is above 0, onboarding.reason says links to other hosts were not read",
    interfaces: "website, api, mcp, cli: existence and discoverability as evaluations",
    capabilities: "derived from OpenAPI tags, untagged operation summaries/IDs, or llms.txt sections; each with evidence and, for OpenAPI, operationDetails preserving summaries and descriptions",
    authentication: "methods declared in securitySchemes (not necessarily used), separate text mentions, requirement, agentCanUnderstandSetup, friction; none of these establishes live access",
    authentication_requirement: "{ value: none|required|mixed|not_declared|unknown, reason, basedOn, rule, operations: [{ operation, value, reason, basedOn, rule, source: operation|global|absent, schemeNames }] }; operation security overrides global security; none requires an explicit operation [] or anonymous {} alternative; absent or empty global security is not_declared; unresolved declarations or incomplete operation coverage are unknown",
    pricing: "model, plans, observedPrices, agentCanDetermineCost, ambiguities, agentPurchase. agentPurchase is null or { rule: agent_buys_through_api|payment_required_approval|pay_per_request_own_api|checkout_protocol_own_api, rules, approval: once|none_documented, call, protocol: x402|MPP|ACP|AP2|UCP|null, evidence: [{ obs, quote }] }: a way for an agent to buy from the product through an API, as the product's own pages describe it (an agent buying with a purchase call, a cap or an approval; 402 payment_required with an approval link; x402 or MPP on a call to the product's own API; an ACP or UCP checkout session call on the product's own API, or a UCP business profile at /.well-known/ucp). protocol names the payment or checkout protocol the quoted sentence names, when it names one. approval once means a person approves first and the agent buys after that. A documented claim, never a result.",
    machineAccess: "robots, llms.txt, agent.json facts plus aiCrawlersAllowed, hasAgentReadableIndex and agentAuthDiscoverable",
    onboarding: "{ patterns: [{ id: try_then_claim|limited_until_claimed|agent_is_customer|agent_identity|existing_account|pay_per_request, name, status: documented|inferred, reason, evidence: [{ obs, quote }], humanBoundary, needs: [inbox|cli|wallet|agent_identity], needsEvidence?: { <need>: [{ obs, quote }] }, provider?: AgentID }], apiHosts: [{ domain, host, example, evidence }], primary, reason }. apiHosts are API URLs on other domains that the product's agent-facing pages point to. Ways an agent can start, as the public docs describe them; needs lists what testing that way end to end requires beyond HTTP requests, which a given deployment may or may not provide. provider names the identity provider an agent_identity pattern uses, when the docs name one the detector knows (AgentID). A pattern is a documented claim, never a result.",
    funnel: "{ headline, passed, stepsPassing, documented, verified, of, stopsAt, path, paths, steps: [{ id: discover|understand|signup|access|use|pay|manage, name, area: web|onboarding|monetization, question, state: agent_did|agent_can|handoff|needs_person|blocked|not_checked|not_applicable, reason, fix?, basedOn, quotes?, live?, evidence? }], applicable, fixes }. not_applicable: the product's machine-readable files say the step has nothing to do (Pay when every plan in pricing.json costs 0 and no purchase is documented; Manage when that is one plan); it neither passes nor stops the walk, and applicable counts the other steps. quotes: [{ for, obs, quote }], the sentences behind a claim that the product needs or requires something; a need with no quote is not reported. The seven steps an agent takes, from public evidence only. handoff means a person steps in at a documented point and the agent carries on, which counts as passing. agent_did appears only when the latest test run for that step on this product passed; a blocked test run sets blocked. live names that test. evidence lists, newest first, what else set or touched the step: { kind: test|pay|signal|stuck, at, reason, runId?, outcome?, count? }; a test or payment or the product's own signals can decide the state, a stuck report only attaches. documented counts agent_can and handoff steps, verified counts agent_did steps; the headline gives both and never calls a documented step verified. passed counts the passing steps before the first one that does not pass; stepsPassing counts every passing step (documented plus verified), the total the headline gives.",
    unknowns: "every field whose verdict is unknown or whose fact is null, with the reason",
    limits: "what this run could not do (no JS rendering, no login, no model interpretation)",
  },
};

class ValidationError extends Error {
  constructor(problems) {
    super(`interface.json invalid:\n  - ${problems.join("\n  - ")}`);
    this.name = "ValidationError";
    this.problems = problems;
  }
}

function checkEval(e, path, problems) {
  if (!e || typeof e !== "object") return problems.push(`${path} missing`);
  if (!VERDICTS.includes(e.verdict)) problems.push(`${path}.verdict invalid: ${e.verdict}`);
  if (typeof e.reason !== "string") problems.push(`${path}.reason missing`);
  if (!Array.isArray(e.basedOn)) problems.push(`${path}.basedOn must be an array`);
}

function checkFact(f, path, problems) {
  if (f === null) return;
  if (!f || typeof f !== "object" || !("value" in f)) return problems.push(`${path} must be a fact or null`);
  if (!Array.isArray(f.evidence) || !f.evidence.length) problems.push(`${path}.evidence must be a non-empty array`);
}

export function validateInterface(doc) {
  const problems = [];
  if (!doc || typeof doc !== "object") throw new ValidationError(["document is not an object"]);
  if (doc.schema !== SCHEMA_ID) problems.push(`schema must be ${SCHEMA_ID}`);
  if (!doc.generator?.name || !doc.generator?.version || !doc.generator?.runId) problems.push("generator.name, version, runId required");
  if (!doc.target?.url) problems.push("target.url required");
  if (typeof doc.startedAt !== "string" || typeof doc.finishedAt !== "string") problems.push("startedAt and finishedAt required");
  if (!Array.isArray(doc.observations)) problems.push("observations must be an array");
  else {
    const ids = new Set(doc.observations.map((o) => o.id));
    doc.observations.forEach((o, i) => {
      for (const k of ["id", "role", "url", "fetchedAt"]) if (typeof o[k] !== "string") problems.push(`observations[${i}].${k} missing`);
      if (!Number.isInteger(o.status)) problems.push(`observations[${i}].status missing`);
      if (!o.discoveredVia?.kind) problems.push(`observations[${i}].discoveredVia.kind missing`);
    });
    const walk = (node, path) => {
      if (!node || typeof node !== "object") return;
      if (Array.isArray(node.basedOn)) for (const id of node.basedOn) if (!ids.has(id)) problems.push(`${path}.basedOn references unknown ${id}`);
      if (Array.isArray(node.evidence)) for (const e of node.evidence) if (!ids.has(e.obs)) problems.push(`${path}.evidence references unknown ${e.obs}`);
      for (const [k, v] of Object.entries(node)) if (k !== "observations") walk(v, `${path}.${k}`);
    };
    walk(doc, "doc");
  }
  for (const k of ["name", "description", "category"]) checkFact(doc.product?.[k], `product.${k}`, problems);
  for (const i of ["website", "api", "mcp", "cli"]) checkEval(doc.interfaces?.[i]?.exists, `interfaces.${i}.exists`, problems);
  checkEval(doc.authentication?.agentCanUnderstandSetup, "authentication.agentCanUnderstandSetup", problems);
  if (doc.authentication?.requirement) {
    const states = ["none", "required", "mixed", "not_declared", "unknown"];
    const requirement = doc.authentication.requirement;
    if (!states.includes(requirement.value)) problems.push("authentication.requirement.value invalid");
    if (typeof requirement.reason !== "string" || !Array.isArray(requirement.basedOn)) problems.push("authentication.requirement requires reason and basedOn");
    if (!Array.isArray(requirement.operations)) problems.push("authentication.requirement.operations must be an array");
    else for (const operation of requirement.operations) if (!operation || typeof operation.operation !== "string" || !states.includes(operation.value)) problems.push("authentication.requirement operation invalid");
  }
  checkEval(doc.pricing?.agentCanDetermineCost, "pricing.agentCanDetermineCost", problems);
  checkEval(doc.machineAccess?.aiCrawlersAllowed, "machineAccess.aiCrawlersAllowed", problems);
  if (doc.onboarding !== undefined) {
    const ids = ["try_then_claim", "limited_until_claimed", "agent_is_customer", "agent_identity", "existing_account", "pay_per_request"];
    if (!Array.isArray(doc.onboarding?.patterns)) problems.push("onboarding.patterns must be an array");
    else for (const p of doc.onboarding.patterns) if (!ids.includes(p?.id) || !["documented", "inferred"].includes(p?.status) || !Array.isArray(p?.needs)) problems.push(`onboarding pattern invalid: ${p?.id}`);
  }
  if (!Array.isArray(doc.capabilities)) problems.push("capabilities must be an array");
  if (!Array.isArray(doc.unknowns)) problems.push("unknowns must be an array");
  if (problems.length) throw new ValidationError(problems);
  return doc;
}

export { ValidationError };
