// ONE purchase of ONE paid plan through Stripe Projects (docs.stripe.com/projects), the pattern where a person sets a
// wallet up once (Stripe sign-in, a card, a spending cap, the provider linked) and a program spends from it with one
// command. Real money moves: the card on the operator's Stripe account is charged, through Stripe, for the provider's
// plan. Nothing secret is handed to the agent: the Stripe CLI on this machine is already signed in by the operator,
// and this task copies the project folder (`.projects/`, from AGENT_READY_STRIPE_PROJECT_DIR) into the run's work
// directory. The per-run cap is AGENT_READY_PAY_CAP_USD (default 5.00 here: the plan costs $5). The evaluator never
// asks the agent: it reads PURCHASE.json, then Stripe Projects' own status and charges from the operator's session,
// and the provider's API for the plan.
//
// The first manual run (2026-10-14) showed why the evaluator reads charges and the provider, not the command's
// verdict: `add` reported "Provisioning failed" after 17 minutes while `spend` showed the $5.00 charge and
// Cloudflare's billing page showed Workers Paid. The same run showed the Stripe Projects plugin cannot run inside
// the harness sandbox: it listens on 127.0.0.1 to talk to the Stripe CLI, and the operator's session lives in the
// macOS Keychain, which the sandbox does not reach. So this task runs Bash outside the sandbox (task.sandbox), and
// the run's confinement record says so.
import { execFile } from "node:child_process";
import { cpSync, existsSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const PROTOCOL = "stripe-projects";
export const PROJECT_DIR_ENV = "AGENT_READY_STRIPE_PROJECT_DIR";
export const CLOUDFLARE_TOKEN_ENV = "AGENT_READY_CLOUDFLARE_TOKEN";
export const CLOUDFLARE_ACCOUNT_ENV = "AGENT_READY_CLOUDFLARE_ACCOUNT";
export const PLAN = { provider: "cloudflare", providerName: "Cloudflare", service: "workers:paid", serviceName: "Workers Paid", priceUsd: 5 };
const DEFAULT_CAP_USD = 5;
// The evaluator only reads (status, spend), which answer in seconds; the agent runs the slow `add` itself.
const READ_TIMEOUT_MS = 120_000;

export function capUsd(env = process.env) {
  const raw = env.AGENT_READY_PAY_CAP_USD;
  if (raw === undefined || raw === "") return DEFAULT_CAP_USD;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`AGENT_READY_PAY_CAP_USD must be a positive number of dollars, got ${JSON.stringify(raw)}`);
  return n;
}

const PROJECT_DIR = {
  env: PROJECT_DIR_ENV,
  injectAs: "STRIPE_PROJECT_DIR",
  test: /^\/.+/,
  rejectReason: "must be the absolute path of a folder where `stripe projects init` ran, with a card and a Cloudflare link set up by a person",
  description: "folder of a Stripe Projects project the operator initialized, with billing added, a spending limit set and Cloudflare linked; the run copies its .projects/ folder and buys from it",
};

const ADD_COMMAND = `stripe projects add ${PLAN.provider}/${PLAN.service} --confirm-paid-service --accept-tos --json --yes`;

