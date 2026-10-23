import { defineSignupTask } from "../harness/tasks/signup.js";
import { PRODUCT_SUBDOMAINS, registrableDomain } from "../interface/sources.js";

// alg test: a real agent tries the task on the user's own product, and a separate checker decides.
// The checker is the call the user declared in alg.yml, made three times: with the agent's key (must
// succeed and pass the assertion), with no key and with a wrong key (both must be refused). That catches an
// endpoint that answers anyone, without code written for each product.

// A request turned away for lacking a valid key. Cloudflare answers a missing token with 400, not 401.
const REFUSED = new Set([400, 401, 403]);
export const KEY_ENV = "AGENT_READY_KEY";

// The verify_* lines of alg.yml as a spec, or { error } naming what is missing.
// A call is "GET <url>" or "POST <url>". {key} is the agent's key, and {NAME} is any other value the agent saved in
// CREDENTIAL.env (listed in verify_fields), so a check can name the account or project the signup created.
// verify_exchange is an optional first call that turns the key into the token the check uses, as Neon's identity
// assertion is exchanged for an access token.
const CALL = /^(?:(GET|POST)\s+)?(https?:\/\/\S+)$/i;
const FIELD_NAME = /^[A-Z][A-Z0-9_]*$/;
const REGISTRY_HOSTS = { npm: ["registry.npmjs.org"], pypi: ["pypi.org", "files.pythonhosted.org"] };

export function parseVerifySpec(config) {
  const callText = (config?.verify_call || "").trim();
  if (!callText) return { error: "alg.yml has no verify_call. Add the call that proves a key works, for example: verify_call: GET https://api.example.com/v1/me" };
  const match = CALL.exec(callText);
  if (!match) return { error: `verify_call must be "GET <full URL>" or "POST <full URL>", not "${callText}"` };
  const header = (config.verify_header || "Authorization: Bearer {key}").trim();
  const colon = header.indexOf(":");
  if (colon < 1 || !header.includes("{key}")) return { error: `verify_header must look like "Name: value with {key}", not "${header}"` };
  const expect = Number(config.verify_expect || 200);
  if (!Number.isInteger(expect) || expect < 200 || expect > 299) return { error: `verify_expect must be a 2xx status, not "${config.verify_expect}"` };
  const fields = (config.verify_fields || "").split(/[\s,]+/).filter(Boolean);
  const badField = fields.find((f) => !FIELD_NAME.test(f) || f === KEY_ENV);
  if (badField) return { error: `verify_fields must be upper-case names like PROJECT_ID, not "${badField}"` };
  const assertText = (config.verify_assert || "").trim();
  const eq = assertText.indexOf("=");
  const assert = !assertText ? null : eq === -1 ? { path: assertText, equals: null } : { path: assertText.slice(0, eq).trim(), equals: assertText.slice(eq + 1).trim() };
  let exchange = null;
  if (config.verify_exchange) {
    const ex = CALL.exec(config.verify_exchange.trim());
    if (!ex) return { error: `verify_exchange must be "POST <full URL>", not "${config.verify_exchange}"` };
    if (!config.verify_exchange_token) return { error: "verify_exchange needs verify_exchange_token: the response field that holds the token, for example access_token" };
    exchange = { method: (ex[1] || "POST").toUpperCase(), url: ex[2], body: config.verify_exchange_body || null, tokenPath: config.verify_exchange_token.trim() };
  }
  // Extra hosts the agent may reach, beyond the product's own: a CLI's package registry, a second dashboard domain.
  const hosts = (config.verify_hosts || "").split(/[\s,]+/).filter(Boolean);
  const badHost = hosts.find((h) => !/^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(h));
  if (badHost) return { error: `verify_hosts must be host names like registry.npmjs.org, not "${badHost}"` };
  // verify_cli: the package registries the agent may install the product's CLI from, by name.
  const registries = (config.verify_cli || "").split(/[\s,]+/).filter(Boolean);
  const badRegistry = registries.find((r) => !REGISTRY_HOSTS[r]);
  if (badRegistry) return { error: `verify_cli must be ${Object.keys(REGISTRY_HOSTS).join(" or ")}, not "${badRegistry}"` };
  for (const r of registries) hosts.push(...REGISTRY_HOSTS[r]);
  return { method: (match[1] || "GET").toUpperCase(), url: match[2], body: config.verify_body || null, header: { name: header.slice(0, colon).trim(), template: header.slice(colon + 1).trim() }, expect, assert, fields, exchange, hosts, cli: registries };
}

