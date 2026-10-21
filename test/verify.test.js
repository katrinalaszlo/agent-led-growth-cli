import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseVerifySpec, checkKey, buildVerifyTask, classify, networkFor, KEY_ENV } from "../src/verify/index.js";
import { renderVerify } from "../src/verify/render.js";
import { makeStyle } from "../src/audit/render.js";
import { runHarness } from "../src/harness/index.js";
import { EXECUTORS } from "../src/harness/execute.js";
import { secretsInText, secretsInMail, resolveCredentials } from "../src/harness/secrets.js";
import { chmodSync, mkdirSync } from "node:fs";
import { argsFor, settingsFor, run as runClaudePrint } from "../src/harness/executors/claude-print.js";
import { readConfig, writeConfig } from "../src/audit/config.js";
import { latestAnswers } from "../src/verify/infer.js";

const CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "bin", "cli.js");
const GOOD = "ar_live_goodkey_123456";

// A product whose /v1/me answers only the good key, and an open endpoint that answers anyone.
function serve() {
  const server = createServer((req, res) => {
    const auth = req.headers.authorization || "";
    if (req.url === "/") {
      res.writeHead(200, { "content-type": "text/html" });
      return res.end("<html><head><title>Acme</title></head><body>Acme API</body></html>");
    }
    if (req.url === "/v1/me") {
      if (auth === `Bearer ${GOOD}`) {
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(JSON.stringify({ id: "acct_1", anonymous: false }));
      }
      res.writeHead(401, { "content-type": "application/json" });
      return res.end(JSON.stringify({ error: "unauthorized" }));
    }
    if (req.url === "/v1/open") {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ id: "anyone" }));
    }
    res.writeHead(404);
    res.end("not found");
  });
  return new Promise((r) => server.listen(0, "127.0.0.1", () => r({ server, base: `http://127.0.0.1:${server.address().port}` })));
}

// Stands in for Claude Code: writes what an agent would leave in its scratch directory.
function fakeAgent(files) {
  return {
    name: "fake-verify",
    run: async ({ workDir }) => {
      for (const [name, body] of Object.entries(files)) writeFileSync(join(workDir, name), body);
      const now = new Date().toISOString();
      return { executor: { name: "fake-verify" }, startedAt: now, finishedAt: now, exitCode: 0, stoppedBecause: "success", turns: 4, costUsd: 0.5, stderr: null, rawTrace: null };
    },
  };
}

const PLAN = "Use the REST API. Signup docs: https://acme.dev/docs/agents\n";

describe("verify: the declared call", () => {
  it("needs a GET with a full URL, a header with {key}, a 2xx expectation", () => {
    assert.match(parseVerifySpec({}).error, /no verify_call/);
    assert.match(parseVerifySpec({ verify_call: "PUT https://x.dev/v1/me" }).error, /must be "GET <full URL>" or "POST <full URL>"/);
    assert.equal(parseVerifySpec({ verify_call: "POST https://x.dev/v1/query", verify_body: '{"q":1}' }).method, "POST");
    assert.match(parseVerifySpec({ verify_call: "GET https://x.dev/{ACCOUNT_ID}", verify_fields: "account-id" }).error, /upper-case names/);
    assert.match(parseVerifySpec({ verify_call: "GET https://x.dev/me", verify_exchange: "POST https://x.dev/token" }).error, /needs verify_exchange_token/);
    assert.match(parseVerifySpec({ verify_call: "GET https://x.dev/v1/me", verify_header: "X-Key" }).error, /verify_header must look like/);
    assert.match(parseVerifySpec({ verify_call: "GET https://x.dev/v1/me", verify_expect: "401" }).error, /2xx/);
    const spec = parseVerifySpec({ verify_call: "https://x.dev/v1/me", verify_assert: "anonymous=false" });
    assert.deepEqual(spec.header, { name: "Authorization", template: "Bearer {key}" });
    assert.deepEqual(spec.assert, { path: "anonymous", equals: "false" });
    assert.equal(spec.expect, 200);
  });

  it("adds the hosts listed in verify_hosts, and only host names", () => {
    const spec = parseVerifySpec({ verify_call: "GET https://api.cloudflare.com/client/v4/accounts/{ACCOUNT_ID}/workers/subdomain", verify_fields: "ACCOUNT_ID", verify_hosts: "workers.dev, registry.npmjs.org" });
    const hosts = networkFor("https://cloudflare.com/", spec);
    for (const h of ["api.cloudflare.com", "workers.dev", "registry.npmjs.org"]) assert.ok(hosts.includes(h), h);
    assert.match(parseVerifySpec({ verify_call: "GET https://x.dev/me", verify_hosts: "https://evil.dev/path" }).error, /host names/);
  });

  it("verify_cli opens a package registry by name so the agent can install the product's CLI", () => {
    const npm = parseVerifySpec({ verify_call: "GET https://api.vercel.com/v2/user", verify_cli: "npm" });
    assert.deepEqual(npm.cli, ["npm"]);
    assert.ok(networkFor("https://vercel.com/", npm).includes("registry.npmjs.org"));
    const both = networkFor("https://acme.dev/", parseVerifySpec({ verify_call: "GET https://api.acme.dev/me", verify_cli: "npm, pypi" }));
    for (const h of ["registry.npmjs.org", "pypi.org", "files.pythonhosted.org"]) assert.ok(both.includes(h), h);
    assert.match(parseVerifySpec({ verify_call: "GET https://x.dev/me", verify_cli: "brew" }).error, /verify_cli must be npm or pypi, not "brew"/);
  });

  it("lets the agent reach the product, its usual subdomains and the API host", () => {
    const hosts = networkFor("https://acme.dev/", { url: "https://api.acme-cloud.com/v1/me" });
    for (const h of ["acme.dev", "api.acme.dev", "docs.acme.dev", "api.acme-cloud.com"]) assert.ok(hosts.includes(h), h);
  });
});

