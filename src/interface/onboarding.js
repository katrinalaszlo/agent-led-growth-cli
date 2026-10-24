import { htmlToText, registrableDomain, sameSite } from "./sources.js";
import { freePlansOnly } from "./evaluate.js";
import { blockContext, quoteAt } from "./quote.js";

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
  // A person can take ownership afterwards. "The owner claims the workspace", with an object: an OpenID Connect "owner
  // claim" is a field in a token (AgentID's llms-full.txt "the requested owner claim quietly missing"), not a person.
  claim: /\bclaim(?:s|ed|ing)? (?:it|this|the|your|their) (?:account|project|workspace|deployment|bucket|inbox|resources?)\b|\bclaim (?:url|code|link|token|flow|page|email)\b|\bclaim_url\b|\bclaimUrl\b|\/claim\b|\bunclaimed\b|\bclaimable\b|\b(?:human|owner|person) (?:can |may |will |must |then )?(?:later )?claims? (?:it|this|the|your|their|its)\b|\battach (?:a |the )?(?:human )?owner\b|\badopt (?:the |this )?workspace\b/i,
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
  // At most four words between the tool and the flag or subcommand, so it is one command line: Track's docs say
  // "npx agent-led-growth check <url> runs a real agent through signup", which is prose after a command, not a signup.
  cliBootstrap: /\b(?:npx|wrangler|mem0|stripe|npm i(?:nstall)?|pip install|brew install)\b(?:[ \t]+[^\s`]+){0,4}?[ \t]+(?:--temporary|--agent|sign-?up\b|projects init)/i,
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
    const kept = matches.filter((m) => !AGENTID_ELSEWHERE.test(text.slice(Math.max(0, m.index - 60), m.index + m[0].length + 60)) && !announcedByOther(text.slice(Math.max(0, m.index - 60), m.index + m[0].length), doc) && !AGENTID_VENDOR.test(sentenceAround(text, m.index, m.index + m[0].length)));
    // The first kept match with a clean quote: one sentence or labelled element holding the words (src/interface/quote.js).
    let match = null;
    let q = null;
    for (const m of kept) {
      q = quoteAt(body, text, m.index, m.index + m[0].length, obs.role);
      if (q) {
        match = m;
        break;
      }
    }
    if (!match) continue;
    out.push({ obs: obs.id, quote: q.quote, ...(q.label ? { label: q.label } : {}), agentFacing });
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
// A signal that says the product requires something (an inbox, a person setting access up, restricted access, a
// payment) counts only from a sentence that says so about the product itself. Text that merely mentions the thing never
// counts: a negation ("No project key can sign in to the dashboard"), an example ("such as opening a verification
// email") or a sentence about the reader's own customers. Each kept match is quoted, and the quote is shown with the
// step it decides.
// A negation in the same clause just before the match: "A project key cannot sign in to the dashboard". A comma ends
// the clause, so "If you don't have one, create an API key in the dashboard" still counts.
const CLAUSE_NEGATION = /\b(?:no|not|never|cannot|can't|can not|without|don't|doesn't|won't|isn't|aren't|nothing)\b[^.,;:!?\n]{0,40}$/i;
const negatedBefore = (sentence, match) => {
  const at = sentence.indexOf(match.replace(/\s+/g, " "));
  return at >= 0 && CLAUSE_NEGATION.test(sentence.slice(0, at));
};
// Expiry said not to happen: Track's "Unclaimed, nothing is deleted", "the workspace and key never expire".
const NO_EXPIRY = /\b(?:nothing|never|not|no\s+\w+)\s+(?:is\s+|are\s+|will\s+|gets?\s+|be\s+|ever\s+)*(?:deleted|removed|expires?)\b|\bdo(?:es)?(?: not|n't) expire\b/i;
// An example of something, not the product's own step: Track's "For a step your API never sees, such as opening a
// verification email, send an onboarding_step event".
const EXAMPLE = /\b(?:such as|for example|for instance|e\.g\.|i\.e\.)/i;
// An inbox step counts only in a sentence about the product's own signup or sign-in path. The words are looked for
// outside the match, so "Verification email never opened" (a sample error message in Track's docs) is not its own
// context.
const SIGNUP_CONTEXT = /\bsign(?:s|ing|ed)?[- ]?(?:up|in)\b|\bsignups?\b|\bregist(?:er|ers|ered|ering|ration)\b|\bcreat(?:e|es|ing) (?:an? |your |the )?(?:new )?account\b|\bonboard(?:ing)?\b|\bverif(?:y|ies|ied|ication)\b|\bconfirm(?:s|ed)?\b|\blog ?in\b|\bget (?:an? |your )?(?:API )?key\b/i;
// The product saying there is no inbox step. Authoritative: one such sentence on the product's own pages clears every
// inbox match. Track's "POST /v1/signup returns a key with no account, email or browser", "Track needs no inbox
// verification", "takes no email and sends nothing to confirm". Not "without email": Telnyx's "Without email access the
// flow falls back to..." is a condition, and its signup does send a magic link.
export const NO_INBOX = /\b(?:takes|needs|requires|asks for|sends) no (?:e-?mail|inbox)\b|\bneeds? no inbox\b|\bno inbox (?:verification|step|needed|required)\b|\bno (?:account, )?e-?mail(?:,| or| needed| required)\b|\bno (?:e-?mail )?verification (?:e-?mail|code|link|step)\b|\bsends nothing to confirm\b/i;
const withoutMatch = (sentence, match) => sentence.replace(match.replace(/\s+/g, " "), " ");
// A line of a link index ("- [Email OTP](https://neon.com/docs/auth/...): Sign in and verify email addresses") describes
// another page, often a feature the product sells, not the product's own signup.
const INDEX_LINE = /^\s*(?:[-*]\s*)?\[[^\]]+\]\([^)]+\)/;
// Signing up somewhere else: AgentMail's "Enable browser agents to sign up for services by extracting OTP codes".
// AgentLine's "Receive OTP codes so your agent can sign up and verify" is a feature for signing up elsewhere too.
const SIGNUP_ELSEWHERE = /\bsign(?:s|ing)? up for (?:services|other|any|third-party|apps|sites|websites)\b|\b(?:other|third-party) (?:services|apps|sites|websites)\b|\bso (?:your|the|an) agents? can sign up\b/i;
// An optional step is not a requirement: Locus's "the human is needed only for an optional AgentMail OTP".
const OPTIONAL = /\boptional(?:ly)?\b/i;

// An inbox step counts only when its subject is the product's own signup. AgentID's llms-full.txt tells the general
// problem, "An agent signs up with its owner's email, reads the verification code out of the owner's inbox", and that
// read as AgentID's own signup needing an inbox. A sentence counts when it says so itself (ownSignup below), or when it
// sits on the product's own agent-signup or auth page, or in a signup section of a page (under a "Sign up", "Agent
// Signup", "Registration" or "Quick start" heading, or right after a step that is the product's own signup call).
// A third-person narrative ("an agent signs up", "AI agents can sign up for a SaaS product") counts only on the
// product's own signup page.
// The sentence calls one of the product's signup, sign-in or verify endpoints: AgentLine's "`POST /v1/auth/otp` →
// `POST /v1/auth/verify`", Cosmic's "(POST /v3/agents/sign-up)", AgentMail's "curl -X POST .../v0/agent/sign-up".
const SIGNUP_CALL = /\b(?:POST|GET|PUT)\b[^\n]{0,24}?\/[\w.\/{}:-]*?(?:sign[-_]?up|sign[-_]?in|register|registration|verif\w*|otp|auth|login|magic[-_]?link|onboard)\b/i;
// "We send", "we'll email", "our signup": the product speaking about its own flow.
const FIRST_PERSON = /\b(?:we|we'll|we will)\s+(?:then\s+)?(?:send|email|text|mail)\b|\bour (?:sign[- ]?up|signup|registration|onboarding|verification|sign[- ]?in|login)\b|\b(?:create an account|sign up|register) here\b/i;
const SIGNUP_HEADING = /^\W*(?:\w+ )?(?:sign[- ]?up|signup|sign[- ]?in|register|registration|create (?:an |your )?account|get(?:ting)? started|quick ?start|onboarding)\b(?![^?]*\?)/i;
const GENERIC_NARRATIVE = /\b(?:an?|every|each|any|most|many|some)\s+(?:AI\s+)?(?:agents?|users?|people|persons?|humans?|developers?|bots?)\b(?:\s+\w+){0,3}?\s+(?:sign(?:s|ed|ing)?|can sign|could sign) up\b/i;
const OWN_SIGNUP_PAGES = new Set(["onboarding", "auth"]);
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
// The product's names: its host's labels (agentmail, cosmicjs and cosmic) and the first part of its page title.
function productNames(doc) {
  const labels = doc.target.host.toLowerCase().split(".").slice(0, -1).filter((l) => l !== "www" && l.length > 2);
  const variants = labels.flatMap((l) => [l, l.replace(/(?:js|hq|app|ai|io|dev|labs)$/, "")]).filter((l) => l.length > 2);
  const title = String(doc.product?.name?.value || "").split(/\s+[|\u2014\u2013:-]\s+|\s*[|:]\s*/)[0].trim();
  return [...new Set([...variants, ...(title && title.length <= 40 ? [title.toLowerCase()] : [])])];
}
function ownSignupSentence(sentence, names) {
  if (SIGNUP_CALL.test(sentence) || FIRST_PERSON.test(sentence)) return true;
  if (!names.length) return false;
  const name = `(?:${names.map(escapeRe).join("|")})`;
  return new RegExp(`\\b(?:sign(?:s|ed|ing)?[- ]?(?:up|in)|log(?:s|ged|ging)?[- ]?in|register(?:s|ed|ing)?|creat(?:e|es|ed|ing) (?:an? |your )?account)\\s+(?:for|to|with|on|at|into)\\s+(?:an? )?${name}\\b|\\b${name}\\s+(?:sends?|emails?|will (?:send|email)|texts?)\\b|\\b(?:your|an?|the) ${name} account\\b|\\b${name}[\\w.]*\\/(?:sign-?up|register|signin|login)\\b`, "i").test(sentence);
}
function ownSignup(sentence, match, page) {
  if (ownSignupSentence(sentence, page.names)) return true;
  // On the product's own signup page the sentence still has to be about signing up: Moltbook's "Verification code
  // expired." is a line of an error list, Locus's "Never ask the human to reveal their ... email verification
  // code" is advice. The words are looked for outside the match.
  if (OWN_SIGNUP_PAGES.has(page.role) && SIGNUP_CONTEXT.test(withoutMatch(sentence, match))) return true;
  if (GENERIC_NARRATIVE.test(sentence)) return false;
  const ctx = page.context();
  if (!ctx) return false;
  const heading = ctx.heading.replace(/[#*_`]/g, " ").trim();
  return SIGNUP_HEADING.test(heading) || ownSignupSentence(heading, page.names) || ownSignupSentence(ctx.previous, page.names);
}