export function describeSpec(spec) {
  const assertion = spec.assert ? (spec.assert.equals === null ? `, ${spec.assert.path} present` : `, ${spec.assert.path} = ${spec.assert.equals}`) : "";
  const first = spec.exchange ? `${spec.exchange.method} ${spec.exchange.url} for a token (${spec.exchange.tokenPath}), then ` : "";
  return `${first}${spec.method} ${spec.url} with ${spec.header.name}: ${spec.header.template}; expect ${spec.expect}${assertion}`;
}

function readPath(json, path) {
  let value = json;
  for (const part of path.split(".")) {
    if (value === null || typeof value !== "object") return undefined;
    value = value[part];
  }
  return value;
}

// A key that has the right shape but cannot be the real one.
function wrongKey(key) {
  return key.length > 8 ? `${key.slice(0, -4)}${key.slice(-4) === "xxxx" ? "yyyy" : "xxxx"}` : `${key}x`;
}

// {key} and {NAME} placeholders. In a URL the values are encoded; in a body or header they are used as they are.
function fill(template, values, encode = false) {
  return template.replace(/\{(key|[A-Z][A-Z0-9_]*)\}/g, (whole, name) => (name in values ? (encode ? encodeURIComponent(values[name]) : values[name]) : whole));
}

// A body that starts with { is sent as JSON, anything else as a form.
const contentType = (body) => (body.trim().startsWith("{") ? "application/json" : "application/x-www-form-urlencoded");

async function send(fetchImpl, method, url, body, headers) {
  const init = { method, headers: { ...headers }, signal: AbortSignal.timeout(30_000) };
  if (body !== null && body !== undefined) {
    init.body = body;
    init.headers["content-type"] = contentType(body);
  }
  const res = await fetchImpl(url, init);
  const text = await res.text();
  let json = null;
  let jsonError = null;
  try {
    json = JSON.parse(text);
  } catch (err) {
    // Kept, not dropped: an assertion against a body that is not JSON reports why it failed.
    jsonError = err.message;
  }
  return { status: res.status, json, jsonError, text };
}

// The exchange, when there is one: the key in, a token out. A refused exchange is a refused key.
async function tokenFor(spec, key, values, fetchImpl) {
  if (!spec.exchange) return { token: key };
  const r = await send(fetchImpl, spec.exchange.method, fill(spec.exchange.url, { ...values, key }, true), spec.exchange.body === null ? null : fill(spec.exchange.body, { ...values, key }), {});
  const token = r.jsonError ? undefined : readPath(r.json, spec.exchange.tokenPath);
  if (r.status < 200 || r.status > 299 || typeof token !== "string" || !token) return { token: null, status: r.status, detail: `exchange ${spec.exchange.url} → ${r.status}${typeof token === "string" ? "" : `, no ${spec.exchange.tokenPath}`}` };
  return { token };
}

async function call(spec, key, values, fetchImpl) {
  const url = fill(spec.url, values, true);
  const body = spec.body === null ? null : fill(spec.body, values);
  if (key === null) return send(fetchImpl, spec.method, url, body, {});
  const t = await tokenFor(spec, key, values, fetchImpl);
  if (t.token === null) return { status: t.status, json: null, jsonError: null, text: "", exchangeDetail: t.detail };
  return send(fetchImpl, spec.method, url, body, { [spec.header.name]: fill(spec.header.template, { ...values, key: t.token }) });
}