// A Neon-shaped product: the agent's key is an assertion exchanged for an access token, and the check reads one
// project, named by an id the agent saved next to its key.
function serveExchange() {
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    const json = (status, value) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(value)); };
    if (req.url === "/" ) { res.writeHead(200, { "content-type": "text/html" }); return res.end("<html><head><title>Neonish</title></head></html>"); }
    if (req.url === "/oauth/token" && req.method === "POST") {
      const form = new URLSearchParams(body);
      return form.get("assertion") === "eyJ.good.assertion" ? json(200, { access_token: "tok_access_123456" }) : json(401, { error: "invalid_grant" });
    }
    if (req.url === "/v1/projects/prj_42/credentials") return req.headers.authorization === "Bearer tok_access_123456" ? json(200, { database_url: "postgresql://neondb_owner:npg_s3cretPassw0rd@ep-x.neon.tech/neondb" }) : json(401, { error: "unauthorized" });
    if (req.url === "/v1/query" && req.method === "POST") return req.headers["x-api-key"] === GOOD && JSON.parse(body || "{}").q === "quota" ? json(200, { isAnonymous: false }) : json(401, {});
    json(404, {});
  });
  return new Promise((r) => server.listen(0, "127.0.0.1", () => r({ server, base: `http://127.0.0.1:${server.address().port}` })));
}

describe("verify: checks with an exchange, saved fields or a POST", () => {
  let site;
  before(async () => { site = await serveExchange(); });
  after(() => site.server.close());
  const neon = () => parseVerifySpec({
    verify_call: `GET ${site.base}/v1/projects/{PROJECT_ID}/credentials`,
    verify_fields: "PROJECT_ID",
    verify_exchange: `POST ${site.base}/oauth/token`,
    verify_exchange_body: "grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion={key}",
    verify_exchange_token: "access_token",
    verify_assert: "database_url",
  });

  it("exchanges the key for a token, fills the saved project id, and refuses no key and a wrong key", async () => {
    const r = await checkKey(neon(), "eyJ.good.assertion", { fields: { PROJECT_ID: "prj_42" } });
    assert.equal(r.ok, true, r.detail);
    assert.match(r.objects.checks[2].detail, /exchange .* → 401/);
    assert.match(r.objects.checks[0].detail, /database_url present/);
    assert.doesNotMatch(JSON.stringify(r), /npg_s3cretPassw0rd/);
  });

  it("a missing saved field is a clear failure, not a confusing 404", async () => {
    const r = await checkKey(neon(), "eyJ.good.assertion", { fields: {} });
    assert.equal(r.ok, false);
    assert.match(r.detail, /did not save PROJECT_ID/);
  });

  it("asks the agent to save the fields the check needs", () => {
    const { task } = buildVerifyTask({ url: `${site.base}/`, task: "Sign up", spec: neon() });
    assert.ok(task.instructions.signup.some((line) => /AGENT_READY_KEY=<value> and PROJECT_ID=<value>/.test(line)));
  });

  it("a POST check sends its body with the key in the declared header", async () => {
    const spec = parseVerifySpec({ verify_call: `POST ${site.base}/v1/query`, verify_body: '{"q":"quota"}', verify_header: "X-Api-Key: {key}", verify_assert: "isAnonymous=false" });
    const r = await checkKey(spec, GOOD);
    assert.equal(r.ok, true, r.detail);
  });
});

