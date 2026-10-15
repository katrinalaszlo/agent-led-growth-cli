// Puts the extractor's stage verdicts (journey@1, from evidence) beside what the agent actually did (trace) and
// what the evaluator found (scratch files, product state). The interesting output is the discrepancy column.
// Agent outcomes: passed | failed | human_required | credential_required | not_reached | not_applicable | skipped.

function hostOf(u) {
  try {
    return new URL(u).host.replace(/^www\./, "");
  } catch {
    return "";
  }
}

function stageFromRun(name, { execution, evaluation, doc }) {
  const productHost = hostOf(doc.target.url);
  const firstParty = execution.sources.filter((u) => hostOf(u).endsWith(productHost));
  const apiHost = execution.task?.apiHost || "api.stripe.com";
  const calledApi = execution.commands.some((c) => c.includes(apiHost)) || execution.sources.some((u) => u.includes(apiHost));
  const mode = execution.mode;
  const check = (id) => evaluation.checks.find((c) => c.id === id);
  const plan = execution.files.plan;
  const acquired = check("credential_acquired");
  const hasKey = mode === "given" || (mode === "signup" && acquired?.pass);
  switch (name) {
    case "discover":
      return { outcome: firstParty.length ? "passed" : "failed", basis: firstParty.length ? `agent read ${firstParty.length} first-party page(s): ${firstParty.slice(0, 4).join(", ")}` : "agent fetched no first-party page", rule: "agent_fetched_first_party_page" };
    case "understand":
      return { outcome: check("plan_written")?.pass ? "passed" : "failed", basis: check("plan_written")?.detail || "no plan", rule: "plan_written_with_interface_and_auth_source" };
    case "choose_interface": {
      const named = plan ? (plan.match(/\bMCP\b|\bCLI\b|\bAPI\b/i) || [null])[0] : null;
      return { outcome: named ? "passed" : "failed", basis: named ? `PLAN.md names ${named.toUpperCase()}` : plan ? "PLAN.md names no interface" : "no plan", rule: "plan_names_interface" };
    }
    case "acquire_credential": {
      if (mode === "given") return { outcome: "skipped", basis: "credential was injected; signup not attempted", rule: "credential_acquired_and_authenticates" };
      if (mode === "none") return { outcome: "skipped", basis: "signup not attempted (mode none)", rule: "credential_acquired_and_authenticates" };
      if (acquired?.pass) return { outcome: "passed", basis: acquired.detail, rule: "credential_acquired_and_authenticates", mail: execution.mail?.delivered?.length ?? 0 };
      if (acquired?.status === "human_required") return { outcome: "human_required", basis: acquired.detail, rule: "credential_acquired_and_authenticates", mail: execution.mail?.delivered?.length ?? 0 };
      // The agent may run out of turns before recording the wall it hit. The trace still shows it.
      const wall = execution.signals?.captcha ? ` Trace shows a CAPTCHA on the signup surface (${execution.signals.captcha}); the agent stopped (${execution.stoppedBecause}) without recording it.` : "";
      if (execution.signals?.serverErrors >= 3) return { outcome: "product_unavailable", basis: `${execution.signals.serverErrors} tool results carried 5xx responses from the product; the documented signup path was unavailable during the run (${execution.stoppedBecause}).` + wall, rule: "credential_acquired_and_authenticates", mail: execution.mail?.delivered?.length ?? 0, signals: execution.signals };
      return { outcome: "failed", basis: (acquired?.detail || "no key obtained") + wall, rule: "credential_acquired_and_authenticates", mail: execution.mail?.delivered?.length ?? 0, signals: execution.signals || null };
    }
    case "authenticate": {
      if (!hasKey) {
        if (mode === "signup") return { outcome: "not_reached", basis: "no working credential was acquired", rule: "evaluator_found_tagged_object" };
        const documented = check("credential_need_documented")?.pass;
        return { outcome: "credential_required", basis: documented ? `agent identified the credential it needs and where it is obtained (${check("credential_need_documented").detail}); no credential was available to this run` : `no credential was available and the agent did not document what it needs (${check("credential_need_documented")?.detail || "no NEEDS_CREDENTIAL.md"})`, rule: "no_credential_then_need_documented", documented: Boolean(documented) };
      }
      if (evaluation.stoppedAt === "evaluator_auth_failed") return { outcome: "not_reached", basis: check("customer_created")?.detail || "evaluator could not read the account", rule: "evaluator_found_tagged_object" };
      // A credential the agent acquired but the evaluator's own call rejects is an authenticate failure, not "not reached".
      if (evaluation.stoppedAt === "credential_rejected") return { outcome: "failed", basis: `the acquired credential was rejected by the evaluator's verify call: ${check("credential_works")?.detail || "no detail"}`, rule: "evaluator_confirmed_authenticated_call" };
      const authed = evaluation.authenticated === true || check("customer_created")?.pass === true;
      return { outcome: authed ? "passed" : calledApi ? "failed" : "not_reached", basis: authed ? "an authenticated call reached the product (evaluator confirmed with the credential)" : calledApi ? "agent called the API but nothing authenticated" : "agent never called the API", rule: "evaluator_confirmed_authenticated_call" };
    }
    case "execute":
      if (!hasKey) return { outcome: mode === "signup" ? "not_reached" : "credential_required", basis: execution.files.request ? "agent prepared request.sh with the exact calls; not sent" : "not reachable without a credential", rule: "evaluator_criteria" };
      if (evaluation.stoppedAt === "evaluator_auth_failed") return { outcome: "not_reached", basis: "evaluator could not read the account", rule: "evaluator_criteria" };
      // A key that works, then a step only a person can pass (an account tier gate before a payment): the product stopped the agent, the agent did not fail.
      if (evaluation.stoppedAt === "human_required") return { outcome: "human_required", basis: evaluation.checks.find((c) => c.status === "human_required" && c.tier === "local")?.detail || "agent stopped at a step for a person", rule: "evaluator_criteria" };
      return { outcome: evaluation.success ? "passed" : evaluation.authenticated || check("customer_created")?.pass ? "failed" : "not_reached", basis: evaluation.checks.filter((c) => c.tier === "live").map((c) => `${c.id}: ${c.pass ? "pass" : "fail"} (${c.detail})`).join("; "), rule: "evaluator_criteria" };
    case "recover":
      if (!hasKey) return { outcome: mode === "signup" ? "not_reached" : "credential_required", basis: "depends on execute", rule: "errors_then_success" };
      if (evaluation.stoppedAt === "evaluator_auth_failed") return { outcome: "not_reached", basis: "evaluator could not read the account", rule: "errors_then_success" };
      if (evaluation.stoppedAt === "human_required") return { outcome: "not_reached", basis: "agent stopped at a step for a person", rule: "errors_then_success" };
      if (!calledApi) return { outcome: "not_reached", basis: "agent never called the API", rule: "errors_then_success" };
      if (!execution.errors.length) return { outcome: "not_applicable", basis: "no tool errors occurred", rule: "errors_then_success" };
      return { outcome: evaluation.success ? "passed" : "failed", basis: `${execution.errors.length} error(s), ${execution.recoveryAttempts} action(s) after the first error; final state ${evaluation.success ? "meets" : "does not meet"} the criteria`, rule: "errors_then_success" };
    default:
      return { outcome: "not_reached", basis: "", rule: null };
  }
}

