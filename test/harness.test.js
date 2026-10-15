import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { reconcile } from "../src/harness/reconcile.js";
import { buildPrompt, sourcesFrom } from "../src/harness/execute.js";
import { resolveCredentials, secretsInText } from "../src/harness/secrets.js";
import { settingsFor } from "../src/harness/executors/claude-print.js";
import { task, evaluate } from "../src/harness/tasks/stripe-subscription.js";

const doc = { target: { url: "https://stripe.com/" }, product: { name: { value: "Stripe" } }, observations: [{ id: "obs_01", ok: true, role: "homepage", url: "https://stripe.com/" }] };
const journey = {
  schema: "agent-ready/journey@1",
  stages: [
    { stage: "discover", status: "success", reason: "ok", basedOn: ["obs_01"] },
    { stage: "understand", status: "success", reason: "ok", basedOn: [] },
    { stage: "choose_interface", status: "success", reason: "api", basedOn: [] },
    { stage: "acquire_credential", status: "not_run", reason: "no rule", basedOn: [] },
    { stage: "authenticate", status: "failed", reason: "no declared scheme", basedOn: [] },
    { stage: "execute", status: "not_run", reason: "", basedOn: [] },
    { stage: "recover", status: "not_run", reason: "", basedOn: [] },
  ],
};
const files = (map) => ({ read: (n) => map[n] ?? null, readRaw: (n) => map[n] ?? null });
const baseExec = (over) => ({ executor: { name: "test" }, mode: "none", persona: null, mail: null, credentials: { available: [], missing: ["STRIPE_RESTRICTED_KEY"], rejected: [] }, turns: 3, costUsd: 0.01, toolCalls: 3, sources: ["https://docs.stripe.com/api/authentication"], commands: [], errors: [], denied: 0, recoveryAttempts: 0, stoppedBecause: "success", files: { plan: "Use the REST API. Auth: https://docs.stripe.com/keys", needsCredential: null, request: null }, events: [], ...over });

