import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { get, isHtml, parseJson, joinUrl, VERSION } from "../probe/http.js";
import { recordVideoOptions, finalizeSmokeVideo } from "../report/video.js";

// Playwright is not a dependency of the npm package: only the browser and video commands need it.
async function loadPlaywright() {
  try {
    return await import("playwright");
  } catch (err) {
    if (err.code !== "ERR_MODULE_NOT_FOUND") throw err;
    throw new Error("This command drives a browser and needs Playwright: npm i -g playwright && npx playwright install chromium");
  }
}

// Scripted, LLM-free walk: open pricing and signup, screenshot, detect CAPTCHA / email loops. Never submits.
const PRICING_PATHS = ["/pricing", "/plans", "/pricing.json"];
const SIGNUP_PATHS = ["/signup", "/sign-up", "/register", "/auth/signup", "/get-started", "/start"];
const CAPTCHA_RE = /recaptcha|hcaptcha|turnstile|cf-challenge|arkoselabs|funcaptcha/i;
const EMAIL_LOOP_RE = /verif(y|ication)\s+(your\s+)?email|check your (inbox|email)|magic link|confirmation (email|link)/i;
const PRICE_RE = /(\$|€|£)\s?\d+(\.\d+)?|\d+\s?(\$|€|£)|\bfree\b/i;

// SPAs paint after domcontentloaded; wait for the network to settle, then a beat for client-side rendering.
// A page that will not load is a result, not a crash: the walk goes on and `errors` in the result says why.
async function visit(page, target, errors) {
  let res;
  try {
    res = await page.goto(target, { waitUntil: "domcontentloaded", timeout: 20000 });
  } catch (err) {
    errors.push({ step: "goto", url: target, error: err.message.split("\n")[0] });
    return null;
  }
  if (!res) return null;
  // Pages with analytics or long-polling never go network-idle; the wait is a courtesy, so a timeout is noted and ignored.
  await page.waitForLoadState("networkidle", { timeout: 8000 }).catch((err) => errors.push({ step: "networkidle", url: target, error: err.message.split("\n")[0] }));
  await page.waitForTimeout(800);
  return res;
}

// Probe a candidate path without the browser first, so the recorded session only ever shows real pages.
async function exists(url) {
  const res = await get(url);
  return res.ok && res.status < 400 && isHtml(res);
}

async function launch() {
  const { chromium } = await loadPlaywright();
  return chromium.launch();
}

