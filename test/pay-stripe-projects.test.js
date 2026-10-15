import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { task, evaluate, prepare, parsePurchase, spendCents, capUsd, PROJECT_DIR_ENV, CLOUDFLARE_TOKEN_ENV, CLOUDFLARE_ACCOUNT_ENV, PROTOCOL } from "../src/harness/tasks/pay-stripe-projects.js";
import { resolveCredentials } from "../src/harness/secrets.js";
import { TASKS as ALL } from "../src/harness/index.js";
import { settingsFor } from "../src/harness/executors/claude-print.js";

const files = (map) => ({ read: (n) => map[n] ?? null, readRaw: (n) => map[n] ?? null });
const PLAN = "Buy via https://docs.stripe.com/projects";
const NEW = "fres_61Vnew00000000000000000000000000000000000";
const OLD = "fres_61Vold00000000000000000000000000000000000";
const purchase = (extra = {}) => JSON.stringify({ provider: "cloudflare", service: "workers:paid", command: "stripe projects add cloudflare/workers:paid --confirm-paid-service --accept-tos --json --yes", addOk: false, addResponse: { ok: false, error: { code: "UNKNOWN_ERROR", message: "Provisioning failed for cloudflare/workers:paid" } }, resourceName: "cloudflare-plan-3", resourceId: NEW, resourceStatus: "pending", ...extra });
const spendDoc = (cents) => ({ ok: true, data: { totals: [{ amount: cents, currency: "usd", formatted: `$${(cents / 100).toFixed(2)}` }] } });
const statusDoc = (plans) => ({ ok: true, data: { plans, providers: [{ name: "Cloudflare", status: "complete" }] }, meta: { authenticated: true } });
const plan = (id, status = "pending") => ({ id, name: `cloudflare-plan-${id.slice(-3)}`, service_id: "workers:paid", status });
// What the operator's session answers after a run that bought the plan: the new resource listed, $5.00 more charged.
const runAfter = ({ plans = [plan(OLD, "errored"), plan(NEW)], cents = 1000 } = {}) => async (args) => (args[0] === "status" ? statusDoc(plans) : spendDoc(cents));
const prepared = { projectDir: "/somewhere", at: "2026-10-15T04:00:00.000Z", spendBeforeCents: 500, resourceIds: [OLD] };
const cloudflare = (state = "Paid") => async () => ({ status: 200, json: async () => ({ success: true, result: [{ id: "sub_1", state, currency: "USD", price: 5, rate_plan: { id: "workers_paid", public_name: "Workers Paid" } }] }) });
const ENV = { [CLOUDFLARE_TOKEN_ENV]: "cf-token-of-the-operator", [CLOUDFLARE_ACCOUNT_ENV]: "a".repeat(32) };

