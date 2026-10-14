import { htmlToText, registrableDomain, sameSite } from "./sources.js";

// Which ways can an agent start using this product? Read from public docs only, so every pattern is a claim the docs
// make, with the quotes that make it; none is a result. A product can support several. Rules, not a model: each signal
// is a named pattern over page text, and each onboarding pattern is a named combination of signals.

const SIGNALS = {
  // The docs describe an agent getting an account or credential by itself.
  // Not "self sign-up" or "agent mode": real products use both for features unrelated to an agent signing itself up
  // (Twilio's WhatsApp sender self sign-up, Postman's and Copilot's Agent Mode). The code token agent_mode stays.
  // "Your agent can sign up.", "Agents create their own accounts.": the agent signs up here, and the clause ends there,
  // or goes on only to say how ("in one API call", "and get an API key instantly", ", get a key", "— no forms", "(beta)").
  // Agent-infra products use the same words for signing up somewhere else: AgentLine's "so your agent can sign up and
  // verify", AgentID's "apps where agents can sign up and sign in with AgentID". "No agent can sign up" is the opposite.
  bootstrap: /\bagent[- ]?sign[- ]?up\b|(?<!\b(?:no|not|never|where)\s+(?:\w+\s+){0,2})\bagents? (?:can )?(?:sign(?:s)? (?:itself |themselves )?up|creates? (?:its|their) own (?:accounts?|API keys?))(?:\*\*)?(?: here| for an account| in one (?:API )?(?:call|request)| and get (?:an? |its |their )?(?:own )?(?:API )?key| \(beta\)| instantly| immediately| automatically| programmatically)*(?=(?:\*\*)?\s*(?:[.;!)\n]|,\s*(?:and )?get\b|[—–]|$))|\/agents?\/sign-?up\b|\bsign(?:s|ing)? (?:itself|themselves) up\b|\bregisters? itself\b|\bno (?:human|account|signup|sign-up)(?: or API key)? (?:is )?(?:needed|required)\b|\bwithout (?:a |an )?(?:human|account)\b|\banonymous(?:ly)? (?:create|creates|provision|access|account|project|identit)|\btemporary (?:account|project|deployment)s?\b|--temporary\b|\binit --agent\b|\bagent_mode\b|\bbot[_ ]signup\b|\bidentity_types_supported\b/i,
  // A person can take ownership afterwards.
  claim: /\bclaim(?:s|ed|ing)? (?:it|this|the|your|their) (?:account|project|workspace|deployment|bucket|inbox|resources?)\b|\bclaim (?:url|code|link|token|flow|page|email)\b|\bclaim_url\b|\bclaimUrl\b|\/claim\b|\bunclaimed\b|\bclaimable\b|\b(?:human|owner|person) (?:can |may |will )?(?:later )?claim\b|\battach (?:a |the )?(?:human )?owner\b|\badopt (?:the |this )?workspace\b/i,
  // What the agent made goes away unless someone keeps it.
  // Tied to the account or resource: "quotes expire after 5 minutes" is not this. The sentence must name an account,
  // project, workspace, key or token and not a stored thing (STORED_THING below): Supermemory's "temporary facts drop
  // after they expire" is a memory's TTL, not an account awaiting an owner.
  expiry: /\b(?:unclaimed|temporary|anonymous)\b[^.]{0,80}\b(?:expire|deleted|removed)|\b(?:account|project|deployment|bucket|workspace)s? (?:expire|are deleted|is deleted)\b[^.]{0,40}\b(?:after|in|within|unless)\b|\bauto-?delet\w*|\b\d+[- ](?:minute|hour|day)s? to claim\b/i,
  // Before a person steps in, the agent can do only part of the job.
  restricted: /\b(?:only|just) (?:send|email|message|write)s? (?:mail |email |messages )?to (?:the|its|your|their) (?:human|owner)\b|\brestricted (?:until|before|to (?:the|its|your) (?:human|owner))\b|\brestrictions? (?:lift|are lifted|are removed)\b|\buntil (?:the )?(?:human|owner|account) (?:verifies|claims|is verified)\b|\buntil (?:verified|claimed|verification)\b|\blimited (?:scope|access) until\b/i,
  // The product asks the agent to prove it is an agent rather than to prove it is a person.
  agentChallenge: /\bbot[_ ]challenge\b|\breverse[- ]captcha\b|\bchallenge_type\b|\bagent[- ]?captcha\b|\bproof[- ]of[- ]work\b/i,
  // Some step goes through an inbox.
  emailStep: /\bmagic link\b|\bverification (?:code|email|link)\b|\bemailed (?:code|OTP|link)\b|\bOTP\b|\breadable (?:mail)?box\b|\bagent inbox\b/i,
  // The agent can add money without a person at a checkout page.
  apiFunding: /\badd (?:USD )?credit programmatically\b|\bno portal funding\b|\bfund (?:the|your) account[^.]{0,60}\b(?:API|programmatically)\b/i,
  // The agent authenticates as itself, with authority delegated by a person.
  // "Agent verified successfully" after a person approves it is a claim step, not this.
  // AgentID is matched on its own (AGENTID_SIGN_IN below): its name alone is not a way in.
  agentIdentity: /\b[Vv]erified agent identity\b|\b[Aa]gent identity (?:token|assertion|provider)\b|\b[Aa]gent[- ]verified (?:identity|registration|sign-?in)\b/,
  // A person has to set access up before the agent starts.
  // A token a person creates counts the same way: GitHub's "personal access token", Vercel's "create a token on the
  // tokens page", Neon's "authenticate with a Neon API key", MarginFront's "Get a secret API key (`mf_sk_*`) from the
  // dashboard's Developer Zone", Supermemory's "API requests require an API key from the console".
  humanFirst: /\bpersonal access tokens?\b|\bcreate (?:a |an )?(?:new )?(?:access |API )?token (?:on|in|from) (?:the |your )?(?:\w+ )?(?:tokens? page|dashboard|settings|account settings|console)\b|\bauthenticate (?:with|using) (?:a |an |your )?(?:[A-Z]\w+ )?API key\b|\bmanage (?:your )?API keys? (?:at|in|from|on)\b|\b(?:generate|get|find|create|copy|requires?|required) (?:a |an |your )?(?:new )?(?:secret |live |test )?API key\b[^.\n]{0,40}?\b(?:in|from|at|on|under) (?:the |your )?(?:dashboard|console|portal|settings|account)\b|\bcreate (?:an |your )?API key (?:in|from) (?:the |your )?(?:dashboard|console|portal)\b|\b(?:sign|log) ?in to (?:the |your )?(?:dashboard|console|portal)\b|\blink (?:your|a) (?:Stripe )?account\b|\btell the user to complete sign-?in\b|\bbrowser was opened for authentication\b/i,
  // A request is paid for in the request itself. A bare 402 is not this: products also
  // use it to mean "claim first" (Cosmic) or "over your plan" (Inkbox).
  payPerRequest: /\bx402\b|\bX-PAYMENT\b|\bPAYMENT-REQUIRED\b/,
  // The documented way in is a command-line tool rather than an HTTP call.
  cliBootstrap: /\b(?:npx|wrangler|mem0|stripe|npm i(?:nstall)?|pip install|brew install)\b[^\n]{0,60}(?:--temporary|--agent|\binit\b|\bsign-?up\b|projects init)/i,
  // The product's CLI takes a token without a browser, so an agent can run it unattended once a person has made the
  // token: Vercel's "Set the VERCEL_TOKEN environment variable" or "Pass the --token option", GitHub's "--with-token".
  // An environment variable counts only where the text calls it one: code samples are full of other _API_KEY names.
  cliToken: /--with-token\b|\b[Pp]ass the --(?:token|api-key) (?:option|flag)\b|\b[A-Z][A-Z0-9]*_(?:TOKEN|API_KEY|ACCESS_TOKEN)\b environment variable|\benvironment variables? (?:named |called )?\b[A-Z][A-Z0-9]*_(?:TOKEN|API_KEY|ACCESS_TOKEN)\b/,
  // The CLI signs in through a browser: a person has to be at the machine once.
  cliBrowserLogin: /\bweb-based browser flow\b|\blaunches a browser\b|\bbrowser window where you (?:authorize|log in|sign in)\b|\brequires manual input\b/i,
  // A signup call: the path ends in a signup, register or onboard segment (Moltbook's /api/v1/agents/register, Cosmic's
  // /v3/agents/sign-up, Telnyx's /v2/bot_signup), or in agent/identity or agent/auth (Neon's
  // claimable.neon.tech/v1/agent/identity, Firecrawl's www.firecrawl.dev/agent/auth). A path that only contains
  // "agents" is not one: an agent-billing product's POST /v1/agents or POST /v1/pricing-plans/:planId/agents creates a
  // record about its customer's agent. Nor is a call under the signup path: Inkbox's
  // POST /agent-signup/{identity_id}/approve is a person approving.
  httpBootstrap: /\bPOST\s+(?:https?:\/\/[^\s/]+)?(?:\/[\w.:{}-]+)*\/(?:(?:\w+[-_])?(?:sign[-_]?ups?|register|registration|onboard)|agents?\/(?:identity|auth))\/?(?![\w/{-])|curl -X POST \S*\/(?:(?:\w+[-_])?(?:sign[-_]?ups?|register|registration|onboard)|agents?\/(?:identity|auth))\/?(?![\w/{-])/i,
};

export const PATTERNS = {
  try_then_claim: {
    name: "Try first, claim later",
    humanBoundary: "After the first job, if a person wants to keep what the agent made.",
  },
  limited_until_claimed: {
    name: "Limited until claimed",
    humanBoundary: "Before the agent needs more than the restricted scope allows.",
  },
  agent_is_customer: {
    name: "Agent is the customer",
    humanBoundary: "None documented. The agent signs up and holds the account itself.",
  },
  agent_identity: {
    name: "Agent identity",
    humanBoundary: "When the agent's owner sets up its identity or approves an app.",
  },
  existing_account: {
    name: "Person sets up access first",
    humanBoundary: "Before the agent starts: a person creates the account or key.",
  },
  pay_per_request: {
    name: "Payment instead of signup",
    humanBoundary: "Only to fund the wallet the agent pays from.",
  },
};

// AgentID (issuer https://auth.agentid.com, from AgentMail) is an OpenID Connect provider for agents: the agent signs
// in as itself from its AgentMail inbox, and no person approves each sign-in. A product accepts it when its own pages
// say so, in one of these forms, each from a live page read 2026-10-06:
// - a sign-in phrase: Archil's llms.txt "Archil accepts [AgentID](https://www.agentid.com) ... choose "Sign up with
//   AgentID"", Keenable's agent-api-key.md "You signed in to Keenable with AgentID";
// - "via AgentID", "the AgentID path" or "chooses AgentID" next to sign-in words: AgentLine's skill.md "Get one via
//   **AgentID**", Locus's auth.md "An agent-owned account chooses AgentID";
// - on an agent-facing page, AgentID declared as the identity provider or issuer: Locus's auth.md "Identity provider:
//   AgentID OpenID Connect", "Issuer: `https://auth.agentid.com`";
// - the product's own AgentID route: AgentLine's POST /v1/auth/agentid/start, Locus's /agent/identity/agentid.
// The name alone is not this: AgentMail's homepage links "New product AgentID", launch posts name it, and
// opencatalog's llms.txt "AgentID is configured" is a deployment status, not a way in. Integration tokens are not this
// either: oauth_agentid, the discovery URL and @agentmail/agentid-better-auth are on Clerk's and AgentID's own docs,
// which teach other apps to accept it. Case-sensitive: an "agentId" field is an id, not AgentID.
const AGENTID_NAME = String.raw`(?:\*\*|\[|"|“)?AgentID\b`;
const AGENTID_SIGN_IN = new RegExp(String.raw`\b(?:[Ss]ign(?:s|ed|ing)?[- ]?(?:in|up)|[Ll]og(?:s|ged|ging)?[- ]?in|[Aa]uthenticat(?:e|es|ed|ing)|[Cc]ontinue)(?:\s+(?:in)?to\s+[\w.-]+(?:\s+[\w.-]+)?)?\s+(?:with|using)\s+${AGENTID_NAME}|\b(?:[Aa]ccepts?|[Ss]upports?)\s+${AGENTID_NAME}`, "g");
const AGENTID_VIA = new RegExp(String.raw`\bvia\s+${AGENTID_NAME}|\bAgentID(?:\*\*)? path\b|\bchoos(?:es?|ing)\s+${AGENTID_NAME}`, "g");
const AGENTID_DECLARED = /\b[Ii]dentity provider:?\s*(?:\*\*)?AgentID\b|\b[Ii]ssuer:?\s*[`"]?https:\/\/auth\.agentid\.com\b/g;
const AGENTID_ROUTE = /\/(?:auth|identity|oauth2?|sso|login)\/agentid\b/g;
// "via AgentID" and the others need sign-in words nearby: "via AgentID" alone could be anything.
const AGENTID_AUTH_WORDS = /\b(?:sign|log|auth\w*|account|key|token|credential|session|OIDC|OpenID)|_(?:KEY|TOKEN)\b/i;
// Words next to the match that put the sign-in at another product: AgentMail's llms.txt has agents "sign in with
// AgentID where apps accept it", AgentID's site says "Find apps that accept AgentID", "services where agents can sign
// up and sign in with AgentID", "on the app's login page" and
// "add Sign in with AgentID to your app", and Clerk's docs "allow your users to sign up and sign in". A first-party
// sentence that goes on to "your application settings" is not one of these.
const AGENTID_ELSEWHERE = /\b(?:apps?|sites?|services?|products?)\s+(?:that|which)\s+(?:accept|support)|\bwhere\s+(?:apps?|sites?|services?)\s+(?:accept|support)|\b(?:apps?|sites?|services?|products?)\s+where\s+agents\b|\b(?:any|other|every)\s+(?:apps?|sites?|services?|products?)\b|\bthe app['’]s\b|\b(?:to|into|in|add)\s+your\s+(?:app|application|site|product|login page|sign-in page)\b|\b(?:let|allow)s?\s+your users\b|\byour app['’]s\b/i;
// A page written for developers adding AgentID to their own app, as AgentID's guides ("Add AgentID to Clerk",
// "Accepting AgentID sign-ins") and its llms.txt ("Relying party (RP): an app that accepts AgentID sign-ins") are.
// Wherever it is copied, it teaches integration; it does not say this product accepts AgentID.
const AGENTID_INTEGRATION_PAGE = /\bAdd AgentID to\b|\b[Aa]ccepting AgentID sign-ins\b|\b[Rr]elying part(?:y|ies)\b/;
// An auth vendor's integration note in the same sentence: "Descope accepts AgentID through its OIDC connector", "The
// Better Auth plugin lets you sign in with AgentID". Only the sentence itself: Keenable's llms.txt line ends just
// before a link to its "Integrations directory".
const AGENTID_VENDOR = /\b(?:connection|connector|plugin|integration)s?\b/i;
// Looks for the sentence's ends only within 200 characters of the match: a 2 MB page on one line would otherwise be
// scanned end to end for every match. A line break followed by a lowercase letter is hard-wrapped prose, not the end of
// a sentence: fly.io's auth.md wraps "registers itself\ndynamically".
export function sentenceAround(text, start, end) {
  const lo = Math.max(0, start - 200);
  const near = text.slice(lo, Math.min(text.length, end + 200));
  const wrapped = (i) => /[a-z]/.test(near[i + 1] || "");
  let from = Math.max(near.lastIndexOf(". ", start - lo), 0);
  for (let i = near.lastIndexOf("\n", start - lo); i > from; i = near.lastIndexOf("\n", i - 1)) {
    if (!wrapped(i)) {
      from = i;
      break;
    }
  }
  let to = near.indexOf(". ", end - lo);
  if (to < 0) to = near.length;
  for (let i = near.indexOf("\n", end - lo); i >= 0 && i < to; i = near.indexOf("\n", i + 1)) {
    if (!wrapped(i)) {
      to = i;
      break;
    }
  }
  return near.slice(from, to);
}

// News that another company added AgentID: "Clerk now supports AgentID as a social connection", "Turso added Sign
// in with AgentID". The word before the verb is the company; it counts only when it names the product being checked.
const AGENTID_ANNOUNCED = /\b([A-Z][\w.-]*)\s+(?:now\s+)?(?:supports|accepts|added|adds|launched|launches|ships|shipped|announced)\b/g;
const SELF_WORDS = new Set(["it", "we", "this", "our", "now", "also"]);

// The issuer's own site documents AgentID for the apps that accept it; it is not one of them. Its "a verified agent
// identity" describes what those apps receive, so neither AgentID nor the general agent-identity wording counts there.
const AGENTID_ISSUER = "https://auth.agentid.com/";
// Whether the product mentions the owner claims near its AgentID sign-in. owner_sub is left out: it comes with the
// plain profile scope and is an opaque id, not a verified owner.
const AGENTID_OWNER = /\bowner_(?:email|name|profile)\b/;
const OWNER_WINDOW = 800;
// What the agent needs, for the reasons here and in the funnel.
export const AGENTID_NEEDS = "an AgentMail inbox (the inbox is its AgentID), an AgentMail key with app_connect on, and usually a browser (or the owner finishes the sign-in in the AgentMail console, or the agent's software registers its own signing key with AgentMail)";

// Pages that exist to tell an agent how to start. A signal quoted from one of these is the product saying so.
export const AGENT_FACING = new Set(["onboarding", "auth", "llms_txt", "llms_full", "prm"]);
const EVIDENCE_PER_SIGNAL = 3;

// Starts at a word boundary a little before the match, so the quote reads as text.
export function quoteAround(text, index, width = 220) {
  let start = Math.max(0, index - 60);
  if (start > 0) start = Math.min(index, text.indexOf(" ", start) + 1 || index);
  return text.slice(start, start + width).replace(/\s+/g, " ").trim();
}

// Whether the words just before a match announce some other company's AgentID support.
function announcedByOther(before, doc) {
  const own = [...doc.target.host.toLowerCase().split("."), ...String(doc.product?.name?.value || "").toLowerCase().split(/\s+/)].filter(Boolean);
  return [...before.matchAll(AGENTID_ANNOUNCED)].some((m) => !SELF_WORDS.has(m[1].toLowerCase()) && !own.includes(m[1].toLowerCase()));
}

// Every match on a page is tried, so one guarded mention does not hide a real one further down.
function findAgentIdSignIn(doc, bodies) {
  const out = [];
  let ownerDocumented = false;
  for (const obs of doc.observations) {
    const body = bodies.get(obs.id);
    if (!body || out.length >= EVIDENCE_PER_SIGNAL || !sameSite(obs.url, doc.target.url)) continue;
    const text = body.html ? htmlToText(body.text) : body.text;
    if (AGENTID_INTEGRATION_PAGE.test(text)) continue;
    const agentFacing = AGENT_FACING.has(obs.role);
    const matches = [
      ...[...text.matchAll(AGENTID_SIGN_IN)],
      ...[...text.matchAll(AGENTID_VIA)].filter((m) => AGENTID_AUTH_WORDS.test(text.slice(Math.max(0, m.index - 120), m.index + m[0].length + 120))),
      ...(agentFacing ? [...text.matchAll(AGENTID_DECLARED)] : []),
      ...[...text.matchAll(AGENTID_ROUTE)],
    ].sort((x, y) => x.index - y.index);
    const match = matches.find((m) => !AGENTID_ELSEWHERE.test(text.slice(Math.max(0, m.index - 60), m.index + m[0].length + 60)) && !announcedByOther(text.slice(Math.max(0, m.index - 60), m.index + m[0].length), doc) && !AGENTID_VENDOR.test(sentenceAround(text, m.index, m.index + m[0].length)));
    if (!match) continue;
    out.push({ obs: obs.id, quote: quoteAround(text, match.index), agentFacing });
    if (AGENTID_OWNER.test(text.slice(Math.max(0, match.index - OWNER_WINDOW), match.index + OWNER_WINDOW))) ownerDocumented = true;
  }
  return { entries: out, ownerDocumented };
}

// A sentence about the product's own customers is the product's domain, not an agent starting with this product:
// a billing product's "your customers can check out without an account", "No signup required for your end users".
// Not "your client": that is the reader's HTTP or MCP client (Cosmic, fly.io, Exa).
export const DOMAIN_ACTORS = /\byour (?:customers?|users?|end[- ]users?|buyers?|subscribers?)\b|\b(?:end[- ]users?|shoppers?)\b|\bguest checkout\b/i;
// A sentence about a stored thing expiring is the product's data model, not an account: Supermemory's "temporary
// facts drop after they expire" and its OpenAPI example `"forgetReason": "temporary project deadline"` next to
// `forgetAfter`. Expiry counts only in a sentence that names an account-like thing and no stored thing; the
// "temporary account/project" signup wording is skipped where a stored thing is named.
const ACCOUNT_THING = /\b(?:accounts?|projects?|workspaces?|deployments?|buckets?|inbox(?:es)?|sandbox(?:es)?|(?:API )?keys?|tokens?|resources?)\b/i;
const STORED_THING = /\bmemor(?:y|ies)\b|\bforget\w*|\bdata\b|\brecords?\b|\bitems?\b|\bmessages?\b/i;
// Agent signup said to be off: Browser Use's "Agent signup is off. Create an API key in Cloud".
const SIGNUP_OFF = /\bagent[- ]?sign[- ]?ups? (?:is|are|was|has been) (?:currently |now |temporarily )?(?:off|disabled|closed|paused|unavailable|not (?:available|enabled|open|supported))\b/i;
// A person without an account is a person signing up: fly.io's "`fly auth signup` is the same flow for a human without
// an account".
const PERSON_WITHOUT_ACCOUNT = /\b(?:humans?|persons?|people|users?|developers?) without (?:a |an )?account\b/i;
// OAuth dynamic client registration registers a client app, not an account: fly.io's "client follows that to the
// authorization server, registers itself dynamically, and runs the browser flow; the human approves in the browser".
const CLIENT_REGISTRATION = /\bregisters?\s+itself\s+dynamically\b|\bdynamic(?:ally)?\s+(?:client\s+)?registration\b|\bclient\s+registration\b/i;
// Access through the developer's Stripe account is a person setting access up once, not the agent signing itself up:
// E2B's "the agent can use Stripe Projects to discover, provision, and authenticate a secure E2B sandbox ... without a
// human touching a dashboard". Stripe Projects vouches with the developer's account and payment method.
const BROKERED = /\b(?:use|uses|using|through|via|with)\s+Stripe Projects\b|\bstripe projects add\b/i;
// "Use x402 without a human" is paying per request, which pay_per_request reports; it is not an account.
const PAYMENT_WAY_IN = /\bx402\b|\bMPP\b/;
// Selling with x402 is not paying with it: Stripe's "Charge for API requests, tool calls, and content via HTTP 402",
// "accept x402 payments", "monetize your API". "Browser Use Cloud now accepts payment in USDC over the x402 protocol"
// is the product being paid, so the third person "accepts" stays.
export const SELLER = /\bcharg(?:e|ing) (?:for|your)\b|\bmonetiz\w*|\baccept(?:ing)? (?:x402|payments?|stablecoins?)\b|\bget(?:ting)? paid\b|\bpaywall\w*/i;
// Describing the protocol is not this product taking it: Stripe's "x402 is the internet's payment standard for agentic
// payments at scale".
export const PROTOCOL_DESCRIPTION = /\b(?:x402|MPP)\b[^.]{0,40}?\bis (?:a|an|the)\b[^.]{0,80}?\b(?:standard|protocol)\b/i;
// Paying at another site is not paying this product: Stripe's "Agents can now contribute directly to Stripe Climate at
// [climate.stripe.dev](…) using MPP or x402". The protocols' own sites are not other products.
export const PROTOCOL_SITES = new Set(["x402.org", "mpp.dev", "agenticcommerce.dev", "ucp.dev", "ap2-protocol.org"]);
const AT_HOST = /\b(?:at|on)\s+\[?(?:https?:\/\/)?((?:[a-z0-9-]+\.)+[a-z]{2,})\b/gi;
export function paysElsewhere(sentence, ownDomain) {
  return [...sentence.matchAll(AT_HOST)].some((m) => {
    const domain = registrableDomain(m[1].toLowerCase());
    return domain !== ownDomain && !PROTOCOL_SITES.has(domain);
  });
}
const EXAMPLE_PAGE = /\/(?:templates?|examples?|starters?)\//i;
// OAuth dynamic client registration (POST /oauth/register, /oauth2/register, /connect/register) registers a client app
// with an authorization server; it is not an agent getting an account.
const OAUTH_REGISTRATION = /\/(?:oauth2?|connect|clients?|dcr)\/regist(?:er|ration)\b/i;
// Whether a sentence holding a match is about something else; such a match is skipped and the next one tried.
const SKIP = {
  bootstrap: (sentence, ownDomain, match) => DOMAIN_ACTORS.test(sentence) || SIGNUP_OFF.test(sentence) || PERSON_WITHOUT_ACCOUNT.test(sentence) || PAYMENT_WAY_IN.test(sentence) || CLIENT_REGISTRATION.test(sentence) || BROKERED.test(sentence) || (/^temporary\b/i.test(match) && STORED_THING.test(sentence)),
  expiry: (sentence) => !ACCOUNT_THING.test(sentence) || STORED_THING.test(sentence),
  httpBootstrap: (sentence, ownDomain, match) => DOMAIN_ACTORS.test(sentence) || OAUTH_REGISTRATION.test(match),
  payPerRequest: (sentence, ownDomain) => DOMAIN_ACTORS.test(sentence) || SELLER.test(sentence) || PROTOCOL_DESCRIPTION.test(sentence) || paysElsewhere(sentence, ownDomain),
};
const GLOBAL = Object.fromEntries(Object.keys(SKIP).map((name) => [name, new RegExp(SIGNALS[name].source, `${SIGNALS[name].flags}g`)]));

// The first match whose sentence is not about something else. Tries at most MAX_TRIED matches a page, so a page that
// repeats a skipped phrase thousands of times costs no more than one that says it once.
const MAX_TRIED = 200;
function firstKept(text, re, skip, ownDomain) {
  let tried = 0;
  for (const m of text.matchAll(re)) {
    if (!skip(sentenceAround(text, m.index, m.index + m[0].length).replace(/\s+/g, " "), ownDomain, m[0])) return m;
    tried += 1;
    if (tried >= MAX_TRIED) return null;
  }
  return null;
}

function findSignals(observations, bodies, targetUrl) {
  const ownDomain = registrableDomain(new URL(targetUrl).hostname);
  const found = Object.fromEntries(Object.keys(SIGNALS).map((name) => [name, []]));
  for (const obs of observations) {
    const body = bodies.get(obs.id);
    if (!body) continue;
    const text = body.html ? htmlToText(body.text) : body.text;
    for (const [name, re] of Object.entries(SIGNALS)) {
      if (found[name].length >= EVIDENCE_PER_SIGNAL) continue;
      // A sitemap's URL slugs ("/posts/x402-launch") are page names, and a template or example page
      // (vercel.com/templates/next.js/x402-ai-starter) is code for the reader's own app: neither documents paying this product.
      if (name === "payPerRequest" && (obs.role === "sitemap" || EXAMPLE_PAGE.test(new URL(obs.url).pathname))) continue;
      // Guarded signals try every match, so one sentence about something else does not hide a real one.
      const skip = SKIP[name];
      const match = skip ? firstKept(text, GLOBAL[name], skip, ownDomain) : re.exec(text);
      if (match) found[name].push({ obs: obs.id, quote: quoteAround(text, match.index), agentFacing: AGENT_FACING.has(obs.role) });
    }
  }
  return found;
}

// What testing this pattern end to end requires beyond HTTP requests: an inbox for an
// email step, a command-line runner, a funded wallet. Whether a deployment has each is
// decided where the report is shown, not here. Agent identity has no runner support.
function needsFor(id, found) {
  const cliOnly = found.cliBootstrap.length > 0 && !found.httpBootstrap.length;
  if (id === "existing_account") return cliOnly ? ["cli"] : [];
  if (id === "pay_per_request") return ["wallet"];
  if (id === "agent_identity") return ["agent_identity"];
  const needs = [];
  if (found.emailStep.length) needs.push("inbox");
  if (cliOnly) needs.push("cli");
  return needs;
}

function pattern(id, found, signalNames, reason) {
  // The product's agent-facing pages first: a quote from llms.txt or an agent-signup
  // page says more than the same words in homepage navigation.
  const entries = signalNames.flatMap((name) => found[name]);
  const evidence = [...entries.filter((e) => e.agentFacing), ...entries.filter((e) => !e.agentFacing)].map(({ obs, quote }) => ({ obs, quote }));
  const documented = signalNames.some((name) => found[name].some((entry) => entry.agentFacing));
  return {
    id,
    name: PATTERNS[id].name,
    status: documented ? "documented" : "inferred",
    reason,
    evidence,
    humanBoundary: PATTERNS[id].humanBoundary,
    needs: needsFor(id, found),
  };
}

// API endpoints the product's agent-facing pages send an agent to on another domain:
// Neon documents on neon.com and takes signups at claimable.neon.tech. Only URLs that
// look like an API (a versioned, /api or /oauth path, or an api./claimable. host) count,
// so links to GitHub or a blog do not. A flow may reach these only because the product
// itself names them here.
const API_URL = /https:\/\/([a-z0-9.-]+\.[a-z]{2,})(\/[^\s"'`<>)\]]*)?/gi;
const API_LOOKING = (host, path) => /^(?:api|claimable|agent|agents)\./.test(host) || /^\/(?:v\d+|api|oauth2?)(?:\/|$)/.test(path || "");
function findApiHosts(doc, bodies) {
  const hosts = new Map();
  for (const obs of doc.observations) {
    const body = bodies.get(obs.id);
    if (!body || !AGENT_FACING.has(obs.role)) continue;
    const text = body.html ? htmlToText(body.text) : body.text;
    for (const match of text.matchAll(API_URL)) {
      const host = match[1].toLowerCase();
      const domain = registrableDomain(host);
      if (hosts.size >= 5 || hosts.has(domain) || sameSite(`https://${host}/`, doc.target.url) || !API_LOOKING(host, match[2])) continue;
      hosts.set(domain, { domain, host, example: match[0].slice(0, 200), evidence: [{ obs: obs.id, quote: quoteAround(text, match.index) }] });
    }
  }
  return [...hosts.values()];
}

