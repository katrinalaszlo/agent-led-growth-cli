import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { OUT_DIR } from "../history/index.js";
import { buildFunnel } from "../interface/funnel.js";
import { applyEvidence } from "../interface/evidence.js";
import { latestInterface } from "./infer.js";

// The seven steps for one product from what this machine has: the newest check's interface.json, with every `test`
// run's verify.json applied the way the hosted product applies its runs. Nothing is fetched.

// A run folder is named by its run id, which starts with the time it ran ("2026-10-15T22-35-47-…").
const folderTime = (name) => name.replace(/^(\d{4}-\d\d-\d\dT\d\d)-(\d\d)-(\d\d).*$/, "$1:$2:$3Z");

// What one signup test says about the steps. Passed and handoff prove Sign up and Access; a failure stops at the step
// the checker named; inconclusive is attached to Sign up and changes nothing.
export function runsFromVerify(summary, at) {
  const base = { kind: "usability", id: summary.runId, name: "Your test", completedAt: summary.at || at, summary: summary.reason };
  if (summary.outcome === "passed") return [{ ...base, step: "signup", outcome: "passed" }, { ...base, step: "access", outcome: "passed" }];
  if (summary.outcome === "handoff") return [{ ...base, step: "signup", outcome: "handoff" }, { ...base, step: "access", outcome: "passed" }];
  if (summary.outcome === "failed") return [{ ...base, step: summary.step || "signup", outcome: "blocked" }];
  if (summary.outcome === "inconclusive") return [{ ...base, step: "signup", outcome: "inconclusive" }];
  return [];
}

export function localTestRuns(cwd, url) {
  const dir = join(cwd, OUT_DIR, new URL(url).host);
  if (!existsSync(dir)) return [];
  const runs = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name, "verify.json");
    if (!existsSync(path)) continue;
    runs.push(...runsFromVerify(JSON.parse(readFileSync(path, "utf8")), folderTime(name)));
  }
  return runs;
}

// Null when this machine has never checked the product: the strip needs a check to start from.
export function localJourney(cwd, url) {
  const latest = latestInterface(cwd, url);
  if (!latest) return null;
  return applyEvidence(buildFunnel(latest.doc), { runs: localTestRuns(cwd, url) });
}