describe("pay-stripe-projects: the task", () => {
  it("is registered, runs Bash outside the sandbox, and takes the project folder as its only credential", () => {
    assert.equal(ALL["pay-stripe-projects-cloudflare"].task, task);
    assert.deepEqual(task.sandbox, { enabled: false });
    assert.equal(task.credentials[0].env, PROJECT_DIR_ENV);
    const ok = resolveCredentials(task, { [PROJECT_DIR_ENV]: "/Users/op/agent-ready-stripe-run" });
    assert.deepEqual(ok.available, ["STRIPE_PROJECT_DIR"]);
    assert.equal(resolveCredentials(task, { [PROJECT_DIR_ENV]: "relative/path" }).rejected.length, 1);
    assert.match(task.instructions.always.join("\n"), /run exactly once/);
    assert.match(task.instructions.always.join("\n"), /Do not run it a second time/);
    assert.match(task.instructions.always.join("\n"), /nohup .* never end your turn while the command is still running/s);
    assert.equal(task.timeoutMs, 60 * 60_000);
    assert.match(task.instructions.always.join("\n"), /\$5\.00 per month and the cap for this run is \$5\.00/);
  });

  it("the executor settings honour the task's sandbox switch and the local-binding allowance", () => {
    const off = settingsFor({ network: ["api.stripe.com"], tools: ["Bash"], sandbox: { enabled: false } });
    assert.deepEqual(off.sandbox, { enabled: false });
    assert.deepEqual(off.permissions.allow, ["Bash", "WebFetch(domain:api.stripe.com)"]);
    const on = settingsFor({ network: ["api.stripe.com"], tools: ["Bash"] });
    assert.equal(on.sandbox.enabled, true);
    assert.equal(on.sandbox.network.allowLocalBinding, undefined);
    assert.equal(settingsFor({ network: ["api.stripe.com"], tools: ["Bash"], sandbox: { allowLocalBinding: true } }).sandbox.network.allowLocalBinding, true);
  });

  it("the cap defaults to the plan's price and reads AGENT_READY_PAY_CAP_USD", () => {
    assert.equal(capUsd({}), 5);
    assert.equal(capUsd({ AGENT_READY_PAY_CAP_USD: "10" }), 10);
    assert.throws(() => capUsd({ AGENT_READY_PAY_CAP_USD: "free" }), /positive number/);
  });

  it("reads the month's charges from the spend document and the purchase from PURCHASE.json", () => {
    assert.equal(spendCents(spendDoc(500)), 500);
    assert.equal(spendCents({ ok: false }), 0);
    assert.equal(parsePurchase(purchase()).ok, true);
    assert.match(parsePurchase(null).reason, /no PURCHASE/);
    assert.match(parsePurchase("{").reason, /not JSON/);
    assert.match(parsePurchase(purchase({ service: "r2:bucket" })).reason, /names cloudflare\/r2:bucket/);
    assert.match(parsePurchase(purchase({ resourceId: null })).reason, /fres_/);
  });

  it("prepare copies the operator's .projects/ into the work directory and reads the charges before the run", async () => {
    const projectDir = mkdtempSync(join(tmpdir(), "stripe-project-"));
    mkdirSync(join(projectDir, ".projects"));
    writeFileSync(join(projectDir, ".projects", "state.json"), "{}");
    const workDir = mkdtempSync(join(tmpdir(), "stripe-work-"));
    const seen = [];
    const before = await prepare({ workDir, mode: "given", env: { [PROJECT_DIR_ENV]: projectDir }, log: (t) => seen.push(t), run: async (args, { cwd }) => { assert.equal(cwd, workDir); return args[0] === "status" ? statusDoc([plan(OLD, "errored")]) : spendDoc(500); } });
    assert.equal(readFileSync(join(workDir, ".projects", "state.json"), "utf8"), "{}");
    assert.equal(before.spendBeforeCents, 500);
    assert.deepEqual(before.resourceIds, [OLD]);
    assert.match(seen[0], /\$5\.00; 1 plan resource/);
    assert.equal(await prepare({ workDir, mode: "none", env: {} }), null);
    await assert.rejects(prepare({ workDir, mode: "given", env: { [PROJECT_DIR_ENV]: join(projectDir, "nope") } }), /no \.projects/);
  });
});