describe("verify: the checker", () => {
  let site;
  before(async () => { site = await serve(); });
  after(() => site.server.close());

  it("passes only when the key works and no key and a wrong key are both refused", async () => {
    const spec = parseVerifySpec({ verify_call: `GET ${site.base}/v1/me`, verify_assert: "anonymous=false" });
    const good = await checkKey(spec, GOOD);
    assert.equal(good.ok, true, good.detail);
    assert.deepEqual(good.objects.checks.map((c) => c.pass), [true, true, true]);
    const bad = await checkKey(spec, "ar_live_notthekey_99999");
    assert.equal(bad.ok, false);
    assert.equal(bad.objects.checks[0].pass, false);
  });

  it("an agent that could not connect at all is inconclusive, not a failure of the product", () => {
    const result = { evaluation: { success: false, stoppedAt: "not_acquired" }, execution: { stoppedBecause: "success", signals: { connectionFailures: 3 } } };
    const verdict = classify(result, "try_then_claim");
    assert.equal(verdict.outcome, "inconclusive");
    assert.match(verdict.reason, /could not connect/);
  });

  it("an agent stopped at the spending cap is inconclusive and says how to raise it", () => {
    const result = { evaluation: { success: false, stoppedAt: "not_acquired" }, execution: { stoppedBecause: "error_max_budget_usd", executor: { maxBudgetUsd: 2 } } };
    const verdict = classify(result, "try_then_claim");
    assert.equal(verdict.outcome, "inconclusive");
    assert.equal(verdict.exitCode, 3);
    assert.match(verdict.reason, /spending cap \(\$2\).*--max-budget-usd/);
  });

  it("a 400 for a missing key counts as refused, as Cloudflare answers it", async () => {
    const fake = async (url, init) => ({ status: init.headers.Authorization === `Bearer ${GOOD}` ? 200 : init.headers.Authorization ? 401 : 400, text: async () => "{}" });
    const r = await checkKey(parseVerifySpec({ verify_call: "GET https://api.cloudflare.com/client/v4/user" }), GOOD, { fetchImpl: fake });
    assert.equal(r.ok, true, r.detail);
  });

  it("a server error the agent reports, with no key, is inconclusive and says it is the agent's report", () => {
    const result = { evaluation: { success: false, stoppedAt: "not_acquired" }, execution: { stoppedBecause: "success", signals: {} } };
    const v = classify(result, "limited_until_claimed", "**HTTP Status**: 500 (Server Error)\nSorry, we encountered an error");
    assert.equal(v.outcome, "inconclusive");
    assert.match(v.reason, /agent reports server errors/);
    assert.equal(classify(result, "limited_until_claimed", "Read the docs; 500 requests per minute allowed.").outcome, "failed");
  });

  it("an endpoint that answers without a key proves nothing, and says so", async () => {
    const spec = parseVerifySpec({ verify_call: `GET ${site.base}/v1/open` });
    const r = await checkKey(spec, GOOD);
    assert.equal(r.ok, false);
    assert.equal(r.objects.checkerInvalid, true);
    assert.equal(classify({ evaluation: { success: false, objects: r.objects } }, "try_then_claim").exitCode, 3);
  });
});