export const task = {
  id: "pay-stripe-projects-cloudflare",
  url: "https://cloudflare.com",
  apiHost: "api.stripe.com",
  credentialEnvName: null,
  text: `Buy the Cloudflare ${PLAN.serviceName} plan ($${PLAN.priceUsd}/month) through Stripe Projects, from the operator's signed-in Stripe CLI, with one \`stripe projects add\` command.`,
  credentials: [PROJECT_DIR],
  network: ["cloudflare.com", "www.cloudflare.com", "developers.cloudflare.com", "docs.stripe.com", "api.stripe.com", "access.stripe.com", "files.stripe.com", "r.stripe.com", "projects.dev", "stripe.jfrog.io"],
  // The Stripe Projects plugin cannot run inside the sandbox (see the top of this file). Bash runs with the operator's
  // own access for this task; WebFetch keeps its domain allowlist.
  sandbox: { enabled: false },
  // The first agent run was killed at the executor's 30-minute wall clock while `add` was still provisioning.
  timeoutMs: 60 * 60_000,
  instructions: {
    always: [
      "Work only inside the current directory. Do not touch other directories.",
      "The Stripe CLI (`stripe`) is on your PATH and already signed in by the operator, and this directory holds their Stripe Projects project (`.projects/`). Never run `stripe login`, `stripe projects init`, `stripe projects switch-account`, `stripe projects billing ...`, `stripe projects link ...` or any other command that changes the operator's account, card or spending limit. Never read or print `.projects/`, `~/.config/stripe` or any file outside this directory.",
      "Write PLAN.md first: the Stripe Projects documentation you read (https://docs.stripe.com/projects), the provider and service you will buy, the price `stripe projects catalog cloudflare --json` quotes for it, and the exact command. Then act.",
      "Run `stripe projects status --json` once. If `meta.authenticated` is not true, or Cloudflare is not among `data.providers` with status complete, write NEEDS_HUMAN.md stating what is missing and stop: linking a provider and signing in are a person's steps.",
      `The purchase is this one command, run exactly once: \`${ADD_COMMAND}\`. Do not run it a second time whatever it answers: on a previous run it reported a failure after the charge had gone through.`,
      "The command can take 20 minutes, longer than one shell call may run, so start it detached in the shell, as `nohup <the command> > add-output.json 2> add-stderr.txt &`, and then wait for it in the foreground: run `sleep 240; cat add-output.json` as its own command, again and again, until add-output.json holds the command's JSON or 40 minutes have passed. Never use the Bash tool's own background option and never end your turn while the command is still running: this run ends when your turn ends, and the command would be killed with it.",
      `The plan costs $${PLAN.priceUsd}.00 per month and the cap for this run is $${capUsd().toFixed(2)}. If the catalog quotes more than the cap, write NEEDS_HUMAN.md with the quote and stop without buying.`,
      "If the command answers BROWSER_AUTH_REQUIRED, ACCOUNT_NOT_ELIGIBLE, NOT_AUTHENTICATED or that the payment failed, write NEEDS_HUMAN.md quoting the response and stop. Do not try another provider, service or command.",
      "When the command has returned (ok or not), run `stripe projects status --json` once more and write PURCHASE.json with: provider (\"cloudflare\"), service (\"workers:paid\"), command (the exact command you ran), addOk (the command's `ok` field, or false if it printed no JSON), addResponse (the command's JSON or its error text), and from the status: resourceName, resourceId (the `id` starting fres_) and resourceStatus of the newest `data.plans` entry whose service_id is workers:paid. If no such entry exists, set those three to null.",
      "Do not decide or state whether you succeeded. When you have done what you can, stop.",
    ],
    withCredential: [],
    signup: [],
    withoutCredential: [`No Stripe Projects project is available for this run. Read https://docs.stripe.com/projects, write PLAN.md with the exact command you would run, write NEEDS_CREDENTIAL.md naming ${PROJECT_DIR_ENV}, and stop.`],
  },
  criteria: {
    local: ["PLAN.md exists and cites Stripe Projects' documentation", "PURCHASE.json records one `stripe projects add` of cloudflare/workers:paid and the resource Stripe Projects created"],
    live: ["Stripe Projects lists the resource", "the operator's Stripe account was charged for it during the run", "the amount is within AGENT_READY_PAY_CAP_USD", "Cloudflare's API shows the Workers Paid subscription"],
  },
};

// `stripe projects <args> --json`, run in the given folder (the plugin keeps the project's state in its `.projects/`).
// A refusal is still JSON with ok false; what is not JSON at all (the plugin failing to start) is an error.
export async function runStripe(args, { cwd, timeoutMs = READ_TIMEOUT_MS } = {}) {
  let stdout;
  try {
    ({ stdout } = await execFileAsync("stripe", ["projects", ...args, "--json"], { cwd, timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, env: { ...process.env, NO_COLOR: "1" } }));
  } catch (err) {
    if (typeof err.stdout === "string" && err.stdout.includes("{")) stdout = err.stdout;
    else throw new Error(`stripe projects ${args.join(" ")} failed: ${(err.stderr || err.message || "").toString().trim().split("\n")[0].slice(0, 200)}`);
  }
  const start = stdout.indexOf("{");
  if (start < 0) throw new Error(`stripe projects ${args.join(" ")} printed no JSON`);
  return JSON.parse(stdout.slice(start));
}

// The month's charges to date for the provider, in cents, from `spend <provider> --json`.
export function spendCents(doc) {
  const totals = doc?.data?.totals;
  if (!Array.isArray(totals)) return 0;
  return totals.filter((t) => t.currency === "usd").reduce((sum, t) => sum + Number(t.amount || 0), 0);
}

// Before the agent runs: copy the operator's project into the work directory and read the charges so far, so the
// evaluator can tell what this run added. Nothing here is secret (the session is in the Keychain, the vault key too).
export async function prepare({ workDir, mode, env = process.env, log = () => {}, run = runStripe }) {
  if (mode !== "given") return null;
  const projectDir = env[PROJECT_DIR_ENV];
  const source = join(projectDir, ".projects");
  if (!existsSync(source)) throw new Error(`${PROJECT_DIR_ENV}=${projectDir} has no .projects/ folder; run \`stripe projects init\` there first`);
  cpSync(source, join(workDir, ".projects"), { recursive: true });
  const spend = await run(["spend", PLAN.provider], { cwd: workDir });
  const status = await run(["status"], { cwd: workDir });
  const resourceIds = (status?.data?.plans || []).map((p) => p.id);
  const spendBeforeCents = spendCents(spend);
  log(`${PLAN.providerName} charges on the operator's Stripe account so far this month: $${(spendBeforeCents / 100).toFixed(2)}; ${resourceIds.length} plan resource(s) already in the project`);
  return { projectDir, at: new Date().toISOString(), spendBeforeCents, resourceIds };
}