// The three calls. checkerInvalid means the declared call proves nothing (it answers without a key), which is a
// problem with alg.yml, not with the product or the agent. fields are the other values in CREDENTIAL.env.
export async function checkKey(spec, key, { fetchImpl = fetch, fields = {} } = {}) {
  const values = Object.fromEntries(spec.fields.map((f) => [f, fields[f]]).filter(([, v]) => v));
  const missing = spec.fields.filter((f) => !values[f]);
  if (missing.length) {
    const checks = [{ id: "key_works", label: "Key works", pass: false, detail: `the agent did not save ${missing.join(", ")} in CREDENTIAL.env` }];
    return { ok: false, status: 0, detail: checks[0].detail, objects: { checks, checkerInvalid: false } };
  }
  const real = await call(spec, key, values, fetchImpl);
  const none = await call(spec, null, values, fetchImpl);
  const wrong = await call(spec, wrongKey(key), values, fetchImpl);
  const checks = [];
  let assertPass = true;
  let assertDetail = "";
  if (spec.assert && !real.exchangeDetail) {
    const value = real.jsonError ? undefined : readPath(real.json, spec.assert.path);
    assertPass = spec.assert.equals === null ? value !== undefined && value !== null : String(value) === spec.assert.equals;
    // A presence check names the field, never its value: the response may be a credential (Neon's database_url
    // carries the database password), and this detail is printed and saved.
    const shown = value === undefined || value === null ? "missing" : spec.assert.equals === null ? "present" : JSON.stringify(value);
    assertDetail = real.jsonError ? `; body is not JSON (${real.jsonError})` : spec.assert.equals === null ? `; ${spec.assert.path} ${shown}` : `; ${spec.assert.path} = ${shown}`;
  }
  checks.push({ id: "key_works", label: "Key works", pass: !real.exchangeDetail && real.status === spec.expect && assertPass, detail: real.exchangeDetail || `${spec.method} ${spec.url} → ${real.status}${assertDetail}` });
  checks.push({ id: "no_key_refused", label: "No key refused", pass: REFUSED.has(none.status), detail: `without a key → ${none.status}` });
  checks.push({ id: "wrong_key_refused", label: "Wrong key refused", pass: Boolean(wrong.exchangeDetail) ? wrong.status >= 400 && wrong.status < 500 : REFUSED.has(wrong.status), detail: wrong.exchangeDetail ? `with a wrong key → ${wrong.exchangeDetail}` : `with a wrong key → ${wrong.status}` });
  const checkerInvalid = !REFUSED.has(none.status) && none.status >= 200 && none.status < 300;
  const ok = checks.every((c) => c.pass);
  const detail = checks.map((c) => c.detail).join("; ");
  return { ok, status: real.status, detail, objects: { checks, checkerInvalid } };
}

// Hosts the agent may reach: the product's own site and the usual subdomains, plus the verify call's host.
export function networkFor(targetUrl, spec) {
  const host = new URL(targetUrl).hostname;
  const apex = registrableDomain(host);
  const hosts = [host, apex, ...PRODUCT_SUBDOMAINS.map((s) => `${s}.${apex}`), new URL(spec.url.replace(/\{[^}]+\}/g, "x")).hostname, ...(spec.exchange ? [new URL(spec.exchange.url.replace(/\{[^}]+\}/g, "x")).hostname] : []), ...(spec.hosts || [])];
  return [...new Set(hosts)];
}

export function buildVerifyTask({ url, task, spec, fetchImpl = fetch }) {
  const host = new URL(url).hostname;
  return defineSignupTask({
    id: "verify",
    name: host,
    url,
    apiHost: new URL(spec.url.replace(/\{[^}]+\}/g, "x")).hostname,
    network: networkFor(url, spec),
    credentialEnvName: KEY_ENV,
    extraFields: spec.fields,
    keyPattern: /^\S{8,}$/,
    taskText: `${task}. The product is ${host}.`,
    verify: { describe: describeSpec(spec), call: (key, runId, fields) => checkKey(spec, key, { fetchImpl, fields }) },
  });
}

