import { createHash } from "node:crypto";
import { getDomain, parse } from "tldts";
import { get, isHtml, joinUrl } from "../probe/http.js";

// Discover and fetch a product's first-party public surfaces. Every fetch becomes one observation with provenance:
// what URL, what we got back, when, and how we found it (a guessed well-known path, a link on another page, the sitemap).
// Nothing here judges anything.

const WELL_KNOWN = [
  { role: "homepage", path: "/" },
  { role: "robots", path: "/robots.txt" },
  { role: "llms_txt", path: "/llms.txt" },
  { role: "llms_full", path: "/llms-full.txt" },
  { role: "auth", path: "/auth.md" },
  // Agent-first products publish their signup procedure as a file an agent can
  // read: Telnyx at /agent-signup.md, Cosmic at /skill.md (redirected to its docs).
  { role: "onboarding", path: "/agent-signup.md" },
  { role: "onboarding", path: "/skill.md" },
  { role: "prm", path: "/.well-known/oauth-protected-resource" },
  { role: "agent_json", path: "/.well-known/agent.json" },
  { role: "agent_json", path: "/.well-known/agent-card.json" },
  { role: "mcp_json", path: "/.well-known/mcp.json" },
  // A business's Universal Commerce Protocol profile (ucp.dev: "Businesses publish their profile at /.well-known/ucp").
  { role: "ucp_profile", path: "/.well-known/ucp" },
  { role: "pricing_json", path: "/pricing.json" },
  { role: "openapi", path: "/openapi.json" },
  { role: "openapi", path: "/.well-known/openapi.json" },
  { role: "openapi", path: "/openapi.yaml" },
  { role: "openapi", path: "/v3/api-docs" },
  { role: "openapi", path: "/swagger.json" },
  { role: "sitemap", path: "/sitemap.xml" },
  { role: "pricing", path: "/pricing" },
  { role: "docs", path: "/docs" },
];

// A link is worth following when its path or text says what it is. One role per pattern; first match wins.
const LINK_ROLES = [
  // First, so an agent-signup page is not filed under the looser auth or docs roles.
  ["onboarding", /agent[-_]?(sign-?up|mode|register|onboarding)|agent-skills|\/skill\.md$|\/auth\.md$|\/claim(\.md)?$|claim-deployments|temporary-accounts|x402/i],
  ["pricing", /^\/(pricing|plans|price)(\.(md|html?))?\/?$/i],
  ["auth", /auth|api-key|apikey|api_keys|credentials|tokens?\b|oauth/i],
  ["mcp", /\bmcp\b|model-context-protocol/i],
  ["cli", /\bcli\b|command-line/i],
  ["api_docs", /api-reference|\/reference|\/api\b|api-docs|openapi|swagger|graphql/i],
  ["docs", /\/docs?\b|documentation|developers?\b|\/guides?\b|getting-started|quickstart/i],
];

const MAX_OBSERVATIONS = 36;
const MAX_FOLLOW = 14;
const MAX_PER_ROLE = 3;
const SKIP_PATH = /\/(blog|news|changelog|careers|legal|privacy|terms)\b|\.(png|jpg|svg|css|js|xml|json)$/i;