export function parsePurchase(text) {
  if (!text) return { ok: false, reason: "no PURCHASE.json" };
  let doc;
  try { doc = JSON.parse(text); } catch (err) { return { ok: false, reason: `PURCHASE.json is not JSON: ${err.message}` }; }
  if (doc.provider !== PLAN.provider || doc.service !== PLAN.service) return { ok: false, reason: `PURCHASE.json names ${doc.provider}/${doc.service}, not ${PLAN.provider}/${PLAN.service}` };
  if (typeof doc.resourceId !== "string" || !/^fres_[A-Za-z0-9]+$/.test(doc.resourceId)) return { ok: false, reason: "PURCHASE.json has no resourceId of the form fres_…" };
  return { ok: true, doc };
}

// Cloudflare's own word: GET /client/v4/accounts/{id}/subscriptions, read with a token of the operator's that can read
// billing. The Workers Paid subscription is the one whose rate plan names Workers and is paid.
export async function cloudflareSubscription({ token, account, fetchImpl = fetch }) {
  const r = await fetchImpl(`https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(account)}/subscriptions`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(30_000) });
  const body = await r.json().catch(() => null);
  if (r.status !== 200 || !body?.success) throw new Error(`Cloudflare answered ${r.status}: ${JSON.stringify(body?.errors || body).slice(0, 160)}`);
  const subs = body.result || [];
  const workers = subs.find((s) => /workers/i.test(`${s.rate_plan?.id || ""} ${s.rate_plan?.public_name || ""}`) && /paid/i.test(`${s.rate_plan?.id || ""} ${s.rate_plan?.public_name || ""}`)) || null;
  return { subscriptions: subs.length, workers: workers ? { id: workers.id, state: workers.state, planId: workers.rate_plan?.id || null, planName: workers.rate_plan?.public_name || null, currency: workers.currency || null, price: workers.price ?? null } : null };
}

const LIVE = ["resource_listed", "charge_recorded", "amount_within_cap", "provider_confirmed"];

