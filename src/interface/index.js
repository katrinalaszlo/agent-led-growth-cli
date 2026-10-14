import { collectSources } from "./sources.js";
import { extractAll } from "./extract.js";
import { evaluateInterfaces, evaluateAuthentication, evaluatePricing, evaluateMachineAccess, deriveCapabilities, collectUnknowns } from "./evaluate.js";
import { detectOnboarding } from "./onboarding.js";
import { detectAgentPurchase } from "./purchase.js";
import { SCHEMA_ID, validateInterface } from "./schema.js";
import { runId as newRunId } from "../schema/ids.js";

export const LIMITS = [
  "GET requests only to the product's own pages for the seven steps; the standards catalog sends the product's URL to isitagentready.com and AgentGrade's service (--no-standards avoids that)",
  "no JavaScript rendering; client-rendered pages read as empty",
  "links followed only on the same registrable domain; docs on a third-party host are not read",
  "purchase paths documented on another company's site (a payments provider's catalog) are not read",
  "no model-generated interpretation; every value is fetched or produced by a named rule",
  "public pages cannot show whether a step works; a test runs a real agent",
];

// URL → structured agent interface. Three passes, each reading only the previous one's output:
// collect (observations) → extract (facts with evidence) → evaluate (verdicts naming their rule and evidence).
export async function buildInterface({ url, version, log = () => {}, runId = newRunId(), fetchSource }) {
  const startedAt = new Date().toISOString();
  const base = new URL(url).toString();
  const { observations, bodies, otherHostsSkipped } = await collectSources(base, { log, fetchSource });
  const x = extractAll(observations, bodies);
  const doc = {
    schema: SCHEMA_ID,
    generator: { name: "agent-ready", version, runId },
    target: { url: base, host: new URL(base).host },
    startedAt,
    finishedAt: null,
    product: x.product,
    observations,
    otherHostsSkipped,
    interfaces: evaluateInterfaces(x, observations, bodies),
    capabilities: deriveCapabilities(x),
    authentication: evaluateAuthentication(x, observations),
    pricing: evaluatePricing(x, observations),
    machineAccess: evaluateMachineAccess(x, observations),
    unknowns: [],
    limits: LIMITS,
  };
  doc.onboarding = detectOnboarding(doc, bodies);
  doc.pricing.agentPurchase = detectAgentPurchase(doc, bodies);
  doc.unknowns = [...collectUnknowns(doc), ...x.parseFailures];
  doc.finishedAt = new Date().toISOString();
  return validateInterface(doc);
}
