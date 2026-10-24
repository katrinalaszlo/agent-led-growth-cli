import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildInterface } from "../interface/index.js";
import { buildFunnel } from "../interface/funnel.js";
import { PATTERNS } from "../interface/onboarding.js";
import { optionLabel } from "./questions.js";
import { promptTitle, renderPrompt } from "./prompts.js";

// Not audit.json / audit@1: the Claude Code skill writes that file, in another format, into the same run folder.
export const AUDIT_SCHEMA = "agent-ready/audit-report@1";
export const DEFAULT_TASK = "Sign up, get an API key, and make one authenticated read call";

// How each step's state was found. observed: read from a structured file or an HTTP status. heuristic: matched in page
// text. not_checked: public pages cannot show it. tested: a `test` run on this machine set it, the only way a step
// reads Agent did.
export function basisFor(step, doc) {
  if (step.live) return "tested";
  if (step.state === "not_applicable") return "observed";
  if (step.state === "not_checked") return "not_checked";
  if (step.id === "discover") return "observed";
  if (step.id === "understand") return doc.pricing?.agentCanDetermineCost?.verdict === "yes" ? "observed" : "heuristic";
  if (step.id === "access") return doc.authentication?.methods?.length ? "observed" : "heuristic";
  if (step.id === "use") return doc.interfaces?.api?.machineReadableSpec?.verdict === "yes" ? "observed" : "heuristic";
  if (step.id === "pay") return doc.pricing?.plans?.length && !doc.pricing?.agentPurchase ? "observed" : "heuristic";
  return "heuristic";
}

const SEVERITY = { blocked: "high", needs_person: "medium" };
export { PASSING } from "../dashboard/strip.js";
import { PASSING } from "../dashboard/strip.js";

// The product name from the page title, which often carries a tagline ("Resend · Email for developers",
// "Home \ Anthropic"). Keep the segment that names the host; otherwise the first one.
export function productName(doc) {
  const title = doc.product?.name?.value;
  if (!title) return doc.target.host;
  const parts = title.split(/\s+[·|\\—–-]\s+/).map((p) => p.trim()).filter(Boolean);
  const stem = doc.target.host.replace(/^www\./, "").split(".")[0].toLowerCase();
  return parts.find((p) => p.toLowerCase().replace(/[^a-z0-9]/g, "").includes(stem)) || parts[0] || doc.target.host;
}

// Inspect only: fetch public pages, build the interface document and the funnel. No questions, no files.
export async function inspect({ url, version, runId, log, fetchSource }) {
  const doc = await buildInterface({ url, version, runId, log, fetchSource });
  const funnel = buildFunnel(doc);
  return { doc, funnel };
}

