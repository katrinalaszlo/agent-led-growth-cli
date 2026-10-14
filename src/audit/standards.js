import { writeFileSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { runAeoReady as spawnAeoReady } from "../scan/index.js";

const require = createRequire(import.meta.url);

// The aeo-ready catalog: five third-party benchmarks of a product's public surface (agentic-seo, Cloudflare, Fern,
// Vercel, AgentGrade). Their checks and their scores, kept apart from the seven steps, which they never change.
export const BENCHMARKS = [
  { id: "agenticSeo", name: "agentic-seo" },
  { id: "cloudflare", name: "Cloudflare" },
  { id: "fern", name: "Fern" },
  { id: "vercel", name: "Vercel" },
  { id: "agentgrade", name: "AgentGrade" },
];

export function aeoReadyVersion() {
  return require("aeo-ready/package.json").version;
}

// A benchmark reports each check as pass, ok, fail, warn or skip. aeo-ready's own output counts warn as failed and
// leaves skip out, so this does the same. agentic-seo reports categories only, so it has no checks to count.
// The values come from a third-party CLI's JSON and end up in a page, so a score is a finite number or null and a
// grade or check id is a string.
const number = (value) => (value === null || value === undefined || value === "" || !Number.isFinite(Number(value)) ? null : Number(value));
function shapeBenchmark({ id, name }, b) {
  if (!b || b.available === false) return { id, name, score: null, maxScore: null, grade: null, passed: 0, total: 0, failed: [], error: b?.reason ? String(b.reason) : "did not run" };
  const checks = (b.checks || []).filter((c) => c.status !== "skip");
  return {
    id,
    name,
    score: number(b.score),
    maxScore: number(b.maxScore),
    grade: b.grade ? String(b.grade) : null,
    passed: checks.filter((c) => c.status === "pass" || c.status === "ok").length,
    total: checks.length,
    failed: checks.filter((c) => c.status === "fail" || c.status === "warn").map((c) => String(c.id)),
    error: null,
  };
}

// The `standards` field of audit-report@1, from what runAeoReady returned.
export function shapeStandards({ result, warnings, error }, version) {
  return {
    generator: { name: "aeo-ready", version },
    averageScore: number(result?.averageScore),
    benchmarks: result ? BENCHMARKS.map((b) => shapeBenchmark(b, result.benchmarks?.[b.id])) : [],
    warnings,
    error,
  };
}

// Runs the catalog for url and writes aeo-ready's own JSON to <out>/aeo-ready.json. Spawns npx inside aeo-ready and
// takes 1-3 minutes. AGENT_READY_AEO_CLI names another aeo-ready CLI script to run instead of the installed one.
// Returns the `standards` object and the raw file's path (null when aeo-ready gave no result; its error is in
// standards.error, never dropped).
export async function runStandards({ url, out, timeoutMs = undefined, runAeoReady = spawnAeoReady, env = process.env }) {
  mkdirSync(out, { recursive: true });
  const r = await runAeoReady({ url, cwd: join(out, "vendor"), cli: env.AGENT_READY_AEO_CLI || null, ...(timeoutMs ? { timeoutMs } : {}) });
  const standards = shapeStandards(r, aeoReadyVersion());
  let raw = null;
  if (r.result) {
    raw = join(out, "aeo-ready.json");
    writeFileSync(raw, JSON.stringify(r.result, null, 2));
  }
  return { standards, raw };
}