function sha(text) {
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

// By the Public Suffix List bundled with tldts (no network), including its private section: platform suffixes
// such as vercel.app, github.io and s3.amazonaws.com, where each tenant is its own site. An IP address, a bare
// suffix or a single-label name has no registrable domain and stands for itself.
const PSL = { allowPrivateDomains: true };
export function registrableDomain(host) {
  const name = host.toLowerCase();
  return getDomain(name, PSL) || name;
}

// Whether a host on another site looks like the product's own: its registrable name, without the suffix, is the
// product's (acme.io for acme.dev, foo.netlify.app for foo.vercel.app) or the product's plus docs, api, dev, app or hq
// (acmedocs.com, foo-docs.vercel.app). Conservative on purpose: docs a product links on nextjs.org, docker.com or
// raw.githubusercontent.com are someone else's, and counting them put a note on most products.
const OWN_SUFFIXES = /^-?(?:docs|api|dev|app|hq)$/;
export function productHost(host, base) {
  const own = parse(new URL(base).hostname, PSL).domainWithoutSuffix;
  const other = parse(host.toLowerCase(), PSL).domainWithoutSuffix;
  if (!own || !other) return false;
  return other === own || (other.startsWith(own) && OWN_SUFFIXES.test(other.slice(own.length)));
}

// The host is itself a public suffix (co.uk, gov.au, x.ck under *.ck): no name under it belongs to one owner.
export function isPublicSuffix(host) {
  const parsed = parse(host.toLowerCase(), PSL);
  return !parsed.isIp && parsed.domain === null;
}

// The name is a public suffix by the ICANN section alone (co.uk, gov.au), not counting platform suffixes
// such as workers.dev, whose subdomains are deployments a product's own tool can print.
export function isIcannSuffix(host) {
  const parsed = parse(host.toLowerCase());
  return !parsed.isIp && parsed.domain === null;
}

// The host sits under a platform suffix (tenant.vercel.app, user.github.io): its neighbours on that suffix are
// other customers of the platform, so nothing but the host itself belongs to the product.
export function onSharedHost(host) {
  return parse(host.toLowerCase(), PSL).isPrivate === true;
}

// The product's own hosts an agent is sent to most often, besides the one it was given. The CLI's network (verify)
// and a hosted run's reach (usability) use the same list.
export const PRODUCT_SUBDOMAINS = ["www", "api", "docs", "app", "auth", "console", "dashboard", "developers"];

export function sameSite(url, base) {
  try {
    // Hostname, not host: a port is not part of which site something belongs to.
    return registrableDomain(new URL(url).hostname) === registrableDomain(new URL(base).hostname);
  } catch {
    return false;
  }
}

// Pull href + anchor text pairs out of HTML without a DOM.
export function extractLinks(html, pageUrl) {
  const out = [];
  const re = /<a\b[^>]*href\s*=\s*["']([^"'#]+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(html))) {
    let href;
    try {
      href = new URL(m[1], pageUrl).toString();
    } catch {
      continue;
    }
    const text = m[2].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 80);
    out.push({ href: href.replace(/[?#].*$/, ""), text });
  }
  return out;
}

export function extractMarkdownLinks(text, pageUrl) {
  const out = [];
  // Bounded and on one line, so an unclosed "[" does not rescan the rest of the file.
  const re = /\[([^\[\]\n]{0,500})\]\(([^)\s]+)\)/g;
  let m;
  while ((m = re.exec(text))) {
    try {
      out.push({ href: new URL(m[2], pageUrl).toString().replace(/[?#].*$/, ""), text: m[1].slice(0, 80) });
    } catch {
      // not a URL
    }
  }
  return out;
}

export function extractSitemapUrls(xml) {
  return [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)].map((m) => m[1]);
}

// Role comes from the path; anchor text alone is too loose (every blog post "about pricing" would match).
export function roleForLink({ href }) {
  let path;
  try {
    path = new URL(href).pathname;
  } catch {
    return null;
  }
  if (SKIP_PATH.test(path)) return null;
  for (const [role, re] of LINK_ROLES) if (re.test(path)) return role;
  return null;
}

// "&#8217;" and "&#x2019;" (x402.org writes "the Internet&#8217;s original sin"). src/interface/quote.js decodes the same
// way, so its block offsets line up with this text.
export const NUMERIC_ENTITY = /&#(?:(\d{1,7})|x([0-9a-f]{1,6}));/gi;
export function decodeNumeric(whole, dec, hex) {
  const n = dec ? Number(dec) : parseInt(hex, 16);
  return n > 0 && n <= 0x10ffff && !(n >= 0xd800 && n <= 0xdfff) ? String.fromCodePoint(n) : whole;
}

export function htmlToText(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(NUMERIC_ENTITY, decodeNumeric)
    .replace(/\s+/g, " ")
    .trim();
}

function observation(id, role, url, res, discoveredVia) {
  const text = res.text || "";
  return {
    id,
    role,
    url,
    finalUrl: res.url || url,
    method: "GET",
    status: res.status,
    ok: res.ok && res.status >= 200 && res.status < 300,
    contentType: res.contentType.split(";")[0].trim() || null,
    bytes: text.length,
    sha256: text ? sha(text) : null,
    fetchedAt: new Date().toISOString(),
    error: res.error || null,
    discoveredVia,
    excerpt: text ? (isHtml(res) ? htmlToText(text) : text).slice(0, 240) : "",
    // The one response header worth keeping: a 401 that names its resource
    // metadata is how an agent discovers what an API is without being told.
    wwwAuthenticate: res.headers?.["www-authenticate"] || null,
  };
}

// Returns observations (for the record) and bodies (kept in memory for extraction, never written out).
export async function collectSources(base, { log = () => {}, fetchSource = get } = {}) {
  const observations = [];
  const bodies = new Map();
  const seen = new Set();
  let n = 0;

  async function fetchOne(role, url, discoveredVia) {
    const key = url.replace(/\/$/, "");
    if (seen.has(key) || observations.length >= MAX_OBSERVATIONS) return null;
    seen.add(key);
    const res = await fetchSource(url);
    n += 1;
    const obs = observation(`obs_${String(n).padStart(2, "0")}`, role, url, res, discoveredVia);
    observations.push(obs);
    if (obs.ok && res.text) bodies.set(obs.id, { text: res.text, html: isHtml(res) });
    log(obs);
    return obs;
  }

  for (const w of WELL_KNOWN) await fetchOne(w.role, joinUrl(base, w.path), { kind: "well_known", path: w.path });

  // Docs often live on their own subdomain with their own llms.txt, and that is
  // where an agent-signup page is indexed (Mem0 links it only from docs.mem0.ai).
  const docsHost = `docs.${registrableDomain(new URL(base).host)}`;
  if (new URL(base).host !== docsHost) await fetchOne("llms_txt", `https://${docsHost}/llms.txt`, { kind: "well_known", path: "docs subdomain /llms.txt" });

  // If the resource metadata names its own API, ask that API for something
  // without a credential. A refusal is the observation: whether the 401 tells an
  // agent where the rules are written, or just says no. Without this the check
  // can never be satisfied by anyone, since nothing else we fetch is protected.
  // One unauthenticated GET, which is what any client does before it has a key.
  const prm = observations.find((o) => o.ok && o.role === "prm");
  const prmBody = prm && bodies.get(prm.id);
  if (prmBody) {
    let resource = null;
    try { resource = JSON.parse(prmBody.text).resource; } catch { resource = null; }
    if (typeof resource === "string" && /^https?:\/\//.test(resource)) {
      await fetchOne("resource_challenge", resource, { kind: "resource_metadata", path: "resource" });
    }
  }

  // Follow links from what we already have: homepage, llms.txt, docs, sitemap. Same registrable domain only. Hosts
  // skipped for being another site are counted when the link would otherwise have been followed (a docs or auth page)
  // and the host looks like the product's own (productHost), so a report can say what it did not read: a
  // platform-hosted product's docs on a sibling tenant (foo.vercel.app linking foo-docs.vercel.app) are another site.
  const candidates = [];
  const skippedHosts = new Set();
  for (const obs of [...observations]) {
    const body = bodies.get(obs.id);
    if (!body) continue;
    let links = [];
    if (obs.role === "sitemap") links = extractSitemapUrls(body.text).map((href) => ({ href, text: "" }));
    else if (body.html) links = extractLinks(body.text, obs.finalUrl);
    else if (obs.role === "llms_txt" || obs.role === "llms_full") links = extractMarkdownLinks(body.text, obs.finalUrl);
    for (const link of links) {
      const role = roleForLink(link);
      if (!role) continue;
      if (!sameSite(link.href, base)) {
        const host = new URL(link.href).host;
        if (productHost(host, base)) skippedHosts.add(host);
        continue;
      }
      candidates.push({ role, url: link.href, discoveredVia: { kind: "link", from: obs.id, text: link.text } });
    }
  }
  // Prefer roles we have not seen yet, then keep a few extra docs pages.
  const haveRole = new Set(observations.filter((o) => o.ok).map((o) => o.role));
  // Onboarding pages come first whatever else was found: they decide which way an agent can start.
  const rank = (c) => (c.role === "onboarding" ? -1 : Number(haveRole.has(c.role)));
  candidates.sort((a, b) => rank(a) - rank(b));
  let followed = 0;
  const perRole = {};
  for (const c of candidates) {
    if (followed >= MAX_FOLLOW) break;
    if ((perRole[c.role] || 0) >= MAX_PER_ROLE) continue;
    const obs = await fetchOne(c.role, c.url, c.discoveredVia);
    if (!obs) continue;
    followed += 1;
    perRole[c.role] = (perRole[c.role] || 0) + 1;
  }

  return { observations, bodies, otherHostsSkipped: skippedHosts.size };
}
