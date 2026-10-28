import test from "node:test";
import assert from "node:assert/strict";
import { inspect } from "../src/audit/index.js";

const home = "<html><head><title>Acme</title></head><body><h1>Acme</h1><p>Pricing</p></body></html>";
const pagesFrom = (pages) => async (url) => {
  const text = pages[url];
  if (text === undefined) return { ok: false, status: 404, url, contentType: "text/html", headers: {}, text: "" };
  return { ok: true, status: 200, url, contentType: url.endsWith(".json") ? "application/json" : "text/html", headers: {}, text };
};
async function funnelOf(pages, url = "https://acme.dev/") {
  const { funnel } = await inspect({ url, version: "test", runId: "r", fetchSource: pagesFrom(pages) });
  return Object.fromEntries(funnel.steps.map((s) => [s.id, s]));
}

test("a pricing URL that returns the homepage is a soft 404, not evidence", async () => {
  const steps = await funnelOf({ "https://acme.dev/": home, "https://acme.dev/pricing": home });
  assert.equal(steps.understand.state, "not_checked");
  assert.match(steps.understand.reason, /same page as the homepage|pricing page/i);
  assert.deepEqual(steps.understand.basedOn, []);
  assert.notEqual(steps.pay.state, "not_applicable");
  assert.doesNotMatch(steps.pay.reason, /only free plans/i);
});

test("a JavaScript pricing shell is unconfirmed, not free", async () => {
  const shell = "<html><head><title>Acme</title></head><body><div id=app>Pricing plans</div><script>boot()</script></body></html>";
  const steps = await funnelOf({ "https://acme.dev/": home, "https://acme.dev/pricing": shell });
  assert.equal(steps.understand.state, "not_checked");
  assert.match(steps.understand.reason, /JavaScript|not.*confirmed/i);
  assert.equal(steps.pay.state, "not_checked");
  assert.match(steps.pay.reason, /confirmed/i);
  assert.equal(steps.pay.fix, undefined);
});

test("no pricing evidence is not called free", async () => {
  const steps = await funnelOf({ "https://acme.dev/": home });
  assert.equal(steps.pay.state, "not_checked");
  assert.doesNotMatch(steps.pay.reason, /free/i);
  assert.equal(steps.pay.fix, undefined);
});

test("a native app with no web API marks the web-only steps not applicable", async () => {
  const app = `<html><head><title>Acme</title></head><body>Acme <a href="https://apps.apple.com/app/acme/id123">Download on the App Store</a></body></html>`;
  const steps = await funnelOf({ "https://acme.dev/": app });
  assert.equal(steps.signup.state, "not_applicable");
  assert.equal(steps.access.state, "not_applicable");
  assert.equal(steps.use.state, "not_applicable");
  assert.equal(steps.signup.fix, undefined);
  assert.match(steps.signup.reason, /mobile app|web API/i);
});

test("a web product with no API but no app-store signal keeps the normal funnel", async () => {
  const steps = await funnelOf({ "https://acme.dev/": home });
  assert.notEqual(steps.signup.state, "not_applicable");
});
