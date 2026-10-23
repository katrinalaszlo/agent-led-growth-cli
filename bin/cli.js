#!/usr/bin/env node
import { Command, InvalidArgumentError } from "commander";
import { readFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { runId as newRunId } from "../src/schema/ids.js";
import { dirname, join, resolve, basename, relative, sep } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { buildReport, previousFromDir, writeReport } from "../src/report/index.js";
import { historyLine } from "../src/report/delta.js";
import { readHistory, appendHistory } from "../src/history/index.js";
import { validateScan, validateAudit, validateCrash, validateReport } from "../src/schema/validate.js";
import { scan, killAeoReady } from "../src/scan/index.js";
import { smoke } from "../src/crash/smoke.js";
import { renderDemo } from "../src/report/demo.js";
import { renderReplay, replayFrames } from "../src/report/replay.js";
import { renderHero, heroPlan } from "../src/report/hero.js";
import { webPlan } from "../src/report/web.js";
import { heroCaptions, replayCaptions } from "../src/report/captions.js";
import { webExports, recordDemo, stitchReel, trimToWebm, trimHead } from "../src/report/video.js";
import { runDir, OUT_DIR } from "../src/history/index.js";
import { merge } from "../src/report/merge.js";
import { buildInterface } from "../src/interface/index.js";
import { validateInterface } from "../src/interface/schema.js";
import { runHarness, TASKS } from "../src/harness/index.js";
import { inspect, buildAudit, writeAudit, parseTarget, unreachableReason, DEFAULT_TASK } from "../src/audit/index.js";
import { defaultAnswers, askQuestions, QUESTIONS } from "../src/audit/questions.js";
import { readConfig, writeConfig, writeVerifyCall, configHost, CONFIG_FILE } from "../src/audit/config.js";
import { makeStyle, renderAnswer, renderVerdict, renderSteps, renderSummary, renderNext, renderStandardsStart, renderStandards, renderStrip } from "../src/audit/render.js";
import { localJourney, localTestRuns } from "../src/verify/journey.js";
import { applyEvidence } from "../src/interface/evidence.js";
import { runStandards } from "../src/audit/standards.js";
import { parseVerifySpec, buildVerifyTask, classify, failedStep, networkFor, describeSpec } from "../src/verify/index.js";
import { renderVerify, renderPlan, duration } from "../src/verify/render.js";
import { inferVerifyCall, latestInterface, latestAnswers } from "../src/verify/infer.js";
import { renderPrompt } from "../src/audit/prompts.js";
import { patternInfo } from "../src/audit/index.js";
import { createInterface } from "node:readline/promises";
import { spawnSync } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(__dirname, "..", "package.json"), "utf8"));

const frameSize = (value) => {
  const match = /^(\d{2,5})x(\d{2,5})$/.exec(value);
  if (!match) throw new InvalidArgumentError("Use WIDTHxHEIGHT, e.g. 1920x1080.");
  return [Number(match[1]), Number(match[2])];
};

const program = new Command();
program.name("alg").description("Score: evals for agents as customers. Runs a real agent through signup, key and first call on your product, before you ship. Track, the analytics half, measures which agents convert after.").version(pkg.version);

function parseClaims(value) {
  const on = value.split(",").map((s) => s.trim()).filter(Boolean);
  return { web: on.includes("web"), onboarding: on.includes("onboarding"), monetization: on.includes("monetization") };
}

const FAIL_ON = { high: ["high"], medium: ["high", "medium"] };

// Errors for both readers: a sentence on stderr, and with --json the same error as JSON on stdout, so an agent
// parsing stdout gets a reason and a next step instead of nothing. The exit code carries the same meaning.
// `extra` carries fields an agent acts on, such as next_action and the run allowance.
function fail(opts, exitCode, code, message, hint = null, extra = {}) {
  console.error(`  ${message}`);
  if (hint) console.error(`  ${hint}`);
  if (opts.json) process.stdout.write(JSON.stringify({ schema: "agent-ready/error@1", error: { code, message, hint, ...extra } }, null, 2) + "\n");
  process.exit(exitCode);
}


// Usage errors (a missing argument, an unknown option) exit 2, so 1 keeps meaning "fixes found"; with --json they
// also arrive as JSON. Help and --version exit 0.
function usageExit(err) {
  if (err.exitCode !== 0 && process.argv.includes("--json")) process.stdout.write(JSON.stringify({ schema: "agent-ready/error@1", error: { code: "usage", message: err.message.replace(/^error: /, ""), hint: "Run with --help for the options and examples." } }, null, 2) + "\n");
  process.exit(err.exitCode === 0 ? 0 : 2);
}

const QUESTION_FLAGS = { onboarding: "onboarding", abuseCost: "abuse_cost", humanBefore: "human_before" };