// The address as typed, as a URL to audit, or null when it is not a web address. A bare domain gets https://;
// a bare localhost or IP gets http://, since local servers rarely serve TLS (a loop run failed on https://localhost).
const LOCAL = /^(localhost|\d{1,3}(\.\d{1,3}){3})(:\d+)?(\/|$)/i;
export function parseTarget(input) {
  const text = String(input || "").trim();
  if (!text) return null;
  let url;
  try {
    url = new URL(/^https?:\/\//i.test(text) ? text : `${LOCAL.test(text) ? "http" : "https"}://${text}`);
  } catch {
    return null; // Not a URL at all: the caller reports "not a web address" with an example.
  }
  const host = url.hostname;
  const looksReal = host === "localhost" || /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || /^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(host);
  return looksReal ? url.toString() : null;
}

// Why the homepage could not be read, or null when it loaded or answered with a status the funnel can judge.
// A 4xx is the product answering (a bot block is a finding); no answer or a 5xx means there is nothing to audit.
export function unreachableReason(doc) {
  const home = doc.observations.find((o) => o.role === "homepage");
  if (!home) return "No homepage was fetched.";
  if (home.status === 0) {
    const error = home.error || "";
    if (error.includes("ENOTFOUND")) return "No DNS record for this host.";
    if (error.includes("ECONNREFUSED")) return "The connection was refused.";
    if (error.startsWith("timeout")) return `No answer (${error}).`;
    return `No answer (${error || "no response"}).`;
  }
  if (home.status >= 500) return `The server answered ${home.status}.`;
  return null;
}

export function patternInfo(id) {
  return { id, ...PATTERNS[id] };
}

// Everything the audit reports, from the inspection and the answers. Pure, so it is tested without a network.
export function buildAudit({ doc, funnel, answers, task, runId, version }) {
  const pattern = patternInfo(answers.onboarding.value);
  // quotes: the sentences behind a claim that the product requires something, with the page each is on. A step a test
  // decided says what the test did instead, so it carries none.
  const urlOf = (obs) => doc.observations.find((o) => o.id === obs)?.url || null;
  const quotesOf = (s) => (!s.live && s.quotes?.length ? { quotes: s.quotes.map((q) => ({ ...q, url: urlOf(q.obs) })) } : {});
  const steps = funnel.steps.map((s) => ({ id: s.id, name: s.name, state: s.state, basis: basisFor(s, doc), reason: s.reason, basedOn: s.basedOn, ...quotesOf(s), ...(s.fix ? { fix: s.fix } : {}) }));
  // The chosen model is the target. A product whose docs only describe a person handing over a key passes Sign up
  // as a handoff, but if the owner chose an agent-first model, that handoff is the gap to close. Agent identity
  // counts: the agent is meant to sign in as itself (for example with AgentID), not take a key from a person.
  const agentFirst = pattern.id !== "existing_account";
  const gap = (s) => SEVERITY[s.state] || (agentFirst && s.id === "signup" && s.state === "handoff");
  const findings = steps
    .filter(gap)
    .map((s) => (SEVERITY[s.state] ? s : { ...s, state: "needs_person", reason: `Your onboarding model is ${pattern.name}, but the docs only describe a person creating the account and handing the agent a key.` }))
    .map((s, i) => ({ n: i + 1, step: s.id, name: s.name, severity: SEVERITY[s.state], reason: s.reason, basedOn: s.basedOn }))
    .map((f) => ({ ...f, title: promptTitle(f, pattern, answers), file: `${String(f.n).padStart(2, "0")}-${f.step}.md` }));
  return {
    schema: AUDIT_SCHEMA,
    generator: { name: "agent-ready", version, runId },
    target: doc.target,
    product: productName(doc),
    generatedAt: new Date().toISOString(),
    task,
    // The funnel's headline: documented and verified kept apart. verified counts steps a test proved; a funnel built
    // from public pages alone, as check builds it, has none.
    headline: funnel.headline,
    documented: funnel.documented,
    verified: funnel.verified,
    applicable: funnel.applicable ?? funnel.steps.filter((s) => s.state !== "not_applicable").length,
    pagesRead: doc.observations.filter((o) => o.ok).length,
    steps,
    onboarding: {
      chosen: { id: pattern.id, name: pattern.name, source: answers.onboarding.source },
      detected: funnel.paths.map((p) => ({ id: p.id, name: p.name, status: p.status })),
    },
    answers: Object.fromEntries(Object.entries(answers).map(([k, a]) => [k, { value: a.value, label: optionLabel(k, a.value), source: a.source }])),
    findings,
    limits: doc.limits,
  };
}

// A one-page brief for the people who decide the questions the CLI asked: security, legal, billing.
export function renderBrief(audit, doc) {
  const evidence = (ids) => [...new Set(ids.map((id) => doc.observations.find((o) => o.id === id)?.url).filter(Boolean))].slice(0, 3);
  const lines = [
    `# Agent onboarding brief: ${audit.product}`,
    "",
    `${audit.target.url} · checked ${audit.generatedAt.slice(0, 10)} · public pages only (${audit.pagesRead} read)`,
    "",
    `**${audit.headline}**`,
    "",
    "## Recommended onboarding model",
    "",
    `${audit.onboarding.chosen.name} (${audit.onboarding.chosen.source}). A person steps in: ${patternInfo(audit.onboarding.chosen.id).humanBoundary}`,
    "",
    audit.onboarding.detected.length
      ? `What the docs describe today: ${audit.onboarding.detected.map((p) => `${p.name} (${p.status})`).join("; ")}.`
      : "The docs read describe no way for an agent to start. That is not proof none exists.",
    "",
    "## Decisions to confirm",
    "",
    "| Question | Answer | Who should confirm |",
    "| --- | --- | --- |",
    `| Who holds the account when an agent first uses it? | ${audit.answers.onboarding.label} | Product |`,
    `| What does one abusive free account cost? | ${audit.answers.abuse_cost.label} | Security |`,
    `| Must a verified person exist before the agent acts? | ${audit.answers.human_before.label} | Legal, compliance |`,
    "",
  ];
  if (audit.answers.human_before.value === "always" && audit.onboarding.chosen.id !== "existing_account") {
    lines.push(`Conflict: a verified person must exist before any use, but ${audit.onboarding.chosen.name} lets an agent act first. Consider "A person sets up access first".`, "");
  }
  lines.push("## Steps", "", "| Step | State | How we know | Evidence |", "| --- | --- | --- | --- |");
  for (const s of audit.steps) lines.push(`| ${s.name} | ${s.state.replace("_", " ")} | ${s.basis.replace("_", " ")} | ${evidence(s.basedOn).join(", ") || "none"}${(s.quotes || []).map((q) => `<br>"${q.quote.replace(/\|/g, "\\|")}"`).join("")} |`);
  lines.push("", "## Fixes", "");
  if (!audit.findings.length) lines.push("None from public pages. A test with a real agent is the next step: `npx agent-led-growth test --check` shows the plan for free, `npx agent-led-growth test` runs it.");
  for (const f of audit.findings) lines.push(`${f.n}. **${f.title}** (${f.severity}, ${f.name}). Prompt: prompts/${f.file}`);
  lines.push("", "## What this check cannot show", "", ...audit.limits.map((l) => `- ${l}`), "- payment, KYC and claim decisions by a real person were not tested", "");
  return lines.join("\n");
}

export function writeAudit({ audit, doc, out }) {
  const promptsDir = join(out, "prompts");
  mkdirSync(promptsDir, { recursive: true });
  const pattern = patternInfo(audit.onboarding.chosen.id);
  const answers = Object.fromEntries(Object.entries(audit.answers).map(([k, a]) => [k, { value: a.value }]));
  const bodies = [];
  for (const f of audit.findings) {
    const body = renderPrompt({ finding: f, pattern, answers, doc, product: audit.product, url: audit.target.url });
    writeFileSync(join(promptsDir, f.file), body);
    bodies.push(body);
  }
  if (bodies.length) writeFileSync(join(promptsDir, "ALL.md"), bodies.join("\n---\n\n"));
  writeFileSync(join(out, "interface.json"), JSON.stringify(doc, null, 2));
  // check writes the report before the benchmarks and again after them; through a temporary file and a rename, a
  // reader never sees half of it.
  writeFileSync(join(out, "audit-report.json.tmp"), JSON.stringify(audit, null, 2));
  renameSync(join(out, "audit-report.json.tmp"), join(out, "audit-report.json"));
  writeFileSync(join(out, "brief.md"), renderBrief(audit, doc));
  return { folder: out, promptsDir, brief: join(out, "brief.md"), json: join(out, "audit-report.json") };
}