// Deterministic. Reads what the agent recorded, then confirms from the operator's own Stripe Projects session that the
// resource exists and the account was charged during the run, and from Cloudflare's API that the plan is on. Never
// trusts the agent's `addOk`: the first real run's command said failed while the charge and the plan were real.
export async function evaluate({ files, mode, prepared = null, workDir, env = process.env, run = runStripe, fetchImpl = fetch }) {
  const checks = [];
  const plan = files.read("PLAN.md");
  const planUrl = plan ? (plan.match(/https?:\/\/[^\s)>\]]+/) || [null])[0] : null;
  checks.push({ id: "plan_written", tier: "local", pass: Boolean(plan && planUrl), detail: plan ? `PLAN.md ${plan.length} chars; cites ${planUrl || "no URL"}` : "no PLAN.md", evidence: { file: "PLAN.md" } });
  const done = (stoppedAt, objects = null) => ({ method: "deterministic", protocol: PROTOCOL, checkedAt: new Date().toISOString(), success: checks.filter((c) => c.tier === "live").length > 0 && checks.every((c) => c.pass === true), stoppedAt, checks, authenticated: null, objects, keySource: null });
  const nulls = (status, detail) => { for (const id of LIVE) checks.push({ id, tier: "live", pass: null, status, detail, evidence: null }); };

  if (mode === "none") {
    const needs = files.read("NEEDS_CREDENTIAL.md");
    checks.push({ id: "credential_need_documented", tier: "local", pass: Boolean(needs && needs.includes(PROJECT_DIR_ENV)), detail: needs ? `NEEDS_CREDENTIAL.md names ${PROJECT_DIR_ENV}` : "no NEEDS_CREDENTIAL.md", evidence: { file: "NEEDS_CREDENTIAL.md" } });
    nulls("credential_required", "no project in this mode");
    return done("credential_required");
  }

  const human = files.read("NEEDS_HUMAN.md");
  const purchase = parsePurchase(files.readRaw("PURCHASE.json"));
  checks.push({ id: "purchase_recorded", tier: "local", pass: purchase.ok, status: purchase.ok ? undefined : human ? "human_required" : "not_recorded", detail: purchase.ok ? `PURCHASE.json: ${purchase.doc.command || ADD_COMMAND}; resource ${purchase.doc.resourceName || purchase.doc.resourceId} (${purchase.doc.resourceStatus || "status unrecorded"}); the command said ok=${purchase.doc.addOk}` : human ? `stopped before buying: ${human.split("\n").find((l) => l.trim() && !l.startsWith("#"))?.trim().slice(0, 160) || "see NEEDS_HUMAN.md"}` : purchase.reason, evidence: { file: purchase.ok ? "PURCHASE.json" : human ? "NEEDS_HUMAN.md" : "PURCHASE.json" } });
  if (!purchase.ok) {
    nulls(human ? "human_required" : "not_recorded", "no purchase to confirm");
    return done(human ? "human_required" : "not_recorded");
  }

  const { doc } = purchase;
  const cap = capUsd(env);
  let status;
  let spend;
  try {
    status = await run(["status"], { cwd: workDir });
    spend = await run(["spend", PLAN.provider], { cwd: workDir });
  } catch (err) {
    nulls("evaluator_cli_failed", err.message);
    return done("evaluator_cli_failed");
  }
  const listed = (status?.data?.plans || []).find((p) => p.id === doc.resourceId) || null;
  const isNew = !(prepared?.resourceIds || []).includes(doc.resourceId);
  checks.push({ id: "resource_listed", tier: "live", pass: Boolean(listed && listed.service_id === PLAN.service && isNew), detail: listed ? `${listed.name} (${listed.service_id}) status ${listed.status}${isNew ? "" : ", but it existed before this run"}` : `no plan resource ${doc.resourceId} in \`stripe projects status\``, evidence: { request: "stripe projects status --json", resourceStatus: listed?.status ?? null } });

  const after = spendCents(spend);
  const before = prepared ? prepared.spendBeforeCents : null;
  const deltaCents = before === null ? null : after - before;
  const paidUsd = deltaCents === null ? null : deltaCents / 100;
  if (deltaCents === null) checks.push({ id: "charge_recorded", tier: "live", pass: null, status: "no_baseline", detail: `charges this month $${(after / 100).toFixed(2)}; no reading from before the run to compare`, evidence: { request: `stripe projects spend ${PLAN.provider} --json`, afterCents: after } });
  else checks.push({ id: "charge_recorded", tier: "live", pass: deltaCents > 0, detail: `${PLAN.providerName} charges this month went from $${(before / 100).toFixed(2)} to $${(after / 100).toFixed(2)} during the run`, evidence: { request: `stripe projects spend ${PLAN.provider} --json`, beforeCents: before, afterCents: after, paidUsd } });
  checks.push({ id: "amount_within_cap", tier: "live", pass: paidUsd !== null && paidUsd > 0 && paidUsd <= cap, detail: `$${(paidUsd ?? 0).toFixed(2)} charged; cap $${cap.toFixed(2)}`, evidence: { paidUsd, capUsd: cap } });

  const token = env[CLOUDFLARE_TOKEN_ENV];
  const account = env[CLOUDFLARE_ACCOUNT_ENV];
  let subscription = null;
  if (!token || !account) checks.push({ id: "provider_confirmed", tier: "live", pass: null, status: "not_configured", detail: `set ${CLOUDFLARE_TOKEN_ENV} (a token that can read the account's billing) and ${CLOUDFLARE_ACCOUNT_ENV} to read the subscription from Cloudflare`, evidence: null });
  else {
    try {
      subscription = await cloudflareSubscription({ token, account, fetchImpl });
      const on = Boolean(subscription.workers && /^(paid|provisioned)$/i.test(subscription.workers.state || ""));
      checks.push({ id: "provider_confirmed", tier: "live", pass: on, detail: subscription.workers ? `Cloudflare lists ${subscription.workers.planName || subscription.workers.planId} in state ${subscription.workers.state}` : `Cloudflare lists ${subscription.subscriptions} subscription(s), none of them Workers Paid`, evidence: { request: "GET https://api.cloudflare.com/client/v4/accounts/<account>/subscriptions", state: subscription.workers?.state ?? null, planId: subscription.workers?.planId ?? null } });
    } catch (err) {
      checks.push({ id: "provider_confirmed", tier: "live", pass: null, status: "evaluator_api_failed", detail: err.message, evidence: { request: "GET https://api.cloudflare.com/client/v4/accounts/<account>/subscriptions" } });
    }
  }

  return done(null, { paidUsd, provider: PLAN.providerName, service: PLAN.service, serviceName: PLAN.serviceName, resourceId: doc.resourceId, resourceStatus: listed?.status ?? null, subscriptionState: subscription?.workers?.state ?? null });
}