program
  .command("check <url>")
  .alias("audit")
  .description("Read your public pages and mark the seven steps. Free, GET only, one fix prompt per gap.")
  .option("-y, --yes", "skip the question about running a test next")
  .option("--ask", "answer the three onboarding questions yourself instead of taking them from your docs")
  .option("--task <text>", "what an agent should accomplish", DEFAULT_TASK)
  .option("--onboarding <model>", "who holds the account: try_then_claim | limited_until_claimed | agent_is_customer | agent_identity | existing_account | pay_per_request")
  .option("--abuse-cost <cost>", "what one abusive free account costs you: low | high")
  .option("--human-before <when>", "when a verified person must exist: never | outbound | always")
  .option("--fail-on <level>", "exit 1 when a fix at this severity or above is found: high | medium")
  .option("--out <dir>", "run directory (default: .alg/<host>/<runId>)")
  .option("--json", "print audit-report.json to stdout")
  .option("--standards", "also score five third-party benchmarks (aeo-ready); 1-3 minutes, sends your URL to Cloudflare and AgentGrade")
  .option("--no-color", "plain output")
  .addHelpText("after", `
Examples:
  alg check example.com                           the seven steps and a fix prompt per gap, in seconds
  alg check example.com --standards               plus five third-party benchmark scores
  alg check example.com --ask                     answer the three onboarding questions yourself
  alg check example.com --fail-on high --json     for CI
  alg check example.com --onboarding existing_account --human-before always --json
                                                          answer the questions with flags (agents, CI)`)
  .showHelpAfterError("  Try: alg check example.com")
  // Usage errors exit 2, so 1 keeps meaning "fixes found". Help and --version still exit 0.
  .exitOverride(usageExit)
  .action(async (input, opts) => {
    if (opts.failOn && !FAIL_ON[opts.failOn]) fail(opts, 2, "invalid_flag", `--fail-on must be high or medium, not ${opts.failOn}.`);
    for (const [flag, key] of Object.entries(QUESTION_FLAGS)) {
      const q = QUESTIONS.find((x) => x.key === key);
      if (opts[flag] && !q.options.some((o) => o.id === opts[flag])) fail(opts, 2, "invalid_flag", `--${key.replace(/_/g, "-")} must be one of ${q.options.map((o) => o.id).join(", ")}, not ${opts[flag]}.`);
    }
    const flagged = Object.keys(QUESTION_FLAGS).some((flag) => opts[flag]);
    const url = parseTarget(input);
    if (!url) fail(opts, 2, "invalid_address", `"${input}" is not a web address.`, "Try: alg check example.com");
    const host = new URL(url).host;
    const style = makeStyle(Boolean(process.stderr.isTTY) && opts.color && !process.env.NO_COLOR && !opts.json);
    const say = opts.json ? () => {} : (line = "") => console.error(line);
    const configPath = join(process.cwd(), CONFIG_FILE);
    const saved = readConfig(configPath);
    const savedHere = saved && saved.url && configHost(saved.url) === host ? saved : null;
    // Answering any question by flag means the caller is not a person at a terminal: the rest take their defaults.
    // The questions are asked only on --ask: most people do not know the answers on a first run, and the defaults
    // (what the docs document, or the recommended model) give the same headline and steps.
    if (opts.ask && (!process.stdin.isTTY || opts.json)) fail(opts, 2, "answers_required", "--ask needs a terminal.", `Run "alg check ${host} --ask" in a terminal, or answer with --onboarding, --abuse-cost and --human-before.`);
    const interactive = Boolean(opts.ask) && !flagged;

    const id = newRunId();
    const out = resolve(opts.out || runDir(process.cwd(), { url }, id));
    say("");
    say(`  ${style.bold("alg check")} · ${host}`);
    const live = !opts.json && Boolean(process.stderr.isTTY);
    if (live) process.stderr.write(`  ${style.dim("Reading public pages…")}`);
    const inspected = await inspect({ url, version: pkg.version, runId: id });
    const doc = inspected.doc;
    // A step a `test` run on this machine proved reads Agent did, not what the public pages suggest.
    const funnel = applyEvidence(inspected.funnel, { runs: localTestRuns(process.cwd(), url) });
    if (live) process.stderr.write("\r\x1b[2K");
    const unreachable = unreachableReason(doc);
    if (unreachable) fail(opts, 3, "unreachable", `Could not reach ${url}. ${unreachable}`, "Check the address and try again. Nothing was written.");
    say(`  ${style.dim(`Read ${doc.observations.filter((o) => o.ok).length} public ${doc.observations.filter((o) => o.ok).length === 1 ? "page" : "pages"}. GET only, nothing submitted.`)}`);

    let answers = defaultAnswers(funnel);
    if (savedHere && !opts.ask) {
      for (const key of ["onboarding", "abuse_cost", "human_before"]) if (savedHere[key]) answers[key] = { value: savedHere[key], source: `from ${CONFIG_FILE}` };
    }
    for (const [flag, key] of Object.entries(QUESTION_FLAGS)) if (opts[flag]) answers[key] = { value: opts[flag], source: "flag" };
    const task = opts.task !== DEFAULT_TASK ? opts.task : savedHere?.task || DEFAULT_TASK;
    // The questions come before the verdict, so the verdict and steps are printed once, from the final answers.
    let savedTo = null;
    if (interactive) {
      say("");
      say(`  ${style.bold("How should agents onboard?")} ${style.dim("Not sure? Press Enter to keep the default; change it later in alg.yml.")}`);
      try {
        answers = await askQuestions(answers, { style });
      } catch (err) {
        if (err.code !== "ABORT_ERR") throw err;
        say("");
        say("  Cancelled. Nothing saved.");
        process.exit(130);
      }
      const { droppedVerifyFor } = writeConfig(configPath, { url: url.startsWith("https://") ? host : new URL(url).origin, task, answers });
      savedTo = `saved to ${CONFIG_FILE}`;
      if (droppedVerifyFor) say(`  ${style.dim(`Dropped verify_call for ${droppedVerifyFor}; test will pick a call for ${host}.`)}`);
    } else {
      if (!saved) {
        // With no alg.yml yet the answers are written, so test has a file to read. It never overwrites one.
        writeConfig(configPath, { url: url.startsWith("https://") ? host : new URL(url).origin, task, answers });
        savedTo = `defaults saved to ${CONFIG_FILE}`;
      }
    }

    const audit = buildAudit({ doc, funnel, answers, task, runId: id, version: pkg.version });
    say("");
    for (const line of renderAnswer(audit, style)) say(line);
    for (const line of renderVerdict(audit, style)) say(line);
    say("");
    for (const line of renderSteps(audit, style)) say(line);
    // The fixes and the next step are written and printed before the catalog, which takes minutes: a reader can act
    // on them while it runs, and Ctrl+C during it loses nothing. audit-report.json is written again after it, with
    // `standards`.
    let paths = writeAudit({ audit, doc, out });
    const rel = (p) => relative(process.cwd(), p) || ".";
    if (!opts.json) for (const line of renderSummary(audit, paths, style, rel, savedTo)) say(line);
    // Skipped, the benchmarks get one line above Next, so Next stays the last thing on screen.
    if (!opts.json && !opts.standards) for (const line of renderStandards(null, style)) say(line);
    if (!opts.json) for (const line of renderNext(audit, paths, style, rel)) say(line);

    let standardsFile = null;
    if (opts.standards) {
      const started = Date.now();
      for (const line of renderStandardsStart(style)) say(line);
      let child = null;
      const stop = () => {
        if (child && child.exitCode === null && child.signalCode === null) killAeoReady(child);
        if (live) process.stderr.write("\r\x1b[2K");
        say(`  Benchmarks skipped. Fixes saved in ${rel(paths.folder)}/`);
        process.exit(130);
      };
      process.once("SIGINT", stop);
      process.once("SIGTERM", stop);
      const tick = () => process.stderr.write(`\r\x1b[2K              ${style.dim(`${duration(Date.now() - started)} · usually 1-3 min · Ctrl+C skips; your fixes are saved`)}`);
      let ticker = null;
      if (live) {
        tick();
        ticker = setInterval(tick, 1000);
      } else say(`              ${style.dim("Running, usually 1-3 min…")}`);
      const { standards, raw } = await runStandards({ url, out, onChild: (c) => (child = c) });
      if (ticker) clearInterval(ticker);
      process.removeListener("SIGINT", stop);
      process.removeListener("SIGTERM", stop);
      if (live) process.stderr.write("\r\x1b[2K");
      audit.standards = standards;
      standardsFile = raw;
      paths = writeAudit({ audit, doc, out });
      if (!opts.json) for (const line of renderStandards(standards, style, raw ? rel(raw) : null)) say(line);
      // The last line on screen is the next action, not the benchmark table.
      if (!opts.json) {
        const next = audit.findings.length ? " Next: the fix prompt above, then check again." : ` Next: ${style.bold(`${TEST_CMD} ${host} --check`)}`;
        say(`  Done in ${duration(Date.now() - started)}.${next}`);
        say("");
      }
    }

    const files = { folder: rel(paths.folder), brief: rel(paths.brief), report: rel(paths.json), prompts: audit.findings.map((f) => rel(join(paths.promptsDir, f.file))), config: existsSync(configPath) ? rel(configPath) : null, standards: standardsFile ? rel(standardsFile) : null };
    if (opts.json) process.stdout.write(JSON.stringify({ ...audit, files }, null, 2) + "\n");
    if (opts.failOn && audit.findings.some((f) => FAIL_ON[opts.failOn].includes(f.severity))) process.exitCode = 1;
    // With nothing to fix, the next step is a test, and a person at a terminal can start it here.
    const canAsk = Boolean(process.stdin.isTTY && process.stderr.isTTY) && !opts.yes && !opts.json;
    if (canAsk && !audit.findings.length) await offerTest({ audit, style, say });
  });

// check reads public pages; test has a real agent do the steps. With nothing to fix, a person at a terminal can
// start one here. The same commands are printed under Next for --yes, pipes and agents, so nothing waits on them.
const TEST_CMD = "npx agent-led-growth test";
async function offerTest({ audit, style, say }) {
  say(`  ${style.bold("What next?")}`);
  say(`    ${style.bold("1")}  Run a test now    your Claude Code signs up on ${audit.target.host} for real (asks first)`);
  say(`    ${style.bold("2")}  See the plan      what a test would do, free, runs nothing`);
  say(`    ${style.bold("3")}  Later             quit; the commands are under Next`);
  say("");
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  const reply = await rl.question("  Pick 1-3 [1]: ").catch((err) => {
    if (err.code === "ABORT_ERR") return "3";
    throw err;
  });
  rl.close();
  const pick = reply.trim() || "1";
  if (pick !== "1" && pick !== "2") return;
  say("");
  const run = spawnSync(process.execPath, [fileURLToPath(import.meta.url), "test", audit.target.host, ...(pick === "2" ? ["--check"] : [])], { stdio: "inherit" });
  if (run.status) process.exitCode = run.status;
}

