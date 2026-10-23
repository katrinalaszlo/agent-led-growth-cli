import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { get, USER_AGENT, VERSION, MAX_BODY_BYTES } from "../src/probe/http.js";

describe("probe/http get", () => {
  let server;
  let port;
  before(async () => {
    server = createServer((req, res) => {
      if (req.url === "/away") return res.writeHead(302, { location: `http://localhost:${port}/landed` }).end();
      if (req.url === "/same") return res.writeHead(302, { location: `http://127.0.0.1:${port}/landed` }).end();
      if (req.url === "/landed") return res.writeHead(200, { "content-type": "text/plain" }).end("here");
      if (req.url === "/huge") {
        res.writeHead(200, { "content-type": "text/plain" });
        const chunk = Buffer.alloc(256 * 1024, "a");
        let sent = 0;
        const pump = () => {
          while (sent <= MAX_BODY_BYTES + chunk.length) {
            sent += chunk.length;
            if (!res.write(chunk)) return res.once("drain", pump);
          }
          res.end();
        };
        res.on("error", () => {});
        return pump();
      }
      res.writeHead(404).end();
    });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    port = server.address().port;
  });
  after(() => server.close());

  it("marks a redirect to a different host instead of following it silently", async () => {
    const res = await get(`http://127.0.0.1:${port}/away`);
    assert.equal(res.ok, true);
    assert.equal(res.text, "here");
    assert.equal(res.crossHost, true);
    assert.equal(res.redirectedTo, `http://localhost:${port}/landed`);
  });

  it("leaves a same-host redirect unmarked", async () => {
    const res = await get(`http://127.0.0.1:${port}/same`);
    assert.equal(res.ok, true);
    assert.equal(res.crossHost, undefined);
  });

  it("stops reading past the body cap and says so", async () => {
    const res = await get(`http://127.0.0.1:${port}/huge`);
    assert.equal(res.ok, false);
    assert.equal(res.text, "");
    assert.match(res.error, /larger than 2097152 bytes/);
  });

  it("takes its version from package.json", () => {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    assert.equal(VERSION, pkg.version);
    assert.ok(USER_AGENT.includes(`agent-led-growth/${pkg.version} `));
  });
});
