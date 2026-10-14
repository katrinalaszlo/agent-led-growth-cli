import { writeFileSync } from "node:fs";
import { join } from "node:path";

// What aeo-ready 1.7.x prints for `scan <url> --json`, cut down from a real run: each benchmark's checks carry
// id, status (pass, ok, fail, warn or skip) and message; agentic-seo reports categories only.
export const AEO_RESULT = {
  url: "https://acme.dev",
  timestamp: "2026-10-14T00:50:10.943Z",
  averageScore: 59,
  benchmarks: {
    agenticSeo: { score: 63, maxScore: 100, grade: "C", categories: { structure: { score: 2, maxScore: 3 } }, available: true },
    cloudflare: { score: 1, maxScore: 5, grade: "F", level: 1, available: true, checks: [{ id: "robotsTxt", status: "pass", message: "" }, { id: "sitemap", status: "ok", message: "" }] },
    fern: { score: 70, maxScore: 100, grade: "C", available: true, checks: [{ id: "llms-txt-exists", status: "pass", message: "" }, { id: "llms-txt-size", status: "warn", message: "large" }, { id: "markdown-endpoint", status: "fail", message: "" }, { id: "mcp-server", status: "skip", message: "" }] },
    vercel: { available: false, reason: "@vercel/agent-readability timed out after 60s" },
    agentgrade: { score: 74, maxScore: 100, grade: "B", available: true, checks: [{ id: "MCP endpoint responds", status: "fail", message: "" }, { id: "Tools listed", status: "pass", message: "" }, { id: "A2A agent card", status: "fail", message: "" }] },
  },
};

// A stand-in for aeo-ready's CLI, for tests that run bin/cli.js: AGENT_READY_AEO_CLI points at it. `result` prints
// the fixture as JSON; `fail` warns on stderr and exits 1 with no JSON, as a broken install would.
export function writeFakeAeoCli(dir, mode = "result") {
  const path = join(dir, `fake-aeo-${mode}.mjs`);
  const body = mode === "fail"
    ? `process.stderr.write("Warning: no network\\n"); process.exit(1);\n`
    : `process.stderr.write("Warning: history.json not written\\n"); process.stdout.write(${JSON.stringify(JSON.stringify(AEO_RESULT))});\n`;
  writeFileSync(path, body);
  return path;
}
