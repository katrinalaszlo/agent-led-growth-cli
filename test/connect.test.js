import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { execFile, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, statSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { connect, pollForKey, writeEnvFile, gitIgnoreStatus, saveKeyInVercel, resolveEndpoint, DEFAULT_ENDPOINT } from "../src/connect/index.js";

const KEY = "trk_live_secret_0123456789abcdef";
const CLI = fileURLToPath(new URL("../bin/cli.js", import.meta.url));
const dirs = [];
after(() => { for (const dir of dirs) rmSync(dir, { recursive: true, force: true }); });
const tempDir = () => {
  const dir = mkdtempSync(join(tmpdir(), "alg-connect-"));
  dirs.push(dir);
  return dir;
};

// A Track server for the device login: start answers once, and each poll takes the next scripted answer.
async function fakeTrack(pollAnswers, { startStatus = 201, interval = 1, expiresIn = 600 } = {}) {
  const requests = [];
  const answers = [...pollAnswers];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      requests.push({ method: req.method, path: req.url, body: JSON.parse(body) });
      const send = (status, json) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(json));
      };
      if (req.url === "/v1/connect/start") return send(startStatus, { device_code: "dev_1", user_code: "WDJB-MJHT", verification_url: `http://127.0.0.1:${server.address().port}/connect?code=WDJB-MJHT`, expires_in: expiresIn, interval });
      if (req.url === "/v1/connect/poll") {
        const [status, json] = answers.shift() ?? [202, { error: "authorization_pending" }];
        return send(status, json);
      }
      send(404, { error: "not_found" });
    });
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  const endpoint = `http://127.0.0.1:${server.address().port}`;
  return { endpoint, requests, close: () => new Promise((done) => server.close(done)) };
}

const approved = (endpoint) => [200, { key: KEY, project_id: "6f1c2b8e-0000-4000-8000-000000000001", project_name: "Acme API", endpoint }];

// A child-process stand-in: records each call and its stdin, and answers from a table keyed by "cmd args".
function fakeRun(answers = {}) {
  const calls = [];
  const run = (cmd, args, options = {}) => {
    calls.push({ cmd, args, input: options.input });
    const answer = answers[`${cmd} ${args.join(" ")}`];
    if (answer === "missing") return { error: Object.assign(new Error(`spawn ${cmd} ENOENT`), { code: "ENOENT" }), status: null, stdout: "", stderr: "" };
    return { status: 0, stdout: "", stderr: "", ...answer };
  };
  return { calls, run };
}

async function runConnect({ endpoint, cwd, interactive = false, replies = [], vercel, run = fakeRun({ "git rev-parse --is-inside-work-tree": { status: 128 } }).run }) {
  const lines = [];
  const sleeps = [];
  const asked = [];
  const code = await connect({
    endpoint,
    envFile: join(cwd, ".env"),
    vercel,
    cwd,
    interactive,
    sleep: async (ms) => { sleeps.push(ms); },
    run,
    ask: async (question) => { asked.push(question); return replies.shift() ?? ""; },
    say: (line) => lines.push(line),
  });
  return { code, output: lines.join("\n"), sleeps, asked };
}

