import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, existsSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { buildFunnel } from "../src/interface/funnel.js";
import { buildAudit, basisFor, renderBrief, inspect, parseTarget, productName } from "../src/audit/index.js";
import { defaultAnswers, askQuestions } from "../src/audit/questions.js";
import { PassThrough } from "node:stream";
import { renderPrompt } from "../src/audit/prompts.js";
import { readConfig, writeConfig } from "../src/audit/config.js";
import { patternInfo } from "../src/audit/index.js";
import { wrap, makeStyle, renderVerdict, renderSteps } from "../src/audit/render.js";
import { writeFakeAeoCli } from "./standards-fixtures.js";

const CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "bin", "cli.js");
const verdict = (v, reason = "because", basedOn = ["obs_1"]) => ({ verdict: v, reason, basedOn, rule: "r", method: "rule" });

function doc(overrides = {}) {
  return {
    target: { url: "https://acme.dev/", host: "acme.dev" },
    product: { name: { value: "Acme" } },
    observations: [{ id: "obs_1", role: "homepage", ok: true, status: 200, url: "https://acme.dev/" }],
    machineAccess: { aiCrawlersAllowed: verdict("yes"), hasAgentReadableIndex: verdict("yes", "/llms.txt with 3 links") },
    pricing: { agentCanDetermineCost: verdict("yes", "2 plan(s) with amounts in pricing.json"), ambiguities: [], plans: [{ id: "pro", amount: 20, evidence: [{ obs: "obs_1" }] }] },
    onboarding: { patterns: [] },
    authentication: { methods: [{ value: { type: "apiKey" } }], requirement: { value: "required", basedOn: [] } },
    capabilities: [{ name: "Create project", evidence: [{ obs: "obs_1" }] }],
    interfaces: { api: { exists: verdict("yes"), machineReadableSpec: verdict("yes") } },
    limits: ["GET requests only"],
    ...overrides,
  };
}

const answersFor = (funnel, over = {}) => ({ ...defaultAnswers(funnel), ...over });

describe("audit: findings and the onboarding model", () => {
  it("recommends try first, claim later when the docs describe no agent signup, and says it is a recommendation", () => {
    const none = buildFunnel(doc({ onboarding: { patterns: [] } }));
    assert.deepEqual(defaultAnswers(none).onboarding, { value: "try_then_claim", source: "recommended" });
  });

  it("keeps the documented pattern as the default when the docs describe one", () => {
    const d = doc({ onboarding: { patterns: [{ id: "try_then_claim", name: "Try first, claim later", status: "documented", humanBoundary: "After the first job.", needs: [], evidence: [{ obs: "obs_1" }] }] } });
    assert.deepEqual(defaultAnswers(buildFunnel(d)).onboarding, { value: "try_then_claim", source: "documented" });
  });

  it("makes one finding per step that needs a person or is blocked, ranked by severity label, never for manage", () => {
    const d = doc({ machineAccess: { aiCrawlersAllowed: verdict("no", "GPTBot is disallowed"), hasAgentReadableIndex: verdict("no") } });
    const funnel = buildFunnel(d);
    const audit = buildAudit({ doc: d, funnel, answers: answersFor(funnel), task: "t", runId: "run_1", version: "test" });
    const discover = audit.findings.find((f) => f.step === "discover");
    assert.equal(discover.severity, "high");
    assert.equal(discover.file, "01-discover.md");
    assert.ok(!audit.findings.some((f) => f.step === "manage"));
  });

  it("a person-first product gets a signup fix when the owner chooses an agent-first model, and none otherwise", () => {
    const d = doc({ onboarding: { patterns: [{ id: "existing_account", name: "Person sets up access first", status: "documented", needs: [], evidence: [{ obs: "obs_1" }] }] } });
    const funnel = buildFunnel(d);
    const personFirst = buildAudit({ doc: d, funnel, answers: answersFor(funnel), task: "t", runId: "r", version: "test" });
    assert.ok(!personFirst.findings.some((f) => f.step === "signup"));
    const tryFirst = buildAudit({ doc: d, funnel, answers: answersFor(funnel, { onboarding: { value: "try_then_claim", source: "asked" } }), task: "t", runId: "r", version: "test" });
    const signup = tryFirst.findings.find((f) => f.step === "signup");
    assert.equal(signup.severity, "medium");
    assert.match(signup.reason, /Your onboarding model is Try first, claim later/);
  });

  it("lists Use before Pay, because agents use a product before they pay for it", () => {
    const funnel = buildFunnel(doc());
    const ids = funnel.steps.map((s) => s.id);
    assert.ok(ids.indexOf("use") < ids.indexOf("pay"));
  });

  it("never reports a step as verified from public pages", () => {
    const d = doc();
    const funnel = buildFunnel(d);
    for (const s of funnel.steps) assert.notEqual(basisFor(s, d), "verified");
    assert.equal(basisFor(funnel.steps.find((s) => s.id === "manage"), d), "not_checked");
    assert.equal(basisFor(funnel.steps.find((s) => s.id === "discover"), d), "observed");
  });
});