// A question says nothing about this product: AgentID's llms-full.txt "How can you tell an agent signup from a human
// one?" heads an explainer, and its comparison table's row "Can the agent sign up for a new service on its own" has no
// question mark. An FAQ's answer, where it says yes, is its own sentence and is tried next.
const QUESTION = /\?\s*(?:\*\*)?\s*$|^\W*(?:can|could|does|do|is|are|will|should|how|why|what|when|where)\b/i;

// The match names a page rather than saying anything: AgentID's "[can an AI agent sign up for a
// SaaS](/blog/can-an-ai-agent-sign-up-for-a-saas)" is a link to a blog post, in its text and in its slug. A path like
// /agents/signup starts with a slash and still counts.
function inSlug(sentence, match) {
  if (match.startsWith("/")) return false;
  const m = escapeRe(match);
  if (new RegExp(`\\[[^\\]]*${m}[^\\]]*\\]\\(`, "i").test(sentence)) return true;
  const re = new RegExp(`[\\w/]-${m}|${m}-[a-z]`, "i");
  return re.test(sentence) && !sentence.includes(` ${match} `) && !sentence.startsWith(`${match} `);
}

// Whether a sentence holding a match is about something else; such a match is skipped and the next one tried.
// page: { role, names, context() } for the rules that read where the sentence is (the inbox rule).
const SKIP = {
  bootstrap: (sentence, ownDomain, match) => inSlug(sentence, match) || QUESTION.test(sentence) || DOMAIN_ACTORS.test(sentence) || SIGNUP_OFF.test(sentence) || PERSON_WITHOUT_ACCOUNT.test(sentence) || PAYMENT_WAY_IN.test(sentence) || CLIENT_REGISTRATION.test(sentence) || BROKERED.test(sentence) || (/^temporary\b/i.test(match) && STORED_THING.test(sentence)),
  expiry: (sentence) => !ACCOUNT_THING.test(sentence) || STORED_THING.test(sentence) || NO_EXPIRY.test(sentence),
  restricted: (sentence, ownDomain, match) => DOMAIN_ACTORS.test(sentence) || EXAMPLE.test(sentence) || negatedBefore(sentence, match),
  emailStep: (sentence, ownDomain, match, page, label) => label === "Code" || DOMAIN_ACTORS.test(sentence) || EXAMPLE.test(sentence) || INDEX_LINE.test(sentence) || SIGNUP_ELSEWHERE.test(sentence) || OPTIONAL.test(sentence) || NO_INBOX.test(sentence) || negatedBefore(sentence, match) || !ownSignup(sentence, match, page),
  humanFirst: (sentence, ownDomain, match) => DOMAIN_ACTORS.test(sentence) || EXAMPLE.test(sentence) || negatedBefore(sentence, match),
  httpBootstrap: (sentence, ownDomain, match) => DOMAIN_ACTORS.test(sentence) || OAUTH_REGISTRATION.test(match),
  payPerRequest: (sentence, ownDomain, match) => DOMAIN_ACTORS.test(sentence) || SELLER.test(sentence) || PROTOCOL_DESCRIPTION.test(sentence) || paysElsewhere(sentence, ownDomain) || negatedBefore(sentence, match),
};
const GLOBAL = Object.fromEntries(Object.keys(SIGNALS).map((name) => [name, new RegExp(SIGNALS[name].source, `${SIGNALS[name].flags.replace("g", "")}g`)]));