describe("secret boundary", () => {
  it("injects only under the task's name, rejects live keys, and redacts values from any text", () => {
    const none = resolveCredentials(task, { PATH: "/bin" });
    assert.deepEqual(none.available, []);
    assert.deepEqual(none.missing, ["STRIPE_RESTRICTED_KEY"]);
    const live = resolveCredentials(task, { STRIPE_RESTRICTED_KEY: "sk_live_abc" });
    assert.equal(live.rejected.length, 1);
    assert.deepEqual(live.available, []);
    const ok = resolveCredentials(task, { STRIPE_RESTRICTED_KEY: "rk_test_Zz9secret", CLAUDECODE: "1" });
    assert.deepEqual(ok.available, ["STRIPE_API_KEY"]);
    assert.equal(ok.childEnv.STRIPE_API_KEY, "rk_test_Zz9secret");
    assert.equal("STRIPE_RESTRICTED_KEY" in ok.childEnv, false);
    assert.equal("CLAUDECODE" in ok.childEnv, false);
    assert.equal(ok.redact("curl -u rk_test_Zz9secret: https://api.stripe.com"), "curl -u <redacted>: https://api.stripe.com");
    assert.equal(ok.redact("Authorization: Bearer sk_test_51Hxyz123abcdefg"), "Authorization: Bearer sk_test_…redacted");
    assert.doesNotMatch(buildPrompt({ task, runId: "r1", doc, credentials: ok }), /rk_test_Zz9/);
    assert.match(buildPrompt({ task, runId: "r1", doc, credentials: none }), /No credential is available/);
    assert.match(buildPrompt({ task, runId: "r1", doc, credentials: ok }), /STRIPE_API_KEY/);
  });

  it("never shows the agent the extractor's verdicts", () => {
    const judged = { ...doc, interfaces: { api: { exists: { verdict: "partial", reason: "no OpenAPI" } } }, authentication: { agentCanUnderstandSetup: { verdict: "no", reason: "no declared scheme" } } };
    const prompt = buildPrompt({ task, runId: "r1", doc: judged, credentials: resolveCredentials(task, {}) });
    assert.doesNotMatch(prompt, /verdict|no declared scheme|no OpenAPI|interface\.json|unknown/);
    assert.match(prompt, /https:\/\/stripe\.com\//);
  });

  it("confines the executor: tool allowlist, WebFetch default-deny, sandboxed network allowlist", () => {
    const s = settingsFor({ network: task.network, tools: ["Bash", "WebFetch", "Read"] });
    assert.ok(s.permissions.deny.includes("WebFetch"));
    assert.ok(s.permissions.allow.includes("WebFetch(domain:api.stripe.com)"));
    assert.equal(s.sandbox.enabled, true);
    assert.equal(s.sandbox.failIfUnavailable, true);
    assert.equal(s.sandbox.network.strictAllowlist, true);
    assert.equal(s.sandbox.allowUnsandboxedCommands, false);
    assert.deepEqual(s.sandbox.network.allowedDomains, task.network);
  });
});

describe("trace", () => {
  it("counts pages fetched with curl as sources, not only WebFetch", () => {
    const s = sourcesFrom([{ kind: "tool_use", tool: "Bash", input: 'for u in https://docs.stripe.com/api/authentication.md https://docs.stripe.com/keys.md; do curl -sL "$u"; done' }, { kind: "tool_use", tool: "WebFetch", input: "https://stripe.com/pricing" }, { kind: "tool_result", text: "https://example.com/not-a-fetch" }]);
    assert.deepEqual(s, ["https://docs.stripe.com/api/authentication.md", "https://docs.stripe.com/keys.md", "https://stripe.com/pricing"]);
  });
});

describe("evaluator", () => {
  it("without a credential runs local checks only and reports live checks as credential_required", async () => {
    const creds = resolveCredentials(task, {});
    const ev = await evaluate({ runId: "r1", credentials: creds, mode: "none", files: files({ "PLAN.md": "REST API; auth from https://docs.stripe.com/keys", "NEEDS_CREDENTIAL.md": "Need a secret key: https://docs.stripe.com/keys" }) });
    assert.equal(ev.success, false);
    assert.equal(ev.stoppedAt, "credential_required");
    assert.equal(ev.checks.find((c) => c.id === "plan_written").pass, true);
    assert.equal(ev.checks.find((c) => c.id === "credential_need_documented").pass, true);
    assert.equal(ev.checks.find((c) => c.id === "customer_created").status, "credential_required");
  });
});

describe("reconcile", () => {
  it("preserves unresolved inspection states without turning them into failures or skipped checks", () => {
    const unresolvedJourney = { ...journey, stages: journey.stages.map((s) => ({ ...s, status: s.stage === "understand" ? "needs_input" : s.stage === "authenticate" ? "unknown" : s.status })) };
    const evaluation = { success: false, stoppedAt: "credential_required", checks: [], authenticated: null };
    const r = reconcile({ journey: unresolvedJourney, execution: baseExec({}), evaluation, doc });
    assert.equal(r.reconciled.stages.find((s) => s.stage === "understand").extractor.outcome, "needs_input");
    assert.equal(r.reconciled.stages.find((s) => s.stage === "authenticate").extractor.outcome, "unknown");
    assert.deepEqual(r.reconciled.discrepancies, []);
  });

  it("stops at authenticate with credential_required when no key was available, without a discrepancy", async () => {
    const creds = resolveCredentials(task, {});
    const evaluation = await evaluate({ runId: "r1", credentials: creds, mode: "none", files: files({ "PLAN.md": "REST API; https://docs.stripe.com/keys", "NEEDS_CREDENTIAL.md": "https://docs.stripe.com/keys" }) });
    const r = reconcile({ journey, execution: baseExec({}), evaluation, doc });
    assert.equal(r.reconciled.stages.find((s) => s.stage === "acquire_credential").agent.outcome, "skipped");
    assert.equal(r.schema, "agent-ready/journey@1");
    assert.equal(r.reconciled.stoppedAt.stage, "authenticate");
    assert.equal(r.reconciled.stoppedAt.outcome, "credential_required");
    assert.equal(r.reconciled.stages.find((s) => s.stage === "authenticate").agent.documented, true);
    assert.equal(r.reconciled.stages.find((s) => s.stage === "execute").agent.outcome, "credential_required");
    assert.deepEqual(r.reconciled.discrepancies, []);
  });

  it("flags the discrepancy when extraction failed a stage the agent completed with a key", () => {
    const execution = baseExec({ mode: "given", credentials: { available: ["STRIPE_API_KEY"], missing: [], rejected: [] }, commands: ["curl https://api.stripe.com/v1/customers"], errors: [{ seq: 4, text: "error" }], recoveryAttempts: 2 });
    const evaluation = { success: true, stoppedAt: null, checks: [{ id: "plan_written", tier: "local", pass: true, detail: "ok" }, { id: "customer_created", tier: "live", pass: true, detail: "cus_1" }, { id: "subscription_active", tier: "live", pass: true, detail: "sub_1 active" }, { id: "price_matches", tier: "live", pass: true, detail: "1 item" }] };
    const r = reconcile({ journey, execution, evaluation, doc });
    const auth = r.reconciled.stages.find((s) => s.stage === "authenticate");
    assert.equal(auth.extractor.outcome, "failed");
    assert.equal(auth.agent.outcome, "passed");
    assert.equal(auth.discrepancy, true);
    assert.equal(r.reconciled.stages.find((s) => s.stage === "recover").agent.outcome, "passed");
    assert.equal(r.reconciled.stages.find((s) => s.stage === "acquire_credential").agent.outcome, "skipped");
    assert.equal(r.reconciled.stoppedAt, null);
    assert.match(r.reconciled.discrepancies[0], /could not establish/);
  });
});

describe("signup mode", () => {
  it("stops at acquire_credential with human_required when the agent hits a human-only step", async () => {
    const creds = resolveCredentials(task, {});
    const evaluation = await evaluate({ runId: "r1", credentials: creds, mode: "signup", files: files({ "PLAN.md": "REST API; https://docs.stripe.com/keys", "NEEDS_HUMAN.md": "# NEEDS_HUMAN\nPhone verification at https://dashboard.stripe.com/register asked for an SMS code." }) });
    assert.equal(evaluation.checks.find((c) => c.id === "credential_acquired").status, "human_required");
    const execution = baseExec({ mode: "signup", persona: { name: "Ari Vale", email: "x@agentmail.to" }, mail: { provider: "relay", email: "x@agentmail.to", delivered: [{ file: "001-a.json" }] }, files: { plan: "REST API https://docs.stripe.com/keys", needsHuman: "phone", request: null } });
    const r = reconcile({ journey, execution, evaluation, doc });
    const acq = r.reconciled.stages.find((s) => s.stage === "acquire_credential");
    assert.equal(acq.agent.outcome, "human_required");
    assert.equal(acq.agent.mail, 1);
    assert.equal(r.reconciled.stoppedAt.stage, "acquire_credential");
    assert.equal(r.reconciled.stages.find((s) => s.stage === "authenticate").agent.outcome, "not_reached");
  });

  it("reads a signed-up key that works, then a product gate before the payment, as human_required at execute, not failed", async () => {
    const { evaluate: evaluatePay } = await import("../src/harness/tasks/pay-x402.js");
    const verifyKey = { describe: "GET balance", call: async () => ({ ok: true, status: 200, detail: "balance read" }) };
    const evaluation = await evaluatePay({ mode: "signup", credentialEnvName: "TELNYX_API_KEY", verifyKey, files: files({ "PLAN.md": "REST API; https://telnyx.com/.well-known/agent-skills/telnyx-x402-payment/SKILL.md", "CREDENTIAL.env": "TELNYX_API_KEY=KEY0123456789abcdef\n", "NEEDS_HUMAN.md": "# NEEDS_HUMAN\n403 Feature not permitted at https://api.telnyx.com/v2/x402/credit_account/quote" }), fetchReceipt: async () => { throw new Error("must not be called"); }, env: {} });
    const execution = baseExec({ mode: "signup", persona: { name: "Ari Vale", email: "x@agentmail.to" }, mail: { provider: "relay", email: "x@agentmail.to", delivered: [{ file: "001-a.json" }] }, commands: ["curl https://api.telnyx.com/v2/x402/credit_account/quote"], files: { plan: "REST API https://telnyx.com", needsHuman: "403", request: null } });
    const r = reconcile({ journey, execution, evaluation, doc });
    const stage = (name) => r.reconciled.stages.find((s) => s.stage === name).agent.outcome;
    assert.equal(stage("acquire_credential"), "passed");
    assert.equal(stage("authenticate"), "passed");
    assert.equal(stage("execute"), "human_required");
    assert.equal(stage("recover"), "not_reached");
  });

  it("learns an agent-acquired key and redacts it afterwards", () => {
    const creds = resolveCredentials(task, {});
    creds.learn("rk_test_agentGotThis123");
    assert.equal(creds.redact("STRIPE_API_KEY=rk_test_agentGotThis123"), "STRIPE_API_KEY=<redacted>");
    const p = buildPrompt({ task, runId: "r1", doc, credentials: creds, mode: "signup", persona: { name: "Ari Vale", email: "ari@agentmail.to", company: "Agent Ready Test Co", role: "developer", country: "US" } });
    assert.match(p, /ari@agentmail.to/);
    assert.match(p, /NEEDS_HUMAN.md/);
    assert.doesNotMatch(p, /STRIPE_API_KEY is in the environment/);
  });
});

describe("acquired credential survives until the evaluator reads it", () => {
  it("scrubWorkDir leaves CREDENTIAL.env alone but scrubs everything else", async () => {
    const fs = await import("node:fs");
    const os = await import("node:os");
    const path = await import("node:path");
    const { execute } = await import("../src/harness/execute.js");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ar-scrub-"));
    fs.writeFileSync(path.join(dir, "CREDENTIAL.env"), "MOLTBOOK_API_KEY=moltbook_abcdefgh12345\n");
    fs.writeFileSync(path.join(dir, "notes.md"), "key is moltbook_abcdefgh12345\n");
    const creds = resolveCredentials(task, {});
    const fakeExecutor = { name: "fake", run: async () => ({ executor: { name: "fake" }, startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), exitCode: 0, stoppedBecause: "success", turns: 0, costUsd: 0, stderr: null, rawTrace: null }) };
    const { EXECUTORS } = await import("../src/harness/execute.js");
    EXECUTORS.fake = fakeExecutor;
    await execute({ task: { ...task, credentialEnvName: "MOLTBOOK_API_KEY", instructions: task.instructions }, runId: "r1", doc, workDir: dir, credentials: creds, mode: "signup", executorName: "fake" });
    assert.match(fs.readFileSync(path.join(dir, "CREDENTIAL.env"), "utf8"), /moltbook_abcdefgh12345/);
    assert.doesNotMatch(fs.readFileSync(path.join(dir, "notes.md"), "utf8"), /abcdefgh12345/);
    assert.doesNotMatch(fs.readFileSync(path.join(dir, "execution.json"), "utf8"), /abcdefgh12345/);
  });

  it("scrubWorkDir steps over a dangling symlink headless Chrome left in .tools", async () => {
    const fs = await import("node:fs");
    const os = await import("node:os");
    const path = await import("node:path");
    const { execute, EXECUTORS } = await import("../src/harness/execute.js");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ar-scrub-"));
    const profile = path.join(dir, ".tools", "chrome-profile");
    fs.mkdirSync(profile, { recursive: true });
    fs.symlinkSync("some-host-12345-67890", path.join(profile, "SingletonCookie"));
    fs.writeFileSync(path.join(profile, "Preferences"), "key is moltbook_abcdefgh12345\n");
    const creds = resolveCredentials(task, {});
    EXECUTORS.fake = { name: "fake", run: async () => ({ executor: { name: "fake" }, startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), exitCode: 0, stoppedBecause: "success", turns: 0, costUsd: 0, stderr: null, rawTrace: null }) };
    await execute({ task: { ...task, credentialEnvName: "MOLTBOOK_API_KEY", instructions: task.instructions }, runId: "r1", doc, workDir: dir, credentials: creds, mode: "signup", executorName: "fake" });
    assert.equal(fs.readlinkSync(path.join(profile, "SingletonCookie")), "some-host-12345-67890");
    assert.doesNotMatch(fs.readFileSync(path.join(profile, "Preferences"), "utf8"), /abcdefgh12345/);
  });
});

