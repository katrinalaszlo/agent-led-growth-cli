import { wrap } from "../audit/render.js";

// Terminal output for `agent-ready test`, in the same layout as audit: one row per check, the result after.

const OUTCOME = { passed: "PASS", handoff: "PASS (handoff)", failed: "FAIL", inconclusive: "INCONCLUSIVE" };

// Same units as the dashboard's timing line: "850 ms", "42 s", "2 min 10 s".
export function duration(ms) {
  if (ms < 1000) return `${ms} ms`;
  if (ms < 60000) return `${Math.round(ms / 1000)} s`;
  return `${Math.floor(ms / 60000)} min ${Math.round((ms % 60000) / 1000)} s`;
}

function mark(pass, style) {
  if (pass === true) return style.green("✓");
  if (pass === false) return style.red("✗");
  return style.dim("·");
}

export function verifyRows(result) {
  const evaluation = result.evaluation || {};
  const acquired = (evaluation.checks || []).find((c) => c.id === "credential_acquired");
  const rows = [{ label: "Got a key", pass: acquired ? acquired.pass : false, detail: acquired ? (acquired.pass ? "the agent got its own key; redacted from every file" : acquired.detail) : "no key" }];
  const checks = evaluation.objects?.checks || [];
  if (checks.length) for (const c of checks) rows.push({ label: c.label, pass: c.pass, detail: c.detail });
  else rows.push({ label: "Key works", pass: null, detail: "not checked: no key to try" });
  return rows;
}

export function renderVerify({ host, task, result, verdict, folder, promptFile }, style) {
  const out = ["", `  ${style.bold("agent-ready test")} · ${host}`, ...wrap(`Task: ${task}`, 76).map((l) => `  ${style.dim(l)}`), ""];
  // Same width rule as audit: every line fits 80 columns, continuation lines indented under the detail.
  for (const r of verifyRows(result)) {
    const [first = "", ...rest] = wrap(r.detail, 80 - 23);
    out.push(`  ${mark(r.pass, style)} ${r.label.padEnd(18)} ${first}`);
    for (const line of rest) out.push(`${" ".repeat(23)}${line}`);
  }
  const paint = verdict.outcome === "passed" || verdict.outcome === "handoff" ? style.green : verdict.outcome === "failed" ? style.red : (s) => s;
  out.push("", `  ${style.bold(paint(OUTCOME[verdict.outcome]))}  ${verdict.reason}`);
  const execution = result.execution || {};
  const cost = typeof execution.costUsd === "number" ? ` · $${execution.costUsd.toFixed(2)}` : "";
  const ran = typeof execution.durationMs === "number" ? `ran ${duration(execution.durationMs)} · ` : "";
  out.push(`  ${style.dim(`${ran}${execution.turns ?? "?"} turns${cost} · evidence in ${folder}/`)}`);
  if (promptFile) out.push("", `  ${style.bold("Next")}  paste ${promptFile} into your coding agent,`, `        then deploy, run ${style.bold(`npx @tansohq/agent-ready check ${host}`)} again,`, "        and test again");
  else if (verdict.outcome === "passed" || verdict.outcome === "handoff") out.push("", ...wrap("Keep it passing: app.tansohq.com runs this test on a schedule and emails you when it breaks (5 free runs a month).", 76).map((l) => `  ${style.dim(l)}`));
  out.push("");
  return out;
}

// `test --check`: what a run would do, in the same row layout, so the one paid run holds no surprises.
export function renderPlan(plan, style) {
  const out = ["", `  ${style.bold("agent-ready test --check")} · ${plan.target.host}`, ...wrap(`Task: ${plan.task}`, 76).map((l) => `  ${style.dim(l)}`), ""];
  const row = (pass, label, detail) => {
    const [first = "", ...rest] = wrap(detail, 80 - 23);
    out.push(`  ${mark(pass, style)} ${label.padEnd(18)} ${first}`);
    for (const line of rest) out.push(`${" ".repeat(23)}${line}`);
  };
  row(plan.claudeCode.ok, "Claude Code", plan.claudeCode.detail);
  row(null, "Agent may reach", plan.agent.hosts.join(", "));
  row(null, "Inbox", plan.agent.inbox);
  row(null, "Limits", `${plan.agent.maxTurns} turns, $${plan.agent.maxBudgetUsd} of model use (checked after each turn, so a run can end slightly above it)`);
  row(null, "Agent saves", `${plan.agent.saves.join(" and ")} in work/CREDENTIAL.env (the harness asks for them; the task need not)`);
  row(null, "Checker calls", plan.checker.call);
  if (plan.checker.inferred) {
    row(null, "API host", `${plan.checker.apiHost} (from ${plan.checker.inferredFrom}${plan.checker.inferredVia ? `, linked from ${plan.checker.inferredVia}` : ""})`);
    if (plan.checker.apiHostOffSite) row(null, "", `This API host is on a different site than ${plan.target.host}; the key the agent gets is sent there.`);
    row(null, "", "inferred; set verify_call in agent-ready.yml to choose another");
  }
  for (const c of plan.checker.calls) row(null, "", c);
  out.push("");
  if (plan.ready) out.push(`  ${style.bold(style.green("READY"))}  Nothing ran. Start the agent with ${style.bold("npx @tansohq/agent-ready test")}`);
  else out.push(`  ${style.bold(style.red("NOT READY"))}  ${plan.claudeCode.hint}`);
  for (const warning of plan.warnings || []) for (const line of wrap(warning, 76)) out.push(`  ${style.yellow(line)}`);
  out.push(`  ${style.dim("A host the agent needs is missing? Add it to verify_hosts in agent-ready.yml.")}`, "");
  return out;
}