// The first match that has a clean quote (src/interface/quote.js) and whose sentence is not about something else. The
// guards read the same sentence the quote shows, so a rule never decides on words from a neighbouring element of the
// page. Tries at most MAX_TRIED matches a page, so a page that repeats a skipped phrase thousands of times costs no
// more than one that says it once.
const MAX_TRIED = 200;
function firstKept(page, re, skip, ownDomain) {
  let tried = 0;
  for (const m of page.text.matchAll(re)) {
    const q = quoteAt(page.body, page.text, m.index, m.index + m[0].length, page.role);
    const at = { ...page, context: () => blockContext(page.body, page.text, m.index, m.index + m[0].length, page.role) };
    if (q && !(skip && skip(q.quote, ownDomain, m[0], at, q.label))) return { index: m.index, ...q };
    tried += 1;
    if (tried >= MAX_TRIED) return null;
  }
  return null;
}

function findSignals(observations, bodies, targetUrl, names) {
  const ownDomain = registrableDomain(new URL(targetUrl).hostname);
  const found = Object.fromEntries(Object.keys(SIGNALS).map((name) => [name, []]));
  for (const obs of observations) {
    const body = bodies.get(obs.id);
    if (!body) continue;
    const page = { body, role: obs.role, names, text: body.html ? htmlToText(body.text) : body.text };
    for (const name of Object.keys(SIGNALS)) {
      if (found[name].length >= EVIDENCE_PER_SIGNAL) continue;
      // A sitemap's URL slugs ("/posts/x402-launch", "/blog/can-an-ai-agent-sign-up-for-a-saas") are page names, not
      // claims. A template or example page (vercel.com/templates/next.js/x402-ai-starter) is code for the reader's own
      // app: it does not document paying this product.
      if (obs.role === "sitemap") continue;
      if (name === "payPerRequest" && EXAMPLE_PAGE.test(new URL(obs.url).pathname)) continue;
      // Every match is tried, so one sentence about something else, or words run together from two elements, does not
      // hide a real one.
      const match = firstKept(page, GLOBAL[name], SKIP[name], ownDomain);
      if (match) found[name].push({ obs: obs.id, quote: match.quote, ...(match.label ? { label: match.label } : {}), agentFacing: AGENT_FACING.has(obs.role) });
    }
  }
  return found;
}