describe("verify: a run end to end with a stand-in agent", () => {
  let site;
  before(async () => { site = await serve(); });
  after(() => {
    site.server.close();
    delete EXECUTORS["fake-verify"];
  });

  async function run(files, onboarding = "try_then_claim") {
    EXECUTORS["fake-verify"] = fakeAgent(files);
    const spec = parseVerifySpec({ verify_call: `GET ${site.base}/v1/me`, verify_assert: "id" });
    const out = mkdtempSync(join(tmpdir(), "verify-run-"));
    const result = await runHarness({ taskModule: buildVerifyTask({ url: `${site.base}/`, task: "Sign up and make one read", spec }), runId: "run_v", outDir: out, version: "test", mode: "signup", noInbox: true, executorName: "fake-verify", maxTurns: 5 });
    return { result, verdict: classify(result, onboarding), out };
  }

  it("a key the agent wrote that passes all three calls is a pass, and the key is scrubbed from disk", async () => {
    const { verdict, out } = await run({ "PLAN.md": PLAN, "CREDENTIAL.env": `${KEY_ENV}=${GOOD}\n`, "RESULT.md": "GET /v1/me 200\n" });
    assert.equal(verdict.outcome, "passed", verdict.reason);
    assert.doesNotMatch(readFileSync(join(out, "work", "CREDENTIAL.env"), "utf8"), new RegExp(GOOD));
  });

  it("a key the API rejects is a fail pointing at access", async () => {
    const { verdict } = await run({ "PLAN.md": PLAN, "CREDENTIAL.env": `${KEY_ENV}=ar_live_madeup_000000\n` });
    assert.equal(verdict.outcome, "failed");
    assert.match(verdict.reason, /checker's calls did not pass/);
  });

  it("stopping at a human step fails, unless the onboarding model says a person sets access up first", async () => {
    const files = { "PLAN.md": PLAN, "NEEDS_HUMAN.md": "# Needs a human\nCAPTCHA at https://acme.dev/signup\n" };
    const failed = (await run(files, "try_then_claim")).verdict;
    assert.equal(failed.outcome, "failed");
    // The agent's NEEDS_HUMAN.md is its own reading of the page; the run proved only that no key came back.
    assert.equal(failed.reason, "The agent did not get a key: rejected; cause unknown. Its notes (NEEDS_HUMAN.md) say it stopped at a step for a person; the run did not confirm that.");
    assert.equal((await run(files, "existing_account")).verdict.outcome, "handoff");
  });
});

describe("verify: what the agent inherits and what stays on disk", () => {
  let site;
  before(async () => { site = await serve(); });
  after(() => {
    site.server.close();
  });

  it("the agent runs without the operator's MCP servers, hooks, plugins or CLAUDE.md", () => {
    const args = argsFor({ prompt: "p", maxTurns: 5, settingsPath: "/tmp/s.json", tools: ["Bash"] });
    assert.ok(args.includes("--strict-mcp-config"));
    assert.equal(args[args.indexOf("--setting-sources") + 1], "project,local");
    assert.ok(!args.includes("--max-budget-usd"));
    const capped = argsFor({ prompt: "p", maxTurns: 5, settingsPath: "/tmp/s.json", tools: ["Bash"], maxBudgetUsd: 2 });
    assert.equal(capped[capped.indexOf("--max-budget-usd") + 1], "2");
  });

  it("opens localhost to the agent only when the product itself is local", () => {
    assert.equal(settingsFor({ network: ["acme.dev", "api.acme.dev"], tools: ["Bash"] }).sandbox.network.allowLocalBinding, undefined);
    assert.equal(settingsFor({ network: networkFor("http://localhost:4321/", { url: "http://localhost:4321/v1/me" }), tools: ["Bash"] }).sandbox.network.allowLocalBinding, true);
  });

  it("the agent's commands may carry only the test identity's email, enforced by a hook", () => {
    const guard = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "harness", "executors", "identity-guard.mjs");
    const run = (command, allowed) => spawnSync(process.execPath, [guard, ...allowed], { input: JSON.stringify({ tool_input: { command } }), encoding: "utf8" });
    const real = run('curl -d \'{"human_email":"someone.real@gmail.com"}\' https://inkbox.ai/api/v1/agent-signup/', ["ari@agentmail.to"]);
    assert.equal(real.status, 2);
    assert.match(real.stderr, /uses someone\.real@gmail\.com, which is not this run's test identity/);
    assert.equal(run('curl -d \'{"email":"ari@agentmail.to","hint":"you@example.com"}\' https://x.dev', ["ari@agentmail.to"]).status, 0);
    assert.equal(run("curl https://x.dev -d email=anyone@company.dev", []).status, 2, "with no inbox, no address at all");
    // A script written with the address, then run with a command that has none, is caught when it is written.
    const write = (file_path, content) => spawnSync(process.execPath, [guard, "ari@agentmail.to"], { input: JSON.stringify({ tool_input: { file_path, content } }), encoding: "utf8" });
    assert.equal(write("/run/work/signup.py", 'payload = {"email": "someone.real@gmail.com"}').status, 2);
    assert.equal(write("/run/work/RESULT.md", "Support: support@inkbox.ai").status, 0, "the agent's notes may quote a product's address");
    const hook = settingsFor({ network: ["acme.dev"], tools: ["Bash"], allowedEmails: ["ari@agentmail.to"] }).hooks.PreToolUse[0];
    assert.equal(hook.matcher, "Bash|WebFetch|Write|Edit|MultiEdit");
    assert.match(hook.hooks[0].command, /identity-guard\.mjs" "ari@agentmail\.to"$/);
  });

  it("finds claim codes and one-time links in mail", () => {
    const cosmic = 'Your one-time claim code is 837777 (expires in 15 minutes). Paste this code back to the agent, or visit https://u6979756.ct.sendgrid.net/ls/click?upn=u001.cJWr-2FR-2FBTopcTpj7ZZUDozDf9tDhksc052zjhdPAWyhSE to claim it.';
    const found = secretsInMail(cosmic);
    assert.ok(found.includes("837777"), found.join(", "));
    assert.ok(found.some((v) => v.startsWith("https://u6979756.ct.sendgrid.net/")));
    assert.deepEqual(secretsInMail("Welcome to Acme. Questions? See https://acme.dev/docs"), []);
  });

  it("finds one-time tokens in links, not short page numbers", () => {
    assert.deepEqual(secretsInText("Sign in: https://portal.telnyx.com/#/login?portal_redirect_token=01a10ce9-306e-7bd8&next=1"), ["01a10ce9-306e-7bd8"]);
    assert.deepEqual(secretsInText("https://example.com/docs?page=2&code=abc"), []);
    assert.deepEqual(secretsInText("Claim URL: https://dash.cloudflare.com/claim-preview?claimToken=7pnQXexampleexampleAAAA"), ["7pnQXexampleexampleAAAA"]);
  });

  it("scrubs sign-in links from the emails in inbox/ after the run", async () => {
    const link = "https://portal.example.dev/login?token=onetime0123456789abcdef";
    EXECUTORS["fake-mail"] = {
      name: "fake-mail",
      run: async ({ workDir }) => {
        writeFileSync(join(workDir, "PLAN.md"), PLAN);
        writeFileSync(join(workDir, "inbox", "0001.json"), JSON.stringify({ from: "noreply@example.dev", subject: "Sign in", text: `Click ${link}` }));
        const now = new Date().toISOString();
        return { executor: { name: "fake-mail" }, startedAt: now, finishedAt: now, exitCode: 0, stoppedBecause: "success", turns: 2, costUsd: 0.01, stderr: null, rawTrace: null };
      },
    };
    try {
      const spec = parseVerifySpec({ verify_call: `GET ${site.base}/v1/me` });
      const out = mkdtempSync(join(tmpdir(), "verify-mail-"));
      await runHarness({ taskModule: buildVerifyTask({ url: `${site.base}/`, task: "Sign up", spec }), runId: "run_m", outDir: out, version: "test", mode: "signup", noInbox: true, executorName: "fake-mail", maxTurns: 2 });
      const mail = readFileSync(join(out, "work", "inbox", "0001.json"), "utf8");
      assert.doesNotMatch(mail, /onetime0123456789abcdef/);
      assert.match(mail, /noreply@example\.dev/);
    } finally {
      delete EXECUTORS["fake-mail"];
    }
  });

  it("CLI installs and logins stay in the run folder, and a saved login is scrubbed", async () => {
    let env = null;
    EXECUTORS["fake-cli"] = {
      name: "fake-cli",
      run: async ({ workDir, childEnv }) => {
        env = childEnv;
        writeFileSync(join(workDir, "PLAN.md"), PLAN);
        writeFileSync(join(workDir, "CREDENTIAL.env"), `AGENT_READY_KEY=${GOOD}\n`);
        mkdirSync(join(workDir, ".tools", "home", ".acme"), { recursive: true });
        writeFileSync(join(workDir, ".tools", "home", ".acme", "config.json"), JSON.stringify({ api_key: GOOD }));
        const now = new Date().toISOString();
        return { executor: { name: "fake-cli" }, startedAt: now, finishedAt: now, exitCode: 0, stoppedBecause: "success", turns: 2, costUsd: 0.01, stderr: null, rawTrace: null };
      },
    };
    try {
      const spec = parseVerifySpec({ verify_call: `GET ${site.base}/v1/me`, verify_cli: "npm" });
      const out = mkdtempSync(join(tmpdir(), "verify-cli-tools-"));
      await runHarness({ taskModule: buildVerifyTask({ url: `${site.base}/`, task: "Sign up", spec }), runId: "run_c", outDir: out, version: "test", mode: "signup", noInbox: true, executorName: "fake-cli", maxTurns: 2 });
      const work = join(out, "work");
      assert.equal(env.NODE_USE_ENV_PROXY, "1");
      assert.equal(env.npm_config_prefix, join(work, ".tools", "npm-global"));
      assert.ok(env.PATH.startsWith(join(work, ".tools", "npm-global", "bin")));
      assert.doesNotMatch(readFileSync(join(work, ".tools", "home", ".acme", "config.json"), "utf8"), new RegExp(GOOD));
      assert.match(readFileSync(join(work, "prompt.md"), "utf8"), /HOME="\$PWD\/\.tools\/home"/);
    } finally {
      delete EXECUTORS["fake-cli"];
    }
  });

  it("finds secrets a product returned, by field name, in plain or escaped JSON", () => {
    assert.deepEqual(secretsInText('{"key":"ark_ws1_s3cretvalue","claimCode":"clm_ws1_alsosecret","claimed":false}').sort(), ["ark_ws1_s3cretvalue", "clm_ws1_alsosecret"]);
    assert.deepEqual(secretsInText(String.raw`{"content":"{\n  \"key\": \"ark_ws1_s3cretvalue\"}"}`), ["ark_ws1_s3cretvalue"]);
  });

  it("finds and redacts the password in a connection string, whatever the field is called", () => {
    const line = '{"database_url":"postgresql://neondb_owner:npg_s3cretPassw0rd@ep-x.neon.tech/neondb"}';
    assert.deepEqual(secretsInText(line), ["npg_s3cretPassw0rd"]);
    const { redact } = resolveCredentials({ credentials: [] }, {});
    assert.equal(redact("postgres://app:hunter2hunter@db.internal:5432/x"), "postgres://app:<redacted>@db.internal:5432/x");
    assert.doesNotMatch(redact(line), /s3cretPassw0rd/);
    assert.deepEqual(secretsInText("see https://docs.neon.tech/guides and mailto:a@b.dev"), []);
  });

  // The real executor, with a stand-in claude binary on PATH. The signup body sits after long headers, as curl -i
  // printed it in the second real run, so it falls past the 400 characters the event log keeps.
  it("scrubs a key and claim code from the raw trace even when the agent never wrote CREDENTIAL.env", async () => {
    const bin = mkdtempSync(join(tmpdir(), "fake-claude-"));
    const body = '{"workspace":"ws9","key":"ark_ws9_fullsecretkey123","claimCode":"clm_ws9_fullclaimcode456"}';
    const headers = Array.from({ length: 20 }, (_, i) => `x-header-${i}: ${"v".repeat(30)}`).join("\r\n");
    const lines = [
      { type: "system", subtype: "init", mcp_servers: [] },
      { type: "user", message: { content: [{ type: "tool_result", content: `HTTP/2 201\r\n${headers}\r\n\r\n${body}` }] } },
    ];
    const script = `#!/usr/bin/env node\nfor (const l of ${JSON.stringify(lines.map((l) => JSON.stringify(l)))}) console.log(l);\nprocess.exit(143);\n`;
    writeFileSync(join(bin, "claude"), script);
    chmodSync(join(bin, "claude"), 0o755);
    const path = process.env.PATH;
    process.env.PATH = `${bin}:${path}`;
    try {
      const spec = parseVerifySpec({ verify_call: `GET ${site.base}/v1/me` });
      const out = mkdtempSync(join(tmpdir(), "verify-leak-"));
      const result = await runHarness({ taskModule: buildVerifyTask({ url: `${site.base}/`, task: "Sign up", spec }), runId: "run_l", outDir: out, version: "test", mode: "signup", noInbox: true, executorName: "claude-print", maxTurns: 5 });
      for (const file of ["trace.jsonl", "execution.json"]) assert.doesNotMatch(readFileSync(join(out, "work", file), "utf8"), /fullsecretkey123|fullclaimcode456/, file);
      // Stopped mid-run: not a result about the product.
      assert.equal(classify(result, "try_then_claim").outcome, "inconclusive");
    } finally {
      process.env.PATH = path;
    }
  });
});

describe("verify: an agent that goes silent", () => {
  it("is stopped after the idle window and reported as stalled, not left to the 30-minute limit", async () => {
    const bin = mkdtempSync(join(tmpdir(), "fake-claude-"));
    writeFileSync(join(bin, "claude"), `#!/usr/bin/env node\nconsole.log(JSON.stringify({ type: "system", subtype: "init" }));\nsetTimeout(() => {}, 60000);\n`);
    chmodSync(join(bin, "claude"), 0o755);
    const workDir = mkdtempSync(join(tmpdir(), "stall-"));
    const started = Date.now();
    const r = await runClaudePrint({ prompt: "p", workDir, childEnv: { ...process.env, PATH: `${bin}:${process.env.PATH}` }, tools: ["Bash"], network: ["acme.dev"], maxTurns: 2, redact: (t) => t, onEvent: () => {}, idleMs: 500 });
    assert.equal(r.stoppedBecause, "stalled");
    assert.ok(Date.now() - started < 10000);
    assert.equal(classify({ evaluation: {}, execution: { stoppedBecause: r.stoppedBecause } }, "try_then_claim").outcome, "inconclusive");
  });
});

describe("verify: output", () => {
  it("every line fits 80 columns, even with a long check URL", () => {
    const long = "GET https://api.some-very-long-product-name.example.com/v1/organizations/current/members/me → 200; id = \"acct_123\"";
    const result = { evaluation: { checks: [{ id: "credential_acquired", pass: true }], objects: { checks: [{ label: "Key works", pass: true, detail: long }, { label: "No key refused", pass: true, detail: "without a key → 401" }] } }, execution: { turns: 9, costUsd: 0.2 } };
    const lines = renderVerify({ host: "example.com", task: "Sign up", result, verdict: { outcome: "passed", reason: "ok" }, folder: ".agent-ready/x", promptFile: null }, makeStyle(false));
    for (const line of lines) assert.ok([...line].length <= 80, line);
    assert.ok(lines.some((l) => l.includes("members/me")));
  });

  it("after a pass it says how to keep it passing; after a fail it says to deploy, check and test again", () => {
    const result = { evaluation: { checks: [{ id: "credential_acquired", pass: true }], objects: { checks: [{ label: "Key works", pass: true, detail: "200" }] } }, execution: { turns: 9, costUsd: 0.2 } };
    const style = makeStyle(false);
    const passed = renderVerify({ host: "example.com", task: "Sign up", result, verdict: { outcome: "passed", reason: "ok" }, folder: ".agent-ready/x", promptFile: null }, style);
    assert.match(passed.join("\n"), /Keep it passing: hosted runs, on a schedule with an email when this test\s+breaks, are coming\. Join the waitlist at tansohq\.com\./);
    const failed = renderVerify({ host: "example.com", task: "Sign up", result, verdict: { outcome: "failed", reason: "no" }, folder: ".agent-ready/x", promptFile: "prompts/01-signup.md" }, style);
    assert.match(failed.join("\n"), /then deploy, run npx @tansohq\/agent-ready check example\.com again,\n {8}and test again/);
    assert.doesNotMatch(failed.join("\n"), /Keep it passing/);
    for (const line of [...passed, ...failed]) assert.ok([...line].length <= 80, line);
  });
});

describe("verify: command", () => {
  const runCli = (args, cwd) => spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: "utf8", env: { ...process.env, NO_COLOR: "1" } });

  it("without agent-ready.yml it exits 2 and says to run check first", () => {
    const r = runCli(["verify"], mkdtempSync(join(tmpdir(), "verify-cli-")));
    assert.equal(r.status, 2);
    assert.match(r.stderr, /Name the product, as in "agent-ready test example\.com", or run "agent-ready check <url> --yes" first/);
  });

  // agent-ready.yml for neon.com, with a verify_call: naming another product must never send its key there.
  it("test <product> does not use an agent-ready.yml for another product, and leaves it unchanged", () => {
    const { cwd, env } = checkIn(fakeClaude(true));
    const before = readFileSync(join(cwd, "agent-ready.yml"), "utf8");
    const r = spawnSync(process.execPath, [CLI, "test", "127.0.0.1:9", "--check"], { cwd, encoding: "utf8", env });
    assert.equal(r.status, 2, r.stderr);
    assert.match(r.stderr, /Not using agent-ready\.yml: it is for neon\.com\./);
    assert.match(r.stderr, /No verify_call for 127\.0\.0\.1:9, and none could be taken from the product's docs/);
    assert.match(r.stderr, /Run "agent-ready check 127\.0\.0\.1:9" in a folder of its own/);
    assert.doesNotMatch(r.stderr, /claimable\.neon\.tech/);
    assert.equal(readFileSync(join(cwd, "agent-ready.yml"), "utf8"), before);
    const json = spawnSync(process.execPath, [CLI, "test", "127.0.0.1:9", "--check", "--json"], { cwd, encoding: "utf8", env });
    assert.equal(JSON.parse(json.stdout).error.code, "verify_call_invalid");
  });

  it("test <product> uses agent-ready.yml when it is for that product", () => {
    const { cwd, env } = checkIn(fakeClaude(true));
    const r = spawnSync(process.execPath, [CLI, "test", "neon.com", "--check", "--json"], { cwd, encoding: "utf8", env });
    assert.equal(r.status, 0, r.stderr);
    assert.ok(JSON.parse(r.stdout).agent.hosts.includes("claimable.neon.tech"));
  });

  it("test <product> with no agent-ready.yml looks for a call instead of stopping, and writes no file", () => {
    const cwd = mkdtempSync(join(tmpdir(), "verify-cli-"));
    const r = runCli(["test", "127.0.0.1:9", "--check", "--json"], cwd);
    assert.equal(r.status, 2);
    assert.equal(JSON.parse(r.stdout).error.code, "verify_call_invalid");
    assert.equal(existsSync(join(cwd, "agent-ready.yml")), false);
  });

  it("latestAnswers reads the task and answers of the product's latest check, or nothing", () => {
    const cwd = mkdtempSync(join(tmpdir(), "verify-cli-"));
    assert.deepEqual(latestAnswers(cwd, "https://acme.dev"), {});
    for (const [run, task] of [["2026-10-01T00-00-00-aaaaaa", "Old task"], ["2026-10-02T00-00-00-bbbbbb", "New task"]]) {
      mkdirSync(join(cwd, ".agent-ready", "acme.dev", run), { recursive: true });
      writeFileSync(join(cwd, ".agent-ready", "acme.dev", run, "audit-report.json"), JSON.stringify({ task, answers: { onboarding: { value: "agent_is_customer" }, abuse_cost: { value: "high" }, human_before: { value: "outbound" } } }));
    }
    assert.deepEqual(latestAnswers(cwd, "https://acme.dev"), { task: "New task", onboarding: "agent_is_customer", abuse_cost: "high", human_before: "outbound" });
  });

  // Nothing listens on port 9, so the inference finds no OpenAPI document without leaving this machine.
  it("without a verify_call it exits 2 with an example", () => {
    const cwd = mkdtempSync(join(tmpdir(), "verify-cli-"));
    writeConfig(join(cwd, "agent-ready.yml"), { url: "127.0.0.1:9", task: "Sign up", answers: { onboarding: { value: "try_then_claim" }, abuse_cost: { value: "low" }, human_before: { value: "never" } } });
    const r = runCli(["verify"], cwd);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /verify_call: GET https:\/\/api\.example\.com\/v1\/me/);
  });

  it("without Claude Code installed it says how to install it, exit 2", () => {
    const cwd = mkdtempSync(join(tmpdir(), "verify-cli-"));
    writeFileSync(join(cwd, "agent-ready.yml"), "url: acme.dev\ntask: Sign up\nonboarding: try_then_claim\nverify_call: GET https://api.acme.dev/v1/me\n");
    const r = spawnSync(process.execPath, [CLI, "verify", "--yes"], { cwd, encoding: "utf8", env: { ...process.env, NO_COLOR: "1", PATH: dirname(process.execPath) } });
    assert.equal(r.status, 2, r.stderr);
    assert.match(r.stderr, /claude command was not found/);
  });

  it("without a terminal it will not start an agent unless --yes is passed", () => {
    const cwd = mkdtempSync(join(tmpdir(), "verify-cli-"));
    writeFileSync(join(cwd, "agent-ready.yml"), "url: acme.dev\ntask: Sign up\nonboarding: try_then_claim\nverify_call: GET https://api.acme.dev/v1/me\n");
    const r = runCli(["verify"], cwd);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /Pass --yes/);
  });

  // A stand-in claude on PATH answers --version and auth status, so the check never depends on this machine.
  const fakeClaude = (loggedIn) => {
    const bin = mkdtempSync(join(tmpdir(), "fake-claude-"));
    writeFileSync(join(bin, "claude"), `#!/usr/bin/env node\nif (process.argv[2] === "--version") console.log("9.9.9 (Claude Code)");\nelse console.log(JSON.stringify({ loggedIn: ${loggedIn} }));\n`);
    chmodSync(join(bin, "claude"), 0o755);
    return bin;
  };
  const checkIn = (bin) => {
    const cwd = mkdtempSync(join(tmpdir(), "verify-cli-"));
    writeFileSync(join(cwd, "agent-ready.yml"), "url: neon.com\ntask: Sign up\nonboarding: try_then_claim\nverify_call: GET https://claimable.neon.tech/v1/projects/{PROJECT_ID}/credentials\nverify_fields: PROJECT_ID\nverify_exchange: POST https://claimable.neon.tech/v1/oauth2/token\nverify_exchange_body: assertion={key}\nverify_exchange_token: access_token\n");
    const env = { ...process.env, NO_COLOR: "1", PATH: `${bin}:${process.env.PATH}` };
    delete env.ANTHROPIC_API_KEY;
    return { cwd, env };
  };

  it("--check prints the plan and starts nothing", () => {
    const { cwd, env } = checkIn(fakeClaude(true));
    const r = spawnSync(process.execPath, [CLI, "verify", "--check", "--json"], { cwd, encoding: "utf8", env });
    assert.equal(r.status, 0, r.stderr);
    const plan = JSON.parse(r.stdout);
    assert.equal(plan.schema, "agent-ready/verify-plan@1");
    assert.equal(plan.claudeCode.detail, "Claude Code 9.9.9, signed in");
    assert.deepEqual(plan.agent.saves, ["AGENT_READY_KEY", "PROJECT_ID"]);
    assert.ok(plan.agent.hosts.includes("claimable.neon.tech"));
    assert.match(plan.checker.call, /oauth2\/token for a token/);
    assert.equal(plan.agent.maxBudgetUsd, 5);
    assert.equal(existsSync(join(cwd, ".agent-ready")), false);
  });

  it("--check warns when the chosen pattern needs an inbox and none is set, and stays ready", () => {
    const { cwd, env } = checkIn(fakeClaude(true));
    delete env.AGENTMAIL_API_KEY;
    const run = join(cwd, ".agent-ready", "neon.com", "2026-10-09T00-00-00-aaaaaa");
    mkdirSync(run, { recursive: true });
    writeFileSync(join(run, "interface.json"), JSON.stringify({ onboarding: { primary: "try_then_claim", patterns: [{ id: "try_then_claim", needs: ["inbox"] }] } }));
    const warning = "The product's docs mention an emailed code or link and no inbox is set. Set AGENTMAIL_API_KEY or pass --inbox, or the run may end inconclusive.";
    const json = spawnSync(process.execPath, [CLI, "test", "--check", "--json"], { cwd, encoding: "utf8", env });
    assert.equal(json.status, 0, json.stderr);
    const plan = JSON.parse(json.stdout);
    assert.equal(plan.ready, true);
    assert.deepEqual(plan.warnings, [warning]);
    const text = spawnSync(process.execPath, [CLI, "test", "--check"], { cwd, encoding: "utf8", env });
    assert.equal(text.status, 0);
    assert.match(text.stderr, /READY {2}Nothing ran\.[^\n]*\n {2}The product's docs mention an emailed code or link/);
    const relayed = spawnSync(process.execPath, [CLI, "test", "--check", "--json", "--inbox", "me@example.com"], { cwd, encoding: "utf8", env });
    assert.equal(JSON.parse(relayed.stdout).warnings, undefined);
  });

  it("--check and a real run both stop when Claude Code is signed out", () => {
    const { cwd, env } = checkIn(fakeClaude(false));
    const check = spawnSync(process.execPath, [CLI, "verify", "--check"], { cwd, encoding: "utf8", env });
    assert.equal(check.status, 2);
    assert.match(check.stderr, /NOT READY .*claude auth login/);
    const run = spawnSync(process.execPath, [CLI, "verify", "--yes", "--json"], { cwd, encoding: "utf8", env });
    assert.equal(run.status, 2);
    assert.equal(JSON.parse(run.stdout).error.code, "claude_code_signed_out");
  });

  it("keeps the exchange and field lines too when the answers are rewritten", () => {
    const cwd = mkdtempSync(join(tmpdir(), "verify-cli-"));
    const path = join(cwd, "agent-ready.yml");
    writeFileSync(path, "url: neon.com\ntask: Sign up\nonboarding: try_then_claim\nverify_call: GET https://claimable.neon.tech/v1/projects/{PROJECT_ID}/credentials\nverify_fields: PROJECT_ID\nverify_exchange: POST https://claimable.neon.tech/v1/oauth2/token\nverify_exchange_body: grant_type=x&assertion={key}\nverify_exchange_token: access_token\n");
    writeConfig(path, { url: "neon.com", task: "Sign up", answers: { onboarding: { value: "try_then_claim" }, abuse_cost: { value: "low" }, human_before: { value: "never" } } });
    const config = readConfig(path);
    assert.equal(config.verify_exchange_token, "access_token");
    assert.equal(config.verify_fields, "PROJECT_ID");
    assert.equal(config.verify_exchange_body, "grant_type=x&assertion={key}");
    writeFileSync(path, readFileSync(path, "utf8") + "verify_cli: npm\n");
    writeConfig(path, { url: "neon.com", task: "Sign up", answers: { onboarding: { value: "try_then_claim" }, abuse_cost: { value: "low" }, human_before: { value: "never" } } });
    assert.equal(readConfig(path).verify_cli, "npm");
  });

  it("re-answering the audit questions keeps the verify lines the user filled in", () => {
    const cwd = mkdtempSync(join(tmpdir(), "verify-cli-"));
    const path = join(cwd, "agent-ready.yml");
    writeFileSync(path, "url: acme.dev\ntask: Sign up\nonboarding: try_then_claim\nverify_call: GET https://api.acme.dev/v1/me\nverify_assert: id\n");
    writeConfig(path, { url: "acme.dev", task: "Sign up", answers: { onboarding: { value: "agent_is_customer" }, abuse_cost: { value: "low" }, human_before: { value: "never" } } });
    const config = readConfig(path);
    assert.equal(config.onboarding, "agent_is_customer");
    assert.equal(config.verify_call, "GET https://api.acme.dev/v1/me");
    assert.equal(config.verify_assert, "id");
  });

  it("re-answering for another host drops the old product's verify lines, so its key never goes there", () => {
    const cwd = mkdtempSync(join(tmpdir(), "verify-cli-"));
    const path = join(cwd, "agent-ready.yml");
    writeFileSync(path, "url: otherproduct.example\ntask: Sign up\nonboarding: try_then_claim\nverify_call: GET https://api.otherproduct.example/v1/me\nverify_header: Authorization: Bearer {key}\nverify_hosts: auth.otherproduct.example\n");
    const answers = { onboarding: { value: "agent_is_customer" }, abuse_cost: { value: "low" }, human_before: { value: "never" } };
    assert.deepEqual(writeConfig(path, { url: "acme.dev", task: "Sign up", answers }), { droppedVerifyFor: "otherproduct.example" });
    const config = readConfig(path);
    assert.equal(config.url, "acme.dev");
    assert.ok(!Object.keys(config).some((k) => k.startsWith("verify_")), JSON.stringify(config));
    assert.doesNotMatch(readFileSync(path, "utf8"), /otherproduct/);
    // The same host, written as a URL, keeps them.
    writeFileSync(path, "url: acme.dev\nverify_call: GET https://api.acme.dev/v1/me\n");
    assert.deepEqual(writeConfig(path, { url: "https://acme.dev", task: "Sign up", answers }), { droppedVerifyFor: null });
    assert.equal(readConfig(path).verify_call, "GET https://api.acme.dev/v1/me");
  });
});