// Pass, handoff, fail or inconclusive, from the harness result. A handoff passes only when the chosen onboarding
// model says a person sets access up first: then stopping at that step is the agent doing the right thing.
const PERSON_FIRST = new Set(["existing_account", "agent_identity"]);
// resultMd: the agent's own notes. Its report of a 5xx counts only as the agent's report, and only when the trace
// itself shows no key: Inkbox's 500s reached the agent through `curl -s`, which drops the status line.
const REPORTED_5XX = /\b(?:HTTP\s*(?:status)?|status(?:\s*code)?)\W{0,4}5\d\d\b|\b5\d\d\s*\((?:server|internal)/i;
export function classify(result, onboarding, resultMd = "") {
  const evaluation = result.evaluation || {};
  const stages = result.reconciled?.stages || [];
  if (evaluation.success) return { outcome: "passed", exitCode: 0, reason: "A real agent got its own key and the checker confirmed it works." };
  if (evaluation.objects?.checkerInvalid) return { outcome: "inconclusive", exitCode: 3, reason: "The verify call answers without a key, so it cannot prove the agent's key works. Pick a call that needs authentication." };
  if (stages.some((s) => s.agent?.outcome === "product_unavailable")) return { outcome: "inconclusive", exitCode: 3, reason: "The product returned server errors during the run. Try again later." };
  // Only a run that ended on its own (or used its whole turn budget) says anything about the product. A timeout,
  // a crash or a stopped process does not: the second real run was stopped after the agent already had a key.
  if (evaluation.stoppedAt !== "credential_rejected" && REPORTED_5XX.test(resultMd || "")) return { outcome: "inconclusive", exitCode: 3, reason: "The agent reports server errors from the product (see RESULT.md). Try again later." };
  const stopped = result.execution?.stoppedBecause || "";
  if (stopped === "error_max_budget_usd") return { outcome: "inconclusive", exitCode: 3, reason: `The agent stopped at the spending cap ($${result.execution?.executor?.maxBudgetUsd ?? "?"}) before it finished. Raise --max-budget-usd to let it continue. This is not a result about the product.` };
  if (!["success", "error_max_turns"].includes(stopped)) return { outcome: "inconclusive", exitCode: 3, reason: `The agent run did not finish (${stopped || "no result"}). This is not a result about the product.` };
  const unreachable = result.execution?.signals?.connectionFailures || 0;
  if (!evaluation.success && evaluation.stoppedAt !== "credential_rejected" && unreachable >= 2) return { outcome: "inconclusive", exitCode: 3, reason: `The agent could not connect to the product (${unreachable} connection failures). This is about the test environment, not the product.` };
  if (evaluation.stoppedAt === "human_required") {
    if (PERSON_FIRST.has(onboarding)) return { outcome: "handoff", exitCode: 0, reason: "The agent stopped where a person sets up access, which is what your onboarding model says." };
    // NEEDS_HUMAN.md is the agent's own reading of the page it stopped on, not something the run proved.
    return { outcome: "failed", exitCode: 1, reason: "The agent did not get a key: rejected; cause unknown. Its notes (NEEDS_HUMAN.md) say it stopped at a step for a person; the run did not confirm that." };
  }
  if (evaluation.stoppedAt === "credential_rejected") return { outcome: "failed", exitCode: 1, reason: "The agent got a key, but the checker's calls did not pass." };
  return { outcome: "failed", exitCode: 1, reason: "The agent did not get a key." };
}

// Which audit step a failure points at, so verify can write the same kind of fix prompt.
export function failedStep(result) {
  return result.evaluation?.stoppedAt === "credential_rejected" ? "access" : "signup";
}
