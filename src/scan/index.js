import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { mkdirSync } from "node:fs";
import { runProbes } from "../probe/index.js";
import { runId as newRunId } from "../schema/ids.js";

const require = createRequire(import.meta.url);

// aeo-ready writes .aeo-ready/history.json into process.cwd() and warns on stderr, so it runs as a child
// with cwd pinned inside our output directory and stderr captured into the scan record.
export function runAeoReady({ url, dir, cwd, timeoutMs = 300000, cli = null }) {
  if (!cli) cli = join(dirname(require.resolve("aeo-ready/package.json")), "bin", "cli.js");
  mkdirSync(cwd, { recursive: true });
  const args = [cli, "scan", url, "--json"];
  if (dir) args.push("--dir", dir);
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, { cwd, env: { ...process.env, FORCE_COLOR: "0" }, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (code) => {
      clearTimeout(timer);
      const warnings = stderr.split("\n").map((l) => l.trim()).filter(Boolean);
      const start = stdout.indexOf("{");
      if (start === -1) return resolve({ result: null, warnings, error: `aeo-ready exited ${code} without JSON${stderr ? `: ${warnings.slice(-1)[0]}` : ""}` });
      try {
        resolve({ result: JSON.parse(stdout.slice(start)), warnings, error: null });
      } catch (err) {
        resolve({ result: null, warnings, error: `aeo-ready output was not JSON: ${err.message}` });
      }
    });
  });
}

export async function scan({ url, dir = null, catalogSlug = null, aeo = true, vendorDir, version, log = () => {}, runId = newRunId() }) {
  const startedAt = new Date().toISOString();
  const target = {};
  if (url) target.url = url;
  if (dir) target.dir = dir;

  let aeoResult = null;
  let aeoWarnings = [];
  let aeoError = null;
  if (aeo && url) {
    log({ id: "aeo-ready", status: "run", detail: "running agentic-seo · Cloudflare · Fern · Vercel · AgentGrade (this spawns npx, 1-3 min)" });
    const r = await runAeoReady({ url, dir, cwd: vendorDir });
    aeoResult = r.result;
    aeoWarnings = r.warnings;
    aeoError = r.error;
    log({ id: "aeo-ready", status: aeoResult ? "pass" : "fail", detail: aeoResult ? `average ${aeoResult.averageScore}/100` : aeoError });
  }

  const probes = url ? await runProbes(url, { catalogSlug, log }) : ["robots_ai", "agent_json", "llms_txt", "openapi", "pricing_json", "catalog_pricing", "captcha", "signup_endpoint", "http_402"].map((id) => ({ id, status: "skip", detail: "no URL (dir-only scan)" }));

  return {
    schema: "agent-ready/scan@1",
    runId,
    target,
    startedAt,
    finishedAt: new Date().toISOString(),
    provider: { name: "scan", version, aeoReady: aeoResult ? "run" : aeo && url ? "failed" : "skipped" },
    available: true,
    aeo: aeoResult,
    aeoWarnings,
    aeoError,
    probes,
  };
}
