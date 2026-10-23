import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync, spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { serve, BARE } from "./interface-fixtures.js";
import { pickVerifyCall, inferVerifyCall } from "../src/verify/infer.js";
import { readConfig, writeConfig } from "../src/audit/config.js";

const CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "bin", "cli.js");
const SPEC_URL = "https://acme.dev/openapi.json";

// A product with an OpenAPI document whose only good check is GET /v1/me: the others are public, take a path
// parameter, or come after it in preference.
const BEARER_API = {
  openapi: "3.1.0",
  info: { title: "Acme" },
  servers: [{ url: "/" }],
  security: [{ bearer: [] }],
  components: { securitySchemes: { bearer: { type: "http", scheme: "bearer" } } },
  paths: {
    "/health": { get: { security: [], responses: { 200: {} } } },
    "/v1/widgets": { get: { responses: { 200: {} } }, post: { responses: { 201: {} } } },
    "/v1/users/{id}": { get: { responses: { 200: {} } } },
    "/v1/me": { get: { summary: "The caller's account", responses: { 200: {} } } },
  },
};

const PRODUCT = {
  "/": ["text/html", '<html><head><title>Acme</title></head><body><a href="/docs">Docs</a></body></html>'],
  "/docs": ["text/html", "<html><body>The API is described at /openapi.json. Send your API key as a bearer token.</body></html>"],
  "/openapi.json": ["application/json", JSON.stringify(BEARER_API)],
  // Only reachable through a saved interface.json: no page links it and it is not at a well-known path.
  "/internal/spec.json": ["application/json", JSON.stringify({ ...BEARER_API, paths: { "/v2/whoami": { get: { responses: { 200: {} } } } } })],
};

// A product shaped like tansohq.com on 2026-10-07: its own /openapi.json describes only the public website (no GET that
// needs a key), and its llms.txt and auth.md link the hosted API's description on app.<domain>.
const SITE_ONLY_SPEC = { openapi: "3.1.0", servers: [{ url: "https://acme.dev" }], paths: { "/api/agent": { get: { responses: { 200: {} } } }, "/api/evaluation-request": { post: { responses: { 200: {} } } } } };
const HOSTED_API = {
  openapi: "3.1.0",
  servers: [{ url: "https://app.acme.dev" }],
  security: [{ agentKey: [] }],
  components: { securitySchemes: { agentKey: { type: "http", scheme: "bearer" } } },
  paths: {
    "/v1/signup": { post: { security: [] } },
    "/v1/routes": { get: {} },
    "/v1/runs": { get: {} },
    "/v1/account": { get: { summary: "The caller's workspace" } },
    "/v1/runs/{id}": { get: {} },
  },
};
const tansoLike = (pages) => async (url) => {
  const hit = pages[url];
  if (!hit) return { ok: true, status: 404, url, contentType: "text/html", headers: {}, text: "<html><body>404</body></html>" };
  return { ok: true, status: 200, url, contentType: hit[0], headers: {}, text: hit[1] };
};
const TANSO_LIKE = {
  "https://acme.dev/": ["text/html", "<html><head><title>Acme</title></head><body>Acme</body></html>"],
  "https://acme.dev/llms.txt": ["text/plain", "# Acme\n\n- [Hosted API docs](https://app.acme.dev/docs) and [OpenAPI](https://app.acme.dev/openapi.json): signup, purchases, runs\n- [Access](https://acme.dev/auth.md)\n"],
  "https://acme.dev/auth.md": ["text/markdown", "# Access\n\nThe full hosted API is described at https://app.acme.dev/openapi.json.\n"],
  "https://acme.dev/openapi.json": ["application/json", JSON.stringify(SITE_ONLY_SPEC)],
  "https://app.acme.dev/openapi.json": ["application/json", JSON.stringify(HOSTED_API)],
};

const ANSWERS = { onboarding: { value: "try_then_claim" }, abuse_cost: { value: "low" }, human_before: { value: "never" } };