export function reconcile({ journey, execution, evaluation, doc }) {
  const stages = journey.stages.map((s) => {
    const agent = stageFromRun(s.stage, { execution, evaluation, doc });
    const extractor = s.status === "success" ? "passed" : s.status === "failed" ? "failed" : s.status;
    const comparable = ["passed", "failed"].includes(extractor) && ["passed", "failed"].includes(agent.outcome);
    const discrepancy = comparable && extractor !== agent.outcome;
    return { stage: s.stage, extractor: { outcome: extractor, reason: s.reason, basedOn: s.basedOn }, agent, discrepancy };
  });
  const discrepancies = stages
    .filter((s) => s.discrepancy)
    .map((s) => (s.extractor.outcome === "failed" ? `${s.stage}: structured extraction could not establish this; the agent resolved it during execution (${s.agent.basis}).` : `${s.stage}: extraction judged this possible from evidence; the agent did not accomplish it (${s.agent.basis}).`));
  const stopped = stages.find((s) => ["failed", "human_required", "credential_required", "product_unavailable"].includes(s.agent.outcome)) || null;
  return {
    ...journey,
    execution: {
      executor: execution.executor,
      task: execution.task || null,
      mode: execution.mode,
      persona: execution.persona,
      mail: execution.mail,
      signals: execution.signals || null,
      credentials: execution.credentials,
      turns: execution.turns,
      durationMs: execution.durationMs,
      costUsd: execution.costUsd,
      toolCalls: execution.toolCalls,
      sources: execution.sources,
      commands: execution.commands,
      errors: execution.errors,
      denied: execution.denied,
      recoveryAttempts: execution.recoveryAttempts,
      stoppedBecause: execution.stoppedBecause,
      files: execution.files,
    },
    evaluation,
    reconciled: { stages, success: evaluation.success, stoppedAt: stopped ? { stage: stopped.stage, outcome: stopped.agent.outcome, reason: stopped.agent.basis } : null, discrepancies },
  };
}