export async function smoke({ url, outDir, runId, version, task = "", log = () => {}, video = false }) {
  const startedAt = new Date().toISOString();
  const shots = join(outDir, "screenshots");
  rmSync(shots, { recursive: true, force: true });
  mkdirSync(shots, { recursive: true });
  const flows = [];
  const findings = [];
  const worked = [];
  const errors = [];
  let browser = null;
  try {
    browser = await launch();
  } catch (err) {
    return {
      schema: "agent-ready/crash@1", runId, target: { url }, startedAt, finishedAt: new Date().toISOString(),
      provider: { name: "crash", version, mode: "smoke" }, available: false, reason: `playwright unavailable: ${err.message.split("\n")[0]} (run: npx playwright install chromium-headless-shell)`,
      mode: "smoke", persona: "scripted walk", task, flows: [], findings: [], worked: [], human_interventions: 0, human_assist: false,
    };
  }
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, userAgent: `agent-led-growth/${VERSION} smoke (+https://github.com/katrinalaszlo/agent-led-growth-cli)`, ...(video ? recordVideoOptions(outDir) : {}) });
  const page = await context.newPage();
  let n = 0;
  const shot = async (name) => {
    n += 1;
    const file = `screenshots/${String(n).padStart(2, "0")}-${name}.png`;
    await page.screenshot({ path: join(outDir, file), fullPage: false });
    return file;
  };

  // Evidence first: what a person would see. Home and pricing are captured even when the machine path passes.
  const homeRes = await visit(page, url, errors);
  if (homeRes && video) await page.waitForTimeout(1500);
  const homeShot = homeRes ? await shot("discover-home") : null;
  let pricingShot = null;
  let pricingPageHit = null;
  for (const path of PRICING_PATHS.slice(0, 2)) {
    if (!(await exists(joinUrl(url, path)))) continue;
    const res = await visit(page, joinUrl(url, path), errors);
    if (res && res.status() < 400) {
      pricingPageHit = { path, status: res.status() };
      await page.waitForTimeout(video ? 1500 : 0);
      pricingShot = await shot("understand-pricing");
      break;
    }
  }

  // discover: machine-readable front door
  const front = [];
  for (const path of ["/llms.txt", "/.well-known/agent.json", "/pricing.json", "/openapi.json"]) {
    const res = await get(joinUrl(url, path));
    if (res.ok && res.status === 200 && !isHtml(res)) front.push(path);
  }
  flows.push({
    id: "discover", result: front.length ? "PASS" : "FAIL", human_interventions: 0,
    quote: front.length ? `Found ${front.join(", ")} without opening a page.` : "No llms.txt, agent.json, pricing.json or openapi.json. I would have to scrape HTML to learn anything.",
    http: { method: "GET", url: joinUrl(url, front[0] || "/llms.txt"), status: front.length ? 200 : 404 },
    screenshot: homeShot,
  });
  log(flows.at(-1));
  if (!front.length) findings.push({ flow: "discover", grade: "F-med", text: "No machine-readable front door (llms.txt, agent.json, pricing.json, openapi.json).", command: `GET ${joinUrl(url, "/llms.txt")} → 404` });
  else worked.push(`Machine-readable front door: ${front.join(", ")}`);

  // understand: pricing readable by a machine, else by a page
  const pj = await get(joinUrl(url, "/pricing.json"));
  let understood = false;
  const pricingDoc = pj.ok && pj.status === 200 && !isHtml(pj) ? parseJson(pj) : null;
  if (pricingDoc && typeof pricingDoc === "object") {
    understood = true;
    const plans = Array.isArray(pricingDoc.plans) ? pricingDoc.plans.length : 0;
    flows.push({ id: "understand", result: "PASS", human_interventions: 0, quote: plans ? `pricing.json lists ${plans} plan(s); I can pick one without a browser.` : "pricing.json exists and is parseable; it declares no plans, so there is nothing to price yet, and it says so in a form I can read.", http: { method: "GET", url: joinUrl(url, "/pricing.json"), status: 200 }, screenshot: pricingShot });
    worked.push(plans ? "pricing.json with plans" : "pricing.json states availability machine-readably");
    if (!plans) findings.push({ flow: "understand", grade: "F-low", text: "pricing.json has no plans array; agents can read availability but cannot compare a price.", command: `GET ${joinUrl(url, "/pricing.json")} → 200` });
  } else {
    const pricingPage = pricingPageHit;
    if (pricingPage) await visit(page, joinUrl(url, pricingPage.path), errors);
    if (pricingPage) {
      const text = await page.locator("body").innerText().catch((err) => {
        errors.push({ step: "read pricing text", url: joinUrl(url, pricingPage.path), error: err.message.split("\n")[0] });
        return "";
      });
      const hasPrice = PRICE_RE.test(text);
      const file = pricingShot;
      understood = hasPrice;
      flows.push({ id: "understand", result: hasPrice ? "PASS" : "FAIL", human_interventions: hasPrice ? 1 : 0, quote: hasPrice ? `Prices exist only on the rendered ${pricingPage.path} page; I read them from HTML, which a person would normally do.` : `${pricingPage.path} renders but I cannot find a price in it.`, http: { method: "GET", url: joinUrl(url, pricingPage.path), status: pricingPage.status }, screenshot: file });
      findings.push({ flow: "understand", grade: hasPrice ? "F-med" : "F-high", text: hasPrice ? "Plan prices exist only in rendered HTML; no pricing.json." : "No price discoverable on the pricing page or in pricing.json.", command: `GET ${joinUrl(url, "/pricing.json")} → ${pj.status || pj.error}` });
    } else {
      flows.push({ id: "understand", result: "FAIL", human_interventions: 0, quote: "No pricing page and no pricing.json. I cannot tell what this costs.", http: { method: "GET", url: joinUrl(url, "/pricing"), status: 404 } });
      findings.push({ flow: "understand", grade: "F-high", text: "No pricing page at /pricing or /plans and no pricing.json.", command: `GET ${joinUrl(url, "/pricing")} → 404` });
    }
  }
  log(flows.at(-1));

  // signup: find the form, never submit
  let signupPage = null;
  for (const path of SIGNUP_PATHS) {
    if (!(await exists(joinUrl(url, path)))) continue;
    const res = await visit(page, joinUrl(url, path), errors);
    if (res && res.status() < 400 && (await page.locator("form").count()) > 0) {
      signupPage = { path, status: res.status() };
      await page.waitForTimeout(video ? 1500 : 0);
      break;
    }
  }
  if (signupPage) {
    const html = await page.content();
    const text = await page.locator("body").innerText().catch((err) => {
      errors.push({ step: "read signup text", url: joinUrl(url, signupPage.path), error: err.message.split("\n")[0] });
      return "";
    });
    const captchaHits = [...new Set((html.match(CAPTCHA_RE) || []).map((s) => s.toLowerCase()))];
    const emailLoop = EMAIL_LOOP_RE.test(text);
    const file = await shot("signup-form");
    if (captchaHits.length) {
      flows.push({ id: "signup", result: "FAIL", human_interventions: 1, quote: `The signup form at ${signupPage.path} loads ${captchaHits.join(", ")}. I cannot solve it; a person would have to.`, http: { method: "GET", url: joinUrl(url, signupPage.path), status: signupPage.status }, screenshot: file });
      findings.push({ flow: "signup", grade: "F-high", text: `Signup form requires ${captchaHits.join(", ")}; no CAPTCHA-free machine path advertised.`, command: `GET ${joinUrl(url, signupPage.path)}`, docLine: signupPage.path });
    } else if (emailLoop) {
      flows.push({ id: "signup", result: "PASS", human_interventions: 1, quote: `${signupPage.path} has a form without CAPTCHA, but the copy says email verification follows. A person would need to open the inbox.`, http: { method: "GET", url: joinUrl(url, signupPage.path), status: signupPage.status }, screenshot: file });
      findings.push({ flow: "signup", grade: "F-med", text: "Signup mentions email verification before access; agent would need a human to click the link.", command: `GET ${joinUrl(url, signupPage.path)}`, docLine: signupPage.path });
    } else {
      flows.push({ id: "signup", result: "PASS", human_interventions: 1, quote: `${signupPage.path} has a plain form with no CAPTCHA. I did not submit it (smoke mode); a full run would try the API path first.`, http: { method: "GET", url: joinUrl(url, signupPage.path), status: signupPage.status }, screenshot: file });
      worked.push(`Signup form at ${signupPage.path} without CAPTCHA`);
    }
  } else {
    flows.push({ id: "signup", result: "SKIP", human_interventions: 0, quote: `No signup form found at ${SIGNUP_PATHS.join(", ")}; nothing to walk in smoke mode.` });
  }
  log(flows.at(-1));

  for (const id of ["access", "use", "pay", "manage"]) flows.push({ id, result: "SKIP", human_interventions: 0, quote: "Not attempted in smoke mode." });

  let recording = null;
  if (video) {
    await page.waitForTimeout(800);
    const v = page.video();
    await context.close();
    recording = v ? await finalizeSmokeVideo({ video: () => v }, outDir) : null;
  }
  await browser.close();
  for (const f of flows) if (f.screenshot === null) delete f.screenshot;
  const human = flows.reduce((s, f) => s + (f.human_interventions || 0), 0);
  return {
    schema: "agent-ready/crash@1",
    runId,
    target: { url },
    startedAt,
    finishedAt: new Date().toISOString(),
    provider: { name: "crash", version, mode: "smoke" },
    available: true,
    mode: "smoke",
    persona: "scripted walk (no LLM)",
    task,
    flows,
    findings,
    worked,
    human_interventions: human,
    human_assist: false,
    understood,
    errors,
    video: recording,
  };
}