describe("pay-stripe-projects: the evaluator", () => {
  it("passes when Stripe Projects lists the new resource, the account was charged within the cap, and Cloudflare shows the plan on", async () => {
    const r = await evaluate({ files: files({ "PLAN.md": PLAN, "PURCHASE.json": purchase() }), mode: "given", prepared, workDir: "/w", env: ENV, run: runAfter(), fetchImpl: cloudflare() });
    assert.equal(r.success, true, JSON.stringify(r.checks));
    assert.equal(r.protocol, PROTOCOL);
    assert.deepEqual(r.checks.map((c) => [c.id, c.pass]), [["plan_written", true], ["purchase_recorded", true], ["resource_listed", true], ["charge_recorded", true], ["amount_within_cap", true], ["provider_confirmed", true]]);
    assert.deepEqual(r.objects, { paidUsd: 5, provider: "Cloudflare", service: "workers:paid", serviceName: "Workers Paid", resourceId: NEW, resourceStatus: "pending", subscriptionState: "Paid" });
    assert.match(r.checks[3].detail, /from \$5\.00 to \$10\.00/);
  });

  it("the command's own verdict is not consulted: addOk false still passes when the charge and the plan are real", async () => {
    const r = await evaluate({ files: files({ "PLAN.md": PLAN, "PURCHASE.json": purchase({ addOk: false }) }), mode: "given", prepared, workDir: "/w", env: ENV, run: runAfter(), fetchImpl: cloudflare() });
    assert.equal(r.success, true);
  });

  it("fails on no new charge, on a resource that existed before the run, on an amount over the cap, and on Cloudflare saying the plan is off", async () => {
    const same = await evaluate({ files: files({ "PLAN.md": PLAN, "PURCHASE.json": purchase() }), mode: "given", prepared, workDir: "/w", env: ENV, run: runAfter({ cents: 500 }), fetchImpl: cloudflare() });
    assert.equal(same.checks.find((c) => c.id === "charge_recorded").pass, false);
    assert.equal(same.success, false);
    const old = await evaluate({ files: files({ "PLAN.md": PLAN, "PURCHASE.json": purchase({ resourceId: OLD }) }), mode: "given", prepared, workDir: "/w", env: ENV, run: runAfter(), fetchImpl: cloudflare() });
    assert.equal(old.checks.find((c) => c.id === "resource_listed").pass, false);
    assert.match(old.checks.find((c) => c.id === "resource_listed").detail, /existed before this run/);
    const over = await evaluate({ files: files({ "PLAN.md": PLAN, "PURCHASE.json": purchase() }), mode: "given", prepared, workDir: "/w", env: { ...ENV, AGENT_READY_PAY_CAP_USD: "2" }, run: runAfter(), fetchImpl: cloudflare() });
    assert.equal(over.checks.find((c) => c.id === "amount_within_cap").pass, false);
    const off = await evaluate({ files: files({ "PLAN.md": PLAN, "PURCHASE.json": purchase() }), mode: "given", prepared, workDir: "/w", env: ENV, run: runAfter(), fetchImpl: cloudflare("Cancelled") });
    assert.equal(off.checks.find((c) => c.id === "provider_confirmed").pass, false);
    assert.equal(off.success, false);
  });

  it("without a Cloudflare token the provider check is null and the run is not a success", async () => {
    const r = await evaluate({ files: files({ "PLAN.md": PLAN, "PURCHASE.json": purchase() }), mode: "given", prepared, workDir: "/w", env: {}, run: runAfter(), fetchImpl: cloudflare() });
    const provider = r.checks.find((c) => c.id === "provider_confirmed");
    assert.equal(provider.pass, null);
    assert.equal(provider.status, "not_configured");
    assert.equal(r.success, false);
    assert.equal(r.objects.paidUsd, 5);
  });

  it("without a reading from before the run the charge check is null, not a guess", async () => {
    const r = await evaluate({ files: files({ "PLAN.md": PLAN, "PURCHASE.json": purchase() }), mode: "given", prepared: null, workDir: "/w", env: ENV, run: runAfter(), fetchImpl: cloudflare() });
    assert.equal(r.checks.find((c) => c.id === "charge_recorded").status, "no_baseline");
    assert.equal(r.success, false);
  });

  it("stops at human_required when the agent wrote NEEDS_HUMAN.md and no purchase, and at not_recorded otherwise", async () => {
    const human = await evaluate({ files: files({ "PLAN.md": PLAN, "NEEDS_HUMAN.md": "The payment failed: contact your bank." }), mode: "given", prepared, workDir: "/w", env: ENV, run: runAfter(), fetchImpl: cloudflare() });
    assert.equal(human.stoppedAt, "human_required");
    assert.equal(human.success, false);
    assert.match(human.checks[1].detail, /contact your bank/);
    assert.ok(human.checks.filter((c) => c.tier === "live").every((c) => c.pass === null && c.status === "human_required"));
    const none = await evaluate({ files: files({ "PLAN.md": PLAN }), mode: "given", prepared, workDir: "/w", env: ENV, run: runAfter(), fetchImpl: cloudflare() });
    assert.equal(none.stoppedAt, "not_recorded");
  });

  it("reports the operator's CLI failing as evaluator_cli_failed, never as a failed purchase", async () => {
    const r = await evaluate({ files: files({ "PLAN.md": PLAN, "PURCHASE.json": purchase() }), mode: "given", prepared, workDir: "/w", env: ENV, run: async () => { throw new Error("stripe projects status failed: NOT_AUTHENTICATED"); }, fetchImpl: cloudflare() });
    assert.equal(r.stoppedAt, "evaluator_cli_failed");
    assert.ok(r.checks.filter((c) => c.tier === "live").every((c) => c.pass === null));
  });

  it("in mode none the agent documents the missing project and every live check waits", async () => {
    const r = await evaluate({ files: files({ "PLAN.md": PLAN, "NEEDS_CREDENTIAL.md": `Set ${PROJECT_DIR_ENV}` }), mode: "none", workDir: "/w", env: {} });
    assert.equal(r.stoppedAt, "credential_required");
    assert.equal(r.checks[1].pass, true);
    assert.ok(existsSync("/") && r.checks.filter((c) => c.tier === "live").every((c) => c.status === "credential_required"));
  });
});