describe("audit: fix prompts", () => {
  const finding = { n: 1, step: "signup", name: "Sign up", severity: "medium", reason: "No way for an agent to sign up is documented.", basedOn: ["obs_1"] };

  it("a try-first prompt carries endpoints, security and acceptance tests, and tells the agent to reuse the repo's code", () => {
    const body = renderPrompt({ finding, pattern: patternInfo("try_then_claim"), answers: { abuse_cost: { value: "low" }, human_before: { value: "never" } }, doc: doc(), product: "Acme", url: "https://acme.dev/" });
    assert.match(body, /POST \/v1\/agent\/signup/);
    assert.match(body, /Reuse its existing web framework, auth, API-key and billing code/);
    assert.match(body, /## Acceptance tests/);
    assert.match(body, /never trust a client-appended X-Forwarded-For/);
    assert.match(body, /Evidence: https:\/\/acme\.dev\//);
    assert.match(body, /## Check first\nThe check did not find an agent signup path/);
    assert.doesNotMatch(body, /proof-of-work challenge; signup requires/);
  });

  it("the owner's verified-person rule reaches every prompt, not only signup", () => {
    const pay = { n: 1, step: "pay", name: "Pay", severity: "medium", reason: "No agent purchase path.", basedOn: ["obs_1"] };
    const always = renderPrompt({ finding: pay, pattern: patternInfo("existing_account"), answers: { abuse_cost: { value: "low" }, human_before: { value: "always" } }, doc: doc(), product: "Acme", url: "https://acme.dev/" });
    assert.match(always, /A verified person must own the account before an agent can do anything with it/);
    const never = renderPrompt({ finding: pay, pattern: patternInfo("existing_account"), answers: { abuse_cost: { value: "low" }, human_before: { value: "never" } }, doc: doc(), product: "Acme", url: "https://acme.dev/" });
    assert.doesNotMatch(never, /verified person must own/);
    assert.match(never, /Fit them to the API's existing paths/);
  });

  it("a high abuse cost adds a proof-of-work challenge, never a CAPTCHA", () => {
    const body = renderPrompt({ finding, pattern: patternInfo("try_then_claim"), answers: { abuse_cost: { value: "high" }, human_before: { value: "never" } }, doc: doc(), product: "Acme", url: "https://acme.dev/" });
    assert.match(body, /proof-of-work challenge; signup requires its solution\. No CAPTCHA/);
  });

  it("a person-first product gets a device flow instead of agent signup", () => {
    const body = renderPrompt({ finding, pattern: patternInfo("existing_account"), answers: { abuse_cost: { value: "low" }, human_before: { value: "always" } }, doc: doc(), product: "Acme", url: "https://acme.dev/" });
    assert.match(body, /RFC 8628/);
    assert.doesNotMatch(body, /POST \/v1\/agent\/signup/);
  });
});

describe("audit: brief and config", () => {
  it("the brief flags a model that lets an agent act before a required verified person", () => {
    const d = doc();
    const funnel = buildFunnel(d);
    const answers = answersFor(funnel, { onboarding: { value: "try_then_claim", source: "asked" }, human_before: { value: "always", source: "asked" } });
    const brief = renderBrief(buildAudit({ doc: d, funnel, answers, task: "t", runId: "r", version: "test" }), d);
    assert.match(brief, /Conflict: a verified person must exist before any use/);
    assert.match(brief, /payment, KYC and claim decisions by a real person were not tested/);
  });

  it("agent-ready.yml round-trips the answers", () => {
    const dir = mkdtempSync(join(tmpdir(), "audit-config-"));
    const path = join(dir, "agent-ready.yml");
    writeConfig(path, { url: "acme.dev", task: "Sign up", answers: { onboarding: { value: "agent_is_customer" }, abuse_cost: { value: "high" }, human_before: { value: "outbound" } } });
    assert.deepEqual(readConfig(path), { url: "acme.dev", task: "Sign up", onboarding: "agent_is_customer", abuse_cost: "high", human_before: "outbound" });
  });

  it("the verdict is a tally of working steps, not a walk that stops at the first gap", () => {
    const d = doc({ machineAccess: { aiCrawlersAllowed: verdict("yes"), hasAgentReadableIndex: verdict("no") } });
    const funnel = buildFunnel(d);
    const audit = buildAudit({ doc: d, funnel, answers: answersFor(funnel), task: "t", runId: "r", version: "test" });
    const working = audit.steps.filter((s) => ["agent_can", "handoff", "agent_did"].includes(s.state)).length;
    const [first, second] = renderVerdict(audit, makeStyle(false));
    assert.equal(first, `  Your public pages document ${working} of 7 steps.`);
    assert.equal(second, "  No step has been tested yet: a test runs a real agent.");
    assert.equal(audit.documented, working);
    assert.equal(audit.verified, 0);
    assert.ok(working > 0, "a missing llms.txt does not zero the later steps");
  });

  it("the verdict says how many working steps rely on a person handing over access", () => {
    const d = doc({ onboarding: { patterns: [{ id: "existing_account", name: "Person sets up access first", status: "documented", needs: [], evidence: [{ obs: "obs_1" }] }] } });
    const funnel = buildFunnel(d);
    const audit = buildAudit({ doc: d, funnel, answers: answersFor(funnel), task: "t", runId: "r", version: "test" });
    const lines = renderVerdict(audit, makeStyle(false));
    assert.match(lines[2], /^  2 work because a person steps in once\./);
    // Unchecked steps are named the way the step tag names them.
    const unchecked = audit.steps.filter((x) => x.state === "not_checked").length;
    assert.ok(unchecked > 0);
    assert.match(lines.slice(1).map((l) => l.trim()).join(" "), new RegExp(`${unchecked} needs? a test run\\.`));
    assert.doesNotMatch(lines.join(" "), /agent run/);
    for (const line of lines) assert.ok([...line].length <= 80, line);
  });

  it("every step row fits 80 columns", () => {
    const d = doc();
    const funnel = buildFunnel(d);
    const audit = buildAudit({ doc: d, funnel, answers: answersFor(funnel), task: "t", runId: "r", version: "test" });
    for (const line of renderSteps(audit, makeStyle(false))) assert.ok([...line].length <= 80, line);
  });

  it("parses bare domains, local hosts and IPs, and rejects what is not an address", () => {
    assert.equal(parseTarget("acme.dev"), "https://acme.dev/");
    assert.equal(parseTarget("http://127.0.0.1:8080/x"), "http://127.0.0.1:8080/x");
    assert.equal(parseTarget("localhost:3000"), "http://localhost:3000/");
    assert.equal(parseTarget("127.0.0.1:8080"), "http://127.0.0.1:8080/");
    assert.equal(parseTarget("https://localhost:3000"), "https://localhost:3000/");
    assert.equal(parseTarget("ht!tp://bad url"), null);
    assert.equal(parseTarget("acme"), null);
    assert.equal(parseTarget(""), null);
  });

  it("an answer that is not an option is asked again, not read as the default", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    // readline drops lines typed before it asks, so each reply goes in when its prompt appears.
    const replies = ["9", "3", "not sure", "?"];
    let written = "";
    output.on("data", (b) => {
      written += b;
      if (String(b).includes("Enter to keep, or a number: ") && replies.length) setImmediate(() => input.write(`${replies.shift()}\n`));
    });
    const defaults = { onboarding: { value: "try_then_claim", source: "recommended" }, abuse_cost: { value: "low", source: "default" }, human_before: { value: "never", source: "default" } };
    const answers = await askQuestions(defaults, { input, output, style: makeStyle(false) });
    assert.match(written, /Pick 1 to 6, or press Enter to keep the default\./);
    assert.deepEqual(answers.onboarding, { value: "agent_is_customer", source: "asked" });
    assert.deepEqual(answers.abuse_cost, defaults.abuse_cost);
    assert.deepEqual(answers.human_before, defaults.human_before);
  });

  it("does not ask the onboarding question when the docs document the answer", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const replies = ["", ""];
    let written = "";
    output.on("data", (b) => {
      written += b;
      if (String(b).includes("Enter to keep, or a number: ") && replies.length) setImmediate(() => input.write(`${replies.shift()}\n`));
    });
    const defaults = { onboarding: { value: "limited_until_claimed", source: "documented" }, abuse_cost: { value: "low", source: "default" }, human_before: { value: "never", source: "default" } };
    const answers = await askQuestions(defaults, { input, output, style: makeStyle(false) });
    assert.match(written, /› Nobody yet; limited until a person claims it  \(documented; change it in agent-ready\.yml\)/);
    assert.equal(written.split("Enter to keep, or a number: ").length - 1, 2);
    assert.deepEqual(answers.onboarding, defaults.onboarding);
  });

  it("names the product from its title without the tagline", () => {
    const named = (title, host) => productName({ product: { name: { value: title } }, target: { host } });
    assert.equal(named("Resend · Email for developers", "resend.com"), "Resend");
    assert.equal(named("Home \\ Anthropic", "anthropic.com"), "Anthropic");
    assert.equal(named("Acme API | Widgets", "acme.dev"), "Acme API");
    assert.equal(productName({ product: { name: null }, target: { host: "acme.dev" } }), "acme.dev");
  });

  it("the terminal, audit-report.json and the brief give the same score", () => {
    const d = doc({ machineAccess: { aiCrawlersAllowed: verdict("yes"), hasAgentReadableIndex: verdict("no") } });
    const funnel = buildFunnel(d);
    const audit = buildAudit({ doc: d, funnel, answers: answersFor(funnel), task: "t", runId: "r", version: "test" });
    const [first, second] = renderVerdict(audit, makeStyle(false));
    assert.equal(`${first.trim()} ${second.trim()}`, audit.headline);
    assert.ok(renderBrief(audit, d).includes(`**${audit.headline}**`));
  });

  it("wraps text at spaces within the width", () => {
    const lines = wrap("one two three four five six seven", 10);
    assert.ok(lines.every((l) => l.length <= 10));
    assert.equal(lines.join(" "), "one two three four five six seven");
  });
});

// The command end to end against a local product: no network, no questions.
const SITE = {
  "/": ["text/html", `<!doctype html><html><head><title>Acme API</title></head><body><a href="/docs">Docs</a> <a href="/pricing">Pricing</a></body></html>`],
  "/robots.txt": ["text/plain", "User-agent: *\nAllow: /\n"],
  "/pricing": ["text/html", "<html><body><h1>Pricing</h1><p>Pro $20/mo.</p></body></html>"],
  "/docs": ["text/html", "<html><body>Create an API key in the dashboard.</body></html>"],
};

function serve(table) {
  const server = createServer((req, res) => {
    const hit = table[req.url.split("?")[0]];
    if (!hit) {
      res.writeHead(404, { "content-type": "text/html" });
      return res.end("<html><body>404</body></html>");
    }
    res.writeHead(200, { "content-type": hit[0] });
    res.end(hit[1]);
  });
  return new Promise((r) => server.listen(0, "127.0.0.1", () => r({ server, base: `http://127.0.0.1:${server.address().port}/` })));
}

// check runs the aeo-ready catalog by default, which spawns npx for minutes; the CLI tests point it at a stand-in.
const FAKE_AEO = mkdtempSync(join(tmpdir(), "fake-aeo-"));
const AEO_CLI = { result: writeFakeAeoCli(FAKE_AEO, "result"), fail: writeFakeAeoCli(FAKE_AEO, "fail") };
function runCli(args, cwd, aeo = "result") {
  return spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: "utf8", env: { ...process.env, NO_COLOR: "1", AGENT_READY_AEO_CLI: AEO_CLI[aeo] } });
}

