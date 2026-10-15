import { spawn } from "node:child_process";
import { writeFileSync, createWriteStream } from "node:fs";
import { secretsInText } from "../secrets.js";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

// Executor: Claude Code in print mode. Disposable by design; see executors/README in the interface comment of
// execute.js for what any replacement must provide. Confinement: cwd is the scratch directory, tools are an
// explicit allowlist, WebFetch is limited to the task's domains, and Bash runs in Claude Code's sandbox with an
// outbound network allowlist (settings.json written into the scratch directory).

export const name = "claude-print";

// Normalize Claude's stream-json into the harness event shape. Only summaries leave here; the raw line is
// written to trace.jsonl after redaction.
function normalize(event, redact) {
  const out = [];
  if (event.type === "assistant") {
    for (const block of event.message?.content || []) {
      if (block.type === "text" && block.text?.trim()) out.push({ kind: "text", text: redact(block.text.trim()).slice(0, 400) });
      if (block.type === "tool_use") {
        const input = block.name === "Bash" ? String(block.input?.command || "") : block.name === "WebFetch" ? String(block.input?.url || "") : block.name === "Write" || block.name === "Edit" || block.name === "Read" ? String(block.input?.file_path || "") : JSON.stringify(block.input || {});
        out.push({ kind: "tool_use", tool: block.name, input: redact(input).slice(0, 400) });
      }
    }
  } else if (event.type === "user") {
    for (const block of event.message?.content || []) {
      if (block.type !== "tool_result") continue;
      const text = typeof block.content === "string" ? block.content : (block.content || []).map((c) => c.text || "").join("\n");
      const denied = /permission|not allowed|denied|blocked by sandbox|sandbox/i.test(text.slice(0, 300)) && Boolean(block.is_error);
      const error = Boolean(block.is_error) || /"error"\s*:\s*\{|Invalid API Key|HTTP\/\S+ [45]\d\d|"statusCode":\s*[45]\d\d/i.test(text.slice(0, 3000));
      out.push({ kind: "tool_result", error, denied, text: redact(text).slice(0, 400) });
    }
  } else if (event.type === "result") {
    out.push({ kind: "result", subtype: event.subtype, turns: event.num_turns ?? null, costUsd: event.total_cost_usd ?? null, durationMs: event.duration_ms ?? null });
  }
  return out;
}

const isLocalHost = (host) => host === "localhost" || /^127\.\d+\.\d+\.\d+$/.test(host);

const GUARD = fileURLToPath(new URL("./identity-guard.mjs", import.meta.url));

export function settingsFor({ network, tools, allowedEmails = [], sandbox = {} }) {
  // WebFetch: default-deny, then allow the task's domains. Bash: Seatbelt sandbox with a strict outbound allowlist,
  // and the run fails rather than proceeding unsandboxed. Docs: code.claude.com/docs/en/sandboxing.md, permissions.md.
  // A task sets sandbox: { enabled: false } only when the command it exists to run cannot work inside the sandbox:
  // Stripe Projects keeps the operator's session in the macOS Keychain, which the sandbox does not reach
  // (tasks/pay-stripe-projects.js). Bash then runs with the operator's own access, and the run's confinement says so.
  return {
    permissions: {
      allow: [...tools.filter((t) => t !== "WebFetch"), ...network.map((d) => `WebFetch(domain:${d})`)],
      deny: ["WebFetch", "WebSearch", "Agent", "Task", "NotebookEdit"],
    },
    sandbox: sandbox.enabled === false ? { enabled: false } : {
      enabled: true,
      failIfUnavailable: true,
      // Run 02 showed the agent taking the "run outside the sandbox" retry to launch a browser. Closed.
      allowUnsandboxedCommands: false,
      // A product on this machine is reachable only with allowLocalBinding (macOS), and an allowedDomains entry for
      // localhost does not change a direct connection. It opens every local port, including other services, so it
      // is on only when the target itself is local or the task's CLI needs it (Stripe's Projects plugin listens on
      // 127.0.0.1 to talk to the Stripe CLI). Docs: code.claude.com/docs/en/sandboxing.md.
      network: { allowedDomains: network, strictAllowlist: true, ...(network.some(isLocalHost) || sandbox.allowLocalBinding ? { allowLocalBinding: true } : {}) },
    },
    // Enforced, not asked: every command, fetch and written file is checked for an email that is not the test identity's.
    hooks: { PreToolUse: [{ matcher: "Bash|WebFetch|Write|Edit|MultiEdit", hooks: [{ type: "command", command: [process.execPath, GUARD, ...allowedEmails].map((a) => JSON.stringify(a)).join(" ") }] }] },
  };
}

// A print-mode run that hangs (a stuck tool, a sandbox prompt nobody answers) would otherwise hold the harness forever.
export const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;
// No output for this long means the agent stalled: two real verify runs stopped mid-turn, right after signup, and
// waited until killed. Long commands still print within this window (the polling loops sleep 20 s at a time).
export const DEFAULT_IDLE_MS = 5 * 60 * 1000;

// The agent must not inherit the operator's Claude Code setup. Without these flags a run loaded the operator's
// MCP servers (Gmail, Slack, Drive among 37), user hooks, plugins and CLAUDE.md. --strict-mcp-config with no
// --mcp-config loads no MCP server; --setting-sources project,local skips user settings, hooks, plugins and memory.
// --bare would be stricter but refuses a Claude Code login and needs ANTHROPIC_API_KEY.
export function argsFor({ prompt, maxTurns, settingsPath, tools, model = null, maxBudgetUsd = null }) {
  const args = ["-p", prompt, "--output-format", "stream-json", "--verbose", "--max-turns", String(maxTurns), "--permission-mode", "default", "--strict-mcp-config", "--setting-sources", "project,local", "--settings", settingsPath, "--allowedTools", ...tools, "--disallowedTools", "WebSearch", "Agent", "Task"];
  if (model) args.push("--model", model);
  // Claude Code checks the cap after each turn, so a run can end slightly above it.
  if (maxBudgetUsd) args.push("--max-budget-usd", String(maxBudgetUsd));
  return args;
}

export async function run({ prompt, workDir, childEnv, tools, network, maxTurns, maxBudgetUsd = null, model, redact, learn = () => {}, onEvent, allowedEmails = [], sandbox = {}, timeoutMs = DEFAULT_TIMEOUT_MS, idleMs = DEFAULT_IDLE_MS }) {
  const settings = settingsFor({ network, tools, allowedEmails, sandbox });
  const settingsPath = join(workDir, "executor-settings.json");
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
  const args = argsFor({ prompt, maxTurns, settingsPath, tools, model, maxBudgetUsd });
  const startedAt = new Date().toISOString();
  const child = spawn("claude", args, { cwd: workDir, env: childEnv, stdio: ["ignore", "pipe", "pipe"] });
  const raw = createWriteStream(join(workDir, "trace.jsonl"));
  let stderr = "";
  let buffer = "";
  let result = null;
  // Claude prints one result event per segment of a run that it resumed; the turns add up, the cost is cumulative.
  // A Stripe run's trace held results of 32 and 4 turns and final.json said 4.
  let turns = null;
  let spawnError = null;
  let timedOut = false;
  const handle = (line) => {
    if (!line.trim()) return;
    for (const value of secretsInText(line)) learn(value);
    raw.write(redact(line) + "\n");
    let ev;
    try {
      ev = JSON.parse(line);
    } catch {
      // Claude prints the odd non-JSON line (warnings) on stdout; it is kept verbatim in trace.jsonl above.
      return;
    }
    for (const e of normalize(ev, redact)) {
      if (e.kind === "result") {
        result = e;
        if (e.turns !== null) turns = (turns ?? 0) + e.turns;
      }
      onEvent(e);
    }
  };
  let stalled = false;
  let idle = null;
  const resetIdle = () => {
    clearTimeout(idle);
    idle = setTimeout(() => {
      stalled = true;
      child.kill("SIGTERM");
    }, idleMs);
  };
  resetIdle();
  child.stdout.on("data", (d) => {
    resetIdle();
    buffer += d;
    const lines = buffer.split("\n");
    buffer = lines.pop();
    for (const line of lines) handle(line);
  });
  child.stderr.on("data", (d) => (stderr += d));
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill("SIGTERM");
  }, timeoutMs);
  // ENOENT / EACCES: no claude binary on PATH. Node emits "error" and may never emit "close", so either ends the wait.
  const exitCode = await new Promise((resolve) => {
    child.on("error", (err) => {
      spawnError = err;
      resolve(null);
    });
    child.on("close", resolve);
  });
  clearTimeout(timer);
  clearTimeout(idle);
  handle(buffer);
  await new Promise((resolve, reject) => {
    raw.on("error", reject);
    raw.end(resolve);
  });
  const stoppedBecause = spawnError ? `spawn failed: ${spawnError.code || spawnError.message}` : timedOut ? "timeout" : stalled ? "stalled" : result?.subtype ?? (exitCode === 0 ? "exit" : `exit ${exitCode}`);
  const errText = [spawnError ? `could not start claude: ${spawnError.message}` : null, timedOut ? `killed after ${timeoutMs}ms wall-clock timeout` : null, stalled ? `killed after ${idleMs}ms with no output` : null, stderr.trim() || null].filter(Boolean).join("\n");
  return {
    executor: { name, model: model || "default", maxTurns, maxBudgetUsd, tools, confinement: { cwd: "scratch directory", toolAllowlist: true, webFetchDomains: network, bashSandbox: settings.sandbox, settingsFile: "executor-settings.json" } },
    startedAt,
    finishedAt: new Date().toISOString(),
    exitCode,
    stoppedBecause,
    turns,
    costUsd: result?.costUsd ?? null,
    stderr: redact(errText).slice(0, 2000) || null,
    rawTrace: "trace.jsonl",
  };
}