function parseBudget(value) {
  const usd = Number(value);
  if (!Number.isFinite(usd) || usd <= 0) throw new InvalidArgumentError("It must be a dollar amount above 0, such as 2 or 0.5.");
  return usd;
}


// Claude Code runs the agent. Missing or signed out, the run cannot start: a setup step, not a result.
function claudeStatus() {
  const version = spawnSync("claude", ["--version"], { encoding: "utf8" });
  if (version.error) return { ok: false, code: "claude_code_missing", detail: "test runs the agent with Claude Code, and the claude command was not found.", hint: "Install it from https://claude.com/claude-code, sign in, then run alg test again." };
  const found = `Claude Code ${version.stdout.trim().split(/\s/)[0]}`;
  if (process.env.ANTHROPIC_API_KEY) return { ok: true, detail: `${found}, using ANTHROPIC_API_KEY` };
  const status = spawnSync("claude", ["auth", "status"], { encoding: "utf8" });
  let loggedIn = null;
  try { loggedIn = JSON.parse(status.stdout).loggedIn; }
  catch { return { ok: true, detail: `${found}, sign-in not checked (this version has no "claude auth status")` }; }
  if (loggedIn === false) return { ok: false, code: "claude_code_signed_out", detail: `${found} is installed but not signed in.`, hint: 'Run "claude auth login", then run alg test again.' };
  return { ok: true, detail: `${found}, signed in` };
}