// Each case here is the shape of a leak or a corruption found in the traces of real 0.4.10 runs; the values are invented.
describe("redaction, from real runs", () => {
  it("learns a key printed as a Python dict, in single quotes (Composio's user_api_key)", () => {
    const line = "{'org_id': 'ok_abc', 'api_key': '<redacted>', 'user_api_key': 'uak_Q7v3nX2pL9mR4tY8wZ1aB5cD6eF0gH2jK4lM7nP9qR'}";
    assert.ok(secretsInText(line).includes("uak_Q7v3nX2pL9mR4tY8wZ1aB5cD6eF0gH2jK4lM7nP9qR"));
    const creds = resolveCredentials({ credentials: [] }, {});
    for (const v of secretsInText(line)) creds.learn(v);
    assert.equal(creds.redact(line), "{'org_id': 'ok_abc', 'api_key': '<redacted>', 'user_api_key': '<redacted>'}");
  });

  it("redacts a Firecrawl key shown in page text, and leaves fc- inside a UUID alone", () => {
    const { redact } = resolveCredentials({ credentials: [] }, {});
    assert.equal(redact("Default\nfc-0a1b2c3d4e5f60718293a4b5c6d7e8f9\nCreated on"), "Default\nfc-…redacted\nCreated on");
    // The same key as trace.jsonl carries it, after a literal \n.
    assert.equal(redact(String.raw`{"content":"Default\nfc-0a1b2c3d4e5f60718293a4b5c6d7e8f9\nCreated on"}`), String.raw`{"content":"Default\nfc-…redacted\nCreated on"}`);
    assert.equal(redact('"uuid":"280bbded-8cfc-4cb5-9c34-e17fae410179"'), '"uuid":"280bbded-8cfc-4cb5-9c34-e17fae410179"');
  });

  it("redacts the sandbox proxy's credential from an environment dump", () => {
    const dump = "no_proxy=localhost\nHTTP_PROXY=http://srt.dG9vbHVfMDFDQlY4invented0123456789ABCDEF:a1b2c3d4\nGRPC_PROXY=http://srt.dG9vbHVfMDFDQlY4invented0123456789ABCDEF:a1b2c3d4\n";
    assert.deepEqual(secretsInText(dump), ["srt.dG9vbHVfMDFDQlY4invented0123456789ABCDEF:a1b2c3d4"]);
    const { redact, learn } = resolveCredentials({ credentials: [] }, {});
    assert.equal(redact(dump), "no_proxy=localhost\nHTTP_PROXY=http://<redacted>\nGRPC_PROXY=http://<redacted>\n");
    for (const v of secretsInText(dump)) learn(v);
    assert.equal(redact("curl -x http://srt.dG9vbHVfMDFDQlY4invented0123456789ABCDEF:a1b2c3d4 https://x.dev"), "curl -x http://<redacted> https://x.dev");
  });

  it("learns a token claim from a decoded JWT (MotherDuck's pat)", () => {
    const claims = String.raw`{"content":"{\n \"email\": \"agent-1@agent.example.com\",\n \"pat\": \"mdp_8f3kL0qW9xZ2vN4bT6yH1cJ5mR7sA0dF2gK4\",\n \"iss\": \"md_pat\"\n}"}`;
    assert.deepEqual(secretsInText(claims), ["mdp_8f3kL0qW9xZ2vN4bT6yH1cJ5mR7sA0dF2gK4"]);
  });

  it("learns a JSON-escaped URL in its plain form too", () => {
    const line = String.raw`{"claim_url":"https:\/\/dash.example.dev\/claim\/k9Lm2nQ4rS6tV8w"}`;
    assert.deepEqual(secretsInText(line).sort(), [String.raw`https:\/\/dash.example.dev\/claim\/k9Lm2nQ4rS6tV8w`, "https://dash.example.dev/claim/k9Lm2nQ4rS6tV8w"].sort());
  });

  it("a learned mail code is not replaced inside a longer number, and a JSON line stays JSON", () => {
    const { redact, learn } = resolveCredentials({ credentials: [] }, {});
    learn("000000");
    learn("837777");
    const line = JSON.stringify({ type: "result", modelUsage: { contextWindow: 1000000, estimated_tokens: 837777 }, result: "Your code is 837777; sent 000000 times" });
    const out = redact(line);
    const parsed = JSON.parse(out);
    assert.equal(parsed.modelUsage.contextWindow, 1000000);
    assert.equal(parsed.modelUsage.estimated_tokens, 837777, "a whole JSON number is left alone rather than breaking the line");
    assert.equal(parsed.result, "Your code is <redacted>; sent <redacted> times");
    assert.equal(redact("Your code: 837777."), "Your code: <redacted>.");
    // A key is still replaced wherever it stands, including after a literal \n in a JSON-encoded line.
    learn("ak_Zx9Qw8Er7Ty6Ui5Op4As3Df");
    assert.equal(redact(String.raw`{"stdout":"key\nak_Zx9Qw8Er7Ty6Ui5Op4As3Df\n"}`), String.raw`{"stdout":"key\n<redacted>\n"}`);
  });

  it("does not learn a plain word from a field called key (Turso's pricing rows)", () => {
    const pricing = '{"rows":[{"key":"databases","label":"Databases"},{"key":"developer","name":"Developer"}]}';
    const { redact, learn } = resolveCredentials({ credentials: [] }, {});
    for (const v of secretsInText(pricing)) learn(v);
    learn("<redacted>");
    assert.equal(redact("Free plan: 100 databases, 5 GB"), "Free plan: 100 databases, 5 GB");
  });

  it("learns the keys a CLI saved under .tools/home before scrubbing, so files the agent never printed are scrubbed too", async () => {
    const fs = await import("node:fs");
    const os = await import("node:os");
    const path = await import("node:path");
    const { execute, EXECUTORS } = await import("../src/harness/execute.js");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ar-scrub-"));
    const home = path.join(dir, ".tools", "home", ".acme");
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(path.join(home, "agent.json"), JSON.stringify({ composio: { api_key: "ak_saved0123456789abcdef", user_api_key: "uak_never0123456789printedABCDEF" }, agent_key: "acme_agent_Zx9Qw8Er7Ty6Ui5Op4As3Df" }));
    fs.writeFileSync(path.join(dir, ".tools", "provision-meta.json"), JSON.stringify({ merchant_token: "mt_Lk3Jh5Gf7Ds9Ap1Oi2Uy4Tr6Ew8", country: "US" }));
    fs.writeFileSync(path.join(dir, "notes.md"), "agent key acme_agent_Zx9Qw8Er7Ty6Ui5Op4As3Df; merchant mt_Lk3Jh5Gf7Ds9Ap1Oi2Uy4Tr6Ew8\n");
    fs.writeFileSync(path.join(dir, "CREDENTIAL.env"), "AGENT_READY_KEY=ak_saved0123456789abcdef\n");
    const creds = resolveCredentials(task, {});
    EXECUTORS.fake = { name: "fake", run: async () => ({ executor: { name: "fake" }, startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), exitCode: 0, stoppedBecause: "success", turns: 0, costUsd: 0, stderr: null, rawTrace: null }) };
    const summary = await execute({ task: { ...task, credentialEnvName: "AGENT_READY_KEY", instructions: task.instructions }, runId: "r1", doc, workDir: dir, credentials: creds, mode: "signup", executorName: "fake" });
    for (const f of [path.join(home, "agent.json"), path.join(dir, ".tools", "provision-meta.json"), path.join(dir, "notes.md")]) assert.doesNotMatch(fs.readFileSync(f, "utf8"), /never0123456789printed|Zx9Qw8Er7Ty6|Lk3Jh5Gf7Ds9|saved0123456789/, f);
    assert.match(fs.readFileSync(path.join(dir, ".tools", "provision-meta.json"), "utf8"), /"country":"US"/);
    assert.deepEqual(summary.credentials.scrubbedFiles.sort(), [".tools/home/.acme/agent.json", ".tools/provision-meta.json", "notes.md"]);
  });
});