describe("audit: command", () => {
  let site;
  let child;
  before(async () => {
    // A separate process serves the site because spawnSync blocks this one.
    const script = `import { createServer } from "node:http"; const t = ${JSON.stringify(SITE)}; const s = createServer((q, r) => { const h = t[q.url.split("?")[0]]; if (!h) { r.writeHead(404, { "content-type": "text/html" }); return r.end("404"); } r.writeHead(200, { "content-type": h[0] }); r.end(h[1]); }); s.listen(0, "127.0.0.1", () => console.log(s.address().port));`;
    const { spawn } = await import("node:child_process");
    child = spawn(process.execPath, ["--input-type=module", "-e", script], { stdio: ["ignore", "pipe", "inherit"] });
    const port = await new Promise((r) => child.stdout.once("data", (b) => r(String(b).trim())));
    site = `http://127.0.0.1:${port}/`;
  });
  after(() => child.kill());

  it("without --ask it asks nothing, says which onboarding model it took and saves the defaults", () => {
    const cwd = mkdtempSync(join(tmpdir(), "audit-cli-"));
    const r = runCli(["audit", site, "--no-standards", "--out", join(cwd, "run")], cwd);
    assert.equal(r.status, 0, r.stderr);
    assert.doesNotMatch(r.stderr, /Enter to keep, or a number/);
    assert.match(r.stderr.replace(/\n\s+/g, " "), /Onboarding: .+ \(\w+\)\. Change it in agent-ready\.yml or with --ask\./);
    assert.match(readFileSync(join(cwd, "agent-ready.yml"), "utf8"), /^onboarding: /m);
  });

  it("--ask without a terminal exits 2 and says what to do", () => {
    const cwd = mkdtempSync(join(tmpdir(), "audit-cli-"));
    const r = runCli(["audit", site, "--ask"], cwd);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /--ask needs a terminal/);
  });

  it("with --yes --json it writes the audit, a brief and one prompt per finding", () => {
    const cwd = mkdtempSync(join(tmpdir(), "audit-cli-"));
    const out = join(cwd, "run");
    const r = runCli(["audit", site, "--yes", "--json", "--out", out], cwd);
    assert.equal(r.status, 0, r.stderr);
    const audit = JSON.parse(r.stdout);
    assert.equal(audit.schema, "agent-ready/audit-report@1");
    assert.ok(existsSync(join(out, "audit-report.json")));
    assert.ok(!existsSync(join(out, "audit.json")), "audit.json belongs to the skill");
    assert.ok(audit.findings.length > 0);
    for (const f of audit.findings) assert.ok(existsSync(join(out, "prompts", f.file)), f.file);
    assert.ok(existsSync(join(out, "prompts", "ALL.md")));
    assert.match(readFileSync(join(out, "brief.md"), "utf8"), /## Decisions to confirm/);
    // With no agent-ready.yml yet, --yes writes the defaults so verify has a file to read.
    assert.equal(readConfig(join(cwd, "agent-ready.yml")).onboarding, audit.onboarding.chosen.id);
    assert.ok(readdirSync(out).includes("interface.json"));
    assert.ok(audit.limits.includes("public pages cannot show whether a step works; a test runs a real agent"), JSON.stringify(audit.limits));
    assert.match(readFileSync(join(out, "brief.md"), "utf8"), / · checked \d{4}-\d{2}-\d{2} · /);
  });

  it("says what to do next as the README's steps, before the benchmarks, and ends on the next action", () => {
    const cwd = mkdtempSync(join(tmpdir(), "audit-cli-"));
    const r = runCli(["check", site, "--yes", "--out", join(cwd, "run")], cwd);
    assert.equal(r.status, 0, r.stderr);
    // The answer comes first, from the steps that need a fix.
    assert.match(r.stderr, /Not yet\. Your pages don't show how an agent /);
    // Step 2 names the first prompt by a path that can be copied, then the test commands for later.
    assert.match(r.stderr, /Next {2}Step 2 of 3: fix\. Paste a prompt into your coding agent, deploy,\n {8}then check again:\n {8}\S+\/prompts\/01-\w+\.md\n/);
    const named = new URL(site).host.replace(/\./g, "\\.");
    assert.match(r.stderr, new RegExp(`Then {2}Step 3 of 3: test\\. The plan is free; a signup uses your Claude Code\\.\\n {8}npx @tansohq/agent-ready test ${named} --check\\n {8}npx @tansohq/agent-ready test ${named}\\n`));
    assert.equal(r.stderr.match(/Next {2}/g).length, 1);
    // Next is printed before the catalog runs, so it can be acted on during the wait; the last line repeats it.
    assert.ok(r.stderr.indexOf("Next  ") < r.stderr.indexOf("Benchmarks  optional"), r.stderr);
    assert.match(r.stderr.trimEnd().split("\n").pop(), /^ {2}Done in .+\. Next: the fix prompt above, then check again\.$/);
    // With fixes to make, nothing waits on a menu.
    assert.doesNotMatch(r.stderr, /Pick 1-3/);
    const json = runCli(["check", site, "--yes", "--json", "--out", join(cwd, "json")], cwd);
    assert.doesNotMatch(json.stdout + json.stderr, /npx @tansohq\/agent-ready test/, "--json prints only the report");
  });

  it("runs the standards catalog by default: a Benchmarks section after Next, standards and files.standards in --json", () => {
    const cwd = mkdtempSync(join(tmpdir(), "audit-cli-"));
    const r = runCli(["check", site, "--yes", "--out", join(cwd, "run")], cwd);
    assert.equal(r.status, 0, r.stderr);
    const standardsAt = r.stderr.indexOf("Benchmarks  optional: 5 third-party scores. Sends your URL to Cloudflare");
    assert.ok(standardsAt > r.stderr.indexOf("Next  "), r.stderr);
    assert.match(r.stderr, /Running, usually 1-3 min…/, "without a terminal, one line instead of a timer");
    assert.match(r.stderr, /Scores from aeo-ready [\d.]+; they do not change the seven steps\./);
    assert.match(r.stderr, /✗ Fern {10}1\/3 checks passed {7}score 70\/100 C/);
    assert.match(r.stderr, /Failed checks {2}\d+, the first names shown\. All of them:\n {4}\S*run\/aeo-ready\.json\n {4}Fern {10}2 {2}llms-txt-size, markdown-endpoint\n {4}AgentGrade/);
    assert.match(r.stderr, /· Vercel {8}did not run: @vercel\/agent-readability timed out after 60s/);
    assert.ok(r.stderr.indexOf("Discover") < standardsAt, "the steps come first");
    assert.ok(existsSync(join(cwd, "run", "aeo-ready.json")));
    const json = runCli(["check", site, "--yes", "--json", "--out", join(cwd, "j")], cwd);
    assert.equal(json.status, 0, json.stderr);
    const audit = JSON.parse(json.stdout);
    assert.equal(audit.standards.generator.name, "aeo-ready");
    assert.equal(audit.standards.averageScore, 59);
    assert.deepEqual(audit.standards.benchmarks.map((b) => [b.name, b.passed, b.total, b.failed.length]), [["agentic-seo", 0, 0, 0], ["Cloudflare", 2, 2, 0], ["Fern", 1, 3, 2], ["Vercel", 0, 0, 0], ["AgentGrade", 1, 3, 2]]);
    assert.equal(audit.standards.error, null);
    assert.ok(audit.files.standards.endsWith("aeo-ready.json") && existsSync(join(cwd, audit.files.standards)), audit.files.standards);
    assert.deepEqual(JSON.parse(readFileSync(join(cwd, "j", "audit-report.json"), "utf8")).standards, audit.standards);
    // The field is last, so the rest of the document is unchanged.
    assert.deepEqual(Object.keys(audit).slice(-2), ["standards", "files"]);
  });

  it("Ctrl+C during the benchmarks stops them, keeps the fixes and exits 130", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "audit-cli-"));
    const hang = join(cwd, "hang.mjs");
    writeFileSync(hang, "setTimeout(() => {}, 60000);\n");
    const { spawn } = await import("node:child_process");
    const proc = spawn(process.execPath, [CLI, "check", site, "--yes", "--out", join(cwd, "run")], { cwd, env: { ...process.env, NO_COLOR: "1", AGENT_READY_AEO_CLI: hang } });
    let stderr = "";
    let sent = false;
    proc.stderr.on("data", (chunk) => {
      stderr += chunk;
      if (!sent && stderr.includes("Running, usually 1-3 min")) {
        sent = true;
        proc.kill("SIGINT");
      }
    });
    const status = await new Promise((done) => proc.on("close", done));
    assert.equal(status, 130, stderr);
    assert.match(stderr, /Benchmarks skipped\. Fixes saved in \S*run\//);
    const audit = JSON.parse(readFileSync(join(cwd, "run", "audit-report.json"), "utf8"));
    assert.ok(audit.findings.length > 0);
    assert.ok(existsSync(join(cwd, "run", "prompts", audit.findings[0].file)));
    assert.ok(!existsSync(join(cwd, "run", "audit-report.json.tmp")));
  });

  it("--no-standards skips the catalog: no standards field, no aeo-ready.json, and the section says so", () => {
    const cwd = mkdtempSync(join(tmpdir(), "audit-cli-"));
    const r = runCli(["check", site, "--yes", "--no-standards", "--out", join(cwd, "run")], cwd);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, /Benchmarks {2}skipped \(--no-standards\)/);
    assert.ok(!existsSync(join(cwd, "run", "aeo-ready.json")));
    const json = runCli(["check", site, "--yes", "--json", "--no-standards", "--out", join(cwd, "j")], cwd);
    const audit = JSON.parse(json.stdout);
    assert.ok(!("standards" in audit));
    assert.equal(audit.files.standards, null);
  });

  it("when aeo-ready fails, the section and --json carry its error and the check still completes", () => {
    const cwd = mkdtempSync(join(tmpdir(), "audit-cli-"));
    const r = runCli(["check", site, "--yes", "--out", join(cwd, "run")], cwd, "fail");
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, /\n {14}aeo-ready did not run\. aeo-ready exited 1 without JSON: Warning: no network/);
    const json = runCli(["check", site, "--yes", "--json", "--out", join(cwd, "j")], cwd, "fail");
    const audit = JSON.parse(json.stdout);
    assert.equal(audit.standards.error, "aeo-ready exited 1 without JSON: Warning: no network");
    assert.deepEqual(audit.standards.benchmarks, []);
    assert.deepEqual(audit.standards.warnings, ["Warning: no network"]);
    assert.equal(audit.files.standards, null);
  });

  it("--fail-on medium exits 1 when a medium fix exists, and a bad level exits 2", () => {
    const cwd = mkdtempSync(join(tmpdir(), "audit-cli-"));
    assert.equal(runCli(["audit", site, "--yes", "--json", "--fail-on", "medium", "--out", join(cwd, "a")], cwd).status, 1);
    assert.equal(runCli(["audit", site, "--yes", "--fail-on", "low"], cwd).status, 2);
  });

  it("a site that does not answer stops with exit 3 and writes nothing", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "audit-cli-"));
    const closed = await serve({});
    const dead = closed.base;
    closed.server.close();
    const r = runCli(["audit", dead, "--yes", "--out", join(cwd, "dead")], cwd);
    assert.equal(r.status, 3, r.stderr);
    assert.match(r.stderr, /Could not reach .* Nothing was written\./s);
    assert.ok(!existsSync(join(cwd, "dead")));
  });

  it("a malformed address or a missing one is a usage error, exit 2, with an example", () => {
    const cwd = mkdtempSync(join(tmpdir(), "audit-cli-"));
    const bad = runCli(["audit", "ht!tp://bad url", "--yes"], cwd);
    assert.equal(bad.status, 2);
    assert.match(bad.stderr, /is not a web address\.\s+Try: agent-ready check example\.com/);
    const missing = runCli(["audit"], cwd);
    assert.equal(missing.status, 2);
    assert.match(missing.stderr, /Try: agent-ready check example\.com/);
  });

  it("--help shows example commands and exits 0", () => {
    const r = runCli(["audit", "--help"], mkdtempSync(join(tmpdir(), "audit-cli-")));
    assert.equal(r.status, 0);
    assert.match(r.stdout, /Examples:\n  agent-ready check example\.com /);
  });

  it("--yes never overwrites an agent-ready.yml that is already there", () => {
    const cwd = mkdtempSync(join(tmpdir(), "audit-cli-"));
    const path = join(cwd, "agent-ready.yml");
    writeFileSync(path, "url: other.dev\ntask: Sign up\nonboarding: agent_is_customer\nverify_call: GET https://api.other.dev/v1/me\n");
    const before = readFileSync(path, "utf8");
    assert.equal(runCli(["audit", site, "--yes", "--json", "--out", join(cwd, "c")], cwd).status, 0);
    assert.equal(readFileSync(path, "utf8"), before);
  });

  it("with an agent-ready.yml for another product, check leaves it and names this product in the test commands", () => {
    const cwd = mkdtempSync(join(tmpdir(), "audit-cli-"));
    const path = join(cwd, "agent-ready.yml");
    writeFileSync(path, "url: otherproduct.example\ntask: Sign up\nonboarding: agent_is_customer\nverify_call: GET https://api.otherproduct.example/v1/me\n");
    const before = readFileSync(path, "utf8");
    const r = runCli(["check", site, "--yes", "--out", join(cwd, "c")], cwd);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(readFileSync(path, "utf8"), before);
    const host = new URL(site).host;
    assert.ok(r.stderr.includes(`npx @tansohq/agent-ready test ${host} --check`), r.stderr);
    assert.doesNotMatch(r.stderr, /otherproduct/);
  });

  it("an agent can answer every question with flags, with no terminal and no --yes", () => {
    const cwd = mkdtempSync(join(tmpdir(), "audit-cli-"));
    const r = runCli(["audit", site, "--onboarding", "existing_account", "--abuse-cost", "high", "--human-before", "always", "--json", "--out", join(cwd, "f")], cwd);
    assert.equal(r.status, 0, r.stderr);
    const audit = JSON.parse(r.stdout);
    assert.deepEqual(audit.onboarding.chosen, { id: "existing_account", name: "Person sets up access first", source: "flag" });
    assert.equal(audit.answers.human_before.value, "always");
    // --json says where everything is, relative to where it ran.
    assert.ok(audit.files.prompts.every((p) => existsSync(join(cwd, p))), JSON.stringify(audit.files));
    assert.ok(existsSync(join(cwd, audit.files.brief)));
  });

  it("at a terminal it asks the questions first and prints the verdict and steps once, from the answers given", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "audit-cli-"));
    // stdin is a pipe here; the preload makes the CLI treat it as a terminal so the questions are asked.
    // Each answer is sent when its prompt appears, because a pipe that ends early closes the questions.
    const tty = join(cwd, "tty.mjs");
    writeFileSync(tty, "process.stdin.isTTY = true;\n");
    const { spawn } = await import("node:child_process");
    const proc = spawn(process.execPath, ["--import", tty, CLI, "check", site, "--ask", "--out", join(cwd, "run")], { cwd, env: { ...process.env, NO_COLOR: "1" } });
    const replies = ["5", "", ""];
    const r = { stderr: "", status: null };
    proc.stderr.on("data", (chunk) => {
      r.stderr += chunk;
      const asked = r.stderr.split("Enter to keep, or a number:").length - 1;
      while (asked > 3 - replies.length) {
        proc.stdin.write(`${replies.shift()}\n`);
        if (!replies.length) proc.stdin.end();
      }
    });
    r.status = await new Promise((done) => proc.on("close", done));
    assert.equal(r.status, 0, r.stderr);
    const audit = JSON.parse(readFileSync(join(cwd, "run", "audit-report.json"), "utf8"));
    assert.equal(audit.onboarding.chosen.id, "existing_account");
    const [first] = renderVerdict(audit, makeStyle(false));
    const verdictAt = r.stderr.indexOf(first.trim());
    assert.ok(verdictAt > r.stderr.indexOf("How should agents onboard?"), r.stderr);
    assert.equal(r.stderr.split(first.trim()).length, 2, "the verdict is printed once");
    assert.ok(r.stderr.indexOf("Discover") > verdictAt, "the steps follow the verdict");
  });

  it("with --json every error is JSON on stdout with a code and a next step", () => {
    const cwd = mkdtempSync(join(tmpdir(), "audit-cli-"));
    const cases = [
      [["audit", site, "--onboarding", "maybe", "--json"], "invalid_flag"],
      [["audit", "ht!tp://bad url", "--json", "--yes"], "invalid_address"],
      [["audit", site, "--ask", "--json"], "answers_required"],
      [["audit", "--json"], "usage"],
      [["verify", "--json"], "config_missing"],
    ];
    for (const [args, code] of cases) {
      const r = runCli(args, cwd);
      assert.equal(r.status, 2, args.join(" "));
      const body = JSON.parse(r.stdout);
      assert.equal(body.schema, "agent-ready/error@1");
      assert.equal(body.error.code, code, args.join(" "));
      assert.ok(body.error.hint || body.error.message);
    }
  });

  it("reads answers from agent-ready.yml when it matches the host", () => {
    const cwd = mkdtempSync(join(tmpdir(), "audit-cli-"));
    writeConfig(join(cwd, "agent-ready.yml"), { url: new URL(site).host, task: "Sign up", answers: { onboarding: { value: "agent_is_customer" }, abuse_cost: { value: "high" }, human_before: { value: "never" } } });
    const r = runCli(["audit", site, "--json", "--out", join(cwd, "b")], cwd);
    assert.equal(r.status, 0, r.stderr);
    const audit = JSON.parse(r.stdout);
    assert.deepEqual(audit.onboarding.chosen, { id: "agent_is_customer", name: "Agent is the customer", source: "from agent-ready.yml" });
  });
});

describe("audit: inspect", () => {
  let site;
  before(async () => { site = await serve(SITE); });
  after(() => site.server.close());

  it("builds the interface and funnel from public pages only", async () => {
    const { doc: d, funnel } = await inspect({ url: site.base, version: "test", runId: "run_t" });
    assert.ok(d.observations.length > 0);
    assert.equal(funnel.steps.length, 7);
  });
});