export function detectOnboarding(doc, bodies) {
  const observations = doc.observations;
  const found = findSignals(observations, bodies, doc.target.url);
  const onIssuerSite = sameSite(AGENTID_ISSUER, doc.target.url);
  const agentId = onIssuerSite ? { entries: [], ownerDocumented: false } : findAgentIdSignIn(doc, bodies);
  found.agentIdSignIn = agentId.entries;
  if (onIssuerSite) found.agentIdentity = [];
  // A signup call documented on a page written for agents is the product saying an agent can sign itself up, even
  // without the words "agent signup": Moltbook's skill.md says "register" and shows POST /api/v1/agents/register.
  found.bootstrap.push(...found.httpBootstrap.filter((e) => e.agentFacing && !found.bootstrap.some((b) => b.obs === e.obs)));
  const has = (name) => found[name].length > 0;
  const patterns = [];

  if (has("bootstrap")) {
    if (has("restricted")) patterns.push(pattern("limited_until_claimed", found, ["bootstrap", "restricted", "claim"], "The docs describe an agent signing itself up with restricted access until a person claims or verifies it."));
    else if (has("claim") || has("expiry")) patterns.push(pattern("try_then_claim", found, ["bootstrap", "claim", "expiry"], "The docs describe an agent getting working access on its own, with a person claiming it afterwards."));
    else patterns.push(pattern("agent_is_customer", found, ["bootstrap", "agentChallenge", "apiFunding"], has("agentChallenge") ? "The docs describe an agent proving it is an agent and holding the account itself; no claim step is mentioned." : "The docs describe an agent signing itself up; no claim step or restriction is mentioned in the sources read."));
  }

  // Protected-resource metadata says how to authenticate, not that an agent can
  // authenticate as itself, so it supports this pattern but never establishes it.
  if (has("agentIdSignIn") || has("agentIdentity")) {
    const owner = agentId.ownerDocumented
      ? "The docs mention AgentID's owner claims near the sign-in; the product gets the owner's name and email only if the agent's key has App: Share Owner or the owner approves the sign-in."
      : "The pages read do not say whether the product asks who owns the agent; AgentID shares the owner's name and email only with a registered app that requests them, and only if the agent's key has App: Share Owner or the owner approves.";
    const reason = has("agentIdSignIn") ? `The docs say an agent gets its own account by signing in with AgentID, an OpenID Connect provider for agents: it signs in as itself, usually with no person at each sign-in. It needs ${AGENTID_NEEDS}. ${owner}` : "The docs describe an agent authenticating with its own identity.";
    const p = pattern("agent_identity", found, ["agentIdSignIn", "agentIdentity"], reason);
    if (has("agentIdSignIn")) {
      p.provider = "AgentID";
      p.humanBoundary = "Outside the product, once: a person owns the AgentMail account behind the agent's inbox and turns on app_connect for its key. No one approves each sign-in, unless the product asks for the owner's details and the key lacks App: Share Owner.";
    }
    const prm = observations.find((o) => o.ok && o.role === "prm");
    if (prm) p.evidence.push({ obs: prm.id, quote: "/.well-known/oauth-protected-resource" });
    patterns.push(p);
  }

  if (has("payPerRequest")) patterns.push(pattern("pay_per_request", found, ["payPerRequest"], "The docs describe paying per request over HTTP 402, with no account needed first."));

  // Only the signup side says a person sets access up: a key made in a dashboard, a token a person creates. An auth
  // scheme in the OpenAPI document (Turso's `bearerAuth: http bearer`) says how a request is signed, not who gets the
  // key, so it never establishes this; with no signup evidence the answer is no pattern, and the funnel says so.
  if (has("humanFirst") || has("cliToken")) {
    const reason = has("cliToken") ? "The docs describe a person creating a token that the agent then passes to the CLI with a flag or an environment variable, with no browser." : "The docs describe a person creating access (an account, key or payment method) that the agent then uses.";
    const p = pattern("existing_account", found, ["humanFirst", "cliToken"], reason);
    // How the agent's CLI gets signed in, when the docs say: "token" runs unattended, "browser" needs a person once.
    p.cli = has("cliToken") ? "token" : has("cliBrowserLogin") ? "browser" : null;
    patterns.push(p);
  }

  const agentFirst = patterns.find((p) => ["try_then_claim", "limited_until_claimed", "agent_is_customer", "pay_per_request", "agent_identity"].includes(p.id));
  return {
    patterns,
    apiHosts: findApiHosts(doc, bodies),
    primary: agentFirst?.id || patterns[0]?.id || null,
    reason: patterns.length ? `${patterns.length} way${patterns.length === 1 ? "" : "s"} for an agent to start, from the sources read.` : `No way for an agent to start was found in the sources read.${doc.otherHostsSkipped ? " Links to other hosts were not read." : ""} This is not evidence that none exists.`,
  };
}
