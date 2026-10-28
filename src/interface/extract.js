import { parseRobots, AI_BOTS } from "../probe/index.js";
import { htmlToText, isSoft404 } from "./sources.js";
import { blocksOf, quoteAt } from "./quote.js";

// Deterministic extraction. Every fact carries the observation it came from and a quote from that page.
// A fact that cannot be extracted is null; callers turn nulls into unknowns. No inference happens here.

export function fact(value, obsId, quote, method = "extracted") {
  return { value, method, evidence: [{ obs: obsId, quote: quote ? String(quote).replace(/\s+/g, " ").trim().slice(0, 240) : null }] };
}

function quoteAround(text, re, width = 140) {
  const m = re.exec(text);
  if (!m) return null;
  const start = Math.max(0, m.index - width / 2);
  return text.slice(start, start + width).trim();
}

function meta(html, name) {
  const re = new RegExp(`<meta[^>]+(?:name|property)\\s*=\\s*["']${name}["'][^>]*content\\s*=\\s*["']([^"']*)["']`, "i");
  const m = html.match(re) || html.match(new RegExp(`<meta[^>]+content\\s*=\\s*["']([^"']*)["'][^>]*(?:name|property)\\s*=\\s*["']${name}["']`, "i"));
  return m ? m[1].trim() : null;
}

// null keeps the extractors simple; jsonParseFailures below says why for every page that should have been JSON.
function parseJsonSafe(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

// A JSON surface that answers 200 with a body that does not parse is not the same as one that is missing,
// so each is reported as an unknown with the parser's reason instead of disappearing into a null fact.
export function jsonParseFailures(observations, bodies) {
  const out = [];
  for (const page of pages(observations, bodies, ["agent_json", "pricing_json", "openapi", "mcp_json"])) {
    if (page.html || (page.obs.role === "openapi" && (/^(openapi|swagger):/m.test(page.text) || /\.ya?ml$/i.test(page.obs.url)))) continue;
    try {
      JSON.parse(page.text);
    } catch (err) {
      out.push({ field: `observations.${page.obs.id}`, reason: `${page.obs.role} at ${page.obs.url} returned 200 but is not valid JSON (${err.message}): ${page.text.replace(/\s+/g, " ").slice(0, 200)}` });
    }
  }
  return out;
}

function pages(observations, bodies, roles) {
  return observations.filter((o) => o.ok && roles.includes(o.role) && bodies.has(o.id)).map((o) => ({ obs: o, ...bodies.get(o.id) }));
}

function plainText(page) {
  return page.html ? htmlToText(page.text) : page.text;
}

export function extractProduct(observations, bodies) {
  const out = { name: null, description: null, category: null };
  const agent = pages(observations, bodies, ["agent_json"]).map((p) => ({ ...p, doc: parseJsonSafe(p.text) })).find((p) => p.doc);
  const pricingJson = pages(observations, bodies, ["pricing_json"]).map((p) => ({ ...p, doc: parseJsonSafe(p.text) })).find((p) => p.doc);
  const home = pages(observations, bodies, ["homepage"]).find((p) => p.html);
  if (agent?.doc?.name) out.name = fact(String(agent.doc.name), agent.obs.id, `"name": "${agent.doc.name}"`);
  if (agent?.doc?.description) out.description = fact(String(agent.doc.description), agent.obs.id, agent.doc.description);
  if (pricingJson?.doc?.product?.category) out.category = fact(String(pricingJson.doc.product.category), pricingJson.obs.id, `"category": "${pricingJson.doc.product.category}"`);
  if (home) {
    const siteName = meta(home.text, "og:site_name");
    const title = (home.text.match(/<title[^>]*>([^<]*)<\/title>/i) || [])[1]?.trim();
    if (!out.name && siteName) out.name = fact(siteName, home.obs.id, `og:site_name = ${siteName}`);
    else if (!out.name && title) out.name = fact(title.split(/\s[|–—-]\s/)[0].trim(), home.obs.id, `<title>${title}</title>`);
    const desc = meta(home.text, "description") || meta(home.text, "og:description");
    if (!out.description && desc) out.description = fact(desc, home.obs.id, desc);
  }
  return out;
}

export function extractRobots(observations, bodies) {
  const page = pages(observations, bodies, ["robots"])[0];
  if (!page) return null;
  const groups = parseRobots(page.text);
  const star = groups.get("*");
  const blockedAll = (g) => Boolean(g && g.disallow.some((p) => p === "/") && !g.allow.some((p) => p === "/"));
  const bots = AI_BOTS.map((name) => {
    const g = groups.get(name.toLowerCase());
    const state = g ? (blockedAll(g) ? "blocked" : "allowed") : blockedAll(star) ? "blocked_by_default" : "undeclared";
    return { name, state };
  });
  const quote = page.text.split(/\r?\n/).filter((l) => /user-agent|disallow|allow/i.test(l)).slice(0, 6).join(" | ");
  return { ...fact({ bots, mentionsLlmsTxt: /llms\.txt/i.test(page.text) }, page.obs.id, quote) };
}

export function extractLlmsTxt(observations, bodies) {
  const page = pages(observations, bodies, ["llms_txt"])[0];
  if (!page || page.html) return null;
  // Link text is bounded and stays on one line: an unbounded [^\]]* rescans the rest of the file from every unclosed "[".
  const links = [...page.text.matchAll(/\[([^\[\]\n]{0,500})\]\(([^)\s]+)\)/g)].map((m) => ({ text: m[1].slice(0, 80), href: m[2] }));
  // Bare URLs are links too ("- Website: https://marginfront.com"), once each, outside code blocks and markdown links: a
  // curl example's URL is not part of the index, and a templated https://{workspace}.acme.dev is not a page.
  const prose = page.text.replace(/```[\s\S]*?```/g, " ").replace(/\[[^\[\]\n]{0,500}\]\([^)\s]+\)/g, " ").replace(/`[^`\n]*`/g, " ");
  const bareUrls = new Set((prose.match(/https?:\/\/[^\s<>()"'`\]]+/g) || []).map((url) => url.replace(/[.,;:!?*]+$/, "")).filter((url) => !/[{}]/.test(url)));
  // Links grouped under their ## heading: the heading names a product area, the links under it name what it offers.
  const sections = [];
  let current = null;
  for (const line of page.text.split(/\r?\n/)) {
    const h = line.match(/^##\s+(.+)$/);
    if (h) {
      current = { name: h[1].trim(), links: [] };
      sections.push(current);
      continue;
    }
    const l = line.match(/\[([^\[\]\n]{0,500})\]\(([^)\s]+)\)/);
    if (l && current) current.links.push({ text: l[1].slice(0, 80), href: l[2] });
  }
  return fact({ bytes: page.text.length, links: links.slice(0, 40), linkCount: links.length + bareUrls.size, sections: sections.map((x) => x.name), sectionLinks: sections }, page.obs.id, page.text.split("\n").slice(0, 3).join(" "));
}

