import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { inspect, buildAudit } from "../src/audit/index.js";
import { htmlToText } from "../src/interface/sources.js";
import { isHtml } from "../src/probe/http.js";
import { blocksOf, htmlBlocks, quoteAt, textBlocks } from "../src/interface/quote.js";

// Kat reads every quote under a step, so each must be clean: one or two whole sentences from one element of the page,
// or an element that is not a sentence with a label saying what it is. Resend's Pay quote was "scale as you grow. Are
// you an AI agent? See pricing Add-ons if you send from a": a subtitle, a link and a heading run together.

const recorded = (dir, file) => JSON.parse(gunzipSync(readFileSync(new URL(`../fixtures/${dir}/${file}`, import.meta.url))));
const replayFrom = (responses) => async (url) => responses[url] || { ok: false, status: 0, url, contentType: "", headers: {}, text: "", error: "not recorded" };
const FIXTURES = ["onboarding", "pay"].flatMap((dir) => readdirSync(new URL(`../fixtures/${dir}/`, import.meta.url)).filter((f) => f.endsWith(".json.gz")).map((f) => [dir, f]));
const answers = (funnel) => ({ onboarding: { value: funnel.path?.id || "try_then_claim", source: "from the docs" }, abuse_cost: { value: "low", source: "default" }, human_before: { value: "never", source: "default" } });

test("an HTML page's blocks are exactly the text the rules read, cut where elements start and end", () => {
  const html = `<p class="sub">Start for free and scale as you grow.</p><div><a href="/pricing.md">Are you an AI agent? See pricing<span><svg><path d="M9"></path></svg></span></a></div><h2>Add-ons</h2><h2>Domains -<!-- --> <!-- -->$20<!-- --> / mo</h2><span>Your plan already comes with domains, but if you send from a separate one for each customer or brand, that number runs out quickly.</span>`;
  const text = htmlToText(html);
  const blocks = htmlBlocks(html);
  assert.equal(blocks.map((b) => text.slice(b.start, b.end)).join(" "), text);
  assert.deepEqual(blocks.map((b) => [b.kind, text.slice(b.start, b.end)]), [
    ["phrase", "Start for free and scale as you grow."],
    ["phrase", "Are you an AI agent? See pricing"],
    ["heading", "Add-ons"],
    ["heading", "Domains - $20 / mo"],
    ["phrase", "Your plan already comes with domains, but if you send from a separate one for each customer or brand, that number runs out quickly."],
  ]);
  const body = { text: html, html: true };
  const at = (words) => quoteAt(body, text, text.indexOf(words), text.indexOf(words) + words.length, "pricing");
  assert.deepEqual(at("$20"), { quote: "Domains - $20 / mo", label: "Heading" });
  assert.deepEqual(at("send from a"), { quote: "Your plan already comes with domains, but if you send from a separate one for each customer or brand, that number runs out quickly." });
  assert.deepEqual(at("AI agent"), { quote: "Are you an AI agent?" });
  // Words that run across two elements are no quote at all.
  assert.equal(at("grow. Are you"), null);
});

test("a run of links in one div is quoted as the link the words are in, labelled", () => {
  const html = `<div><a href="/s">Start Sending Free</a> <a href="/b2b">View B2B Plans ($14/mo)</a> <a href="/docs">Read the Docs</a></div>`;
  const text = htmlToText(html);
  const i = text.indexOf("$14");
  assert.deepEqual(quoteAt({ text: html, html: true }, text, i, i + 3, "homepage"), { quote: "View B2B Plans ($14/mo)", label: "Phrase" });
});

test("Markdown blocks: paragraphs, list items, table cells, code lines, MDX tags and shell comments", () => {
  const md = [
    "# Acme",
    "",
    "Acme sends mail. We email a verification code",
    "to the address you sign up with.",
    "",
    "- [Email OTP](https://acme.dev/otp): Sign in and verify email addresses",
    "| State | Meaning |",
    "|---|---|",
    "| `verified` | Human passed the OTP back |",
    "```bash",
    "curl -X POST https://acme.dev/v1/verify # OTP from the email",
    "```",
    '<Card title="Verify">',
    "  Submit the 6-digit verification code",
    "</Card>",
    "#",
    "#         The human_email must not be registered.",
    "#         An OTP will be sent to that email.",
  ].join("\n");
  const body = { text: md, html: false };
  const at = (words) => quoteAt(body, md, md.indexOf(words), md.indexOf(words) + words.length, "llms_txt");
  assert.deepEqual(at("verification code\nto"), { quote: "We email a verification code to the address you sign up with." });
  assert.deepEqual(at("Email OTP"), { quote: "[Email OTP](https://acme.dev/otp): Sign in and verify email addresses", label: "List item" });
  assert.deepEqual(at("Human passed the OTP"), { quote: "Human passed the OTP back", label: "Table cell" });
  assert.deepEqual(at("OTP from the email"), { quote: "curl -X POST https://acme.dev/v1/verify # OTP from the email", label: "Code" });
  assert.deepEqual(at("6-digit verification code"), { quote: "Submit the 6-digit verification code", label: "Text" });
  assert.deepEqual(at("An OTP will"), { quote: "An OTP will be sent to that email." });
  assert.equal(textBlocks(md).find((b) => b.kind === "heading" && md.slice(b.start, b.end) === "# Acme")?.kind, "heading");
});

