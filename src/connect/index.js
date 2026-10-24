import { existsSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import { spawnSync } from "node:child_process";

// `alg connect`: a device login against Track. The person approves in the browser, and the key Track returns is
// written to the env file (and, if they say yes, to Vercel) without ever being printed, logged or put on a command
// line. Everything that touches the outside (fetch, child processes, the clock, the prompt) is passed in, so tests
// run it against a fake server.

export const DEFAULT_ENDPOINT = "https://alg.katrinalaszlo.com";

export function resolveEndpoint(flag, env) {
  return (flag || env.AGENT_TRAFFIC_ENDPOINT || DEFAULT_ENDPOINT).replace(/\/+$/, "");
}

const defaultRun = (cmd, args, options = {}) => spawnSync(cmd, args, { encoding: "utf8", ...options });

async function postJson(fetchImpl, url, body) {
  let res;
  try {
    res = await fetchImpl(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  } catch (err) {
    throw new Error(`Could not reach ${url}: ${err.cause?.message || err.message}`);
  }
  // A proxy or a 5xx page can answer in HTML: only a JSON answer is read, and the status alone says what happened.
  const isJson = (res.headers.get("content-type") || "").includes("json");
  return { status: res.status, body: isJson ? await res.json() : null };
}

export async function startDeviceLogin({ endpoint, fetchImpl }) {
  const res = await postJson(fetchImpl, `${endpoint}/v1/connect/start`, { client: "agent-led-growth" });
  if (res.status !== 201 || !res.body?.device_code || !res.body?.user_code || !res.body?.verification_url) {
    throw new Error(`${endpoint} did not start a sign-in (${res.status}${res.body?.error ? ` ${res.body.error}` : ""}).`);
  }
  return res.body;
}

// Polls until the person approves, denies, or the code expires. Returns { ok: true, result } or
// { ok: false, reason, message }.
export async function pollForKey({ endpoint, start, fetchImpl, sleep, now }) {
  let intervalSeconds = Number(start.interval) || 5;
  const deadline = now() + (Number(start.expires_in) || 600) * 1000;
  const expired = { ok: false, reason: "expired", message: "The sign-in code expired before it was approved. Run alg connect again." };
  for (;;) {
    await sleep(intervalSeconds * 1000);
    if (now() >= deadline) return expired;
    const res = await postJson(fetchImpl, `${endpoint}/v1/connect/poll`, { device_code: start.device_code });
    if (res.status === 202) continue;
    if (res.status === 429) {
      intervalSeconds += 2;
      continue;
    }
    if (res.status === 200 && res.body?.key) return { ok: true, result: res.body };
    if (res.status === 403) return { ok: false, reason: "denied", message: "The sign-in was denied in the browser. Nothing was saved." };
    if (res.status === 410) return expired;
    return { ok: false, reason: "unexpected", message: `${endpoint} answered ${res.status}${res.body?.error ? ` ${res.body.error}` : ""} while waiting for approval. Nothing was saved.` };
  }
}

// Sets each name in values in the env file: an existing line for that name is replaced in place (a second one is
// dropped), every other line is kept as it is, and a missing name is added at the end. A new file is created
// readable only by its owner. Returns { created }.
export function writeEnvFile(path, values) {
  const created = !existsSync(path);
  const lines = created ? [] : readFileSync(path, "utf8").split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  const written = new Set();
  const out = [];
  for (const line of lines) {
    const name = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line)?.[1];
    if (name && name in values) {
      if (written.has(name)) continue;
      out.push(`${name}=${values[name]}`);
      written.add(name);
      continue;
    }
    out.push(line);
  }
  for (const [name, value] of Object.entries(values)) if (!written.has(name)) out.push(`${name}=${value}`);
  const text = out.join("\n") + "\n";
  if (created) writeFileSync(path, text, { mode: 0o600 });
  else writeFileSync(path, text);
  return { created };
}

// "ignored", "not_ignored", "no_repo" (not inside a git work tree) or "no_git" (git is not installed).
export function gitIgnoreStatus(path, run = defaultRun) {
  const cwd = dirname(path);
  const inside = run("git", ["rev-parse", "--is-inside-work-tree"], { cwd });
  if (inside.error) return "no_git";
  if (inside.status !== 0 || inside.stdout.trim() !== "true") return "no_repo";
  const check = run("git", ["check-ignore", "-q", basename(path)], { cwd });
  return check.status === 0 ? "ignored" : "not_ignored";
}

// Adds the file's name to the .gitignore next to it, creating that .gitignore if there is none.
export function addToGitignore(path) {
  const gitignore = join(dirname(path), ".gitignore");
  const before = existsSync(gitignore) ? readFileSync(gitignore, "utf8") : "";
  appendFileSync(gitignore, `${before === "" || before.endsWith("\n") ? "" : "\n"}${basename(path)}\n`);
  return gitignore;
}

export function openBrowser(url, run = defaultRun, platform = process.platform) {
  if (platform === "darwin") return run("open", [url]);
  if (platform === "win32") return run("cmd", ["/c", "start", '""', url.replace(/&/g, "^&")], { windowsVerbatimArguments: true });
  return run("xdg-open", [url]);
}

const vercelByHand = "To add it yourself: run vercel env add AGENT_TRAFFIC_KEY production and paste the AGENT_TRAFFIC_KEY value from your env file when asked, or add it in the Vercel dashboard under Settings, Environment Variables.";

// The key goes to the child on stdin only. Child output is shown only on failure, with the key cut out.
export async function saveKeyInVercel({ key, ask, say, run = defaultRun, cwd }) {
  const hide = (text) => String(text || "").split(key).join("[key]").trim();
  const version = run("vercel", ["--version"], { cwd });
  if (version.error) {
    say("  The vercel command was not found, so the key was not saved in Vercel.");
    say(`  ${vercelByHand}`);
    return "vercel_missing";
  }
  const list = run("vercel", ["env", "ls", "production"], { cwd });
  if (list.status !== 0) {
    say(`  vercel env ls failed, so the key was not saved in Vercel: ${hide(list.stderr) || `exit ${list.status}`}`);
    say(`  ${vercelByHand}`);
    return "failed";
  }
  if (/(^|\s)AGENT_TRAFFIC_KEY(\s|$)/m.test(list.stdout)) {
    const reply = await ask("  AGENT_TRAFFIC_KEY is already set in Vercel production. Replace it? (Y/n) ");
    if (!/^(y(es)?)?$/i.test(reply.trim())) {
      say("  Kept the existing AGENT_TRAFFIC_KEY in Vercel production.");
      return "kept";
    }
    const removed = run("vercel", ["env", "rm", "AGENT_TRAFFIC_KEY", "production", "--yes"], { cwd });
    if (removed.status !== 0) {
      say(`  vercel env rm failed, so the key was not replaced in Vercel: ${hide(removed.stderr) || `exit ${removed.status}`}`);
      say(`  ${vercelByHand}`);
      return "failed";
    }
  }
  const added = run("vercel", ["env", "add", "AGENT_TRAFFIC_KEY", "production"], { cwd, input: key });
  if (added.status !== 0) {
    say(`  vercel env add failed, so the key was not saved in Vercel: ${hide(added.stderr) || `exit ${added.status}`}`);
    say(`  ${vercelByHand}`);
    return "failed";
  }
  say("  Saved AGENT_TRAFFIC_KEY in Vercel production. It takes effect on the next deploy.");
  return "saved";
}

// Runs the whole flow and returns the exit code: 0 connected, 1 denied, expired or failed.
export async function connect({ endpoint, envFile, vercel, cwd, interactive, fetchImpl = fetch, sleep, now = Date.now, run = defaultRun, ask, say, style }) {
  const bold = style?.bold || ((s) => s);
  const dim = style?.dim || ((s) => s);
  say("");
  say(`  ${bold("alg connect")} · ${new URL(endpoint).host}`);
  const start = await startDeviceLogin({ endpoint, fetchImpl });
  say("");
  const opened = openBrowser(start.verification_url, run);
  if (opened.error || opened.status) say(`  Open ${start.verification_url} in your browser.`);
  else say(`  Opened ${start.verification_url} in your browser.`);
  say("");
  say("  Type this code on that page:");
  say("");
  say(`      ${bold(start.user_code)}`);
  say("");
  say(`  Check where the page says the request came from, then approve. ${dim("Waiting…")}`);

  const polled = await pollForKey({ endpoint, start, fetchImpl, sleep, now });
  if (!polled.ok) {
    say("");
    say(`  ${polled.message}`);
    return 1;
  }
  const { key, project_id: projectId, project_name: projectName } = polled.result;
  const trackEndpoint = (polled.result.endpoint || endpoint).replace(/\/+$/, "");

  const values = { AGENT_TRAFFIC_KEY: key };
  if (projectId) values.AGENT_TRAFFIC_PROJECT_ID = projectId;
  // The middleware sends to the default host unless told otherwise.
  if (trackEndpoint !== DEFAULT_ENDPOINT) values.AGENT_TRAFFIC_ENDPOINT = trackEndpoint;
  const { created } = writeEnvFile(envFile, values);
  const shown = relative(cwd, envFile).startsWith("..") ? envFile : relative(cwd, envFile);
  say("");
  say(`  Connected to ${bold(projectName || projectId || "your Track project")}.`);
  say(`  Saved ${Object.keys(values).join(", ")} to ${shown}${created ? " (new file, readable only by you)" : ""}.`);

  const ignored = gitIgnoreStatus(envFile, run);
  if (ignored === "not_ignored") {
    say(`  ${shown} is not in .gitignore, so git would commit the key.`);
    const reply = interactive ? await ask(`  Add ${basename(envFile)} to .gitignore? (Y/n) `) : "n";
    if (/^(y(es)?)?$/i.test(reply.trim())) {
      const gitignore = addToGitignore(envFile);
      say(`  Added ${basename(envFile)} to ${relative(cwd, gitignore).startsWith("..") ? gitignore : relative(cwd, gitignore)}.`);
    } else say(`  Add ${basename(envFile)} to .gitignore before you commit.`);
  } else if (ignored === "no_git") say(`  ${dim("git was not found, so .gitignore was not checked.")}`);

  const linked = existsSync(join(cwd, ".vercel", "project.json"));
  if (vercel === true || (vercel !== false && linked)) {
    say("");
    if (interactive) {
      const reply = await ask("  Also save the key in Vercel production? (Y/n) ");
      if (/^(y(es)?)?$/i.test(reply.trim())) await saveKeyInVercel({ key, ask, say, run, cwd });
      else say("  Not saved in Vercel.");
    } else if (vercel === true) {
      await saveKeyInVercel({ key, ask: async () => "y", say, run, cwd });
    } else say(`  ${dim("This folder is linked to Vercel. Run alg connect --vercel to save the key there too.")}`);
  }

  say("");
  say(`  Next: restart your server, then open ${trackEndpoint}/install to watch the first event.`);
  say("");
  return 0;
}
