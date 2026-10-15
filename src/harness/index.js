import { mkdirSync, writeFileSync, existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { buildInterface } from "../interface/index.js";
import { runJourney } from "../interface/journey.js";
import { execute } from "./execute.js";
import { reconcile } from "./reconcile.js";
import { evaluateOnboarding } from "./onboarding.js";
import { resolveCredentials } from "./secrets.js";
import { persona as makePersona } from "./persona.js";
import { createInbox, startPolling, deleteInbox } from "./mail.js";
import * as stripeSubscription from "./tasks/stripe-subscription.js";
import * as agentmailSend from "./tasks/agentmail-send.js";
import { SIGNUP_TASKS } from "./tasks/signup.js";
import * as payX402 from "./tasks/pay-x402.js";
import * as payStripeProjects from "./tasks/pay-stripe-projects.js";

export const TASKS = { [stripeSubscription.task.id]: stripeSubscription, [agentmailSend.task.id]: agentmailSend, ...Object.fromEntries(SIGNUP_TASKS.map((t) => [t.task.id, t])), ...Object.fromEntries(payX402.TASKS.map((t) => [t.id, { task: t, evaluate: (args) => payX402.evaluate({ ...args, credentialEnvName: t.credentialEnvName, verifyKey: t.verifyKey }) }])), [payStripeProjects.task.id]: payStripeProjects };
export const MODES = ["signup", "given", "none"];

// Inspect → journey (rules) → execute (agent, confined) → evaluate (deterministic) → reconcile. One task, one product.
// mode signup: the agent signs up as a synthetic persona with its own inbox and must obtain its own key (creates an
// account; needs the operator's explicit go). mode given: the key is injected. mode none: no credential, stop early.
// taskModule: a task built at run time (agent-ready verify builds one from agent-ready.yml) instead of a built-in id.
// noInbox: signup without any mailbox, for products whose agent signup needs no email.
export async function runHarness({ taskId, taskModule = null, runId, outDir, version, mode = null, inboxAddress = null, noInbox = false, executorName, maxTurns, maxBudgetUsd = null, model, log = () => {} }) {
  const mod = taskModule || TASKS[taskId];
  if (!mod) throw new Error(`unknown task ${taskId}; known: ${Object.keys(TASKS).join(", ")}`);
  const credentials = resolveCredentials(mod.task);
  for (const r of credentials.rejected) throw new Error(`${r.env} rejected: ${r.reason}`);
  mode = mode || (credentials.available.length ? "given" : "none");
  if (!MODES.includes(mode)) throw new Error(`mode must be one of ${MODES.join(", ")}`);
  if (mode === "given" && !credentials.available.length) throw new Error(`mode given needs ${mod.task.credentials.map((c) => c.env).join(", ")}`);
  mkdirSync(outDir, { recursive: true });
  const workDir = join(outDir, "work");
  log({ step: "secrets", text: mode === "given" ? `credential injected (${credentials.available.join(", ")}); values never logged` : mode === "signup" ? "no credential injected; agent must obtain its own" : `no credential (${credentials.missing.join(", ")} not set); run will stop at credential_required` });

  // Mailbox for signup mode. The agent only ever sees files in work/inbox/.
  let inbox = null;
  let persona = null;
  let mailKey = null;
  if (mode === "signup" && noInbox) {
    persona = makePersona({ runId, email: null });
    log({ step: "mail", text: "no inbox: the agent signs up without email, or stops where the product asks for one" });
  } else if (mode === "signup") {
    mailKey = process.env.AGENTMAIL_API_KEY || null;
    if (mailKey) credentials.learn(mailKey);
    const provider = mailKey ? "agentmail-rest" : "relay";
    inbox = await createInbox({ runId, provider, key: mailKey, redact: credentials.redact });
    if (provider === "relay") {
      if (!inboxAddress) throw new Error("signup mode without AGENTMAIL_API_KEY needs --inbox <address> of an inbox you will relay into work/inbox/");
      inbox.email = inboxAddress;
    }
    persona = makePersona({ runId, email: inbox.email });
    log({ step: "mail", text: `${inbox.provider}: ${inbox.email}${provider === "relay" ? ` (drop messages as JSON into ${join(workDir, "inbox")})` : ""}` });
  }

  log({ step: "inspect", text: mod.task.url });
  const doc = await buildInterface({ url: mod.task.url, version, runId });
  writeFileSync(join(outDir, "interface.json"), JSON.stringify(doc, null, 2));

  const journey = runJourney(doc, mod.task.text, { runId });
  writeFileSync(join(outDir, "journey.json"), JSON.stringify(journey, null, 2));
  log({ step: "journey", text: journey.failure ? `rules stop at ${journey.failure.stage}` : journey.unresolved?.length ? `${journey.unresolved.length} stage(s) remain unresolved from public evidence` : "rules support every evidence-based stage" });

  log({ step: "execute", text: `${executorName} in ${workDir}; mode ${mode}; network ${mod.task.network.join(", ")}${mod.task.sandbox?.enabled === false ? "; Bash runs outside the sandbox (the task's CLI cannot run inside it)" : ""}` });
  mkdirSync(workDir, { recursive: true });
  // A task that reads the operator's own state before the agent runs (Stripe Projects: the project files and the
  // charges so far) does it here; the evaluator gets what it read as `prepared`.
  const prepared = mod.prepare ? await mod.prepare({ workDir, mode, env: process.env, log: (text) => log({ step: "prepare", text }) }) : null;
  const poller = inbox ? startPolling({ workDir, inbox, key: mailKey, log: (e) => log({ step: "agent", ...e }) }) : null;
  const execution = await execute({
    task: mod.task, runId, doc, workDir, credentials, mode, persona, executorName, maxTurns, maxBudgetUsd, model,
    afterRun: async () => ({ mail: inbox ? { provider: inbox.provider, email: inbox.email, delivered: poller.stop() } : null }),
    log: (e) => log({ step: "agent", ...e }),
  });

  log({ step: "evaluate", text: `${mod.task.criteria.local.length} local checks${mode === "none" ? ", live checks skipped (credential_required)" : `, ${mod.task.criteria.live.length} live checks if a key exists`}` });
  const files = {
    read: (name) => (existsSync(join(workDir, name)) ? credentials.redact(readFileSync(join(workDir, name), "utf8")) : null),
    readRaw: (name) => (existsSync(join(workDir, name)) ? readFileSync(join(workDir, name), "utf8") : null),
  };
  const inboxDir = join(workDir, "inbox");
  const inboxFiles = existsSync(inboxDir) ? readdirSync(inboxDir).filter((f) => f.endsWith(".json")).map((f) => JSON.parse(readFileSync(join(inboxDir, f), "utf8"))) : [];
  const evaluation = await mod.evaluate({ runId, files, credentials, mode, inboxFiles, harnessMailKey: mailKey, prepared, workDir });
  // CREDENTIAL.env was read raw by the evaluator; now remove it so no acquired key stays on disk.
  if (existsSync(join(workDir, "CREDENTIAL.env"))) writeFileSync(join(workDir, "CREDENTIAL.env"), readFileSync(join(workDir, "CREDENTIAL.env"), "utf8").replace(/^(\s*[A-Z0-9_]+\s*=).*$/gm, "$1<redacted after evaluation>"));
  writeFileSync(join(outDir, "evaluation.json"), JSON.stringify(evaluation, null, 2));

  if (inbox?.provider === "agentmail-rest") log({ step: "mail", text: (await deleteInbox({ inbox, key: mailKey })) ? "inbox deleted" : "inbox kept" });

  const result = reconcile({ journey, execution, evaluation, doc });
  // Onboarding rules need the tool results, which reconcile leaves out of journey.json; score them here while execution still has events.
  result.onboarding = evaluateOnboarding({ execution, evaluation, resultMd: files.read("RESULT.md"), needsHumanMd: files.read("NEEDS_HUMAN.md") });
  writeFileSync(join(outDir, "journey.json"), JSON.stringify(result, null, 2));
  return result;
}
