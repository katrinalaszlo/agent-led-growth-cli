import { STAGES } from "../schema/stages.js";
import { FIX, summarize } from "./funnel.js";

// Every kind of run fills in the same seven steps. A check sets a step from public pages; this folds in what else is
// known about the product and records, per step, what set it. State-bearing evidence (a test, a payment, the
// product's own server) decides the state, latest first. A stuck report never changes a state; it is attached so the
// step can say agents got stuck there. Inconclusive tests and runs waiting for a person change nothing either.
//
// Each step gains evidence: [{ kind: test|pay|signal|stuck, at, reason, runId?, outcome?, count? }], newest first.
// The deciding test also sets step.live (runId, name, outcome, at) for callers that already read it.
export function applyEvidence(funnel, { runs = [], pay = null, signals = null, stuck = [] } = {}) {
  const byStep = new Map(STAGES.map((id) => [id, []]));
  const add = (step, entry) => { if (byStep.has(step)) byStep.get(step).push(entry); };

  for (const run of runs) {
    if (run.kind && run.kind !== "usability") continue;
    if (!STAGES.includes(run.step)) continue;
    const at = run.completedAt || run.updatedAt || "";
    const name = run.flowName || run.name || "Test";
    if (run.outcome === "passed") add(run.step, { kind: "test", at, runId: run.id, name, outcome: "passed", state: "agent_did", reason: `The agent did this step: ${name} passed its check.` });
    else if (run.outcome === "handoff") add(run.step, { kind: "test", at, runId: run.id, name, outcome: "handoff", state: "handoff", reason: `A person stepped in once and the agent carried on: ${name} passed its check.` });
    else if (run.outcome === "blocked") add(run.step, { kind: "test", at, runId: run.id, name, outcome: "blocked", state: "blocked", reason: `The agent was stopped here: ${run.summary || name}` });
    else if (run.outcome) add(run.step, { kind: "test", at, runId: run.id, name, outcome: run.outcome, reason: run.summary || `${name} ended ${run.outcome.replace(/_/g, " ")}.` });
  }

  if (pay) {
    const at = pay.verifiedAt || pay.at || "";
    if (pay.outcome === "paid") add("pay", { kind: "pay", at, runId: pay.runId || null, outcome: "paid", state: "agent_did", reason: paidReason(pay) });
    else if (pay.outcome) add("pay", { kind: "pay", at, runId: pay.runId || null, outcome: pay.outcome, reason: pay.outcome === "stopped" ? "The agent stopped before paying." : "The agent tried to pay and the payment did not go through." });
  }

  if (signals) {
    const agents = Object.values(signals).filter((record) => record.source === "agent");
    const seen = (field, step, what) => {
      const dated = agents.filter((record) => record[field]).map((record) => record[field]).sort();
      if (!dated.length) return;
      const n = dated.length;
      add(step, { kind: "signal", at: dated[n - 1], count: n, state: "agent_did", reason: `Your server saw ${n} agent account${n === 1 ? "" : "s"} ${what}.` });
    };
    seen("signupAt", "signup", "sign up");
    seen("firstCallAt", "use", "make a first call");
    seen("purchaseAt", "pay", "pay");
  }

  const stuckBy = new Map();
  for (const report of stuck) {
    if (!STAGES.includes(report.step)) continue;
    const entry = stuckBy.get(report.step) || { kind: "stuck", at: "", count: 0 };
    entry.count += 1;
    if ((report.at || "") > entry.at) entry.at = report.at || "";
    stuckBy.set(report.step, entry);
  }
  for (const [step, entry] of stuckBy) add(step, { ...entry, reason: `${entry.count} agent${entry.count === 1 ? "" : "s"} reported being stuck here.` });

  if (![...byStep.values()].some((list) => list.length)) return funnel;

  const steps = funnel.steps.map((step) => {
    const evidence = (byStep.get(step.id) || []).sort((a, b) => (b.at > a.at ? 1 : b.at < a.at ? -1 : 0));
    if (!evidence.length) return step;
    const deciding = evidence.find((entry) => entry.state);
    if (!deciding) return { ...step, evidence };
    const { fix, live, ...rest } = step;
    const next = { ...rest, state: deciding.state, reason: deciding.reason, evidence };
    if (deciding.kind === "test") next.live = { runId: deciding.runId, name: deciding.name, outcome: deciding.outcome, at: deciding.at || null };
    if (deciding.state === "blocked") next.fix = FIX[step.id];
    return next;
  });
  return { ...funnel, ...summarize(steps), steps };
}

// The server's and the dashboard's callers pass only test runs. Same result as before.
export function applyLiveTests(funnel, runs) {
  return applyEvidence(funnel, { runs: (runs || []).filter((run) => ["passed", "blocked"].includes(run.outcome)) });
}

function paidReason(pay) {
  const usd = typeof pay.paidUsd === "number" ? `$${pay.paidUsd.toFixed(2)}` : "a payment";
  if (pay.protocol === "stripe-projects") return `A test proved this: the agent paid ${usd} through Stripe Projects for ${pay.provider} ${pay.service}.`;
  return `A test proved this: the agent paid ${usd} over x402 for one call.`;
}
