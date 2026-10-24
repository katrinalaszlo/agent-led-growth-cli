import { htmlToText, registrableDomain, sameSite } from "./sources.js";

// Evaluations are judgements about what an agent could do with the observed facts. Each one names the rule it applied
// and the observations it rests on, so a reader can disagree with the rule without doubting the evidence.
// Verdicts: yes | partial | no | unknown. unknown means we did not observe enough to say, never "probably not".

export function verdict(value, reason, basedOn = [], rule = null) {
  return { verdict: value, reason, rule, basedOn: [...new Set(basedOn.filter(Boolean))], method: "rule" };
}

const obsOf = (f) => (f ? f.evidence.map((e) => e.obs) : []);

function linkedFrom(observations, obsId) {
  const o = observations.find((x) => x.id === obsId);
  return o?.discoveredVia?.kind === "link" ? o.discoveredVia.from : null;
}

// Was this path mentioned on any page an agent would read first (homepage, llms.txt, docs)?
function referencedByReadingSurfaces(observations, bodies, pathname) {
  const hits = [];
  for (const o of observations) {
    if (!o.ok || !["homepage", "llms_txt", "llms_full", "docs", "api_docs", "agent_json"].includes(o.role)) continue;
    const body = bodies.get(o.id);
    if (body && body.text.includes(pathname)) hits.push(o.id);
  }
  return hits;
}