// The first sentence on the product's own pages saying signup has no inbox step, or null.
function findNoInbox(doc, bodies) {
  for (const obs of doc.observations) {
    const body = bodies.get(obs.id);
    if (!body || !sameSite(obs.url, doc.target.url)) continue;
    const text = body.html ? htmlToText(body.text) : body.text;
    const m = NO_INBOX.exec(text);
    if (m) return { obs: obs.id, quote: quoteAround(text, m.index) };
  }
  return null;
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

// The quotes behind each need, so a step that says the product needs something can show the sentence it came from.
const NEED_SIGNALS = { inbox: ["emailStep"], cli: ["cliBootstrap"], wallet: ["payPerRequest"], agent_identity: ["agentIdSignIn", "agentIdentity"] };
function needsEvidenceFor(needs, found) {
  const ordered = (entries) => [...entries.filter((e) => e.agentFacing), ...entries.filter((e) => !e.agentFacing)];
  return Object.fromEntries(needs.map((need) => [need, ordered(NEED_SIGNALS[need].flatMap((name) => found[name] || [])).map(({ obs, quote, label }) => ({ obs, quote, ...(label ? { label } : {}) }))]));
}

function pattern(id, found, signalNames, reason) {
  // The product's agent-facing pages first: a quote from llms.txt or an agent-signup
  // page says more than the same words in homepage navigation.
  const entries = signalNames.flatMap((name) => found[name]);
  const evidence = [...entries.filter((e) => e.agentFacing), ...entries.filter((e) => !e.agentFacing)].map(({ obs, quote, label }) => ({ obs, quote, ...(label ? { label } : {}) }));
  const documented = signalNames.some((name) => found[name].some((entry) => entry.agentFacing));
  return {
    id,
    name: PATTERNS[id].name,
    status: documented ? "documented" : "inferred",
    reason,
    evidence,
    humanBoundary: PATTERNS[id].humanBoundary,
    needs: needsFor(id, found),
    needsEvidence: needsEvidenceFor(needsFor(id, found), found),
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

// A signup page on another company's site that the product's agent-facing pages send the agent to: AgentID's llms.txt
// "[Get started](https://console.agentmail.to/sign-up): Create an AgentMail inbox to get an AgentID". That page is not
// read, so whether an agent can sign up there is unknown, not a gap in this product's docs.
const SIGNUP_URL = /https:\/\/([a-z0-9.-]+\.[a-z]{2,})(\/[^\s"'`<>)\]]*)?/gi;
const SIGNUP_PATH = /\/(?:sign-?up|register|get-started)(?:[/?#]|$)/i;
function findSignupElsewhere(doc, bodies) {
  for (const obs of doc.observations) {
    const body = bodies.get(obs.id);
    if (!body || !obs.ok || !AGENT_FACING.has(obs.role)) continue;
    const text = body.html ? htmlToText(body.text) : body.text;
    for (const match of text.matchAll(SIGNUP_URL)) {
      if (sameSite(`https://${match[1]}/`, doc.target.url) || !SIGNUP_PATH.test(match[2] || "")) continue;
      return { domain: registrableDomain(match[1].toLowerCase()), url: match[0], evidence: [{ obs: obs.id, quote: quoteAround(text, match.index) }] };
    }
  }
  return null;
}

export function detectOnboarding(doc, bodies) {
  const observations = doc.observations;
  const found = findSignals(observations, bodies, doc.target.url, productNames(doc));
  const onIssuerSite = sameSite(AGENTID_ISSUER, doc.target.url);
  const agentId = onIssuerSite ? { entries: [], ownerDocumented: false } : findAgentIdSignIn(doc, bodies);
  found.agentIdSignIn = agentId.entries;
  if (onIssuerSite) found.agentIdentity = [];
  // A signup call documented on a page written for agents is the product saying an agent can sign itself up, even
  // without the words "agent signup": Moltbook's skill.md says "register" and shows POST /api/v1/agents/register.
  found.bootstrap.push(...found.httpBootstrap.filter((e) => e.agentFacing && !found.bootstrap.some((b) => b.obs === e.obs)));
  // The product saying it has no inbox step outweighs any mention of one.
  const noInbox = findNoInbox(doc, bodies);
  if (noInbox) found.emailStep = [];
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

  // Machine-readable pricing first: when pricing.json lists only free plans, x402 in prose is not a price. Track's docs
  // name x402 as one of the tasks its sister product tests, and that read as Track charging per request.
  if (has("payPerRequest") && !freePlansOnly(doc.pricing)) patterns.push(pattern("pay_per_request", found, ["payPerRequest"], "The docs describe paying per request over HTTP 402, with no account needed first."));

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
    signupElsewhere: findSignupElsewhere(doc, bodies),
    primary: agentFirst?.id || patterns[0]?.id || null,
    reason: patterns.length ? `${patterns.length} way${patterns.length === 1 ? "" : "s"} for an agent to start, from the sources read.` : `No way for an agent to start was found in the sources read.${doc.otherHostsSkipped ? " Links to other hosts were not read." : ""} This is not evidence that none exists.`,
  };
}