describe("alg connect: device login", () => {
  test("start, pending twice, approved: writes the key and project id to a new 0600 .env and never prints the key", async () => {
    const track = await fakeTrack([[202, {}], [202, {}], approved(DEFAULT_ENDPOINT)]);
    const cwd = tempDir();
    const fake = fakeRun({ "git rev-parse --is-inside-work-tree": { status: 128 } });
    const { code, output, sleeps } = await runConnect({ endpoint: track.endpoint, cwd, run: fake.run });
    await track.close();
    assert.equal(code, 0);
    assert.deepEqual(track.requests.map((r) => r.path), ["/v1/connect/start", "/v1/connect/poll", "/v1/connect/poll", "/v1/connect/poll"]);
    assert.deepEqual(track.requests[0].body, { client: "agent-led-growth" });
    assert.deepEqual(track.requests[1].body, { device_code: "dev_1" });
    assert.deepEqual(sleeps, [1000, 1000, 1000]);
    assert.deepEqual(fake.calls[0], { cmd: process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open", args: fake.calls[0].args, input: undefined });
    assert.ok(fake.calls[0].args.at(-1).endsWith("/connect?code=WDJB-MJHT"));
    const env = readFileSync(join(cwd, ".env"), "utf8");
    assert.equal(env, `AGENT_TRAFFIC_KEY=${KEY}\nAGENT_TRAFFIC_PROJECT_ID=6f1c2b8e-0000-4000-8000-000000000001\n`);
    assert.equal(statSync(join(cwd, ".env")).mode & 0o777, 0o600);
    assert.match(output, /Your code: WDJB-MJHT/);
    assert.match(output, /Connected to Acme API\./);
    assert.match(output, /Saved AGENT_TRAFFIC_KEY, AGENT_TRAFFIC_PROJECT_ID to \.env \(new file, readable only by you\)\./);
    assert.match(output, /Next: restart your server, then open https:\/\/alg\.katrinalaszlo\.com\/install to watch the first event\./);
    assert.equal(output.includes(KEY), false);
  });

  test("a browser that does not open: the URL is printed to open by hand", async () => {
    const track = await fakeTrack([approved(DEFAULT_ENDPOINT)]);
    const cwd = tempDir();
    const fake = fakeRun({ "git rev-parse --is-inside-work-tree": { status: 128 } });
    const run = (cmd, args, options) => (cmd === "git" ? fake.run(cmd, args, options) : { error: new Error(`spawn ${cmd} ENOENT`) });
    const { code, output } = await runConnect({ endpoint: track.endpoint, cwd, run });
    await track.close();
    assert.equal(code, 0);
    assert.match(output, /Open http:\/\/127\.0\.0\.1:\d+\/connect\?code=WDJB-MJHT in your browser\./);
  });

  test("a server other than the default is written as AGENT_TRAFFIC_ENDPOINT, so the middleware sends there", async () => {
    const track = await fakeTrack([approved("http://track.local:4000")]);
    const cwd = tempDir();
    const { code, output } = await runConnect({ endpoint: track.endpoint, cwd });
    await track.close();
    assert.equal(code, 0);
    assert.match(readFileSync(join(cwd, ".env"), "utf8"), /^AGENT_TRAFFIC_ENDPOINT=http:\/\/track\.local:4000$/m);
    assert.match(output, /open http:\/\/track\.local:4000\/install/);
  });

  test("denied in the browser: exit 1, a clear message, nothing written", async () => {
    const track = await fakeTrack([[202, {}], [403, { error: "access_denied" }]]);
    const cwd = tempDir();
    const { code, output } = await runConnect({ endpoint: track.endpoint, cwd });
    await track.close();
    assert.equal(code, 1);
    assert.match(output, /The sign-in was denied in the browser\. Nothing was saved\./);
    assert.equal(existsSync(join(cwd, ".env")), false);
  });

  test("expired: a 410 ends it with exit 1 and says to run it again", async () => {
    const track = await fakeTrack([[410, { error: "expired_token" }]]);
    const cwd = tempDir();
    const { code, output } = await runConnect({ endpoint: track.endpoint, cwd });
    await track.close();
    assert.equal(code, 1);
    assert.match(output, /The sign-in code expired before it was approved\. Run alg connect again\./);
    assert.equal(existsSync(join(cwd, ".env")), false);
  });

  test("expired: polling stops at expires_in even when the server keeps saying pending", async () => {
    const track = await fakeTrack([]);
    let clock = 0;
    const polls = [];
    const fetchImpl = async (url, init) => {
      polls.push(url);
      return fetch(url, init);
    };
    const start = { device_code: "dev_1", interval: 5, expires_in: 12 };
    const result = await pollForKey({ endpoint: track.endpoint, start, fetchImpl, sleep: async (ms) => { clock += ms; }, now: () => clock });
    await track.close();
    assert.equal(result.reason, "expired");
    assert.equal(polls.length, 2);
  });

  test("slow_down: each 429 adds 2 seconds to the interval", async () => {
    const track = await fakeTrack([[429, { error: "slow_down" }], [429, { error: "slow_down" }], [202, {}], approved(DEFAULT_ENDPOINT)]);
    const cwd = tempDir();
    const { code, sleeps } = await runConnect({ endpoint: track.endpoint, cwd });
    await track.close();
    assert.equal(code, 0);
    assert.deepEqual(sleeps, [1000, 3000, 5000, 5000]);
  });

  test("a start the server refuses is an error that names the endpoint and status", async () => {
    const track = await fakeTrack([], { startStatus: 503 });
    const cwd = tempDir();
    await assert.rejects(runConnect({ endpoint: track.endpoint, cwd }), /did not start a sign-in \(503\)/);
    await track.close();
  });

  test("the endpoint comes from --endpoint, else AGENT_TRAFFIC_ENDPOINT, else the default", () => {
    assert.equal(resolveEndpoint("http://localhost:3000/", {}), "http://localhost:3000");
    assert.equal(resolveEndpoint(undefined, { AGENT_TRAFFIC_ENDPOINT: "https://track.example" }), "https://track.example");
    assert.equal(resolveEndpoint(undefined, {}), "https://alg.katrinalaszlo.com");
  });
});

describe("alg connect: env file", () => {
  test("replaces existing lines for those names in place, drops a second one, keeps everything else", () => {
    const dir = tempDir();
    const path = join(dir, ".env");
    writeFileSync(path, "# app\nDATABASE_URL=postgres://x\nexport AGENT_TRAFFIC_KEY=old\nAGENT_TRAFFIC_ACCOUNT_SALT=s\nAGENT_TRAFFIC_KEY=older\n\nOTHER=1", { mode: 0o644 });
    const { created } = writeEnvFile(path, { AGENT_TRAFFIC_KEY: "new", AGENT_TRAFFIC_PROJECT_ID: "p-1" });
    assert.equal(created, false);
    assert.equal(readFileSync(path, "utf8"), "# app\nDATABASE_URL=postgres://x\nAGENT_TRAFFIC_KEY=new\nAGENT_TRAFFIC_ACCOUNT_SALT=s\n\nOTHER=1\nAGENT_TRAFFIC_PROJECT_ID=p-1\n");
    assert.equal(statSync(path).mode & 0o777, 0o644);
  });

  test("a new file is created readable only by its owner", () => {
    const path = join(tempDir(), ".env.local");
    assert.equal(writeEnvFile(path, { AGENT_TRAFFIC_KEY: "k" }).created, true);
    assert.equal(readFileSync(path, "utf8"), "AGENT_TRAFFIC_KEY=k\n");
    assert.equal(statSync(path).mode & 0o777, 0o600);
  });
});

describe("alg connect: .gitignore", () => {
  // Real git; any other command (the browser) is a no-op.
  const gitOnly = (cmd, args, options) => (cmd === "git" ? spawnSync(cmd, args, { encoding: "utf8", ...options }) : { status: 0, stdout: "", stderr: "" });
  const gitRepo = () => {
    const dir = tempDir();
    spawnSync("git", ["init", "-q"], { cwd: dir });
    return dir;
  };

  test("in a git repo where .env is not ignored, it warns and, on yes, adds it to .gitignore", async () => {
    const cwd = gitRepo();
    writeFileSync(join(cwd, ".gitignore"), "node_modules/");
    const track = await fakeTrack([approved(DEFAULT_ENDPOINT)]);
    const { code, output, asked } = await runConnect({ endpoint: track.endpoint, cwd, interactive: true, replies: [""], vercel: false, run: gitOnly });
    await track.close();
    assert.equal(code, 0);
    assert.match(output, /\.env is not in \.gitignore, so git would commit the key\./);
    assert.deepEqual(asked, ["  Add .env to .gitignore? (Y/n) "]);
    assert.equal(readFileSync(join(cwd, ".gitignore"), "utf8"), "node_modules/\n.env\n");
    assert.equal(gitIgnoreStatus(join(cwd, ".env")), "ignored");
  });

  test("without a terminal it warns and leaves .gitignore alone", async () => {
    const cwd = gitRepo();
    const track = await fakeTrack([approved(DEFAULT_ENDPOINT)]);
    const { output, asked } = await runConnect({ endpoint: track.endpoint, cwd, vercel: false, run: gitOnly });
    await track.close();
    assert.match(output, /Add \.env to \.gitignore before you commit\./);
    assert.deepEqual(asked, []);
    assert.equal(existsSync(join(cwd, ".gitignore")), false);
  });

  test("an ignored .env, or a folder outside git, gets no warning", async () => {
    const cwd = gitRepo();
    writeFileSync(join(cwd, ".gitignore"), ".env\n");
    writeFileSync(join(cwd, ".env"), "");
    assert.equal(gitIgnoreStatus(join(cwd, ".env")), "ignored");
    const outside = tempDir();
    writeFileSync(join(outside, ".env"), "");
    const status = gitIgnoreStatus(join(outside, ".env"));
    assert.ok(status === "no_repo" || status === "ignored", status);
  });
});

describe("alg connect: Vercel", () => {
  const linkedFolder = () => {
    const cwd = tempDir();
    mkdirSync(join(cwd, ".vercel"));
    writeFileSync(join(cwd, ".vercel", "project.json"), "{}");
    return cwd;
  };
  const notGit = { "git rev-parse --is-inside-work-tree": { status: 128 } };

  test("a linked folder is asked; on yes the key goes to vercel env add on stdin, never on argv or in the output", async () => {
    const cwd = linkedFolder();
    const fake = fakeRun({ ...notGit, "vercel env ls production": { stdout: "> No Environment Variables found\n" } });
    const track = await fakeTrack([approved(DEFAULT_ENDPOINT)]);
    const { code, output, asked } = await runConnect({ endpoint: track.endpoint, cwd, interactive: true, replies: ["y"], run: fake.run });
    await track.close();
    assert.equal(code, 0);
    assert.deepEqual(asked, ["  Also save the key in Vercel production? (Y/n) "]);
    const add = fake.calls.find((c) => c.cmd === "vercel" && c.args[1] === "add");
    assert.deepEqual(add.args, ["env", "add", "AGENT_TRAFFIC_KEY", "production"]);
    assert.equal(add.input, KEY);
    for (const call of fake.calls) assert.equal(call.args.some((a) => a.includes(KEY)), false, `${call.cmd} ${call.args.join(" ")}`);
    assert.equal(fake.calls.some((c) => c.args[1] === "rm"), false);
    assert.match(output, /Saved AGENT_TRAFFIC_KEY in Vercel production\./);
    assert.equal(output.includes(KEY), false);
  });

  test("an existing AGENT_TRAFFIC_KEY is removed first, after asking", async () => {
    const fake = fakeRun({ "vercel env ls production": { stdout: "  name               value      environments\n  AGENT_TRAFFIC_KEY  Encrypted  Production\n" } });
    const asked = [];
    const lines = [];
    const result = await saveKeyInVercel({ key: KEY, ask: async (q) => { asked.push(q); return "y"; }, say: (l) => lines.push(l), run: fake.run, cwd: tempDir() });
    assert.equal(result, "saved");
    assert.deepEqual(asked, ["  AGENT_TRAFFIC_KEY is already set in Vercel production. Replace it? (Y/n) "]);
    assert.deepEqual(fake.calls.map((c) => c.args.join(" ")), ["--version", "env ls production", "env rm AGENT_TRAFFIC_KEY production --yes", "env add AGENT_TRAFFIC_KEY production"]);
  });

  test("an existing key is kept when the answer is no", async () => {
    const fake = fakeRun({ "vercel env ls production": { stdout: "AGENT_TRAFFIC_KEY  Encrypted  Production\n" } });
    const result = await saveKeyInVercel({ key: KEY, ask: async () => "n", say: () => {}, run: fake.run, cwd: tempDir() });
    assert.equal(result, "kept");
    assert.equal(fake.calls.some((c) => c.args[1] === "rm" || c.args[1] === "add"), false);
  });

  test("vercel not installed: says how to add it by hand", async () => {
    const fake = fakeRun({ "vercel --version": "missing" });
    const lines = [];
    const result = await saveKeyInVercel({ key: KEY, ask: async () => "y", say: (l) => lines.push(l), run: fake.run, cwd: tempDir() });
    assert.equal(result, "vercel_missing");
    assert.match(lines.join("\n"), /vercel command was not found[\s\S]*vercel env add AGENT_TRAFFIC_KEY production and paste/);
  });

  test("a failed vercel env add is reported with the key cut out of its output", async () => {
    const fake = fakeRun({ "vercel env ls production": {}, "vercel env add AGENT_TRAFFIC_KEY production": { status: 1, stderr: `Error: could not save ${KEY}` } });
    const lines = [];
    const result = await saveKeyInVercel({ key: KEY, ask: async () => "y", say: (l) => lines.push(l), run: fake.run, cwd: tempDir() });
    assert.equal(result, "failed");
    assert.match(lines.join("\n"), /vercel env add failed, so the key was not saved in Vercel: Error: could not save \[key\]/);
    assert.equal(lines.join("\n").includes(KEY), false);
  });

  test("--no-vercel skips it in a linked folder; without a terminal a linked folder is only told about --vercel", async () => {
    const cwd = linkedFolder();
    const fake = fakeRun(notGit);
    const track = await fakeTrack([approved(DEFAULT_ENDPOINT), approved(DEFAULT_ENDPOINT)]);
    const skipped = await runConnect({ endpoint: track.endpoint, cwd, interactive: true, vercel: false, run: fake.run });
    const told = await runConnect({ endpoint: track.endpoint, cwd, interactive: false, run: fake.run });
    await track.close();
    assert.deepEqual(skipped.asked, []);
    assert.doesNotMatch(skipped.output, /Vercel/);
    assert.match(told.output, /Run alg connect --vercel to save the key there too\./);
    assert.equal(fake.calls.some((c) => c.cmd === "vercel"), false);
  });
});

describe("alg connect: the command", () => {
  test("runs end to end against a fake server; stdout and stderr never carry the key", async () => {
    const track = await fakeTrack([[202, {}], approved(DEFAULT_ENDPOINT)], { interval: 0 });
    const cwd = tempDir();
    const bin = join(cwd, "bin");
    mkdirSync(bin);
    for (const name of ["open", "xdg-open"]) {
      writeFileSync(join(bin, name), "#!/bin/sh\nexit 0\n");
      chmodSync(join(bin, name), 0o755);
    }
    const result = await new Promise((done) => {
      execFile(process.execPath, [CLI, "connect", "--endpoint", track.endpoint, "--no-vercel", "--no-color"], { cwd, env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } }, (err, stdout, stderr) => done({ code: err ? err.code : 0, stdout, stderr }));
    });
    await track.close();
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr.includes(KEY), false);
    assert.match(result.stderr, /alg connect · 127\.0\.0\.1/);
    assert.match(result.stderr, /Opened http:\/\/127\.0\.0\.1:\d+\/connect\?code=WDJB-MJHT in your browser\./);
    assert.match(readFileSync(join(cwd, ".env"), "utf8"), new RegExp(`^AGENT_TRAFFIC_KEY=${KEY}$`, "m"));
  });
});