// An API documented in prose, with no OpenAPI file: a page on the product's own site presents the product's API base
// URL ("## REST API … Base URL: https://api.marginfront.com/v1") and lists at least two endpoints on it ("GET
// /v1/verify", "curl -X POST https://api.marginfront.com/v1/usage/record").
// - The base URL is on the product's own registrable domain: a page that configures another company's API ("base URL
//   https://api.openai.com/v1") does not count.
// - It reads as the product's API: an api. host, an /api or /v1 path, or "API" or "REST" just before it. A tutorial's
//   app ("the base URL is https://my-app.acme.app", "your base URL") or a config variable ("BASE_URL: https://acme.dev")
//   is not.
// - Endpoints count when host-less or on the product's domain, once each: POST /emails, POST /v1/emails and POST
//   https://api.acme.dev/v1/emails are one endpoint.
const TEXT_API_ROLES = ["llms_txt", "llms_full", "docs", "onboarding", "auth"];
const BASE_URL = /\bbase[ -]?url\b(?:\*\*)?\s*(?:is\s+|:\s*)?(?:\*\*)?\s*[`"<]?(https:\/\/[^\s`"'<>)\]*]+)/gi;
const API_LOOKING_URL = /^https:\/\/api\.|^https:\/\/[^/]+\/(?:api|v\d+)(?:\/|$)/i;
const API_WORD_BEFORE = /\b(?:API|REST)\b/;
const YOUR_BEFORE = /\byour\b/i;
const ENDPOINT = /\b(GET|POST|PUT|PATCH|DELETE)\s+(?:https?:\/\/([^\s/`"']+))?(\/[\w{}:.\-/]*[\w}])/g;
const MIN_TEXT_ENDPOINTS = 2;

function presentedAsApi(text, match, url) {
  if (YOUR_BEFORE.test(text.slice(Math.max(0, match.index - 40), match.index))) return false;
  return API_LOOKING_URL.test(url) || API_WORD_BEFORE.test(text.slice(Math.max(0, match.index - 150), match.index));
}

function productEndpoints(text, ownDomain, basePath) {
  const out = new Set();
  for (const m of text.matchAll(ENDPOINT)) {
    if (m[2] && registrableDomain(m[2].toLowerCase()) !== ownDomain) continue;
    let path = m[3];
    if (basePath && (path === basePath || path.startsWith(`${basePath}/`))) path = path.slice(basePath.length) || "/";
    path = path.replace(/^(?:\/api)?\/v\d+(?=\/)/, "");
    out.add(`${m[1]} ${path}`);
  }
  return out;
}

function apiInPageText(observations, bodies) {
  const home = observations.find((o) => o.role === "homepage");
  if (!home) return null;
  const ownDomain = registrableDomain(new URL(home.url).hostname);
  const endpoints = new Set();
  const basedOn = [];
  let baseUrl = null;
  for (const o of observations) {
    const body = bodies.get(o.id);
    if (!o.ok || !body || !TEXT_API_ROLES.includes(o.role) || !sameSite(o.url, home.url)) continue;
    const text = body.html ? htmlToText(body.text) : body.text;
    const base = [...text.matchAll(BASE_URL)]
      .map((m) => ({ m, url: m[1].replace(/[.,;:]+$/, "") }))
      .find(({ m, url }) => URL.canParse(url) && registrableDomain(new URL(url).hostname) === ownDomain && presentedAsApi(text, m, url));
    if (!base) continue;
    const found = productEndpoints(text, ownDomain, new URL(base.url).pathname.replace(/\/+$/, ""));
    if (found.size < MIN_TEXT_ENDPOINTS) continue;
    baseUrl = baseUrl || base.url;
    basedOn.push(o.id);
    for (const e of found) endpoints.add(e);
  }
  return baseUrl ? { baseUrl, endpoints: [...endpoints], basedOn } : null;
}

export function evaluateInterfaces(x, observations, bodies) {
  const home = observations.find((o) => o.role === "homepage");
  const website = { exists: verdict(home?.ok ? "yes" : home ? "no" : "unknown", home?.ok ? `homepage returned ${home.status}` : `homepage ${home?.status || home?.error || "not fetched"}`, [home?.id], "homepage_2xx") };

  const apiDocs = observations.filter((o) => o.ok && o.role === "api_docs");
  const spec = x.openapi;
  const textApi = !spec && !apiDocs.length ? apiInPageText(observations, bodies) : null;
  let api;
  if (spec) {
    const specObs = spec.evidence[0].obs;
    const path = new URL(observations.find((o) => o.id === specObs).url).pathname;
    const refs = referencedByReadingSurfaces(observations, bodies, path);
    api = {
      exists: verdict("yes", `OpenAPI ${spec.value.version} document with ${spec.value.endpointCount ?? "?"} operations`, [specObs], "openapi_document_parsed"),
      machineReadableSpec: verdict(spec.value.parsed ? "yes" : "partial", spec.value.parsed ? "spec parsed as JSON" : "spec found as YAML; not parsed in this version", [specObs], "openapi_parsed"),
      discoverableFromDocs: verdict(refs.length ? "yes" : "no", refs.length ? `spec path ${path} is referenced on ${refs.join(", ")}` : `spec only found by probing ${path}; no homepage, llms.txt or docs page references it`, [specObs, ...refs], "spec_path_referenced_on_reading_surface"),
    };
  } else if (apiDocs.length) {
    api = {
      exists: verdict("partial", `API documentation page(s) found (${apiDocs.map((o) => o.id).join(", ")}) but no OpenAPI document at common paths`, apiDocs.map((o) => o.id), "api_docs_page_without_spec"),
      machineReadableSpec: verdict("no", "no OpenAPI document at /openapi.json, /v3/api-docs, /swagger.json or linked", apiDocs.map((o) => o.id), "openapi_document_parsed"),
      discoverableFromDocs: verdict("unknown", "no spec to locate", [], null),
    };
  } else if (textApi) {
    api = {
      exists: verdict("partial", `the docs state the API base URL ${textApi.baseUrl} and list ${textApi.endpoints.length} endpoints in page text (for example ${textApi.endpoints[0]}); no OpenAPI document was found`, textApi.basedOn, "api_base_url_and_endpoints_in_text"),
      machineReadableSpec: verdict("no", "no OpenAPI document at /openapi.json, /v3/api-docs, /swagger.json or linked", textApi.basedOn, "openapi_document_parsed"),
      discoverableFromDocs: verdict("unknown", "no spec to locate", [], null),
    };
    api.exists.baseUrl = textApi.baseUrl;
    api.exists.endpointCount = textApi.endpoints.length;
  } else {
    api = {
      exists: verdict("unknown", "no OpenAPI document and no page that reads as API documentation; an API may exist behind a login or on another host", [], "openapi_document_parsed"),
      machineReadableSpec: verdict("no", "no OpenAPI document found", [], "openapi_document_parsed"),
      discoverableFromDocs: verdict("unknown", "no spec to locate", [], null),
    };
  }

  const mcpManifest = observations.find((o) => o.ok && o.role === "mcp_json");
  const mcpPage = observations.find((o) => o.ok && o.role === "mcp");
  const mcpMentions = x.mentions.mcp;
  let mcp;
  if (mcpManifest) mcp = { exists: verdict("yes", "/.well-known/mcp.json returned 2xx", [mcpManifest.id], "mcp_manifest_2xx") };
  else if (mcpPage) mcp = { exists: verdict("yes", `a page about MCP is linked from ${linkedFrom(observations, mcpPage.id) || "the site"}`, [mcpPage.id, linkedFrom(observations, mcpPage.id)], "mcp_page_linked") };
  else if (mcpMentions.length) mcp = { exists: verdict("partial", "MCP is mentioned in text; no manifest or dedicated page found", obsOf({ evidence: mcpMentions.flatMap((m) => m.evidence) }), "mcp_text_mention") };
  else mcp = { exists: verdict("unknown", "no MCP manifest, page or mention on the surfaces read", [], "mcp_text_mention") };
  const mcpRefs = mcpManifest ? referencedByReadingSurfaces(observations, bodies, new URL(mcpManifest.url).pathname) : [];
  const mcpMentionSurfaces = mcpMentions.map((m) => m.evidence[0].obs).filter((id) => ["homepage", "docs", "llms_txt", "llms_full", "api_docs"].includes(observations.find((o) => o.id === id)?.role));
  const mcpDiscoverable = mcpPage || mcpRefs.length || mcpMentionSurfaces.length;
  mcp.discoverableFromDocs = verdict(
    mcpDiscoverable ? "yes" : mcp.exists.verdict === "unknown" ? "unknown" : "no",
    mcpPage ? `an MCP page is linked from ${linkedFrom(observations, mcpPage.id) || "the site"}` : mcpRefs.length ? `manifest path is referenced on ${mcpRefs.join(", ")}` : mcpMentionSurfaces.length ? `MCP is mentioned on ${mcpMentionSurfaces.join(", ")}` : "not referenced from homepage, llms.txt or docs; only found by probing the well-known path",
    [mcpPage?.id, linkedFrom(observations, mcpPage?.id), ...mcpRefs, ...mcpMentionSurfaces],
    "mcp_referenced_on_reading_surface",
  );

  const cliMentions = x.mentions.cli;
  const cliPage = observations.find((o) => o.ok && o.role === "cli");
  const cli = {
    exists: verdict(cliMentions.length ? "yes" : cliPage ? "partial" : "unknown", cliMentions.length ? `install command found: ${cliMentions[0].value}` : cliPage ? "a CLI page exists but no install command was recognised" : "no install command or CLI page found", [...obsOf({ evidence: cliMentions.flatMap((m) => m.evidence) }), cliPage?.id], "install_command_present"),
    installCommands: cliMentions.map((m) => ({ command: m.value, evidence: m.evidence })),
  };

  return { website, api, mcp, cli };
}

function understoodScheme(s) {
  if (!s || s.ref) return false;
  if (s.type === "apiKey") return ["header", "query", "cookie"].includes(s.in) && typeof s.name === "string" && Boolean(s.name);
  if (s.type === "http") return typeof s.scheme === "string" && Boolean(s.scheme);
  if (s.type === "oauth2") return Boolean(s.flows?.length);
  if (s.type === "openIdConnect") return Boolean(s.openIdConnectUrl);
  return ["basic", "mutualTLS"].includes(s.type);
}

function authenticationRequirement(spec, specObs) {
  const rule = "effective_openapi_security";
  const basedOn = specObs ? [specObs] : [];
  const operations = [];
  const result = (value, reason) => ({ value, reason, basedOn, rule, operations });
  if (!spec?.parsed) return result("unknown", "no parsed OpenAPI document establishes authentication requirements; access has not been verified live");
  for (const e of spec.endpoints) {
    const source = e.securityDeclared ? "operation" : spec.globalSecurityDeclared ? "global" : "absent";
    const security = source === "operation" ? e.security : source === "global" ? spec.globalSecurity : null;
    const operation = { operation: `${e.method} ${e.path}`, source, basedOn, rule, schemeNames: [] };
    const add = (value, reason) => operations.push({ ...operation, value, reason });
    if (e.unresolved) {
      add("unknown", "the operation or its path uses an unresolved reference or invalid definition");
      continue;
    }
    if (source === "absent" || (source === "global" && Array.isArray(security) && !security.length)) {
      add("not_declared", "no authentication requirement is declared for this operation; access has not been verified live");
      continue;
    }
    if (!Array.isArray(security) || security.some((s) => !s || typeof s !== "object" || Array.isArray(s) || Object.values(s).some((v) => !Array.isArray(v) || v.some((scope) => typeof scope !== "string")))) {
      add("unknown", "the authentication requirement is malformed");
      continue;
    }
    operation.schemeNames = [...new Set(security.flatMap((s) => Object.keys(s)))];
    const unresolved = operation.schemeNames.filter((name) => !Object.hasOwn(spec.securitySchemes, name) || !understoodScheme(spec.securitySchemes[name]));
    if (unresolved.length) {
      add("unknown", `required scheme definitions are missing, unresolved, or unsupported: ${unresolved.join(", ")}`);
      continue;
    }
    if (!security.length || security.some((s) => !Object.keys(s).length)) {
      add("none", "the operation documents access without authentication; not verified live");
    } else {
      add("required", `the operation declares authentication using ${operation.schemeNames.join(", ")}; not verified live`);
    }
  }
  if (!operations.length) return result("unknown", "no operations were parsed to establish authentication requirements");
  if (spec.endpointsTruncated || spec.endpointCount > spec.endpoints.length || spec.unresolvedPathRefs?.length) return result("unknown", "the operation list is incomplete or contains unresolved path references; authentication requirements cannot be established for the whole API");
  const states = new Set(operations.map((o) => o.value));
  if (states.has("unknown")) return result("unknown", "one or more operations have incomplete or unsupported authentication declarations; access has not been verified live");
  if (states.size === 1 && states.has("not_declared")) return result("not_declared", `no authentication requirement is declared for the ${operations.length} documented operation(s); access has not been verified live`);
  if (states.has("not_declared")) return result("unknown", "authentication is declared for some operations and undeclared for others; access has not been verified live");
  if (states.size > 1) return result("mixed", "some operations document access without authentication and others require it; access has not been verified live");
  if (states.has("none")) return result("none", `the ${operations.length} documented operation(s) explicitly allow access without authentication; not verified live`);
  return result("required", `the ${operations.length} documented operation(s) declare authentication requirements; not verified live`);
}

export function evaluateAuthentication(x, observations) {
  const schemes = x.openapi?.value?.securitySchemes || {};
  const specObs = x.openapi?.evidence[0].obs;
  // methods = declared by a spec. mentions = the words appeared in text; a regex cannot tell "use an API key" from "we have no API keys".
  const methods = Object.entries(schemes).map(([name, s]) => ({ name, type: s.type, scheme: s.scheme, in: s.in, header: s.name, flows: s.flows, method: "extracted", evidence: [{ obs: specObs, quote: `securitySchemes.${name}: ${s.type}${s.scheme ? " " + s.scheme : ""}` }] }));
  const mentions = x.mentions.auth.map((m) => ({ term: m.type, method: "extracted:text_mention", evidence: m.evidence }));
  const authPage = observations.find((o) => o.ok && o.role === "auth");
  const requirement = authenticationRequirement(x.openapi?.value, specObs);
  let setup;
  if (requirement.value === "none") setup = verdict("yes", requirement.reason, requirement.basedOn, requirement.rule);
  else if (["unknown", "not_declared"].includes(requirement.value)) setup = verdict("unknown", requirement.reason, requirement.basedOn, requirement.rule);
  else if (authPage) setup = verdict("yes", `${requirement.reason}; the referenced schemes are defined and an authentication page is linked`, [specObs, authPage.id], "required_schemes_defined_and_auth_page_linked");
  else setup = verdict("partial", `${requirement.reason}; the referenced schemes are defined but no page explains how to obtain a credential`, [specObs], "required_schemes_defined_and_auth_page_linked");
  const friction = [];
  const requiredNames = new Set(requirement.operations.filter((o) => o.value === "required").flatMap((o) => o.schemeNames));
  const oauth = methods.filter((m) => requiredNames.has(m.name) && m.type === "oauth2" && !(m.flows || []).some((f) => ["clientCredentials", "application"].includes(f)));
  if (oauth.length) friction.push({ text: "a required OAuth2 scheme has no documented client_credentials flow; further setup may be needed", basedOn: oauth.flatMap((m) => m.evidence.map((e) => e.obs)) });
  return { methods, mentions, requirement, agentCanUnderstandSetup: setup, friction };
}

// pricing.json lists plans and every one costs 0: nothing to buy. Only machine-readable plans count; a price in prose
// can be a demo's sample data (Track's homepage shows a customer paying $49.00).
export function freePlansOnly(pricing) {
  const plans = pricing?.plans || [];
  return plans.length > 0 && plans.every((p) => p.amount === 0);
}

export function evaluatePricing(x, observations) {
  const pj = x.pricingJson;
  const pagesFound = x.pricingPages;
  const pricingPage = observations.find((o) => o.ok && o.role === "pricing");
  const plans = pj?.value.plans || [];
  const priced = plans.filter((p) => typeof p.amount === "number");
  let cost;
  if (priced.length) cost = verdict("yes", `${priced.length} plan(s) with amounts in pricing.json`, obsOf(pj), "structured_plans_with_amounts");
  else if (pj) cost = verdict("no", "pricing.json exists but lists no plan with an amount", obsOf(pj), "structured_plans_with_amounts");
  else if (pagesFound.some((p) => p.value.prices.length)) cost = verdict("partial", "prices appear in page text; no structured pricing an agent can parse without reading prose", pagesFound.filter((p) => p.value.prices.length).flatMap(obsOf), "structured_plans_with_amounts");
  else if (pricingPage) cost = verdict("no", "a pricing page exists with no currency amounts in its text", [pricingPage.id], "structured_plans_with_amounts");
  else cost = verdict("unknown", "no pricing page or pricing.json found", [], "structured_plans_with_amounts");
  const ambiguities = [];
  for (const p of pagesFound) {
    for (const a of p.value.ambiguities) ambiguities.push({ text: `"${a}" on the page: at least one price needs a human conversation`, basedOn: obsOf(p) });
    if (p.value.usageTerms.length && !p.value.prices.length) ambiguities.push({ text: `usage-based terms (${p.value.usageTerms.join(", ")}) without unit prices`, basedOn: obsOf(p) });
  }
  return {
    model: pj?.value.revenueModel ? { value: pj.value.revenueModel, method: "extracted", evidence: pj.evidence } : null,
    plans: plans.map((p) => ({ ...p, evidence: pj.evidence })),
    observedPrices: pagesFound.map((p) => ({ prices: p.value.prices, evidence: p.evidence, ...(p.value.paidQuote ? { paidQuote: p.value.paidQuote } : {}) })),
    agentCanDetermineCost: cost,
    ambiguities,
  };
}

// RFC 9728. Publishing prose for agents and publishing a machine path to it are
// different things: the prose is found by reading, the path by any client that
// gets refused. A product can do the first and leave the second missing, and
// only the second works for an agent that has not been told where to look.
function agentAuthDiscovery(observations) {
  const prm = observations.find((o) => o.ok && o.role === "prm");
  const challenge = observations.find((o) => o.wwwAuthenticate && /resource_metadata=/i.test(o.wwwAuthenticate));
  if (prm && challenge) return verdict("yes", "a 401 names its resource metadata and that document is served", [challenge.id, prm.id], "agent_auth_discoverable");
  if (prm) {
    // Distinguish "we asked its own API without a credential and it did not say
    // where the rules are" from "nothing we fetched was protected". The first is
    // a gap in the product; the second is a limit of reading public pages.
    const asked = observations.find((o) => o.role === "resource_challenge");
    return asked
      ? verdict("partial", `protected resource metadata is served, but the resource it names answered ${asked.status} without naming its metadata to an unauthenticated caller`, [prm.id, asked.id], "agent_auth_discoverable")
      : verdict("partial", "protected resource metadata is served; nothing fetched was protected, so no refusal was observed", [prm.id], "agent_auth_discoverable");
  }
  if (challenge) return verdict("partial", "a response names resource metadata that was not retrievable", [challenge.id], "agent_auth_discoverable");
  // The convention puts auth.md on the service root and the resource metadata on
  // the API host. Only one host was inspected, so a site that documents agent
  // registration here has not been shown to be missing anything: the metadata
  // may sit on the API host this file names. Saying "no" would report a product
  // that follows the convention as one that ignores it.
  const authDoc = observations.find((o) => o.ok && o.role === "auth" && /auth\.md$/.test(o.url));
  if (authDoc) return verdict("unknown", "agent registration is documented at /auth.md, but resource metadata is not on this host; the convention places it on the API host, which was not inspected", [authDoc.id], "agent_auth_discoverable");
  return verdict("no", "no /auth.md, no protected resource metadata, and no response naming any", [], "agent_auth_discoverable");
}

export function evaluateMachineAccess(x, observations = []) {
  const r = x.robots;
  let crawlers;
  if (!r) crawlers = verdict("partial", "no robots.txt; crawlers assume allowed but nothing is declared", [], "ai_bots_not_blocked");
  else {
    const blocked = r.value.bots.filter((b) => b.state === "blocked" || b.state === "blocked_by_default");
    const allowed = r.value.bots.filter((b) => b.state === "allowed");
    if (blocked.length >= 3) crawlers = verdict("no", `robots.txt blocks ${blocked.map((b) => b.name).join(", ")}`, obsOf(r), "ai_bots_not_blocked");
    else if (blocked.length) crawlers = verdict("partial", `robots.txt blocks ${blocked.map((b) => b.name).join(", ")}`, obsOf(r), "ai_bots_not_blocked");
    else if (allowed.length) crawlers = verdict("yes", `robots.txt explicitly allows ${allowed.map((b) => b.name).join(", ")}`, obsOf(r), "ai_bots_not_blocked");
    else crawlers = verdict("partial", "robots.txt has no rules for AI bots (allowed by default, undeclared)", obsOf(r), "ai_bots_not_blocked");
  }
  return {
    robots: r,
    llmsTxt: x.llmsTxt,
    agentJson: x.agentJson,
    aiCrawlersAllowed: crawlers,
    hasAgentReadableIndex: verdict(x.llmsTxt ? "yes" : "no", x.llmsTxt ? `/llms.txt with ${x.llmsTxt.value.linkCount} links` : "no /llms.txt", obsOf(x.llmsTxt), "llms_txt_present"),
    agentAuthDiscoverable: agentAuthDiscovery(observations),
  };
}

export function deriveCapabilities(x) {
  const spec = x.openapi?.value;
  if (spec?.parsed && spec.endpoints.length) {
    const byTag = new Map();
    const untagged = [];
    for (const e of spec.endpoints) {
      if (!e.tags.length) untagged.push(e);
      for (const t of e.tags) byTag.set(t, [...(byTag.get(t) || []), e]);
    }
    const details = (eps) => eps.slice(0, 20).map((e) => ({ operation: `${e.method} ${e.path}`, summary: e.summary, operationId: e.operationId, description: e.description }));
    const evidence = (eps) => [{ obs: x.openapi.evidence[0].obs, quote: eps.slice(0, 3).map((e) => `${e.method} ${e.path}${e.summary || e.operationId ? " — " + (e.summary || e.operationId) : ""}`).join("; ") }];
    return [...[...byTag.entries()].map(([tag, eps]) => ({
      name: tag,
      description: spec.tags.find((t) => t.name === tag)?.description || [...new Set(eps.map((e) => e.summary || e.description).filter(Boolean))].slice(0, 3).join("; ") || null,
      method: "extracted:openapi_tag",
      operations: eps.slice(0, 20).map((e) => `${e.method} ${e.path}`),
      operationDetails: details(eps),
      evidence: evidence(eps),
    })), ...untagged.map((e) => ({
      name: e.summary || e.operationId || `${e.method} ${e.path}`,
      description: e.description || null,
      method: "extracted:openapi_operation",
      operations: [`${e.method} ${e.path}`],
      operationDetails: details([e]),
      evidence: evidence([e]),
    }))];
  }
  if (x.llmsTxt?.value.sections.length) {
    return x.llmsTxt.value.sectionLinks.map((s) => ({
      name: s.name,
      description: null,
      method: "extracted:llms_txt_section",
      operations: s.links.map((l) => l.text).filter(Boolean).slice(0, 30),
      evidence: [{ obs: x.llmsTxt.evidence[0].obs, quote: `## ${s.name}${s.links.length ? ": " + s.links.slice(0, 4).map((l) => l.text).join(", ") : ""}` }],
    }));
  }
  return [];
}

export function collectUnknowns(doc) {
  const out = [];
  const walk = (node, path) => {
    if (!node || typeof node !== "object") return;
    if (node.verdict === "unknown") out.push({ field: path, reason: node.reason });
    for (const [k, v] of Object.entries(node)) if (k !== "basedOn" && k !== "evidence") walk(v, path ? `${path}.${k}` : k);
  };
  walk({ interfaces: doc.interfaces, authentication: doc.authentication, pricing: doc.pricing, machineAccess: doc.machineAccess }, "");
  for (const k of ["name", "description", "category"]) if (!doc.product[k]) out.push({ field: `product.${k}`, reason: k === "category" ? "no first-party source states a category; not guessed" : `not found on homepage or agent.json` });
  return out;
}
