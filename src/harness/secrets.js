// Secret boundary. Credentials enter only from the environment of the harness process, are handed to the executor
// child as its own env, and are never written to disk or logged. Everything that leaves the executor passes through
// the redactor, which knows the actual values as well as the generic key patterns.

const GENERIC = [
  /(sk|rk|rkcs|pk|whsec)_(test|live)_[A-Za-z0-9]+/g,
  /\bam_[A-Za-z0-9]{12,}/g,
  /\bKEY[A-Za-z0-9_-]{12,}\b/g,
  /\bwhisper-[A-Za-z0-9_-]{8,}/g,
  /\bre_[A-Za-z0-9_-]{10,}\b/g,
  /\bmoltbook_(?!claim_)[A-Za-z0-9_-]{8,}/g,
  /\bea_live_[a-f0-9]{16,}/g,
  /\bnpg_[A-Za-z0-9]{8,}/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
  /Bearer\s+[A-Za-z0-9._-]{16,}/g,
  // Firecrawl's keys (fc- and 32 hex): a run's dashboard listing showed a second key the agent never saved. Not \b
  // before it: in trace.jsonl a key on its own line follows a literal \n. A hex digit before it is a UUID's …8cfc-4cb5-….
  /(?<![0-9a-fA-F])fc-[A-Za-z0-9]{20,}\b/g,
  // Composio's project key (ak_) and user key (uak_).
  /\buak_[A-Za-z0-9_-]{20,}/g,
  /\bak_[A-Za-z0-9_-]{16,}/g,
];
// The sandbox's own proxy carries its credential in the URL with no @host (HTTP_PROXY=http://srt.<token>:<secret>),
// so URL_PASSWORD below does not see it. An agent that prints its environment prints it; one run did.
const PROXY_URL = /((?:https?|all|grpc)_proxy=[a-z][a-z0-9+.-]*:\/\/)([^\s\\"']{8,})/gi;

// Secrets a product returned to the agent: values of JSON fields whose names say they are secret. Read from each
// full line of agent output before anything is written, because the agent may never file them in CREDENTIAL.env
// (it stopped, was stopped, or ignored the instruction) and the event log keeps only the start of each result:
// with curl -i the headers fill it and the body holding the key is cut off. Quotes may arrive escaped (\") or as
// Python's single quotes: a Composio run printed a dict with 'user_api_key': 'uak_…' and the key stayed in the trace.
// A slash may arrive escaped (\/) in a JSON-encoded URL. "pat" is MotherDuck's token claim in its decoded JWT.
const SECRET_FIELD = /\\?["']((?:[a-z]+_)*(?:api_?key|key|token|secret|password|pat|jwt|credentials?|claim_?code|claim_?url|verification_code|client_secret)|apiKey|accessToken|refreshToken|claimCode|claimUrl|clientSecret)\\?["']\s*:\s*\\?["']((?:[^"'\\\s]|\\\/){8,})\\?["']/gi;
// The same for links: a one-time sign-in or claim link carries its secret as a URL parameter (Telnyx's emails had
// ?token=…, Cosmic's ?token=agk_…). Values shorter than 12 characters are left alone so page numbers survive.
// Any parameter named like a token counts: Cloudflare's temporary-account claim link is ?claimToken=….
const SECRET_PARAM = /[?&](\w*token|code|key|claim|otp|signature|sig|auth|magic)=([^&\s"'<>\\]{12,})/gi;
// And connection strings: postgres://user:password@host carries its password in the URL (Neon returned one as
// database_url, a field name that says nothing about secrets).
const URL_PASSWORD = /\b([a-z][a-z0-9+.-]{1,20}:\/\/[^\s:/@"'\\]+:)([^\s@"'\\/]{4,})@/gi;
export function secretsInText(text) {
  const t = String(text ?? "");
  const found = [...[...t.matchAll(SECRET_FIELD)].map((m) => m[2]), ...[...t.matchAll(SECRET_PARAM)].map((m) => m[2]), ...[...t.matchAll(URL_PASSWORD)].map((m) => m[2]), ...[...t.matchAll(PROXY_URL)].map((m) => m[2])];
  // A value read in JSON-escaped form (https:\/\/…) is also a secret in its plain form, as the agent writes it in its notes.
  for (const v of [...found]) if (v.includes("\\/")) found.push(v.replaceAll("\\/", "/"));
  return [...new Set(found)];
}

// Mail adds two kinds a product sends a person: a short code after words like "code" or "OTP" (Cosmic's "Your
// one-time claim code is 837777"), and links, which in these emails are one-time (Cosmic's claim link was a
// click-tracking redirect with nothing in it that says "claim"). Any link of 60 characters or more counts.
const MAIL_CODE = /\b(?:code|otp|passcode|pin)\b[^0-9\n]{0,40}?\b(\d{4,8})\b/gi;
const MAIL_LINK = /https?:\/\/[^\s"'<>\\)\]]{52,}/g;
export function secretsInMail(text) {
  const t = String(text ?? "");
  return [...new Set([...secretsInText(t), ...[...t.matchAll(MAIL_CODE)].map((m) => m[1]), ...(t.match(MAIL_LINK) || [])])];
}

// A learned number (a mail code) is replaced only where it stands as a whole number. A Supermemory run had learned
// a six-digit code and replaced it inside contextWindow's 1000000, leaving "1<redacted>" and a trace line that no
// longer parsed. A code that is itself a whole JSON number ("estimated_tokens": 837777) is left alone, so the line
// stays JSON. Any other value is replaced wherever it appears: in trace.jsonl a key on its own line follows a
// literal \n, so a letter boundary would miss it.
function redactValue(text, value) {
  if (!/^\d+$/.test(value)) return text.split(value).join("<redacted>");
  return text.replace(new RegExp(`(?<![0-9])${value}(?![0-9])`, "g"), (m, offset) => {
    const isJsonNumber = /"\s*:\s*$/.test(text.slice(Math.max(0, offset - 20), offset)) && /^\s*[,}\]]/.test(text.slice(offset + m.length, offset + m.length + 3));
    return isJsonNumber ? m : "<redacted>";
  });
}

export function resolveCredentials(task, env = process.env) {
  const injected = {};
  const missing = [];
  const rejected = [];
  for (const c of task.credentials || []) {
    const value = env[c.env];
    if (!value) {
      missing.push(c.env);
      continue;
    }
    if (c.test && !c.test.test(value)) {
      rejected.push({ env: c.env, reason: c.rejectReason || "value does not match the required pattern" });
      continue;
    }
    injected[c.injectAs] = value;
  }
  const values = Object.values(injected);
  // Values learned later (a key the agent obtained itself) join the redactor for every write that follows.
  // A short plain word is not one: Turso's pricing JSON has rows keyed "key": "databases", and learning that word
  // turned "100 databases" in RESULT.md into "100 <redacted>".
  const learn = (v) => {
    if (!v || values.includes(v) || v === "<redacted>") return;
    if (/^[A-Za-z]+$/.test(v) && v.length < 16) return;
    values.push(v);
  };
  const redact = (text) => {
    let out = String(text ?? "");
    for (const v of values) out = redactValue(out, v);
    out = out.replace(URL_PASSWORD, "$1<redacted>@");
    out = out.replace(PROXY_URL, "$1<redacted>");
    // Keep only a type marker (sk_test_, rk_live_, KEY, whisper-, …), never a usable segment of the value.
    for (const re of GENERIC) out = out.replace(re, (m) => (m.match(/^(?:sk|rk|pk|whsec)_(?:test|live)_/) || m.match(/^[A-Za-z]{2,8}[_-]/) || [m.slice(0, 3)])[0] + "…redacted");
    return out;
  };
  // Child env: the parent's PATH etc., minus any variable that held a secret under its original name.
  const childEnv = { ...env, ...injected };
  for (const c of task.credentials || []) delete childEnv[c.env];
  delete childEnv.CLAUDECODE;
  return { available: Object.keys(injected), missing, rejected, childEnv, redact, learn, has: (injectAs) => injectAs in injected, value: (injectAs) => injected[injectAs] };
}
