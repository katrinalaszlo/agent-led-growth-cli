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

// durationMs is the benchmark's own wall-clock time, which aeo-ready reports from 1.8.0; null before that.
// A benchmark reports each check as pass, ok, fail, warn or skip. aeo-ready's own output counts warn as failed and
// leaves skip out, so this does the same. agentic-seo reports categories only, so it has no checks to count.
// The values come from a third-party CLI's JSON and end up in a page, so a score is a finite number or null and a
// grade or check id is a string.
const number = (value) => (value === null || value === undefined || value === "" || !Number.isFinite(Number(value)) ? null : Number(value));
// Cloudflare's score is a readiness level out of 5, not a count of checks, and its report heads each category with
// "n/m passing"; aeo-ready keeps those as `categories`. Their sums are the counts, because aeo-ready up to 1.8.0
// parsed only the PASS and OK lines of the report (its FAIL lines use another separator), so `checks` held no failure
// and a Level 1 site read as all checks passed. The failed names still come from `checks`, so they are missing from
// a catalog run with that aeo-ready and present from the fixed one.
function counts(id, b, checks) {
  if (id === "cloudflare" && b.categories && Object.keys(b.categories).length) {
    const categories = Object.values(b.categories);
    return { passed: categories.reduce((sum, c) => sum + Number(c.score), 0), total: categories.reduce((sum, c) => sum + Number(c.maxScore), 0) };
  }
  return { passed: checks.filter((c) => c.status === "pass" || c.status === "ok").length, total: checks.length };
}

function shapeBenchmark({ id, name }, b) {
  const durationMs = number(b?.durationMs);
  if (!b || b.available === false) return { id, name, score: null, maxScore: null, grade: null, passed: 0, total: 0, failed: [], error: b?.reason ? String(b.reason) : "did not run", durationMs };
  const checks = (b.checks || []).filter((c) => c.status !== "skip");
  return {
    id,
    name,
    score: number(b.score),
    maxScore: number(b.maxScore),
    grade: b.grade ? String(b.grade) : null,
    ...counts(id, b, checks),
    failed: checks.filter((c) => c.status === "fail" || c.status === "warn").map((c) => String(c.id)),
    error: null,
    durationMs,
  };
}

// Many checks in parallel each spawn the catalog's three npx tools, which fetch a site's whole sitemap at once;
// the machine then runs out of local ports (EADDRNOTAVAIL) or DNS lookups fail (EAI_AGAIN).
const EXHAUSTED = /EADDRNOTAVAIL|EAI_AGAIN/;
export const EXHAUSTED_ADVICE = "local ports or DNS exhausted; run checks one at a time";

// The `standards` field of audit-report@1, from what runAeoReady returned. warnings are aeo-ready's stderr lines.
export function shapeStandards({ result, warnings, error }, version) {
  if (error && warnings.some((line) => EXHAUSTED.test(line))) error = `${error}. ${EXHAUSTED_ADVICE}`;
  return {
    generator: { name: "aeo-ready", version },
    averageScore: number(result?.averageScore),
    benchmarks: result ? BENCHMARKS.map((b) => shapeBenchmark(b, result.benchmarks?.[b.id])) : [],
    warnings,
    error,
  };
}

// Runs the catalog for url and writes aeo-ready's own JSON to <out>/aeo-ready.json. Spawns npx inside aeo-ready and
// takes usually 1-3 minutes, up to 15 on a large site; aeo-ready is killed after timeoutMs (runAeoReady's default,
// or AGENT_READY_STANDARDS_TIMEOUT_MS when set). AGENT_READY_AEO_CLI names another aeo-ready CLI script to run
// instead of the installed one.
// Returns the `standards` object and the raw file's path (null when aeo-ready gave no result; its error is in
// standards.error, never dropped).
export async function runStandards({ url, out, timeoutMs = undefined, runAeoReady = spawnAeoReady, env = process.env }) {
  mkdirSync(out, { recursive: true });
  if (!timeoutMs && Number(env.AGENT_READY_STANDARDS_TIMEOUT_MS) > 0) timeoutMs = Number(env.AGENT_READY_STANDARDS_TIMEOUT_MS);
  const r = await runAeoReady({ url, cwd: join(out, "vendor"), cli: env.AGENT_READY_AEO_CLI || null, ...(timeoutMs ? { timeoutMs } : {}) });
  const standards = shapeStandards(r, aeoReadyVersion());
  let raw = null;
  if (r.result) {
    raw = join(out, "aeo-ready.json");
    writeFileSync(raw, JSON.stringify(r.result, null, 2));
  }
  return { standards, raw };
}