// A stand-in claude on PATH, signed in, so --check never depends on this machine.
function fakeClaudeEnv() {
  const bin = mkdtempSync(join(tmpdir(), "fake-claude-"));
  writeFileSync(join(bin, "claude"), `#!/usr/bin/env node\nif (process.argv[2] === "--version") console.log("9.9.9 (Claude Code)");\nelse console.log(JSON.stringify({ loggedIn: true }));\n`);
  chmodSync(join(bin, "claude"), 0o755);
  const env = { ...process.env, NO_COLOR: "1", PATH: `${bin}:${process.env.PATH}` };
  delete env.ANTHROPIC_API_KEY;
  return env;
}

// spawnSync would block this process's event loop, and with it the fixture server the CLI is reading.
function runCli(args, cwd, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

function projectFor(base) {
  const cwd = mkdtempSync(join(tmpdir(), "verify-infer-"));
  writeConfig(join(cwd, "alg.yml"), { url: new URL(base).host, task: "Sign up", answers: ANSWERS });
  return cwd;
}

describe("test: infers the verify call from the product's OpenAPI document", () => {
  it("picks GET /v1/me with a bearer token, on servers[0]", () => {
    const picked = pickVerifyCall(BEARER_API, SPEC_URL);
    assert.equal(picked.call, "GET https://acme.dev/v1/me");
    assert.equal(picked.header, "Authorization: Bearer {key}");
    assert.equal(picked.headerName, "Authorization");
  });

  it("uses an API key header scheme's own header name, and an absolute server with its variable defaults", () => {
    const doc = {
      openapi: "3.0.3",
      servers: [{ url: "https://{region}.api.acme.dev/v2", variables: { region: { default: "us" } } }],
      components: { securitySchemes: { key: { type: "apiKey", in: "header", name: "X-Api-Key" }, query: { type: "apiKey", in: "query", name: "key" } } },
      paths: {
        "/projects": { get: { security: [{ query: [] }] } },
        "/account": { get: { security: [{ key: [] }] } },
      },
    };
    const picked = pickVerifyCall(doc, SPEC_URL);
    assert.equal(picked.call, "GET https://us.api.acme.dev/v2/account");
    assert.equal(picked.header, "X-Api-Key: {key}");
  });

  it("skips operations with required path parameters, even preferred ones", () => {
    const doc = {
      openapi: "3.1.0",
      security: [{ bearer: [] }],
      components: { securitySchemes: { bearer: { type: "http", scheme: "bearer" } }, parameters: { Org: { name: "org", in: "query", required: true } } },
      paths: {
        "/v1/accounts/{account_id}/me": { get: {} },
        "/v1/orgs/me": { get: { parameters: [{ $ref: "#/components/parameters/Org" }] } },
        "/v1/projects": { get: {} },
      },
    };
    assert.equal(pickVerifyCall(doc, SPEC_URL).call, "GET https://acme.dev/v1/projects");
  });

  // Mem0's scheme as published at docs.mem0.ai/openapi.json on 2026-10-07.
  const authorizationKey = (description, extra = {}) => ({
    openapi: "3.0.3",
    servers: [{ url: "https://api.mem0.ai" }],
    security: [{ ApiKeyAuth: [] }],
    components: { securitySchemes: { ApiKeyAuth: { type: "apiKey", in: "header", name: "Authorization", ...(description ? { description } : {}), ...extra } } },
    paths: { "/v1/ping/": { get: {} } },
  });

  it("reads the prefix for an API key in Authorization from the scheme's description", () => {
    const picked = pickVerifyCall(authorizationKey("API key authentication. Prefix your Mem0 API key with 'Token '. Example: 'Token your_api_key'"), SPEC_URL);
    assert.equal(picked.call, "GET https://api.mem0.ai/v1/ping/");
    assert.equal(picked.header, "Authorization: Token {key}");
  });

  it("reads the prefix from an example alone, or from an x- extension", () => {
    assert.equal(pickVerifyCall(authorizationKey("Send it as `Token <key>`."), SPEC_URL).header, "Authorization: Token {key}");
    assert.equal(pickVerifyCall(authorizationKey("Prefix the key with 'Token'."), SPEC_URL).header, "Authorization: Token {key}");
    assert.equal(pickVerifyCall(authorizationKey(null, { "x-example": "Bearer {API_KEY}" }), SPEC_URL).header, "Authorization: Bearer {key}");
  });

  it("sends the key as it is when the document says not to prefix it, and reads a written-out header", () => {
    assert.equal(pickVerifyCall(authorizationKey("Do not prefix the key with Bearer; send the raw key."), SPEC_URL).header, "Authorization: {key}");
    assert.equal(pickVerifyCall(authorizationKey("Send `Authorization: Token abc123def`."), SPEC_URL).header, "Authorization: Token {key}");
  });

  it("skips an API key in Authorization with no documented prefix, and says why when nothing else fits", () => {
    for (const description of [null, "Use your API key.", "Put it in the header <key>.", "Either Token <key> or Bearer <key>."]) {
      const r = pickVerifyCall(authorizationKey(description), SPEC_URL);
      assert.equal(r.call, undefined, description);
      assert.match(r.error, /has GETs that need a key, but its API key goes in the Authorization header \(scheme ApiKeyAuth\) and the document does not say what comes before the key/);
    }
  });

  it("an ambiguous Authorization key is passed over for the next call that can be sent", () => {
    const doc = authorizationKey(null);
    doc.components.securitySchemes.header = { type: "apiKey", in: "header", name: "X-Api-Key" };
    doc.paths["/v1/projects"] = { get: { security: [{ header: [] }] } };
    const picked = pickVerifyCall(doc, SPEC_URL);
    assert.equal(picked.call, "GET https://api.mem0.ai/v1/projects");
    assert.equal(picked.header, "X-Api-Key: {key}");
  });

  it("finds nothing when every GET is public or needs a parameter", () => {
    const doc = { openapi: "3.1.0", paths: { "/v1/items": { get: {} }, "/v1/items/{id}": { get: { security: [{ bearer: [] }] } } }, components: { securitySchemes: { bearer: { type: "http", scheme: "bearer" } } } };
    assert.match(pickVerifyCall(doc, SPEC_URL).error, /no GET that needs a key/);
  });
});

describe("test: an OpenAPI document linked from the product's agent pages", () => {
  const noSaved = mkdtempSync(join(tmpdir(), "verify-infer-none-"));

  it("uses app.<domain>/openapi.json linked from llms.txt when the site's own has no GET that needs a key", async () => {
    const r = await inferVerifyCall({ url: "https://acme.dev/", version: "test", cwd: noSaved, fetchSource: tansoLike(TANSO_LIKE) });
    assert.equal(r.error, undefined, r.error);
    assert.equal(r.call, "GET https://app.acme.dev/v1/account");
    assert.equal(r.header, "Authorization: Bearer {key}");
    assert.equal(r.specUrl, "https://app.acme.dev/openapi.json");
    assert.equal(r.specVia, "https://acme.dev/llms.txt");
  });

  it("keeps the product's own document when it has a GET that needs a key", async () => {
    const pages = { ...TANSO_LIKE, "https://acme.dev/openapi.json": ["application/json", JSON.stringify(BEARER_API)] };
    const r = await inferVerifyCall({ url: "https://acme.dev/", version: "test", cwd: noSaved, fetchSource: tansoLike(pages) });
    assert.equal(r.call, "GET https://acme.dev/v1/me");
    assert.equal(r.specUrl, "https://acme.dev/openapi.json");
    assert.equal(r.specVia, null);
  });

  it("prefers the linked document whose call reads the caller's account", async () => {
    const pages = {
      ...TANSO_LIKE,
      "https://acme.dev/llms.txt": ["text/plain", "# Acme\n\n- [Jobs API](https://jobs.acme.dev/openapi.json)\n- [OpenAPI](https://app.acme.dev/openapi.json)\n"],
      "https://jobs.acme.dev/openapi.json": ["application/json", JSON.stringify({ ...HOSTED_API, servers: [{ url: "https://jobs.acme.dev" }], paths: { "/v1/jobs": { get: {} } } })],
    };
    const r = await inferVerifyCall({ url: "https://acme.dev/", version: "test", cwd: noSaved, fetchSource: tansoLike(pages) });
    assert.equal(r.call, "GET https://app.acme.dev/v1/account");
  });

  it("does not follow an OpenAPI link on another registrable domain", async () => {
    const pages = {
      ...TANSO_LIKE,
      "https://acme.dev/llms.txt": ["text/plain", "# Acme\n\n- [Their OpenAPI](https://api.example.org/openapi.json)\n"],
      "https://acme.dev/auth.md": ["text/markdown", "# Access\n"],
      "https://api.example.org/openapi.json": ["application/json", JSON.stringify({ ...HOSTED_API, servers: [{ url: "https://api.example.org" }] })],
    };
    const r = await inferVerifyCall({ url: "https://acme.dev/", version: "test", cwd: noSaved, fetchSource: tansoLike(pages) });
    assert.match(r.error, /https:\/\/acme\.dev\/openapi\.json has no GET that needs a key/);
  });

  it("moves on to a linked document when the site's own one only has an Authorization key with no prefix", async () => {
    const ambiguous = { ...SITE_ONLY_SPEC, security: [{ k: [] }], components: { securitySchemes: { k: { type: "apiKey", in: "header", name: "Authorization" } } }, paths: { "/v1/me": { get: {} } } };
    const pages = { ...TANSO_LIKE, "https://acme.dev/openapi.json": ["application/json", JSON.stringify(ambiguous)] };
    const r = await inferVerifyCall({ url: "https://acme.dev/", version: "test", cwd: noSaved, fetchSource: tansoLike(pages) });
    assert.equal(r.call, "GET https://app.acme.dev/v1/account");
    assert.equal(r.specUrl, "https://app.acme.dev/openapi.json");
  });

  it("says why each linked document was skipped", async () => {
    const pages = {
      ...TANSO_LIKE,
      "https://acme.dev/llms.txt": ["text/plain", "# Acme\n\n- [A](https://app.acme.dev/openapi.json)\n- [B](https://api.acme.dev/openapi.json)\n- [C](https://docs.acme.dev/openapi.json)\n"],
      "https://acme.dev/auth.md": ["text/markdown", "# Access\n"],
      "https://app.acme.dev/openapi.json": ["application/json", JSON.stringify(SITE_ONLY_SPEC)],
      "https://api.acme.dev/openapi.json": ["application/json", "{ not json"],
    };
    const r = await inferVerifyCall({ url: "https://acme.dev/", version: "test", cwd: noSaved, fetchSource: tansoLike(pages) });
    assert.match(r.error, /^https:\/\/acme\.dev\/openapi\.json has no GET that needs a key/);
    assert.match(r.error, /the OpenAPI documents its agent pages link to were skipped \(https:\/\/app\.acme\.dev\/openapi\.json: has no GET that needs a key[^;]*; https:\/\/api\.acme\.dev\/openapi\.json: not valid JSON; https:\/\/docs\.acme\.dev\/openapi\.json: answered 404\)/);
  });

  it("an own document over the size cap says it could not be read, not that it answered 200", async () => {
    const fetchSource = async (url) => (url === "https://acme.dev/openapi.json" ? { ok: false, status: 200, url, contentType: "application/json", headers: {}, text: "", error: "response body larger than 5000000 bytes" } : tansoLike({ ...TANSO_LIKE, "https://acme.dev/llms.txt": ["text/plain", "# Acme\n"], "https://acme.dev/auth.md": ["text/markdown", "# Access\n"] })(url));
    const saved = mkdtempSync(join(tmpdir(), "verify-infer-saved-"));
    const run = join(saved, ".alg", "acme.dev", "2026-10-07T00-00-00-abcdef");
    mkdirSync(run, { recursive: true });
    writeFileSync(join(run, "interface.json"), JSON.stringify({ observations: [{ id: "obs_1", role: "openapi", url: "https://acme.dev/openapi.json", ok: true, status: 200 }], interfaces: { api: { machineReadableSpec: { verdict: "yes", basedOn: ["obs_1"] } } } }));
    const r = await inferVerifyCall({ url: "https://acme.dev/", version: "test", cwd: saved, fetchSource });
    assert.match(r.error, /could not be read \(response body larger than 5000000 bytes\)/);
    assert.doesNotMatch(r.error, /answered 200/);
  });

  it("names a linked YAML document it does not read", async () => {
    const pages = { ...TANSO_LIKE, "https://acme.dev/llms.txt": ["text/plain", "# Acme\n\n- [OpenAPI](https://app.acme.dev/openapi.yaml)\n"], "https://acme.dev/auth.md": ["text/markdown", "# Access\n"] };
    const r = await inferVerifyCall({ url: "https://acme.dev/", version: "test", cwd: noSaved, fetchSource: tansoLike(pages) });
    assert.match(r.error, /linked YAML document is not read \(https:\/\/app\.acme\.dev\/openapi\.yaml\)/);
  });

  it("takes links in page order, so a relative link before several absolute ones is not crowded out", async () => {
    const pages = {
      ...TANSO_LIKE,
      "https://acme.dev/llms.txt": ["text/plain", "# Acme\n\n- [Hosted](/hosted/openapi.json)\n- https://a.acme.dev/openapi.json\n- https://b.acme.dev/openapi.json\n- https://c.acme.dev/openapi.json\n"],
      "https://acme.dev/auth.md": ["text/markdown", "# Access\n"],
      "https://acme.dev/hosted/openapi.json": ["application/json", JSON.stringify(HOSTED_API)],
    };
    const r = await inferVerifyCall({ url: "https://acme.dev/", version: "test", cwd: noSaved, fetchSource: tansoLike(pages) });
    assert.equal(r.specUrl, "https://acme.dev/hosted/openapi.json");
  });

  it("refuses a linked document that redirects to another site", async () => {
    const base = tansoLike(TANSO_LIKE);
    const fetchSource = async (url) => (url === "https://app.acme.dev/openapi.json" ? { ...(await base(url)), redirectedTo: "https://evil.example/openapi.json", crossHost: true } : base(url));
    const r = await inferVerifyCall({ url: "https://acme.dev/", version: "test", cwd: noSaved, fetchSource });
    assert.match(r.error, /https:\/\/app\.acme\.dev\/openapi\.json: redirects to https:\/\/evil\.example\/openapi\.json/);
  });

  it("marks a call whose server is on another site, and prefers a same-site one", async () => {
    const evil = { ...HOSTED_API, servers: [{ url: "https://evil.example" }] };
    const offSite = await inferVerifyCall({ url: "https://acme.dev/", version: "test", cwd: noSaved, fetchSource: tansoLike({ ...TANSO_LIKE, "https://app.acme.dev/openapi.json": ["application/json", JSON.stringify(evil)] }) });
    assert.equal(offSite.url, "https://evil.example/v1/account");
    assert.equal(offSite.offSite, true);
    assert.equal(offSite.apiHost, "evil.example");
    const pages = {
      ...TANSO_LIKE,
      "https://acme.dev/llms.txt": ["text/plain", "# Acme\n\n- https://app.acme.dev/openapi.json\n- https://api.acme.dev/openapi.json\n"],
      "https://app.acme.dev/openapi.json": ["application/json", JSON.stringify(evil)],
      "https://api.acme.dev/openapi.json": ["application/json", JSON.stringify({ ...HOSTED_API, servers: [{ url: "/" }], paths: { "/v1/jobs": { get: {} } } })],
    };
    const r = await inferVerifyCall({ url: "https://acme.dev/", version: "test", cwd: noSaved, fetchSource: tansoLike(pages) });
    assert.equal(r.url, "https://api.acme.dev/v1/jobs", "a relative server resolves against the document's URL");
    assert.equal(r.offSite, false);
  });
});

describe("test: the inferred call on the command line", () => {
  let product;
  let bare;
  let env;
  before(async () => {
    product = await serve(PRODUCT);
    bare = await serve(BARE);
    env = fakeClaudeEnv();
  });
  after(() => {
    product.server.close();
    bare.server.close();
  });

  it("--check --json --yes plans with the inferred call, marks it inferred, and saves it keeping the other lines", async () => {
    const cwd = projectFor(product.base);
    const before = readFileSync(join(cwd, "alg.yml"), "utf8");
    const r = await runCli(["test", "--check", "--json", "--yes"], cwd, env);
    assert.equal(r.status, 0, r.stderr);
    const plan = JSON.parse(r.stdout);
    assert.equal(plan.schema, "agent-ready/verify-plan@1");
    assert.equal(plan.checker.inferred, true);
    assert.equal(plan.checker.inferredFrom, `${product.base}openapi.json`);
    assert.match(plan.checker.call, new RegExp(`^GET ${product.base}v1/me with Authorization: Bearer \\{key\\}`));
    const after = readFileSync(join(cwd, "alg.yml"), "utf8");
    assert.equal(readConfig(join(cwd, "alg.yml")).verify_call, `GET ${product.base}v1/me`);
    assert.equal(readConfig(join(cwd, "alg.yml")).verify_header, "Authorization: Bearer {key}");
    const kept = before.split("\n").filter((l) => !/^#\s*verify_(call|header):/.test(l));
    for (const line of kept) assert.ok(after.split("\n").includes(line), line);
  });

  it("without --yes and without a terminal, uses the inferred call for the plan but does not save it", async () => {
    const cwd = projectFor(product.base);
    const r = await runCli(["test", "--check"], cwd, env);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, new RegExp(`Will check with GET ${product.base}v1/me on 127\\.0\\.0\\.1 \\(Authorization\\) \\(from ${product.base}openapi\\.json\\)`));
    assert.match(r.stderr, /Not saved to alg\.yml/);
    assert.equal(readConfig(join(cwd, "alg.yml")).verify_call, undefined);
  });

  it("reuses the latest interface.json from check instead of inspecting again", async () => {
    const cwd = projectFor(product.base);
    const run = join(cwd, ".alg", new URL(product.base).host, "2026-10-06T00-00-00-abcdef");
    mkdirSync(run, { recursive: true });
    const doc = { observations: [{ id: "obs_1", role: "openapi", url: `${product.base}internal/spec.json`, ok: true, status: 200 }], interfaces: { api: { machineReadableSpec: { verdict: "yes", basedOn: ["obs_1"] } } } };
    writeFileSync(join(run, "interface.json"), JSON.stringify(doc));
    const r = await runCli(["test", "--check", "--json"], cwd, env);
    assert.equal(r.status, 0, r.stderr);
    assert.match(JSON.parse(r.stdout).checker.call, new RegExp(`^GET ${product.base}v2/whoami`));
  });

  it("says which linked document it used, in --json and in the plan", async () => {
    const linking = await serve({
      "/": ["text/html", "<html><head><title>Acme</title></head><body>Acme</body></html>"],
      "/llms.txt": ["text/plain", "# Acme\n\n- [OpenAPI](/hosted/openapi.json): the hosted API\n"],
      "/openapi.json": ["application/json", JSON.stringify({ ...SITE_ONLY_SPEC, servers: [{ url: "/" }] })],
      "/hosted/openapi.json": ["application/json", JSON.stringify({ ...HOSTED_API, servers: [{ url: "/" }] })],
    });
    try {
      const cwd = projectFor(linking.base);
      const json = await runCli(["test", "--check", "--json"], cwd, env);
      assert.equal(json.status, 0, json.stderr);
      const checker = JSON.parse(json.stdout).checker;
      assert.equal(checker.inferredFrom, `${linking.base}hosted/openapi.json`);
      assert.equal(checker.inferredVia, `${linking.base}llms.txt`);
      assert.match(checker.call, new RegExp(`^GET ${linking.base}v1/account with Authorization: Bearer \\{key\\}`));
      const text = await runCli(["test", "--check"], cwd, env);
      assert.equal(text.status, 0, text.stderr);
      assert.match(text.stderr, new RegExp(`Will check with GET ${linking.base}v1/account on 127\\.0\\.0\\.1 \\(Authorization\\) \\(from ${linking.base}hosted/openapi\\.json, linked from ${linking.base}llms\\.txt\\)`));
      assert.match((text.stdout + text.stderr).replace(/\s+/g, " "), /API host 127\.0\.0\.1 \(from \S+hosted\/openapi\.json, linked from \S+llms\.txt\)/);
    } finally {
      linking.server.close();
    }
  });

  it("an inferred call on another site is used, and the plan says the key goes there", async () => {
    const offSite = await serve({
      "/": ["text/html", "<html><head><title>Acme</title></head><body>Acme</body></html>"],
      "/openapi.json": ["application/json", JSON.stringify({ ...HOSTED_API, servers: [{ url: "https://console.acme-cloud.example" }] })],
    });
    try {
      const cwd = projectFor(offSite.base);
      const json = await runCli(["test", "--check", "--json", "--yes"], cwd, env);
      assert.equal(json.status, 0, json.stderr);
      const checker = JSON.parse(json.stdout).checker;
      assert.equal(checker.apiHost, "console.acme-cloud.example");
      assert.equal(checker.apiHostOffSite, true);
      assert.equal(readConfig(join(cwd, "alg.yml")).verify_call, "GET https://console.acme-cloud.example/v1/account");
      const text = (await runCli(["test", "--check"], projectFor(offSite.base), env));
      assert.equal(text.status, 0, text.stderr);
      const out = (text.stdout + text.stderr).replace(/\s+/g, " ");
      assert.match(out, new RegExp(`Will check with GET https://console\\.acme-cloud\\.example/v1/account on console\\.acme-cloud\\.example \\(Authorization\\) \\(from ${offSite.base}openapi\\.json\\)\\.`));
      // Once on the "Will check with" line and once in the plan's rows.
      assert.match(out, /\(from \S+openapi\.json\)\. This API host is on a different site than 127\.0\.0\.1:\d+; the key the agent gets is sent there\./);
      assert.equal(out.match(/This API host is on a different site than 127\.0\.0\.1:\d+; the key the agent gets is sent there\./g).length, 2, out);
      assert.match(out, /API host console\.acme-cloud\.example \(from \S+openapi\.json\)/);
    } finally {
      offSite.server.close();
    }
  });

  it("a same-site inferred call has no different-site note", async () => {
    const cwd = projectFor(product.base);
    const r = await runCli(["test", "--check"], cwd, env);
    assert.equal(r.status, 0, r.stderr);
    assert.doesNotMatch(r.stdout + r.stderr, /different site/);
  });

  it("a declared verify_call is used as it is, not inferred", () => {
    const cwd = mkdtempSync(join(tmpdir(), "verify-infer-"));
    writeFileSync(join(cwd, "alg.yml"), "url: acme.dev\ntask: Sign up\nverify_call: GET https://api.acme.dev/v1/me\n");
    const r = spawnSync(process.execPath, [CLI, "test", "--check", "--json"], { cwd, encoding: "utf8", env });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(JSON.parse(r.stdout).checker.inferred, false);
  });

  it("with no OpenAPI document to take a call from, exits 2 and says to add verify_call", async () => {
    const cwd = projectFor(bare.base);
    const r = await runCli(["test", "--check", "--json", "--yes"], cwd, env);
    assert.equal(r.status, 2, r.stderr);
    const error = JSON.parse(r.stdout).error;
    assert.equal(error.code, "verify_call_invalid");
    assert.match(error.message, /no verify_call, and none could be taken from the product's docs/);
    assert.match(r.stderr, /verify_call: GET https:\/\/api\.example\.com\/v1\/me/);
    assert.equal(readConfig(join(cwd, "alg.yml")).verify_call, undefined);
  });
});