test("a sentence is not cut at an abbreviation, and a funding round's \"Series B.\" ends one", () => {
  const md = "Pay with a card, e.g. Visa. Introducing our $75M Series B. Read the announcement.";
  const body = { text: md, html: false };
  const at = (words) => quoteAt(body, md, md.indexOf(words), md.indexOf(words) + words.length, "llms_txt");
  assert.deepEqual(at("card"), { quote: "Pay with a card, e.g. Visa." });
  assert.deepEqual(at("$75M"), { quote: "Introducing our $75M Series B." });
});

// The words each kind of quote is for: the quote must hold at least one of them.
const TRIGGER = {
  inbox: /magic link|verification (?:code|email|link)|emailed (?:code|OTP|link)|\bOTP\b|readable (?:mail)?box|agent inbox/i,
  cli: /\b(?:npx|wrangler|mem0|stripe|npm|pip|brew)\b/i,
  wallet: /\bx402\b|X-PAYMENT|PAYMENT-REQUIRED/i,
  agent_identity: /AgentID|agent identity|auth\.agentid\.com/i,
  payment: /[$€£]\s?\d|USD|\b\d+(?:\.\d+)? [A-Z]{3}\b|\bx402\b|\bMPP\b|\bACP\b|\bUCP\b|\bAP2\b|\b402\b|buy|purchas|pay|checkout|\/\.well-known\/ucp/i,
};
const TERMINAL = /[.!?]["'”’)\]*_`]*$/;
const flat = (s) => s.replace(/\n[ \t]*#(?=\s)/g, "\n").replace(/\s+/g, " ");

for (const [dir, file] of FIXTURES) {
  test(`${dir}/${file.replace(".json.gz", "")}: every quote is a whole sentence or a labelled element from one block, holding its trigger`, async () => {
    const data = recorded(dir, file);
    const { doc, funnel } = await inspect({ url: data.url || `https://${data.host}/`, version: "test", runId: "r", fetchSource: replayFrom(data.responses) });
    const audit = buildAudit({ doc, funnel, answers: answers(funnel), task: "t", runId: "r", version: "test" });
    for (const s of audit.steps) {
      for (const q of s.quotes || []) {
        const where = `${s.id} ${JSON.stringify(q)}`;
        assert.ok(q.quote && q.quote.trim() === q.quote, where);
        assert.match(q.quote, TRIGGER[q.for], `${where}: no trigger term`);
        if (q.label) assert.ok(q.quote.length <= 320, `${where}: labelled phrase too long`);
        else assert.match(q.quote, TERMINAL, `${where}: does not end a sentence`);
        assert.doesNotMatch(q.quote, /\.\.\.$|…$/, where);
        const obs = doc.observations.find((o) => o.id === q.obs);
        const res = data.responses[obs.url];
        if (q.label === "pricing.json" || q.label === "UCP business profile") continue;
        const body = { text: res.text, html: isHtml(res) };
        const text = body.html ? htmlToText(body.text) : body.text;
        const blocks = blocksOf(body, obs.role);
        if (!blocks) {
          // A JSON page: the quote is one string or key of it.
          assert.ok(text.includes(q.quote) || text.includes(JSON.stringify(q.quote).slice(1, -1)), `${where}: not one JSON string`);
          continue;
        }
        const holder = blocks.map((b) => flat(text.slice(b.start, b.end))).find((b) => b.includes(q.quote));
        assert.ok(holder, `${where}: not inside one block of ${obs.url}`);
        if (!q.label) {
          const before = holder.slice(0, holder.indexOf(q.quote));
          assert.match(before, /^(?:\s*(?:#{1,6}|>|[-*+]|\d+[.)]))?\s*$|[.!?]["'”’)\]*_`]*\s$/, `${where}: does not start a sentence`);
        }
      }
    }
  });
}

test("resend.com: Pay quotes the add-on heading, not a subtitle, a link and a heading run together", async () => {
  const data = recorded("onboarding", "resend.com.json.gz");
  const { doc, funnel } = await inspect({ url: "https://resend.com/", version: "test", runId: "r", fetchSource: replayFrom(data.responses) });
  const pay = funnel.steps.find((s) => s.id === "pay");
  assert.equal(pay.state, "needs_person");
  assert.equal(pay.quotes.length, 1);
  assert.deepEqual({ quote: pay.quotes[0].quote, label: pay.quotes[0].label }, { quote: "Domains - $20 / mo", label: "Heading" });
  assert.equal(doc.observations.find((o) => o.id === pay.quotes[0].obs).url, "https://resend.com/pricing");
});
