import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { mkdirSync } from "node:fs";
import { runProbes } from "../probe/index.js";
import { runId as newRunId } from "../schema/ids.js";

const require = createRequire(import.meta.url);

// aeo-ready writes .aeo-ready/history.json into process.cwd() and warns on stderr, so it runs as a child
// with cwd pinned inside our output directory and stderr captured into the scan record. A large site takes it
// minutes (airbyte.com: 11), so the default kill is 15; aeo-ready's own per-benchmark deadline is 12.
export const STANDARDS_TIMEOUT_MS = 900_000;

// Stops aeo-ready and the npx tools it spawned. A child started in its own process group (onChild below) is
// stopped as a group, because killing aeo-ready alone leaves its npx children running.
export function killAeoReady(child, signal = "SIGTERM") {
  if (child.detachedGroup) process.kill(-child.pid, signal);
  else child.kill(signal);
}

// onChild: called with the child process, for a caller that stops it itself (check on Ctrl+C). The child then runs in
// its own process group, so a terminal's Ctrl+C reaches only the caller, which must stop it with killAeoReady.
export function runAeoReady({ url, dir, cwd, timeoutMs = STANDARDS_TIMEOUT_MS, cli = null, onChild = null }) {
  if (!cli) cli = join(dirname(require.resolve("aeo-ready/package.json")), "bin", "cli.js");
  mkdirSync(cwd, { recursive: true });
  const args = [cli, "scan", url, "--json"];
  if (dir) args.push("--dir", dir);
  return new Promise((resolve) => {
    const group = Boolean(onChild) && process.platform !== "win32";
    const child = spawn(process.execPath, args, { cwd, env: { ...process.env, FORCE_COLOR: "0" }, stdio: ["ignore", "pipe", "pipe"], detached: group });
    child.detachedGroup = group;
    if (onChild) onChild(child);
    let stdout = "";
    let stderr = "";
    let killed = false;
    const timer = setTimeout(() => {
      killed = true;
      killAeoReady(child, "SIGKILL");
    }, timeoutMs);
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      const warnings = stderr.split("\n").map((l) => l.trim()).filter(Boolean);
      const start = stdout.indexOf("{");
      if (start === -1) {
        const how = killed ? `killed after ${Math.round(timeoutMs / 1000)} s` : code === null ? `killed by ${signal}` : `exited ${code}`;
        return resolve({ result: null, warnings, error: `aeo-ready ${how} without JSON${stderr ? `: ${warnings.slice(-1)[0]}` : ""}` });
      }
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
    log({ id: "aeo-ready", status: "run", detail: "running agentic-seo · Cloudflare · Fern · Vercel · AgentGrade (this spawns npx, usually 1-3 min, up to 15 on a large site)" });
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