export function extractAgentJson(observations, bodies) {
  const page = pages(observations, bodies, ["agent_json"]).map((p) => ({ ...p, doc: parseJsonSafe(p.text) })).find((p) => p.doc && !p.html);
  if (!page) return null;
  return fact({ keys: Object.keys(page.doc), path: new URL(page.obs.url).pathname }, page.obs.id, JSON.stringify(page.doc).slice(0, 200));
}

export function extractOpenApi(observations, bodies) {
  for (const page of pages(observations, bodies, ["openapi"])) {
    if (page.html) continue;
    const doc = parseJsonSafe(page.text);
    if (!doc || !(doc.openapi || doc.swagger)) {
      if (/^openapi:/m.test(page.text)) return fact({ format: "yaml", version: (page.text.match(/^openapi:\s*["']?([\d.]+)/m) || [])[1] || null, parsed: false, endpoints: [], securitySchemes: {}, tags: [], servers: [] }, page.obs.id, page.text.split("\n").slice(0, 2).join(" "));
      continue;
    }
    const endpoints = [];
    const unresolvedPathRefs = [];
    for (const [path, ops] of Object.entries(doc.paths || {})) {
      if (ops?.$ref) unresolvedPathRefs.push(path);
      for (const [method, op] of Object.entries(ops || {})) {
        if (!["get", "post", "put", "patch", "delete", "head", "options", "trace"].includes(method)) continue;
        const valid = Boolean(op && typeof op === "object" && !Array.isArray(op));
        endpoints.push({
          method: method.toUpperCase(), path,
          summary: typeof op?.summary === "string" ? op.summary : null,
          operationId: typeof op?.operationId === "string" ? op.operationId : null,
          description: typeof op?.description === "string" ? op.description : null,
          tags: Array.isArray(op?.tags) ? op.tags.filter((t) => typeof t === "string" && t.trim()) : [],
          responses: Object.keys(op?.responses || {}),
          securityDeclared: valid && Object.hasOwn(op, "security"),
          security: valid && Object.hasOwn(op, "security") ? op.security : null,
          unresolved: !valid || Boolean(ops?.$ref || op?.$ref),
        });
      }
    }
    const schemes = doc.components?.securitySchemes || doc.securityDefinitions || {};
    const securitySchemes = Object.fromEntries(Object.entries(schemes).map(([k, v]) => [k, { type: v?.type || null, scheme: v?.scheme || null, in: v?.in || null, name: v?.name || null, flows: v?.flows ? Object.keys(v.flows) : v?.flow ? [v.flow] : undefined, openIdConnectUrl: v?.openIdConnectUrl || null, ref: v?.$ref || null }]));
    const tags = (doc.tags || []).map((t) => ({ name: t.name, description: t.description || null }));
    const servers = (doc.servers || []).map((s) => s.url).filter(Boolean);
    return fact(
      { format: "json", version: doc.openapi || doc.swagger, parsed: true, title: doc.info?.title || null, endpoints: endpoints.slice(0, 200), endpointCount: endpoints.length, endpointsTruncated: endpoints.length > 200, unresolvedPathRefs, securitySchemes, globalSecurityDeclared: Object.hasOwn(doc, "security"), globalSecurity: Object.hasOwn(doc, "security") ? doc.security : null, tags, servers },
      page.obs.id,
      `openapi ${doc.openapi || doc.swagger}: ${doc.info?.title || ""} (${endpoints.length} operations)`,
    );
  }
  return null;
}

export function extractPricingJson(observations, bodies) {
  const page = pages(observations, bodies, ["pricing_json"]).map((p) => ({ ...p, doc: parseJsonSafe(p.text) })).find((p) => p.doc && !p.html);
  if (!page) return null;
  const plans = Array.isArray(page.doc.plans)
    // `price` is usually { amount, currency, period }; a bare number with the currency beside it, on the plan or the
    // document, says the same thing.
    ? page.doc.plans.map((p) => ({ id: p?.id ?? null, name: p?.name ?? null, amount: typeof p?.price?.amount === "number" ? p.price.amount : typeof p?.price === "number" ? p.price : null, currency: p?.price?.currency ?? (typeof p?.price === "number" ? p?.currency ?? page.doc.currency ?? null : null), period: p?.price?.period ?? p?.billing_period ?? null, provisioningUrl: p?.trial?.api_provisioning_url ?? null }))
    : [];
  return fact({ revenueModel: page.doc.revenue_model?.type ?? null, plans, keys: Object.keys(page.doc) }, page.obs.id, JSON.stringify(page.doc).slice(0, 200));
}

const PRICE_RE = /(?:\$|€|£|USD\s?)\s?\d[\d,]*(?:\.\d+)?(?:\s?(?:\/|per)\s?(?:mo(?:nth)?|yr|year|seat|user|request|call|1k|1000|k)\b)?/gi;
const AMBIGUITY_RE = /contact (?:us|sales)|custom pricing|talk to sales|get a quote|enterprise pricing|request a demo/gi;
// "per request" is a price only beside a price word: "priced per request", "billed per call". Alone it is usually a
// limit: Track's "4 KB per request", "What it sends, per request".
const USAGE_RE = /usage[- ]based|pay[- ]as[- ]you[- ]go|\b(?:priced|charged|billed|paid|pay|costs?|fee|price)\s+(?:\w+\s+)?per (?:request|call|token|seat|user)\b|metered billing/gi;

// A price under one of these headings is not a plan: Resend's "Domains - $20 / mo" sits under "Add-ons", AISend's
// "$20/mo" under "How AISend Compares" is a competitor's, Neon's "$100k in credits" is under "Early-stage startups".
// Such a price is quoted only when the page has no other.
const NOT_A_PLAN = /\badd-?ons?\b|\boverages?\b|\bcompar\w*|\bvs\b|\bcredits?\b|\bstartups?\b|\bdiscounts?\b/i;
// A price that is not a sentence names the heading it sits under, which is usually its plan, and the quote stays the
// page's own words: Price under "Pro": "$14 /month".
function withHeading(q, heading) {
  if (!q.label || !heading || heading.length > 40 || q.quote.includes(heading)) return q;
  return { ...q, label: `${q.label === "Phrase" ? "Price" : q.label} under "${heading}"` };
}

// The nearest heading above [start, end) that holds no price: Resend's "Dedicated IPs - $30 / mo" is a heading under
// "Domains - $20 / mo", and both sit under "Add-ons", the section that says what they are.
function sectionHeading(page, text, start, end) {
  const blocks = blocksOf(page, page.obs.role);
  if (!blocks) return "";
  let i = blocks.findIndex((b) => b.start <= start && end <= b.end);
  for (i -= 1; i >= 0; i -= 1) {
    const b = blocks[i];
    if (b.kind !== "heading") continue;
    const words = text.slice(b.start, b.end).replace(/[#*_`]/g, " ").replace(/\s+/g, " ").trim();
    if (!/(?:\$|€|£)\s?\d/.test(words)) return words;
  }
  return "";
}

function paidPriceQuote(page, text) {
  let tried = 0;
  let fallback = null;
  for (const m of text.matchAll(PRICE_RE)) {
    // "$75M Series B" is a funding round, not a plan.
    if (!/[1-9]/.test(m[0]) || /^[MB]\b/i.test(text.slice(m.index + m[0].length))) continue;
    const q = quoteAt(page, text, m.index, m.index + m[0].length, page.obs.role);
    if (q) {
      const heading = sectionHeading(page, text, m.index, m.index + m[0].length);
      const labelled = withHeading(q, heading);
      if (!NOT_A_PLAN.test(heading)) return labelled;
      fallback ??= labelled;
    }
    if (++tried >= 200) break;
  }
  return fallback;
}

export function extractPricingPages(observations, bodies) {
  const out = [];
  for (const page of pages(observations, bodies, ["pricing", "homepage"]).filter((page) => !isSoft404(page.obs, observations))) {
    const text = plainText(page);
    const prices = [...new Set((text.match(PRICE_RE) || []).map((s) => s.trim()))].slice(0, 12);
    const ambiguities = [...new Set((text.match(AMBIGUITY_RE) || []).map((s) => s.toLowerCase()))];
    const usage = [...new Set((text.match(USAGE_RE) || []).map((s) => s.toLowerCase()))];
    if (page.obs.role === "homepage" && !prices.length) continue;
    // A paid price is what Pay quotes when it says paid plans are published, so it gets a clean quote: the sentence or
    // labelled element holding the first price above zero that has one (src/interface/quote.js), or null.
    const paid = paidPriceQuote(page, text);
    out.push(fact({ prices, ambiguities, usageTerms: usage, paidQuote: paid ? { obs: page.obs.id, ...paid } : null }, page.obs.id, quoteAround(text, /(\$|€|£)\s?\d/) || quoteAround(text, AMBIGUITY_RE) || text.slice(0, 140)));
  }
  return out;
}

const AUTH_PATTERNS = [
  ["api_key", /\bapi[ _-]?keys?\b/i],
  ["bearer_token", /\bbearer\b|authorization:\s*bearer/i],
  ["oauth2", /\boauth\s?2?(?:\.0)?\b|client[ _]credentials|authorization code/i],
  ["personal_access_token", /personal access token|\bPAT\b/],
  ["basic", /\bbasic auth/i],
];
const MCP_RE = /model context protocol|\bmcp\b(?:\s+server)?|mcp\.json|\/mcp\b/i;
const CLI_RE = /(?:npx|npm i(?:nstall)?(?:\s+-g)?|pnpm add|yarn add|brew install|pip install|pipx install|cargo install|go install|curl -[a-zA-Z]+ .*\|\s*(?:sh|bash))\s+[@\w./-]+/i;

// Text mentions across docs pages. Mentions are hints about existence; the evaluation layer decides what they mean.
export function extractMentions(observations, bodies) {
  const auth = [];
  const mcp = [];
  const cli = [];
  for (const page of pages(observations, bodies, ["homepage", "docs", "api_docs", "auth", "mcp", "cli", "llms_txt", "llms_full", "pricing", "mcp_json", "agent_json"])) {
    const text = plainText(page);
    for (const [type, re] of AUTH_PATTERNS) {
      const q = quoteAround(text, re);
      if (q && auth.length < 12) auth.push({ type, ...fact(type, page.obs.id, q) });
    }
    const mq = quoteAround(text, MCP_RE);
    if (mq && mcp.length < 8) mcp.push(fact(page.obs.role === "mcp_json" ? "manifest" : "mention", page.obs.id, mq));
    const cm = text.match(CLI_RE);
    if (cm && cli.length < 8) cli.push(fact(cm[0].slice(0, 120), page.obs.id, quoteAround(text, CLI_RE)));
  }
  return { auth, mcp, cli };
}

export function extractAll(observations, bodies) {
  return {
    product: extractProduct(observations, bodies),
    robots: extractRobots(observations, bodies),
    llmsTxt: extractLlmsTxt(observations, bodies),
    agentJson: extractAgentJson(observations, bodies),
    openapi: extractOpenApi(observations, bodies),
    pricingJson: extractPricingJson(observations, bodies),
    pricingPages: extractPricingPages(observations, bodies),
    mentions: extractMentions(observations, bodies),
    parseFailures: jsonParseFailures(observations, bodies),
  };
}
