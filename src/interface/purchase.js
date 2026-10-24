import { htmlToText, registrableDomain, sameSite } from "./sources.js";
import { AGENT_FACING, DOMAIN_ACTORS, PROTOCOL_DESCRIPTION, PROTOCOL_SITES, SELLER, paysElsewhere, sentenceAround } from "./onboarding.js";
import { quoteAt } from "./quote.js";

// Whether the product's own pages document a way for an agent to buy from it through an API, and whether a person
// approves first. Rules over page text, like the onboarding signals: each rule is a named pattern, every hit carries
// its quote, and a hit is a claim the docs make, never a result. Only pages on the product's registrable domain count.

// An agent is the one buying: "An agent can buy runs with POST /v1/purchases", "the agent buys runs", "agents can
// purchase credits". Not "agents cannot buy" (no match), and not a billing product's customers (guarded below).
const AGENT_BUYS = /\b(?:an?|the|your|its) (?:AI )?agents? (?:can |may |then |also )?(?:buy|buys|purchase|purchases|pay for|pays for|top up|tops up)\b/gi;
// How it buys, in the same sentence: a purchase call, a spending cap or a mandate, or a person approving.
const PURCHASE_CALL = /\bPOST\s+`?(?:https?:\/\/([^\s/`]+))?(?:\/[\w.:{}-]+)*\/(?:purchases?|orders?|checkouts?|buy|top-?ups?|credits?)\b/i;
const SPEND_LIMIT = /\b(?:monthly|daily|weekly|spending|budget) (?:cap|limit)\b|\bwithin (?:a|the|its|their) (?:\w+ )?(?:cap|limit|budget)\b|\bmandates?\b/i;
// A person sets payment up once: "a person approves once through an approval link", "402 payment_required with an
// approval_url", "After that approval, the agent buys", a mandate a person signs, Exa's "charged to the card behind the
// delegation". Read within APPROVAL_WINDOW characters of the match, so the next sentence counts too.
const APPROVAL = /\bapprov(?:e|es|ed|al|ing)\b|\bapproval[_ ](?:url|link)\b|\bmandates?\b|\bsaves? (?:a|the) card\b|\bsaved card\b|\bdelegat(?:e|es|ed|ion|ions)\b|\bcard (?:behind|on file)\b|\bcard-on-file\b/i;
const APPROVAL_WINDOW = 300;
// The product answers a purchase it cannot make yet with 402 and a link a person approves: "answers 402
// payment_required with an approval link". A bare 402 is not this: it also means "claim first" (Cosmic) or "over your
// plan" (Inkbox); those sentences name no approval.
const PAYMENT_REQUIRED = /\b402\b|\bpayment_required\b/gi;
// Paying per request in the request itself, on the product's own API: x402 or MPP next to a call that is itself
// paid. A call is paid when its path says so (Telnyx's /v2/machine-payments/account-credit, AgentLine's
// /v1/x402/numbers/buy, Bitrefill's /x402/invoice/create, Exa's /team-management/nevermined/purchase-key), when it is
// the x402 or MPP variant of an endpoint (Keenable's /v1/x402/search, x402.telnyx.com), or when it sits under a
// heading that says the endpoints are paid (AgentCash's "## Paid endpoints (x402 or MPP)"). Calls are written as text
// ("POST /v1/x", "post /v1/x" in OpenAPI YAML) or as OpenAPI JSON keys ("/v1/x":{"post").
const PROTOCOL = /\bx402\b|\bMPP\b/g;
const TEXT_CALL = /\b(?:GET|POST)\s+`?((?:https?:\/\/[^\s/`]+)?\/[\w.:{}/-]*)/gi;
const JSON_CALL = /"(\/[\w.:{}/-]+)"\s*:\s*\{\s*"(?:get|post)"/gi;
const BUY_PATH = /buy|purchase/i;
const PAY_PATH = /pay|top-?up|credit|invoice|charge|checkout|order/i;
const BARE_PROTOCOL_PATH = /(?<![\w/.:-])(\/(?:v\d+|api)(?:\/[\w.:{}-]+)*\/(?:x402|mpp)\/[\w.:{}/-]+)/gi;
const PROTOCOL_PATH = /(?:^|\/|\.)(?:x402|mpp)(?:\/|\.|$)/i;
// Not a paid call: signing a payment to someone else (Neynar's /v2/signature/x402/), the facilitator's verify and
// settle, registering with a directory, and listings (Locus's /api/x402/endpoints/md, an openapi.json).
const NOT_PAID_PATH = /\/(?:sign(?:ature)?s?|verify|settle|facilitator|registry|register[\w-]*|endpoints|catalog|discovery|list|index|openapi|\.well-known|status|info|details?|events?)(?:\/|\.|$)|\.(?:md|json|ya?ml|txt)$/i;
const PAID_HEADING = /\bpaid\b|\bpay[- ]per[- ](?:call|request|use)\b/i;
const HEADING = /(?:^|\n|\\n)#{1,6}[ \t]+([^\n\\]+)/g;
// A seller's code or page: x402.org's quickstart for sellers configures paymentMiddleware with "GET /weather" and payTo.
const SELLER_SAMPLE = /\bpaymentMiddleware\b|\bpayTo\b|\bfacilitator\b|\bfor sellers\b|\baccept(?:ing)? payments\b|\bmonetiz/i;
// A wallet or proxy page: the agent pays other x402 services through the product (Locus's "Call any x402 URL", its x402
// catalog and wrapped APIs). A paid call there pays a third party, not this product.
const PROXY_PAGE = /\bany x402[- ](?:enabled )?(?:HTTPS )?(?:URL|endpoint|service)s?\b|\bx402 catalog\b|\bwrapped APIs?\b|\bconfigured x402 services\b/i;
const SELLER_PAGE = /sellers?|merchants?|monetiz|\/(?:templates?|examples?|starters?)\//i;
const URL_HOST = /https?:\/\/([a-z0-9.-]+\.[a-z]{2,})/gi;
// Agent-commerce products sell the same words to stores: "let AI agents buy from your store", "agents purchase on
// your site". The reader's store is not this product.
const BUYS_ELSEWHERE = /\b(?:from|on|in|at) your (?:store|shop|site|website|app|business|platform|product|catalog|checkout)\b|\b(?:merchants?|sellers?)\b/i;
// "does not authorize a purchase", "An agent cannot ... approve on its own": the sentence says it is not a way to buy.
const NOT_A_PURCHASE = /\b(?:not|never|no|cannot|can't)\b[^.]{0,40}\b(?:buy|purchase|pay)\b/i;
// A checkout an agent completes over an agent-commerce protocol, on the product's own API. ACP (OpenAI and Stripe's
// Agentic Commerce Protocol) has the merchant implement POST /checkout_sessions, POST /checkout_sessions/{id}/complete
// and three more; UCP (Google's Universal Commerce Protocol) names its REST checkout /checkout-sessions and has the
// business publish a profile at /.well-known/ucp; AP2 (Google's Agent Payments Protocol) defines no endpoint of its
// own, only mandates, so it is found through the agent-buying and mandate wording above, which records the protocol.
// A checkout is a purchase, not a request paid for in itself, so the wording never says "pays per request".
const CHECKOUT_PROTOCOL = /\bAgentic Commerce Protocol\b|\bACP\b|\bAgent Payments? Protocol\b|\bAP2\b|\bUniversal Commerce Protocol\b|\bUCP\b/g;
// A bare acronym is also other things (ACP is IBM's Agent Communication Protocol and Zed's Agent Client Protocol), so
// it counts only on a page that spells the name out or uses the protocol's own tokens.
const ACRONYM_SPELLED = {
  ACP: /\bAgentic Commerce Protocol\b|\bagenticcommerce\.dev\b|\bcheckout_sessions\b/i,
  AP2: /\bAgent Payments? Protocol\b|\bap2-protocol\.org\b|\bPayment Mandates?\b/i,
  UCP: /\bUniversal Commerce Protocol\b|\bucp\.dev\b|\bdev\.ucp\.|\/\.well-known\/ucp\b/i,
};
const CHECKOUT_CALL_PATH = /\/checkout[_-]sessions?(?:\/|$)/i;
// A vendor selling the protocol to merchants: a PSP's delegated payment endpoint (OpenAI -> PSP, never the merchant's),
// payment providers, storefronts, and the reader's own endpoints ("your /checkout_sessions endpoint").
const CHECKOUT_VENDOR = /\bdelegate_payment\b|\bPSPs?\b|\bpayment (?:service )?providers?\b|\bstorefronts?\b|\byour (?:own )?(?:checkout_sessions|checkout-sessions|endpoints?|API|integration|implementation)\b/i;
const CHECKOUT_PROTOCOL_DESCRIPTION = /\b(?:ACP|AP2|UCP|Agentic Commerce Protocol|Agent Payments? Protocol|Universal Commerce Protocol)\b[^.]{0,40}?\bis (?:a|an|the)\b[^.]{0,80}?\b(?:standard|protocol)\b/i;
// The served profile is JSON with a top-level "ucp" member (ucp.dev: "A profile document is a JSON object with a
// required ucp member"). A site that answers every path with its HTML app is not one, and a "ucp" key nested in
// some other document is not a profile.
function isUcpProfile(text) {
  let doc;
  try {
    doc = JSON.parse(text);
  } catch {
    return false;
  }
  return Boolean(doc) && typeof doc === "object" && !Array.isArray(doc) && Boolean(doc.ucp) && typeof doc.ucp === "object";
}
// The protocol a sentence names, for the funnel's wording.
const PROTOCOL_NAMES = [
  ["x402", /\bx402\b/],
  ["MPP", /\bMPP\b/],
  ["ACP", /\bAgentic Commerce Protocol\b|\bACP\b/],
  ["AP2", /\bAgent Payments? Protocol\b|\bAP2\b/],
  ["UCP", /\bUniversal Commerce Protocol\b|\bUCP\b/],
];
const EVIDENCE_MAX = 3;
const MAX_TRIED = 200;

// A URL in the sentence on another registrable domain means the purchase is somewhere else. The protocols' own
// sites are only described, so they do not count.
function namesOtherSite(sentence, ownDomain) {
  return [...sentence.matchAll(URL_HOST)].some((m) => {
    const domain = registrableDomain(m[1].toLowerCase());
    return domain !== ownDomain && !PROTOCOL_SITES.has(domain);
  });
}

function aboutSomethingElse(sentence, ownDomain) {
  return DOMAIN_ACTORS.test(sentence) || SELLER.test(sentence) || BUYS_ELSEWHERE.test(sentence) || paysElsewhere(sentence, ownDomain) || namesOtherSite(sentence, ownDomain);
}

// The best paid call in a raw sentence: 4 for a buying path, 3 for another paying path, 2 for an x402 or MPP variant,
// 1 under a paid heading. A bare path counts only when it is an API path (/v1/…, /api/…) to an x402 or MPP variant
// ("/v1/x402/search"); docs links such as /integrations/x402/agentkit are not calls.
function paidCall(raw) {
  let best = null;
  const calls = [...[...raw.matchAll(TEXT_CALL)].map((m) => ({ at: m.index, url: m[1], text: m[0] })), ...[...raw.matchAll(JSON_CALL)].map((m) => ({ at: m.index, url: m[1], text: m[0] })), ...[...raw.matchAll(BARE_PROTOCOL_PATH)].map((m) => ({ at: m.index, url: m[1], text: `POST ${m[1]}` }))];
  for (const c of calls) {
    const path = c.url.replace(/^https?:\/\/[^/]+/, "").replace(/[.:,;]+$/, "");
    const host = /^https?:\/\/([^/]+)/.exec(c.url)?.[1] || "";
    if (NOT_PAID_PATH.test(path)) continue;
    const heading = [...raw.slice(0, c.at).matchAll(HEADING)].at(-1)?.[1] || "";
    const score = BUY_PATH.test(path) ? 4 : PAY_PATH.test(path) ? 3 : PROTOCOL_PATH.test(path) || PROTOCOL_PATH.test(host) ? 2 : PAID_HEADING.test(heading) ? 1 : 0;
    if (score && (!best || score > best.score)) best = { ...c, path, score };
  }
  return best;
}

// The protocol a sentence names. A bare ACP, AP2 or UCP counts only when the page spells it out (ACRONYM_SPELLED),
// so a page about Zed's Agent Client Protocol never names ACP as the way an agent pays.
function protocolIn(sentence, page = sentence) {
  const name = PROTOCOL_NAMES.find(([, re]) => re.test(sentence))?.[0] || null;
  if (name && ACRONYM_SPELLED[name] && !ACRONYM_SPELLED[name].test(page)) return null;
  return name;
}

// The sentence around a match, or the section under it when the match is on a markdown heading line ("## Paid
// endpoints (x402 or MPP)", "## Checkout (ACP)"): the calls are in the text under the heading.
function around(text, m) {
  const lineStart = text.lastIndexOf("\n", m.index) + 1;
  const line = text.slice(lineStart, (text.indexOf("\n", m.index) + 1 || text.length + 1) - 1);
  return /^#{1,6}[ \t]/.test(line) ? section(text, lineStart) : sentenceAround(text, m.index, m.index + m[0].length);
}

// A checkout session call in a raw sentence, on the product's own API: ACP's "POST /checkout_sessions", UCP's
// "POST https://api.acme.dev/api/v2/checkout-sessions", an OpenAPI key "/checkout_sessions":{"post". Other hosts are
// caught by namesOtherSite on the sentence.
function checkoutCall(raw) {
  const calls = [...[...raw.matchAll(TEXT_CALL)].map((m) => ({ at: m.index, url: m[1], text: m[0] })), ...[...raw.matchAll(JSON_CALL)].map((m) => ({ at: m.index, url: m[1], text: m[0] }))];
  for (const c of calls) {
    const path = c.url.replace(/^https?:\/\/[^/]+/, "").replace(/[.:,;]+$/, "");
    if (CHECKOUT_CALL_PATH.test(path)) return { ...c, path };
  }
  return null;
}

// A heading line and the text under it, up to the next heading or SECTION_MAX characters.
const SECTION_MAX = 1500;
function section(text, start) {
  const rest = text.slice(start, start + SECTION_MAX);
  const next = rest.slice(1).search(/\n#{1,6}[ \t]/);
  return next === -1 ? rest : rest.slice(0, next + 1);
}

const RULES = {
  // An agent buying, with the call, a cap or an approval in the same sentence.
  agent_buys_through_api: (text, ownDomain) => {
    for (const m of take(text, AGENT_BUYS)) {
      const sentence = sentenceAround(text, m.index, m.index + m[0].length).replace(/\s+/g, " ");
      if (aboutSomethingElse(sentence, ownDomain) || NOT_A_PURCHASE.test(sentence)) continue;
      if (PURCHASE_CALL.test(sentence) || SPEND_LIMIT.test(sentence) || APPROVAL.test(sentence)) return { index: m.index, sentence, call: callIn(sentence), score: 3 };
    }
    return null;
  },
  // 402 with a link or step a person approves.
  payment_required_approval: (text, ownDomain) => {
    for (const m of take(text, PAYMENT_REQUIRED)) {
      const sentence = sentenceAround(text, m.index, m.index + m[0].length).replace(/\s+/g, " ");
      if (aboutSomethingElse(sentence, ownDomain)) continue;
      if (/\bapproval[_ ](?:url|link)\b|\b(?:person|owner|human) (?:can )?approves?\b/i.test(sentence)) return { index: m.index, sentence, call: null, score: 3, approved: true };
    }
    return null;
  },
  // x402 or MPP next to a paid call on the product's own API. Every match on the page is tried and the best call kept,
  // so AgentLine's quote is its number purchase, not a polling endpoint in the same tag.
  pay_per_request_own_api: (text, ownDomain) => {
    let best = null;
    for (const m of take(text, PROTOCOL)) {
      const raw = around(text, m);
      const sentence = raw.replace(/\s+/g, " ");
      if (aboutSomethingElse(sentence, ownDomain) || PROTOCOL_DESCRIPTION.test(sentence) || SELLER_SAMPLE.test(sentence)) continue;
      const call = paidCall(raw);
      if (!call || (best && call.score <= best.score)) continue;
      const start = text.indexOf(raw, Math.max(0, m.index - raw.length));
      best = { index: start >= 0 ? start + call.at : m.index, sentence, call: `${call.text.match(/^\w+/)?.[0]?.toUpperCase() === "GET" || /"get"/i.test(call.text) ? "GET" : "POST"} ${call.path}`, score: call.score };
      if (best.score === 4) break;
    }
    return best;
  },
  // ACP or UCP next to a checkout session call on the product's own API. The merchant's checkout endpoints are the
  // product's own; a vendor's page about its merchants' endpoints is not.
  checkout_protocol_own_api: (text, ownDomain) => {
    for (const m of take(text, CHECKOUT_PROTOCOL)) {
      const spelled = ACRONYM_SPELLED[m[0]];
      if (spelled && !spelled.test(text)) continue;
      const raw = around(text, m);
      const sentence = raw.replace(/\s+/g, " ");
      if (aboutSomethingElse(sentence, ownDomain) || CHECKOUT_PROTOCOL_DESCRIPTION.test(sentence) || CHECKOUT_VENDOR.test(sentence) || NOT_A_PURCHASE.test(sentence)) continue;
      const call = checkoutCall(raw);
      if (!call) continue;
      const start = text.indexOf(raw, Math.max(0, m.index - raw.length));
      return { index: start >= 0 ? start + call.at : m.index, sentence, call: `${/^get\b/i.test(call.text) || /"get"/i.test(call.text) ? "GET" : "POST"} ${call.path}`, score: 3, protocol: protocolIn(sentence, text) };
    }
    return null;
  },
};

// "POST /v1/purchases" from the sentence, without a scheme or host, or null.
function callIn(sentence) {
  const m = PURCHASE_CALL.exec(sentence);
  return m ? m[0].replace(/`/g, "").replace(/https?:\/\/[^/\s]+/, "") : null;
}

function* take(text, re) {
  let tried = 0;
  for (const m of text.matchAll(re)) {
    yield m;
    tried += 1;
    if (tried >= MAX_TRIED) return;
  }
}

// { rule, rules, approval, call, protocol, evidence: [{ obs, quote }] } or null. call is the purchase or paid call an
// agent makes, when a quoted sentence names one; protocol is the one the quoted sentence names (x402, MPP, ACP, AP2,
// UCP), when it names one. approval: "once" when a person sets payment up first near any hit (an approval
// link, a cap a person sets, a mandate, a delegation, a saved card), else "none_documented".
export function detectAgentPurchase(doc, bodies) {
  const ownDomain = registrableDomain(new URL(doc.target.url).hostname);
  const hits = [];
  for (const obs of doc.observations) {
    const body = bodies.get(obs.id);
    if (!body || !obs.ok || !sameSite(obs.url, doc.target.url) || obs.role === "sitemap") continue;
    const text = body.html ? htmlToText(body.text) : body.text;
    // The product publishes its UCP business profile: the product saying agents can check out with it over UCP.
    if (obs.role === "ucp_profile") {
      if (isUcpProfile(text)) hits.push({ rule: "checkout_protocol_own_api", obs: obs.id, quote: new URL(obs.url).pathname, label: "UCP business profile", approval: false, call: null, score: 2, protocol: "UCP", agentFacing: true });
      continue;
    }
    const sellerPage = SELLER_PAGE.test(new URL(obs.url).pathname);
    for (const [rule, find] of Object.entries(RULES)) {
      if ((rule === "pay_per_request_own_api" || rule === "checkout_protocol_own_api") && (sellerPage || PROXY_PAGE.test(text))) continue;
      if (hits.filter((h) => h.rule === rule).length >= EVIDENCE_MAX) continue;
      const hit = find(text, ownDomain);
      if (!hit) continue;
      const near = text.slice(Math.max(0, hit.index - APPROVAL_WINDOW), hit.index + APPROVAL_WINDOW);
      // The sentence or labelled element holding the hit (src/interface/quote.js); null when the words run across two
      // elements of the page, and then the hit has no quote.
      const q = quoteAt(body, text, hit.index, hit.index + 1, obs.role);
      hits.push({ rule, obs: obs.id, quote: q?.quote || null, ...(q?.label ? { label: q.label } : {}), approval: Boolean(hit.approved) || APPROVAL.test(hit.sentence) || APPROVAL.test(near), call: hit.call, score: hit.score, protocol: hit.protocol || protocolIn(hit.sentence, text), agentFacing: AGENT_FACING.has(obs.role) });
    }
  }
  if (!hits.length) return null;
  // An agent buying through the API is the strongest claim; 402 with approval alone still says how a purchase goes.
  const order = ["agent_buys_through_api", "payment_required_approval", "pay_per_request_own_api", "checkout_protocol_own_api"];
  const rule = order.find((r) => hits.some((h) => h.rule === r));
  // The strongest call first, then quotes from pages written for agents.
  const ordered = [...hits].sort((a, b) => b.score - a.score || Number(b.agentFacing) - Number(a.agentFacing));
  const ruled = ordered.filter((h) => h.rule === rule);
  return {
    rule,
    rules: [...new Set(hits.map((h) => h.rule))],
    approval: hits.some((h) => h.approval) ? "once" : "none_documented",
    call: ruled.find((h) => h.call)?.call || null,
    protocol: ruled.find((h) => h.protocol)?.protocol || null,
    evidence: ordered.filter((h) => h.rule === rule).concat(ordered.filter((h) => h.rule !== rule)).slice(0, EVIDENCE_MAX * 2).map(({ obs, quote, label }) => ({ obs, quote, ...(label ? { label } : {}) })),
  };
}