program
  .command("test [url]")
  .alias("verify")
  .description("A real agent (your Claude Code) signs up for and uses your product; a separate checker proves its key. Creates a real account, spends up to $5 of model use, asks first.")
  .option("-y, --yes", "skip the confirmation and save an inferred verify_call to alg.yml")
  .option("--inbox <address>", "an inbox you will relay mail from into the run's work/inbox/, for products that email a code")
  .option("--max-turns <n>", "agent turn budget", (v) => parseInt(v, 10), 40)
  .option("--max-budget-usd <usd>", "stop the agent once model use passes this many dollars (checked after each turn)", parseBudget, 5)
  .option("--model <name>", "model for the agent")
  .option("--executor <name>", "agent runner", "claude-print")
  .option("--out <dir>", "run directory (default: .alg/<host>/<runId>)")
  .option("--check", "check the setup and print the run plan without starting the agent (free; with no verify_call it reads the product's public docs to pick one, and otherwise sends nothing to the product)")
  .option("--json", "print the result to stdout")
  .option("--no-color", "plain output")
  .addHelpText("after", `
Examples:
  alg test --check          check Claude Code and alg.yml, print the plan, run nothing
  alg test                  use url, task and verify_call from alg.yml
                                    (no verify_call: one is taken from the product's OpenAPI document)
  alg test --yes --json     no confirmation, JSON result (CI)`)
  .exitOverride(usageExit)
  .action(async (input, opts) => {
    const configPath = join(process.cwd(), CONFIG_FILE);
    const saved = readConfig(configPath);
    if (!saved && !input) fail(opts, 2, "config_missing", `No ${CONFIG_FILE} here.`, `Name the product, as in "alg test example.com", or run "alg check <url> --yes" first, which writes it.`);
    const url = parseTarget(input || saved.url);
    if (!url) fail(opts, 2, "invalid_address", `"${input || saved.url}" is not a web address.`, "Set url in alg.yml, for example: url: example.com");
    const host = new URL(url).host;
    // alg.yml is used only for the product it names: another product's verify_call would be sent this
    // product's agent key. Otherwise the answers come from this product's latest check, or the defaults.
    const savedFor = saved?.url && parseTarget(saved.url) ? new URL(parseTarget(saved.url)).host : null;
    const useSaved = Boolean(saved) && (!input || savedFor === host);
    const config = useSaved ? saved : { url: host, ...latestAnswers(process.cwd(), url) };
    const task = config.task || DEFAULT_TASK;
    const style = makeStyle(Boolean(process.stderr.isTTY) && opts.color && !process.env.NO_COLOR && !opts.json);
    if (saved && !useSaved && !opts.json) {
      const home = homedir();
      const shown = configPath.startsWith(home + sep) ? `~${configPath.slice(home.length)}` : CONFIG_FILE;
      console.error(`  ${style.dim(`Not using ${shown}: it is for ${savedFor || "no product"}.`)}`);
    }
    const addCallHint = `Add the call that proves an agent's key works to ${CONFIG_FILE}, for example: verify_call: GET https://api.example.com/v1/me`;
    // No verify_call: take one from the product's own OpenAPI document. It is saved only once accepted, by a
    // person at the prompt or by --yes; otherwise it is used for this run alone.
    let inferred = null;
    if (!(config.verify_call || "").trim()) {
      const live = !opts.json && Boolean(process.stderr.isTTY);
      if (live) process.stderr.write(`  ${style.dim("Finding a call that proves the agent's key works…")}`);
      inferred = await inferVerifyCall({ url, version: pkg.version, cwd: process.cwd() });
      if (live) process.stderr.write("\r\x1b[2K");
      // For another product's file, the call goes in a file of this product's own, never in that one.
      if (inferred.error && !useSaved) fail(opts, 2, "verify_call_invalid", `No verify_call for ${host}, and none could be taken from the product's docs: ${inferred.error}.`, `Run "alg check ${host}" in a folder of its own, then add the call that proves an agent's key works to the ${CONFIG_FILE} it writes, for example: verify_call: GET https://api.example.com/v1/me`);
      if (inferred.error) fail(opts, 2, "verify_call_invalid", `${CONFIG_FILE} has no verify_call, and none could be taken from the product's docs: ${inferred.error}.`, addCallHint);
      const from = `(from ${inferred.specUrl}${inferred.specVia ? `, linked from ${inferred.specVia}` : ""})`;
      const willCheck = `Will check with ${inferred.call} on ${inferred.apiHost} (${inferred.headerName}) ${from}.`;
      const offSiteNote = inferred.offSite ? `\n  This API host is on a different site than ${host}; the key the agent gets is sent there.` : "";
      let accepted = Boolean(opts.yes);
      if (!accepted && process.stdin.isTTY && !opts.json) {
        const rl = createInterface({ input: process.stdin, output: process.stderr });
        // A person reads the call and where it came from; the "Will check with" line stays for logs and agents.
        const ask = `\n  To prove the agent's key works, we'll call your API with it after signup:\n    ${style.bold(inferred.call)}   ${style.dim(`(from ${inferred.specUrl.replace(/^https?:\/\//, "")})`)}${offSiteNote}\n  Use this call? [Y/n] `;
        const reply = await rl.question(ask).catch((err) => {
          if (err.code === "ABORT_ERR") return "n";
          throw err;
        });
        rl.close();
        if (!/^(y(es)?)?$/i.test(reply.trim())) {
          console.error(`  Cancelled. Nothing saved. To use a different call, add it to ${CONFIG_FILE}, for example: verify_call: GET https://api.example.com/v1/me`);
          process.exit(130);
        }
        accepted = true;
      } else if (!opts.json) console.error(`\n  ${willCheck}${offSiteNote}`);
      if (!useSaved) {
        if (!opts.json) console.error(`  ${style.dim(`Used for this run only: ${CONFIG_FILE} here is not for ${host}.`)}`);
      } else if (accepted) {
        writeVerifyCall(configPath, inferred);
        if (!opts.json) console.error(`  ${style.dim(`Saved to ${CONFIG_FILE}.`)}`);
      } else if (!opts.json) console.error(`  ${style.dim(`Not saved to ${CONFIG_FILE}; pass --yes or run in a terminal to save it.`)}`);
    }
    const spec = parseVerifySpec(inferred ? { ...config, verify_call: inferred.call, verify_header: inferred.header } : config);
    if (spec.error) fail(opts, 2, "verify_call_invalid", spec.error, addCallHint);
    const checker = { inferred: Boolean(inferred), inferredFrom: inferred ? inferred.specUrl : null, ...(inferred?.specVia ? { inferredVia: inferred.specVia } : {}), ...(inferred ? { apiHost: inferred.apiHost, apiHostOffSite: inferred.offSite } : {}) };
    if (opts.check) {
      const claude = opts.executor === "claude-print" ? claudeStatus() : { ok: true, detail: `executor ${opts.executor}` };
      const inbox = process.env.AGENTMAIL_API_KEY ? "AgentMail: a fresh inbox for this run, deleted after" : opts.inbox ? `you relay mail from ${opts.inbox} into work/inbox/` : "none (set AGENTMAIL_API_KEY if the product emails a code or link)";
      const plan = {
        schema: "agent-ready/verify-plan@1",
        ready: claude.ok,
        target: { url, host },
        task,
        claudeCode: claude,
        agent: { hosts: networkFor(url, spec), inbox, maxTurns: opts.maxTurns, maxBudgetUsd: opts.maxBudgetUsd, saves: ["AGENT_READY_KEY", ...spec.fields] },
        checker: { call: describeSpec(spec), calls: ["with the agent's key: must answer " + spec.expect, "with no key: must be refused (400, 401 or 403)", "with a wrong key: must be refused"], ...checker },
      };
      // The onboarding pattern chosen in alg.yml, as the last check's interface.json describes it.
      const onboarding = latestInterface(process.cwd(), url)?.doc.onboarding;
      const chosen = onboarding?.patterns?.find((p) => p.id === (config.onboarding || onboarding.primary));
      if (chosen?.needs?.includes("inbox") && !process.env.AGENTMAIL_API_KEY && !opts.inbox) plan.warnings = ["The product's docs mention an emailed code or link and no inbox is set. Set AGENTMAIL_API_KEY or pass --inbox, or the run may end inconclusive."];
      if (opts.json) process.stdout.write(JSON.stringify(plan, null, 2) + "\n");
      else for (const line of renderPlan(plan, style)) console.error(line);
      process.exit(plan.ready ? 0 : 2);
    }
    if (!opts.yes) {
      if (!process.stdin.isTTY) fail(opts, 2, "confirmation_required", "test runs a real agent that creates an account on the product.", "Pass --yes to run it without a terminal.");
      const rl = createInterface({ input: process.stdin, output: process.stderr });
      const reply = await rl.question(`\n  A real agent will try to sign up on ${host} using your Claude Code.\n  It creates an account named with the run id. Model use is capped at $${opts.maxBudgetUsd} (--max-budget-usd);\n  October runs cost $0.06 to $0.47, and cost depends on your Claude Code model.\n  Continue? [y/N] `).catch((err) => {
        if (err.code === "ABORT_ERR") return "";
        throw err;
      });
      rl.close();
      if (!/^y(es)?$/i.test(reply.trim())) {
        console.error("  Cancelled. Nothing ran.");
        process.exit(130);
      }
    }

    // After the confirmation, so a missing --yes is reported first. The local runner is Claude Code. Without it the run cannot start, which is a setup step, not a result.
    if (opts.executor === "claude-print") {
      const claude = claudeStatus();
      if (!claude.ok) fail(opts, 2, claude.code, claude.detail, claude.hint);
    }
    const id = newRunId();
    const out = resolve(opts.out || runDir(process.cwd(), { url }, id));
    const mailKey = process.env.AGENTMAIL_API_KEY || null;
    const noInbox = !mailKey && !opts.inbox;
    const live = !opts.json && Boolean(process.stderr.isTTY);
    let steps = 0;
    const startedAt = Date.now();
    const progress = () => process.stderr.write(`\r\x1b[2K  ${style.dim(`Agent working · ${steps} actions · ${duration(Date.now() - startedAt)}`)}`);
    const log = (e) => {
      if (e.step === "agent" && e.kind === "tool_use") steps += 1;
      if (live) progress();
    };
    const clock = live ? setInterval(progress, 1000) : null;
    if (!opts.json) console.error(`\n  ${style.dim(`Starting the agent on ${host}${noInbox ? " (no inbox)" : ""}…`)}`);
    const result = await runHarness({ taskModule: buildVerifyTask({ url, task, spec }), runId: id, outDir: out, version: pkg.version, mode: "signup", inboxAddress: opts.inbox || null, noInbox, executorName: opts.executor, maxTurns: opts.maxTurns, maxBudgetUsd: opts.maxBudgetUsd, model: opts.model, log });
    if (clock) clearInterval(clock);
    if (live) process.stderr.write("\r\x1b[2K");
    const resultMd = existsSync(join(out, "work", "RESULT.md")) ? readFileSync(join(out, "work", "RESULT.md"), "utf8") : "";
    const verdict = classify(result, config.onboarding, resultMd);

    let promptFile = null;
    if (verdict.outcome === "failed") {
      const step = failedStep(result);
      const finding = { n: 1, step, name: step === "access" ? "Access" : "Sign up", severity: "high", reason: `${verdict.reason} ${result.evaluation?.checks?.find((c) => c.id === "credential_acquired")?.detail || ""}`.trim(), basedOn: [] };
      const answers = { abuse_cost: { value: config.abuse_cost || "low" }, human_before: { value: config.human_before || "never" } };
      const body = renderPrompt({ finding, pattern: patternInfo(config.onboarding || "try_then_claim"), answers, doc: { observations: [] }, product: host, url });
      mkdirSync(join(out, "prompts"), { recursive: true });
      writeFileSync(join(out, "prompts", `01-${step}.md`), body);
      promptFile = relative(process.cwd(), join(out, "prompts", `01-${step}.md`));
    }
    const summary = { schema: "agent-ready/verify@1", target: { url, host }, task, runId: id, at: new Date().toISOString(), outcome: verdict.outcome, step: verdict.outcome === "failed" ? failedStep(result) : null, reason: verdict.reason, checks: result.evaluation?.objects?.checks || [], turns: result.execution?.turns ?? null, costUsd: result.execution?.costUsd ?? null, folder: out, prompt: promptFile, checker: { call: describeSpec(spec), ...checker } };
    writeFileSync(join(out, "verify.json"), JSON.stringify(summary, null, 2));
    if (opts.json) process.stdout.write(JSON.stringify(summary, null, 2) + "\n");
    else {
      for (const line of renderVerify({ host, task, result, verdict, folder: relative(process.cwd(), out) || ".", promptFile }, style)) console.error(line);
      // The run is on disk now, so the strip includes it.
      const journey = localJourney(process.cwd(), url);
      if (journey) for (const line of renderStrip(journey, style, { stoppedAt: summary.step })) console.error(line);
      else console.error(`  ${style.dim(`Run npx agent-led-growth check ${host} to see this test on all seven steps.`)}`);
      console.error("");
    }
    process.exitCode = verdict.exitCode;
  });

// 0.3 kept a Tanso workspace for verify runs. check and test need no Tanso account now; these
// commands stay so scripts written for 0.3 get a clear answer instead of "unknown command".
for (const name of ["account", "login", "logout"]) {
  program
    .command(name, { hidden: true })
    .allowUnknownOption()
    .action(() => console.error("  alg no longer needs a Tanso account. check is free; test uses your own Claude Code. Nothing to do."));
}

program
  .command("scan [url]", { hidden: true })
  .description("Inspect a product's public surface: aeo-ready benchmarks plus alg probes. GET only, never submits. Writes scan.json and a scan-only report.")
  .option("-d, --dir <path>", "local build/public directory (gives agentic-seo full access)")
  .option("--catalog-slug <slug>", "tanso-oss catalog slug to probe /public/v1/catalog/<slug>/pricing.json")
  .option("--no-aeo", "skip the aeo-ready benchmarks (probes only, seconds instead of minutes)")
  .option("--task <text>", "the customer's task the agent will attempt")
  .option("--claims <list>", "pillars the product claims: web,onboarding,monetization", parseClaims)
  .option("--out <dir>", "run directory (default: .alg/<host>/<runId>)")
  .option("--json", "print scan.json to stdout")
  .option("--threshold <n>", "exit 1 if fewer than n stages are cleared", parseInt)
  .action(async (url, opts) => {
    if (url && !url.startsWith("http")) url = `https://${url}`;
    if (!url && !opts.dir) {
      console.error("  Usage: npx agent-led-growth scan <url> [--dir ./public]");
      process.exit(1);
    }
    const target = url ? { url } : { dir: resolve(opts.dir) };
    const id = newRunId();
    const out = resolve(opts.out || runDir(process.cwd(), target, id));
    mkdirSync(out, { recursive: true });
    const log = opts.json ? () => {} : (r) => console.error(`  ${r.status.padEnd(5)} ${r.id.padEnd(16)} ${r.detail}`);
    if (!opts.json) console.error(`\n  alg scan — ${url || opts.dir}\n`);
    const result = await scan({ url, dir: opts.dir ? resolve(opts.dir) : null, catalogSlug: opts.catalogSlug, aeo: opts.aeo, vendorDir: join(process.cwd(), OUT_DIR, "vendor"), version: pkg.version, log, runId: id });
    validateScan(result);
    writeFileSync(join(out, "scan.json"), JSON.stringify(result, null, 2));
    const runMeta = { task: opts.task || "", claims: opts.claims || { web: true, onboarding: true, monetization: true } };
    writeFileSync(join(out, "run.json"), JSON.stringify(runMeta, null, 2));
    const previous = readHistory(process.cwd(), target);
    const report = merge({ scan: result, task: runMeta.task, claims: runMeta.claims, previous, runId: id, target, version: pkg.version });
    const paths = writeReport(report, out, { assetDir: out });
    appendHistory(process.cwd(), historyLine(report));
    if (opts.json) process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    else {
      const h = report.headline;
      console.error(`\n  ${h.cleared} / ${h.of} stages cleared (inspection only; run audit and crash for the rest)`);
      console.error(`  ${h.text}`);
      for (const s of report.stages) console.error(`  ${s.state.padEnd(16)} ${s.pillar.padEnd(13)} ${s.id}`);
      console.error(`\n  ${paths.html}\n  ${paths.json}\n`);
    }
    if (Number.isInteger(opts.threshold) && report.headline.cleared < opts.threshold) process.exit(1);
  });

program
  .command("interface <url>", { hidden: true })
  .description("URL → structured agent interface. Reads first-party public surfaces (homepage, robots, llms.txt, OpenAPI, pricing, docs) and writes interface.json: observations with provenance, extracted facts with quotes, rule-based verdicts, and unknowns. GET only.")
  .option("--out <dir>", "run directory (default: .alg/<host>/<runId>)")
  .option("--json", "print interface.json to stdout")
  .action(async (url, opts) => {
    if (!url.startsWith("http")) url = `https://${url}`;
    const id = newRunId();
    const out = resolve(opts.out || runDir(process.cwd(), { url }, id));
    mkdirSync(out, { recursive: true });
    const log = opts.json ? () => {} : (o) => console.error(`  ${String(o.status).padEnd(4)} ${o.role.padEnd(13)} ${o.url}${o.discoveredVia.kind === "link" ? `  ← ${o.discoveredVia.from}` : ""}`);
    if (!opts.json) console.error(`\n  alg interface — ${url}\n`);
    const doc = await buildInterface({ url, version: pkg.version, log, runId: id });
    writeFileSync(join(out, "interface.json"), JSON.stringify(doc, null, 2));
    if (opts.json) return process.stdout.write(JSON.stringify(doc, null, 2) + "\n");
    const v = (e) => e.verdict.padEnd(8);
    console.error("");
    console.error(`  product        ${doc.product.name?.value ?? "unknown"}${doc.product.category ? ` · ${doc.product.category.value}` : ""}`);
    console.error(`  api            ${v(doc.interfaces.api.exists)} ${doc.interfaces.api.exists.reason}`);
    console.error(`  mcp            ${v(doc.interfaces.mcp.exists)} ${doc.interfaces.mcp.exists.reason}`);
    console.error(`  cli            ${v(doc.interfaces.cli.exists)} ${doc.interfaces.cli.exists.reason}`);
    console.error(`  auth setup     ${v(doc.authentication.agentCanUnderstandSetup)} ${doc.authentication.agentCanUnderstandSetup.reason}`);
    console.error(`  cost           ${v(doc.pricing.agentCanDetermineCost)} ${doc.pricing.agentCanDetermineCost.reason}`);
    console.error(`  ai crawlers    ${v(doc.machineAccess.aiCrawlersAllowed)} ${doc.machineAccess.aiCrawlersAllowed.reason}`);
    console.error(`  capabilities   ${doc.capabilities.length} · observations ${doc.observations.length} · unknowns ${doc.unknowns.length}`);
    console.error(`\n  ${join(out, "interface.json")}\n`);
  });

program
  .command("execute", { hidden: true })
  .description("Run one of the built-in example tasks against its public product with a real agent. Uses your Claude Code with no spending cap and does not ask first; --mode signup creates an account on that product. For your own product, use `alg test`.")
  .requiredOption("--task <id>", `task id: ${Object.keys(TASKS).join(", ")}`)
  .option("--out <dir>", "run directory (default: .alg/<host>/<runId>)")
  .option("--mode <mode>", "signup (agent obtains its own key as a synthetic persona; creates an account), given (key from env), none (stop at credential_required). Default: given if the key is set, else none")
  .option("--inbox <address>", "signup mode without AGENTMAIL_API_KEY: an existing inbox address you will relay into work/inbox/")
  .option("--executor <name>", "executor implementation", "claude-print")
  .option("--max-turns <n>", "agent turn budget", (v) => parseInt(v, 10), 40)
  .option("--model <name>", "model for the executor agent")
  .option("--json", "print the reconciled journey to stdout")
  .action(async (opts) => {
    const mod = TASKS[opts.task];
    if (!mod) {
      console.error(`  unknown task ${opts.task}; known: ${Object.keys(TASKS).join(", ")}`);
      process.exit(1);
    }
    const id = newRunId();
    const out = resolve(opts.out || runDir(process.cwd(), { url: mod.task.url }, id));
    const log = opts.json
      ? () => {}
      : (e) => console.error(e.step === "agent" ? `    ${e.kind.padEnd(11)} ${e.tool ? e.tool.padEnd(9) + " " : ""}${String(e.input || e.text || e.subject || e.subtype || "").split("\n")[0].slice(0, 110)}${e.from ? `  from ${e.from}` : ""}${e.error ? "  [error]" : ""}` : `  ${e.step.padEnd(9)} ${e.text}`);
    if (!opts.json) console.error(`\n  alg execute — ${opts.task} · ${mod.task.text}\n`);
    const result = await runHarness({ taskId: opts.task, runId: id, outDir: out, version: pkg.version, mode: opts.mode || null, inboxAddress: opts.inbox || null, executorName: opts.executor, maxTurns: opts.maxTurns, model: opts.model || null, log });
    if (opts.json) return process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    console.error("");
    for (const s of result.reconciled.stages) console.error(`  ${s.stage.padEnd(17)} extractor ${s.extractor.outcome.padEnd(8)} agent ${s.agent.outcome.padEnd(19)}${s.discrepancy ? "*" : ""}`);
    const st = result.reconciled.stoppedAt;
    console.error(`\n  ${st ? `stopped at ${st.stage}: ${st.outcome}. ${st.reason}` : "every stage passed"}`);
    console.error(`  evaluator: ${result.evaluation.success ? "task succeeded" : result.evaluation.stoppedAt || "task not accomplished"} (${result.evaluation.checks.filter((c) => c.pass === true).length} pass, ${result.evaluation.checks.filter((c) => c.pass === false).length} fail, ${result.evaluation.checks.filter((c) => c.pass === null).length} need credential)`);
    for (const d of result.reconciled.discrepancies) console.error(`  * ${d}`);
    console.error(`  agent: ${result.execution.turns ?? "?"} turns · ${result.execution.toolCalls} tool calls · ${result.execution.sources.length} sources · ${result.execution.errors.length} errors · ${result.execution.denied} denied · $${result.execution.costUsd ?? "?"} · stopped: ${result.execution.stoppedBecause}`);
    if (result.onboarding) {
      console.error("\n  onboarding");
      for (const k of result.onboarding.rules) console.error(`  ${k.padEnd(27)} ${result.onboarding[k].verdict.padEnd(8)} ${result.onboarding[k].value ?? "-"}  ${result.onboarding[k].reason}`);
    }
    console.error(`\n  ${join(out, "journey.json")}\n  ${join(out, "work", "trace.jsonl")}\n`);
  });

program
  .command("serve", { hidden: true })
  .description("Serve the interface API and the dashboard. POST /v1/interface {url} is the product; / is one client of it.")
  .option("-p, --port <n>", "port", (v) => parseInt(v, 10), 3131)
  // Loaded here, not at the top: the server pulls in Clerk, pg and Vercel's
  // runtime, which no other command needs.
  .action(async (opts) => {
    // The npm package carries the CLI only; the hosted server and dashboard run from the repository.
    const server = await import("../src/server.js").catch((err) => {
      if (err.code !== "ERR_MODULE_NOT_FOUND") throw err;
      console.error("  serve runs from the agent-led-growth repository, not the npm package.");
      process.exit(2);
    });
    const { createApp, ROUTES } = server;
    const app = createApp({ version: pkg.version, log: (m) => console.error(`  ${m}`) });
    app.listen(opts.port, () => {
      console.error(`\n  alg serve — http://localhost:${opts.port}\n`);
      for (const r of ROUTES) console.error(`  ${r.method.padEnd(5)} ${r.path.padEnd(16)} ${r.description}`);
      console.error("");
    });
    const shutdown = () => {
      const deadline = setTimeout(() => process.exit(1), 15000);
      deadline.unref();
      Promise.all([app.flowService.close(), new Promise((done) => app.close(done))])
        .then(() => { clearTimeout(deadline); process.exit(0); })
        .catch(() => process.exit(1));
    };
    process.once("SIGTERM", shutdown);
    process.once("SIGINT", shutdown);
  });

program
  .command("crash <url>", { hidden: true })
  .description("Smoke walk with a real browser: pricing and signup pages, screenshots, CAPTCHA and email-loop detection. Never submits.")
  .requiredOption("--smoke", "run the scripted smoke walk (the only mode the CLI runs itself)")
  .option("--into <dir>", "existing run directory (from scan) to add crash.json to; default: newest run for this host, else a new one")
  .option("--task <text>", "the customer's task")
  .option("--video", "record the browser walk to video/smoke.webm (and .mp4 when ffmpeg is available)")
  .option("--json", "print crash.json to stdout")
  .action(async (url, opts) => {
    if (!url.startsWith("http")) url = `https://${url}`;
    const target = { url };
    let out = opts.into ? resolve(opts.into) : null;
    let id = null;
    if (out && existsSync(join(out, "scan.json"))) id = JSON.parse(readFileSync(join(out, "scan.json"), "utf8")).runId;
    if (!out) {
      id = newRunId();
      out = resolve(runDir(process.cwd(), target, id));
    }
    id = id || newRunId();
    mkdirSync(out, { recursive: true });
    const log = opts.json ? () => {} : (f) => console.error(`  ${f.result.padEnd(5)} ${f.id.padEnd(12)} ${f.quote || ""}`);
    if (!opts.json) console.error(`\n  alg crash --smoke — ${url}\n`);
    const result = await smoke({ url, outDir: out, runId: id, version: pkg.version, task: opts.task || "", log, video: Boolean(opts.video) });
    if (!result.available) {
      console.error(`  ${result.reason}`);
      process.exit(1);
    }
    validateCrash(result);
    writeFileSync(join(out, "crash.json"), JSON.stringify(result, null, 2));
    if (opts.json) process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    else console.error(`\n  ${join(out, "crash.json")}${result.video ? `\n  ${result.video.mp4 || result.video.webm}` : ""}\n  next: npx agent-led-growth report --from ${out}\n`);
  });

program
  .command("report", { hidden: true })
  .description("Merge scan/audit/crash JSON in a run directory into report.json, report.html and report.md")
  .requiredOption("--from <dir>", "run directory holding scan.json / audit.json / crash.json (and optional run.json)")
  .option("--out <dir>", "output directory (default: the run directory)")
  .option("--previous <dir>", "earlier run directory to diff against (overrides history)")
  .option("--no-history", "do not read or append .alg/history.jsonl")
  .option("--task <text>", "the customer's task the agent attempted")
  .option("--claims <list>", "pillars the product claims: web,onboarding,monetization", parseClaims)
  .option("--json", "print report.json to stdout")
  .action((opts) => {
    const dir = resolve(opts.from);
    const out = resolve(opts.out || dir);
    let previous = [];
    let previousLabel = null;
    if (opts.previous) {
      previous = previousFromDir(resolve(opts.previous), pkg.version);
      previousLabel = basename(resolve(opts.previous));
    }
    const report = buildReport({ dir, previous: previous.length ? previous : [], version: pkg.version, task: opts.task, claims: opts.claims });
    if (!opts.previous && opts.history) {
      const lines = readHistory(process.cwd(), report.target);
      if (lines.length) {
        const withHistory = buildReport({ dir, previous: lines, version: pkg.version, task: opts.task, claims: opts.claims });
        Object.assign(report, withHistory);
      }
    }
    const paths = writeReport(report, out, { assetDir: dir, previousLabel });
    if (opts.history) appendHistory(process.cwd(), historyLine(report));
    if (opts.json) process.stdout.write(JSON.stringify(report, null, 2) + "\n");
    else {
      const h = report.headline;
      console.log(`\n  alg — ${report.target.url || report.target.dir}\n`);
      console.log(`  ${h.cleared} / ${h.of} stages cleared unassisted${report.delta ? `  (was ${report.delta.headline.from.cleared} / ${report.delta.headline.from.of})` : ""}`);
      console.log(`  ${h.text}`);
      console.log(`  Level ${report.maturity.level} · ${report.maturity.label}\n`);
      for (const s of report.stages) console.log(`  ${s.state.padEnd(16)} ${s.pillar.padEnd(13)} ${s.id}`);
      console.log(`\n  ${paths.html}\n  ${paths.md}\n  ${paths.json}\n`);
    }
  });

program
  .command("retest <url>", { hidden: true })
  .description("Re-run the deterministic engines with the last run's task and claims for this host, then report the delta. Re-runs smoke if the last run had it.")
  .option("--no-aeo", "skip the aeo-ready benchmarks")
  .action(async (url, opts) => {
    if (!url.startsWith("http")) url = `https://${url}`;
    const target = { url };
    const lines = readHistory(process.cwd(), target);
    if (!lines.length) {
      console.error("  No previous run for this host. Run: npx agent-led-growth scan <url>");
      process.exit(1);
    }
    const last = lines.at(-1);
    const id = newRunId();
    const out = resolve(runDir(process.cwd(), target, id));
    mkdirSync(out, { recursive: true });
    const log = (r) => console.error(`  ${(r.status || r.result || "").padEnd(5)} ${r.id.padEnd(16)} ${r.detail || r.quote || ""}`);
    console.error(`\n  alg retest — ${url} (vs ${last.at.slice(0, 10)})\n`);
    const claims = last.claims || { web: true, onboarding: true, monetization: true };
    const scanResult = await scan({ url, aeo: opts.aeo, vendorDir: join(process.cwd(), OUT_DIR, "vendor"), version: pkg.version, log, runId: id });
    validateScan(scanResult);
    writeFileSync(join(out, "scan.json"), JSON.stringify(scanResult, null, 2));
    writeFileSync(join(out, "run.json"), JSON.stringify({ task: last.task || "", claims }, null, 2));
    let crashResult = null;
    if (last.providersRun.includes("crash") && last.crashMode === "smoke") {
      crashResult = await smoke({ url, outDir: out, runId: id, version: pkg.version, task: last.task || "", log });
      if (crashResult.available) {
        validateCrash(crashResult);
        writeFileSync(join(out, "crash.json"), JSON.stringify(crashResult, null, 2));
      } else {
        console.error(`  ${crashResult.reason}`);
        crashResult = null;
      }
    }
    if (last.providersRun.includes("audit")) console.error("  note: the last run had an audit; re-run the skill's audit step to refresh it, then `alg report --from " + out + "`");
    const report = merge({ scan: scanResult, crash: crashResult, task: last.task || "", claims, previous: lines, runId: id, target, version: pkg.version });
    const paths = writeReport(report, out, { assetDir: out });
    appendHistory(process.cwd(), historyLine(report));
    const h = report.headline;
    const d = report.delta;
    console.error(`\n  ${h.cleared} / ${h.of} stages cleared${d ? `  (was ${d.headline.from.cleared} / ${d.headline.from.of})` : ""}`);
    if (d) {
      for (const st of d.stages.filter((x) => x.direction !== "same")) console.error(`  ${st.id}: ${st.from} → ${st.to}`);
      console.error(`  fixed ${d.findings.fixed.length} · new ${d.findings.new.length} · regressed ${d.findings.regressed.length}`);
    }
    console.error(`\n  ${paths.html}\n`);
  });

program
  .command("demo", { hidden: true })
  .description("Render a run as a customer-task walkthrough (goal, Before / After the change, step states, evidence), and optionally record it as a video")
  .requiredOption("--from <dir>", "run directory holding scan/audit/crash JSON")
  .option("--previous <dir>", "earlier run directory: enables the Before / After comparison")
  .option("--out <dir>", "output directory (default: the run directory)")
  .option("--video", "record the walkthrough playing itself to video/demo.webm (and .mp4 when ffmpeg is available)")
  .option("--step <ms>", "milliseconds between revealed steps when recording", (v) => parseInt(v, 10), 700)
  .option("--hold <ms>", "milliseconds to hold each completed view when recording", (v) => parseInt(v, 10), 2200)
  .option("--label <text>", "header label instead of the target host, e.g. \"tanso-oss · run 01\"")
  .option("--size <WxH>", "recording frame (the viewport)", frameSize, [1920, 1080])
  .option("--zoom <x>", "page zoom inside the frame; the layout is ~1200px wide, so 1.5 fills 1920", parseFloat, 1.5)
  .action(async (opts) => {
    const dir = resolve(opts.from);
    const out = resolve(opts.out || dir);
    let previous = [];
    let previousReport = null;
    if (opts.previous) {
      previousReport = buildReport({ dir: resolve(opts.previous), version: pkg.version });
      previous = [historyLine(previousReport)];
    }
    const report = buildReport({ dir, previous, version: pkg.version });
    mkdirSync(out, { recursive: true });
    const htmlPath = join(out, "demo.html");
    writeFileSync(htmlPath, renderDemo(report, { assetDir: dir, previousReport, label: opts.label || null }));
    console.log(`\n  ${htmlPath}`);
    if (opts.video) {
      const [w, h] = opts.size;
      const { webm, mp4 } = await recordDemo({ htmlPath, outDir: out, stepMs: opts.step, holdMs: opts.hold, width: w, height: h, zoom: opts.zoom });
      console.log(`  ${webm}`);
      if (mp4) console.log(`  ${mp4}`);
      else console.log("  (no ffmpeg found: mp4 skipped)");
    }
    console.log("");
  });

program
  .command("replay", { hidden: true })
  .description("Play the crash record back step by step: each request typed out, its response, the agent's words, the screenshot. Optionally record it.")
  .requiredOption("--from <dir>", "run directory holding crash.json (and scan/audit)")
  .option("--out <dir>", "output directory (default: the run directory)")
  .option("--video", "record the replay to video/replay.webm (and .mp4 when ffmpeg is available)")
  .option("--hold <ms>", "milliseconds to hold each step when recording", (v) => parseInt(v, 10), 2600)
  .option("--type <ms>", "milliseconds per typed character when recording", (v) => parseInt(v, 10), 28)
  .option("--label <text>", "header label instead of the target host")
  .option("--size <WxH>", "recording frame (the viewport)", frameSize, [1920, 1080])
  .option("--zoom <x>", "page zoom inside the frame", parseFloat, 1.5)
  .action(async (opts) => {
    const dir = resolve(opts.from);
    const out = resolve(opts.out || dir);
    const report = buildReport({ dir, version: pkg.version });
    if (!report.sources.crash) {
      console.error("  No crash.json in the run directory; replay needs an agent run.");
      process.exit(1);
    }
    mkdirSync(out, { recursive: true });
    const htmlPath = join(out, "replay.html");
    writeFileSync(htmlPath, renderReplay(report, { assetDir: dir, label: opts.label || null }));
    const rcaps = replayCaptions(replayFrames(report), { typeMs: opts.type, holdMs: opts.hold });
    mkdirSync(join(out, "video"), { recursive: true });
    writeFileSync(join(out, "video", "replay.vtt"), rcaps.vtt);
    writeFileSync(join(out, "video", "replay.transcript.txt"), rcaps.transcript + "\n");
    console.log(`\n  ${htmlPath}\n  ${join(out, "video", "replay.vtt")}`);
    if (opts.video) {
      const [w, h] = opts.size;
      const { webm, mp4 } = await recordDemo({ htmlPath, outDir: out, name: "replay", query: `play=1&hold=${opts.hold}&type=${opts.type}`, doneSelector: "#replay", width: w, height: h, zoom: opts.zoom });
      console.log(`  ${webm}`);
      if (mp4) console.log(`  ${mp4}`);
    }
    console.log("");
  });

program
  .command("reel", { hidden: true })
  .description("Cut one demo reel from a run: the walkthrough, then any UI footage, then the endpoint replay. Records demo and replay first if their videos are missing.")
  .requiredOption("--from <dir>", "run directory")
  .option("--previous <dir>", "earlier run directory for the Before / After walkthrough")
  .option("--ui <files...>", "extra clips to include after the walkthrough, e.g. a crash dummy's recorded browser session")
  .option("--out <file>", "output mp4 (default: <run>/video/reel.mp4)")
  .action(async (opts) => {
    const dir = resolve(opts.from);
    const videoDir = join(dir, "video");
    mkdirSync(videoDir, { recursive: true });
    let previousReport = null;
    let previous = [];
    if (opts.previous) {
      previousReport = buildReport({ dir: resolve(opts.previous), version: pkg.version });
      previous = [historyLine(previousReport)];
    }
    const report = buildReport({ dir, previous, version: pkg.version });
    const demoMp4 = join(videoDir, "demo.mp4");
    if (!existsSync(demoMp4)) {
      const htmlPath = join(dir, "demo.html");
      writeFileSync(htmlPath, renderDemo(report, { assetDir: dir, previousReport }));
      await recordDemo({ htmlPath, outDir: dir });
    }
    const replayMp4 = join(videoDir, "replay.mp4");
    if (!existsSync(replayMp4) && report.sources.crash) {
      const htmlPath = join(dir, "replay.html");
      writeFileSync(htmlPath, renderReplay(report, { assetDir: dir }));
      await recordDemo({ htmlPath, outDir: dir, name: "replay", query: "play=1&hold=2600&type=28", doneSelector: "#replay", height: 860 });
    }
    const smokeMp4 = join(videoDir, "smoke.mp4");
    const clips = [demoMp4, ...(opts.ui || []).map((f) => resolve(f)), smokeMp4, replayMp4];
    const out = resolve(opts.out || join(videoDir, "reel.mp4"));
    const { clips: used } = stitchReel({ clips, outPath: out });
    console.log(`\n  ${out}\n  from: ${used.map((c) => basename(c)).join(" → ")}\n`);
  });

program
  .command("hero", { hidden: true })
  .description("The 55-second cut: Before → the failure → the agent's words → the fix → After, captions burned in. Needs a previous run.")
  .requiredOption("--from <dir>", "run directory (the After run)")
  .requiredOption("--previous <dir>", "earlier run directory (the Before run)")
  .option("--out <dir>", "output directory (default: the run directory)")
  .option("--label <text>", "run label shown in the corner", "run 01")
  .option("--product <text>", "how the title names the product", "our product")
  .option("--fixed-in <text>", "where the fixes landed", "tanso-oss")
  .option("--cta <text>", "end card call to action", "tansohq.com")
  .option("--fixes <n>", "number of findings fixed (default: fixed findings in the delta)", parseInt)
  .option("--ui <file>", "console footage (mp4) to play on the fix card")
  .option("--ui-from <s>", "start of the console clip, seconds", parseFloat, 6)
  .option("--ui-to <s>", "end of the console clip, seconds", parseFloat, 9)
  .option("--video", "record hero.mp4 (1920×1080) and hero-square.mp4 (1080×1080)")
  .option("--speed <x>", "playback speed multiplier while recording", parseFloat, 1)
  .action(async (opts) => {
    const dir = resolve(opts.from);
    const out = resolve(opts.out || dir);
    const previousReport = buildReport({ dir: resolve(opts.previous), version: pkg.version });
    const report = buildReport({ dir, previous: [historyLine(previousReport)], version: pkg.version });
    mkdirSync(join(out, "video"), { recursive: true });
    let uiClip = null;
    if (opts.ui) {
      trimToWebm({ input: resolve(opts.ui), outPath: join(out, "video", "ui-console.webm"), from: opts.uiFrom, to: opts.uiTo });
      uiClip = "video/ui-console.webm";
    }
    const htmlPath = join(out, "hero.html");
    const plan = heroPlan(report, previousReport, { label: opts.label, product: opts.product, fixedIn: opts.fixedIn, cta: opts.cta, fixCount: Number.isInteger(opts.fixes) ? opts.fixes : null, uiClip });
    writeFileSync(htmlPath, plan.html);
    const caps = heroCaptions(plan.scenes, { quote: plan.quote, failText: plan.failText, speed: opts.speed, lead: 50 });
    writeFileSync(join(out, "video", "hero.vtt"), caps.vtt);
    writeFileSync(join(out, "video", "hero.transcript.txt"), caps.transcript + "\n");
    console.log(`\n  ${htmlPath}\n  ${join(out, "video", "hero.vtt")}`);
    if (opts.video) {
      const wide = await recordDemo({ htmlPath, outDir: out, name: "hero", query: `play=1&speed=${opts.speed}`, doneSelector: "#hero", width: 1920, height: 1080 });
      if (wide.mp4) trimHead(wide.mp4, 0.45);
      console.log(`  ${wide.mp4 || wide.webm}`);
      const square = await recordDemo({ htmlPath, outDir: out, name: "hero-square", query: `play=1&layout=square&speed=${opts.speed}`, doneSelector: "#hero", width: 1080, height: 1080 });
      if (square.mp4) trimHead(square.mp4, 0.45);
      console.log(`  ${square.mp4 || square.webm}`);
    }
    console.log("");
  });

program
  .command("web", { hidden: true })
  .description("The web cut, about 40 s: other sites' web probes as an anonymized grid → our own scan → the warning → the fix → the same request, before and after. Needs two scan.json files and an aggregate.json.")
  .requiredOption("--before <file>", "scan.json before the fix")
  .requiredOption("--after <file>", "scan.json after the fix")
  .requiredOption("--aggregate <file>", "aggregate.json from other sites (indices only, no names)")
  .requiredOption("--out <dir>", "output directory")
  .option("--label <text>", "run label shown in the corner", "run 01")
  .option("--host <text>", "how the corner names the site", "tansohq.com")
  .option("--cta <text>", "end card corner tag", "tansohq.com")
  .option("--button <text>", "end card button label", "Request yours")
  .option("--video", "record web.mp4 (1920×1080)")
  .option("--speed <x>", "playback speed multiplier while recording", parseFloat, 1)
  .action(async (opts) => {
    const readJson = (path) => {
      try { return JSON.parse(readFileSync(resolve(path), "utf8")); }
      catch (err) { throw new Error(`Could not read ${path}: ${err.message}`); }
    };
    const before = readJson(opts.before);
    const after = readJson(opts.after);
    const aggregate = readJson(opts.aggregate);
    const out = resolve(opts.out);
    mkdirSync(join(out, "video"), { recursive: true });
    const htmlPath = join(out, "web.html");
    const plan = webPlan(before, after, aggregate, { label: opts.label, host: opts.host, cta: opts.cta, button: opts.button });
    writeFileSync(htmlPath, plan.html);
    const caps = heroCaptions(plan.scenes, { speed: opts.speed, lead: 50 });
    writeFileSync(join(out, "video", "web.vtt"), caps.vtt);
    writeFileSync(join(out, "video", "web.transcript.txt"), caps.transcript + "\n");
    console.log(`\n  ${htmlPath}\n  ${join(out, "video", "web.vtt")}`);
    if (opts.video) {
      const wide = await recordDemo({ htmlPath, outDir: out, name: "web", query: `play=1&speed=${opts.speed}`, doneSelector: "#web", width: 1920, height: 1080 });
      if (wide.mp4) trimHead(wide.mp4, 0.45);
      console.log(`  ${wide.mp4 || wide.webm}`);
    }
    console.log("");
  });

program
  .command("export", { hidden: true })
  .description("Web-ready assets for every mp4 in the run's video/ folder: a VP9 or AV1 webm and a poster JPEG, ready for a <video> element")
  .requiredOption("--from <dir>", "run directory")
  .option("--only <names...>", "limit to these clip names, e.g. hero replay")
  .action((opts) => {
    const dir = resolve(opts.from);
    const made = webExports(join(dir, "video"), { only: opts.only || null });
    for (const m of made) console.log(`  ${basename(m.mp4)} → ${basename(m.webm || "(no webm)")} + ${basename(m.poster)} (${m.codec || "none"})`);
    console.log("");
  });

program
  .command("validate <file>", { hidden: true })
  .description("Validate a scan.json, audit.json, crash.json or report.json")
  .action((file) => {
    const doc = JSON.parse(readFileSync(resolve(file), "utf8"));
    const kind = String(doc.schema || "").replace("agent-ready/", "").replace(/@\d+$/, "");
    const validators = { scan: validateScan, audit: validateAudit, crash: validateCrash, report: validateReport, interface: validateInterface };
    if (!validators[kind]) {
      console.error(`unknown schema: ${doc.schema}`);
      process.exit(1);
    }
    try {
      validators[kind](doc);
      console.log(`ok: ${file} is a valid ${kind}`);
    } catch (err) {
      console.error(err.message);
      process.exit(1);
    }
  });

program
  .command("history", { hidden: true })
  .description("Show past runs from .alg/history.jsonl")
  .option("--url <url>", "filter by target")
  .action((opts) => {
    const lines = readHistory(process.cwd(), opts.url ? { url: opts.url } : null);
    if (!lines.length) {
      console.log("  No runs yet.");
      return;
    }
    for (const l of lines.slice(-20)) console.log(`  ${l.at.slice(0, 10)}  ${(l.target.url || l.target.dir).padEnd(32)} ${l.headline.cleared}/${l.headline.of}  stalled:${l.headline.stalledAt ?? "-"}  L${l.maturity}  [${l.providersRun.join("+")}]`);
  });

program.parseAsync(process.argv).catch((err) => {
  console.error(`Error: ${err.message}`);
  process.exit(1);
});
