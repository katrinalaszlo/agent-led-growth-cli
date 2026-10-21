import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { get } from "../probe/http.js";
import { buildInterface } from "../interface/index.js";
import { sameSite } from "../interface/sources.js";
import { OUT_DIR } from "../history/index.js";

// agent-ready.yml without a verify_call: take the call from the product's own OpenAPI document. The pick is a GET
// that needs a key (a bearer token or an API key header) and has no required parameters, on servers[0],
// preferring a path that reads the caller's own account.
const PREFERRED = /\/(?:me|whoami|account|user|viewer)\/?$/i;

// A local "#/components/..." reference, followed; anything else is returned as it is.
function resolveRef(openapi, node) {
  if (!node || typeof node.$ref !== "string") return node;
  if (!node.$ref.startsWith("#/")) return null;
  let value = openapi;
  for (const part of node.$ref.slice(2).split("/")) {
    if (value === null || typeof value !== "object") return null;
    value = value[part];
  }
  return value ?? null;
}

// An API key sent in Authorization needs the word in front of it, which the scheme type does not say: Mem0's scheme
// is apiKey in Authorization, described "Prefix your Mem0 API key with 'Token '. Example: 'Token your_api_key'".
// The prefix is read from the scheme's description and x- extensions, and from an Authorization header parameter's
// description or example on the operation. Only these words count, so "Use your API key" is not a prefix "Use".
const KNOWN_PREFIXES = ["Token", "Bearer", "Key", "Api-Key", "ApiKey"];
// "Prefix your key with 'Token '", unless just after "do not", "don't", "never" or "no".
const PREFIX_WITH = /\bprefix(?:ed)?\b[^.\n]{0,60}?\bwith\s+(?:the\s+)?[`'"]?([A-Za-z][\w-]*)\s?[`'"]?/gi;
const NEGATED = /\b(?:do not|don't|never|no)\s+$/i;
// A word before a placeholder: "Token <key>", "Bearer {API_KEY}", "Token your_api_key", "Token $KEY".
const PREFIX_EXAMPLE = /(?:^|[\s`'":(])([A-Za-z][\w-]*)\s+(?:<[^>\n]+>|\{[^}\n]+\}|\$\{?\w+\}?|your[_-]?(?:api[_-]?)?key\b|YOUR_[A-Z_]+)/g;
// A header written out with a value: "Authorization: Token abc123".
const HEADER_EXAMPLE = /\bAuthorization:\s*[`'"]?([A-Za-z][\w-]*)\s+[^\s`'"]{4,}/gi;
// The key goes in as it is: "send the raw key", "without a prefix", "Do not prefix the key".
const NO_PREFIX = /\b(?:do not|don't|never)\s+prefix\b|\bwithout (?:a |any )?prefix\b|\b(?:raw|bare) (?:API )?key\b|\bthe key (?:by )?itself\b/i;
function textsAbout(scheme, params) {
  const texts = [];
  if (typeof scheme.description === "string") texts.push(scheme.description);
  for (const [key, value] of Object.entries(scheme)) if (key.startsWith("x-") && typeof value === "string") texts.push(value);
  for (const p of params) if (p?.in === "header" && String(p.name).toLowerCase() === "authorization") texts.push(...[p.description, p.example, p.schema?.example].filter((t) => typeof t === "string"));
  return texts;
}
// The prefix every text agrees on, "" when the texts say to send the key as it is, or null: none documented, or two.
function authorizationPrefix(scheme, params) {
  const found = new Set();
  let bare = false;
  for (const text of textsAbout(scheme, params)) {
    if (NO_PREFIX.test(text)) bare = true;
    for (const re of [PREFIX_WITH, PREFIX_EXAMPLE, HEADER_EXAMPLE]) {
      for (const m of text.matchAll(re)) {
        if (re === PREFIX_WITH && NEGATED.test(text.slice(Math.max(0, m.index - 12), m.index))) continue;
        const word = KNOWN_PREFIXES.find((k) => k.toLowerCase() === m[1].toLowerCase());
        if (word) found.add(word);
      }
    }
  }
  if (found.size === 1 && !bare) return [...found][0];
  if (!found.size && bare) return "";
  return null;
}

// The header a key goes in, from the operation's security requirement, or null when the operation can be called
// without a key (an empty requirement) or only with a scheme the checker cannot send. skipped says why a keyed
// operation was passed over: an API key in Authorization with no documented prefix, or more than one.
function headerFor(openapi, security, params = []) {
  if (!Array.isArray(security) || !security.length) return null;
  if (security.some((s) => !s || typeof s !== "object" || !Object.keys(s).length)) return null;
  const schemes = openapi.components?.securitySchemes || {};
  let skipped = null;
  for (const requirement of security) {
    const names = Object.keys(requirement);
    if (names.length !== 1) continue;
    const scheme = resolveRef(openapi, schemes[names[0]]);
    if (!scheme) continue;
    if (scheme.type === "http" && String(scheme.scheme || "").toLowerCase() === "bearer") return { name: "Authorization", template: "Bearer {key}" };
    if (scheme.type === "apiKey" && scheme.in === "header" && typeof scheme.name === "string" && scheme.name) {
      if (scheme.name.toLowerCase() !== "authorization") return { name: scheme.name, template: "{key}" };
      const prefix = authorizationPrefix(scheme, params);
      if (prefix !== null) return { name: "Authorization", template: prefix ? `${prefix} {key}` : "{key}" };
      skipped = `its API key goes in the Authorization header (scheme ${names[0]}) and the document does not say what comes before the key`;
    }
  }
  return skipped ? { skipped } : null;
}

// servers[0] as an absolute URL, with its variables at their defaults. No servers means "/", as OpenAPI says.
function serverUrl(openapi, specUrl) {
  const server = Array.isArray(openapi.servers) ? openapi.servers[0] : null;
  const text = String(server?.url || "/").replace(/\{([^}]+)\}/g, (whole, name) => server?.variables?.[name]?.default ?? whole);
  if (text.includes("{")) return null;
  return new URL(text, specUrl).toString().replace(/\/$/, "");
}

export function pickVerifyCall(openapi, specUrl) {
  if (!openapi || typeof openapi !== "object" || !openapi.openapi) return { error: `${specUrl} is not an OpenAPI 3 document` };
  const base = serverUrl(openapi, specUrl);
  if (!base) return { error: `the first server URL in ${specUrl} has a variable with no default` };
  const candidates = [];
  let skipped = null;
  for (const [path, item] of Object.entries(openapi.paths || {})) {
    const op = item?.get;
    if (!op || typeof op !== "object") continue;
    // Path parameters are always required, and the checker has no value to fill in.
    if (path.includes("{")) continue;
    const params = [...(item.parameters || []), ...(op.parameters || [])].map((p) => resolveRef(openapi, p));
    if (params.some((p) => !p || p.required)) continue;
    const header = headerFor(openapi, Object.hasOwn(op, "security") ? op.security : openapi.security, params);
    if (!header) continue;
    if (header.skipped) {
      skipped = header.skipped;
      continue;
    }
    candidates.push({ path, header });
  }
  if (!candidates.length && skipped) return { error: `${specUrl} has GETs that need a key, but ${skipped} (such as "Token <key>")` };
  if (!candidates.length) return { error: `${specUrl} has no GET that needs a key (a bearer token or an API key header) and takes no required parameters` };
  candidates.sort((a, b) => Number(!PREFERRED.test(a.path)) - Number(!PREFERRED.test(b.path)) || a.path.length - b.path.length);
  const { path, header } = candidates[0];
  const url = `${base}${path}`;
  return { method: "GET", url, call: `GET ${url}`, header: `${header.name}: ${header.template}`, headerName: header.name };
}

// The newest interface.json that `check` wrote for this host, or null.
export function latestInterface(cwd, url) {
  const dir = join(cwd, OUT_DIR, new URL(url).host);
  if (!existsSync(dir)) return null;
  for (const run of readdirSync(dir).sort().reverse()) {
    const path = join(dir, run, "interface.json");
    if (existsSync(path)) return { path, doc: JSON.parse(readFileSync(path, "utf8")) };
  }
  return null;
}

// The task and answers of the product's latest check run here (its audit-report.json), as agent-ready.yml keys, or
// {} when there is none. test uses them when agent-ready.yml is missing or for another product.
export function latestAnswers(cwd, url) {
  const dir = join(cwd, OUT_DIR, new URL(url).host);
  if (!existsSync(dir)) return {};
  for (const run of readdirSync(dir).sort().reverse()) {
    const path = join(dir, run, "audit-report.json");
    if (!existsSync(path)) continue;
    const audit = JSON.parse(readFileSync(path, "utf8"));
    return { task: audit.task, onboarding: audit.answers?.onboarding?.value, abuse_cost: audit.answers?.abuse_cost?.value, human_before: audit.answers?.human_before?.value };
  }
  return {};
}

// One OpenAPI document fetched and parsed, then the call picked from it, or { error, reason }. reason is the short
// form for a list of skipped documents. A fetch that redirects to another site is refused: the document would then
// come from a site the product never named.
async function callFrom(specUrl, productUrl, fetchSource) {
  const res = await fetchSource(specUrl);
  if (res.redirectedTo && !sameSite(res.redirectedTo, productUrl)) return fail(`its OpenAPI document at ${specUrl} redirects to ${res.redirectedTo}, on another site`, `redirects to ${res.redirectedTo}`);
  if (!res.ok) return fail(`its OpenAPI document at ${specUrl} could not be read (${res.error || "no answer"})`, res.error || "no answer");
  if (res.status < 200 || res.status > 299) return fail(`its OpenAPI document at ${specUrl} answered ${res.status}`, `answered ${res.status}`);
  let openapi;
  try {
    openapi = JSON.parse(res.text);
  } catch (err) {
    return fail(`its OpenAPI document at ${specUrl} is not valid JSON (${err.message})`, "not valid JSON");
  }
  const picked = pickVerifyCall(openapi, specUrl);
  return picked.error ? { ...picked, reason: picked.error.replace(`${specUrl} `, "") } : picked;
}
const fail = (error, reason) => ({ error, reason });

// Pages written for agents, where a product says where its API description is: tansohq.com's llms.txt and auth.md
// link https://app.tansohq.com/openapi.json, while its own /openapi.json describes only the public website.
const LINKING_ROLES = new Set(["llms_txt", "llms_full", "auth", "onboarding", "agent_json", "pricing_json"]);
const MAX_LINKING_PAGES = 8;
const MAX_LINKED_SPECS = 3;
// An absolute URL or a markdown link target, in the order the page has them, whose path names an OpenAPI or Swagger
// document. Only JSON is read: no YAML parser ships with the CLI, so a linked YAML document is named, not read.
const LINK = /https?:\/\/[^\s"'`<>)\]]+|\]\(([^)\s]+)\)/gi;
const SPEC_PATH = /(?:openapi|swagger)[\w.-]*\.(json|ya?ml)$/i;

// OpenAPI documents that the product's agent-facing pages link to, on the product's registrable domain (app., api.
// and other subdomains included), with the page that links each. JSON ones in specs, YAML ones in yaml. GET only.
async function linkedSpecs(doc, url, fetchSource) {
  const found = new Map();
  const yaml = new Set();
  const pages = (doc.observations || []).filter((o) => o.ok && LINKING_ROLES.has(o.role) && sameSite(o.url, url)).slice(0, MAX_LINKING_PAGES);
  for (const page of pages) {
    const res = await fetchSource(page.url);
    if (!res.ok || res.status < 200 || res.status > 299) continue;
    for (const m of (res.text || "").matchAll(LINK)) {
      const target = (m[1] || m[0]).replace(/[.,;:]+$/, "");
      if (!URL.canParse(target, page.url)) continue;
      const spec = new URL(target, page.url);
      spec.hash = "";
      const kind = SPEC_PATH.exec(spec.pathname)?.[1]?.toLowerCase();
      if (!/^https?:$/.test(spec.protocol) || !kind || !sameSite(spec.href, url)) continue;
      if (kind !== "json") yaml.add(spec.href);
      else if (!found.has(spec.href)) found.set(spec.href, page.url);
    }
  }
  return { specs: [...found.entries()].map(([specUrl, via]) => ({ specUrl, via })), yaml: [...yaml] };
}

// The inferred call's host, and whether it is on another site than the product. Such a call is still used: the key
// is the one the agent got from this product, and the host comes from a document the product serves. The plan says
// so, and a same-site call is preferred when there are both.
function withSite(picked, url) {
  return { ...picked, apiHost: new URL(picked.url).hostname, offSite: !sameSite(picked.url, url) };
}

// The call from an interface document already in hand, read with fetchSource: the CLI's saved or fresh inspection,
// or a check the hosted service stored. The call comes from the product's own OpenAPI document when it has a GET
// that needs a key. Otherwise from an OpenAPI document its agent-facing pages link to on the same registrable domain,
// preferring one whose call reads the caller's account. Documents are fetched again in full, because interface.json
// keeps only an excerpt. GET only.
export async function inferFromInterface({ doc, url, fetchSource = get }) {
  const spec = doc.interfaces?.api?.machineReadableSpec;
  const obs = spec?.verdict === "yes" ? (doc.observations || []).find((o) => o.id === spec.basedOn?.[0]) : null;
  let ownError = "the product's public pages have no OpenAPI document in JSON to take one from";
  if (obs) {
    const own = await callFrom(obs.url, url, fetchSource);
    if (!own.error) return { ...withSite(own, url), specUrl: obs.url, specVia: null };
    ownError = own.error;
  }
  const { specs, yaml } = await linkedSpecs(doc, url, fetchSource);
  const linked = specs.filter((l) => l.specUrl !== obs?.url).slice(0, MAX_LINKED_SPECS);
  const picks = [];
  const skipped = [];
  for (const l of linked) {
    const picked = await callFrom(l.specUrl, url, fetchSource);
    if (picked.error) skipped.push(`${l.specUrl}: ${picked.reason}`);
    else picks.push({ ...withSite(picked, url), specUrl: l.specUrl, specVia: l.via });
  }
  // A same-site call first, then one that reads the caller's account.
  const rank = (p) => Number(p.offSite) * 2 + Number(!PREFERRED.test(new URL(p.url).pathname));
  const chosen = [...picks].sort((a, b) => rank(a) - rank(b))[0];
  if (chosen) return chosen;
  const tried = skipped.length ? `; the OpenAPI ${skipped.length === 1 ? "document" : "documents"} its agent pages link to ${skipped.length === 1 ? "was" : "were"} skipped (${skipped.join("; ")})` : "";
  const notRead = yaml.length ? `; linked YAML ${yaml.length === 1 ? "document is" : "documents are"} not read (${yaml.join(", ")})` : "";
  return { error: `${ownError}${tried}${notRead}` };
}

// The saved inspection when there is one, else the same public inspection `check` runs, then inferFromInterface.
export async function inferVerifyCall({ url, version, cwd, log = () => {}, fetchSource = get }) {
  const saved = latestInterface(cwd, url);
  const interfaceFile = saved?.path || null;
  const doc = saved ? saved.doc : await buildInterface({ url, version, log, fetchSource });
  return { ...(await inferFromInterface({ doc, url, fetchSource })), interfaceFile };
}
