import { readFileSync, existsSync } from "node:fs";
import { join, extname } from "node:path";
import { STAGES } from "../schema/stages.js";
import { pathOf } from "./format.js";

// Renders a run the way tansohq.com's homepage demo shows a customer task: goal, Before / After the
// change, a step list with done / human / blocked / unknown states, and one evidence panel. Built to be
// recorded: with ?play=1 the page reveals steps one at a time, then flips to "After the change".

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

const STEP_CLASS = { AGENT_VERIFIED: "done", AGENT_CAPABLE: "done", HUMAN_REQUIRED: "human", BLOCKED: "blocked", NOT_TESTED: "unknown", NOT_APPLICABLE: "unknown" };
const STEP_RESULT = { AGENT_VERIFIED: "Done", AGENT_CAPABLE: "Documented", HUMAN_REQUIRED: "Human", BLOCKED: "Blocked", NOT_TESTED: "Not reached", NOT_APPLICABLE: "Not claimed" };
const STEP_TEXT = {
  discover: "Find the product and its docs",
  understand: "Read plans and prices",
  signup: "Create an account",
  access: "Use the key on its own data",
  pay: "Pay for the plan",
  use: "Make one metered call",
  manage: "Change plan or limits",
};

function dataUri(dir, path) {
  if (!path || !dir) return null;
  const full = join(dir, path);
  if (!existsSync(full)) return null;
  const mime = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp" }[extname(full).toLowerCase()] || "application/octet-stream";
  return `data:${mime};base64,${readFileSync(full).toString("base64")}`;
}

function flowOf(report, id) {
  return report?.sources?.crash?.flows?.find((f) => f.id === id) || null;
}

const PERSON = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="8" r="4"/><path d="M4 21c0-4 3.6-7 8-7s8 3 8 7"/></svg>';

function firstStop(states) {
  for (const id of STAGES) {
    const st = states[id];
    if (st === "BLOCKED" || st === "HUMAN_REQUIRED" || st === "NOT_TESTED") return id;
  }
  return null;
}

function httpBlock(flow) {
  if (!flow?.http) return "";
  const h = flow.http;
  const path = pathOf(h.url);
  const lines = [`${h.method} ${path}`, "", `${h.status}${h.body ? "" : ""}`];
  if (h.body) lines.push(String(h.body).slice(0, 220));
  return lines.join("\n");
}

// One evidence panel for a given set of stage states.
function evidence(report, states, after) {
  const stop = firstStop(states);
  const stage = stop ? report.stages.find((s) => s.id === stop) : null;
  const flow = stop ? flowOf(report, stop) : null;
  const atStop = stop ? report.findings.filter((f) => f.stage === stop) : [];
  const finding = atStop.find((f) => f.severity === "high" && f.fix) || atStop.find((f) => f.severity === "high") || atStop.find((f) => f.fix) || atStop[0] || null;
  const applicable = STAGES.filter((id) => states[id] !== "NOT_APPLICABLE");
  const cleared = applicable.filter((id) => ["AGENT_VERIFIED", "AGENT_CAPABLE"].includes(states[id])).length;

  if (!stop) {
    return {
      status: "Completed", success: true,
      heading: "The agent finished the task.",
      description: `Every claimed stage cleared: ${cleared} of ${applicable.length}. What remains is verification under comparable conditions on the next release.`,
      code: report.worked?.length ? report.worked.slice(0, 4).map((w) => `+ ${w}`).join("\n") : "",
      verify: "Re-run the same task after the next release; the report shows regressions first.",
    };
  }
  const state = states[stop];
  const human = state === "HUMAN_REQUIRED";
  return {
    status: human ? "Needs a person" : state === "BLOCKED" ? "Blocked" : "Not reached",
    success: after && human,
    heading: flow?.quote ? flow.quote.split(/(?<=[.!?])\s/)[0] : human ? `A person has to step in at ${STEP_TEXT[stop].toLowerCase()}.` : `The task stops at ${STEP_TEXT[stop].toLowerCase()}.`,
    description: flow?.quote && flow.quote.length > 80 ? flow.quote : stage?.evidence?.length ? stage.evidence.map((e) => e.note).find(Boolean) || "" : finding?.text || "",
    code: httpBlock(flow) || (finding?.command ? `${finding.command}\n\n${finding.text}` : ""),
    // A person-in-the-loop stop is the designed outcome, so "what to verify" is the handoff itself
    // unless a real fix is on the table; a bare scan finding is not a candidate change.
    verify: finding?.fix || (human
      ? "The agent hands the payment link to the customer and polls until the subscription is active. Verify the link opens and the subscription flips on payment."
      : finding?.text || "Re-run after the change."),
    screenshot: flow?.screenshot || null,
  };
}

// previousReport: the earlier run built as a full report, so the Before side shows what the agent
// actually hit back then, not the current run's evidence under the old stage colours.
export function renderDemo(report, { assetDir = null, previousReport = null, label = null } = {}) {
  const host = label || (report.target.url ? new URL(report.target.url).host : report.target.dir);
  const afterStates = Object.fromEntries(report.stages.map((s) => [s.id, s.state]));
  const beforeStates = previousReport
    ? Object.fromEntries(previousReport.stages.map((s) => [s.id, s.state]))
    : report.delta ? Object.fromEntries(report.delta.stages.map((s) => [s.id, s.from])) : null;
  const hasBefore = Boolean(beforeStates);
  const beforeReport = previousReport || report;

  const stepsFor = (states) => STAGES.filter((id) => states[id] !== "NOT_APPLICABLE").map((id) => {
    const st = states[id];
    const cls = STEP_CLASS[st];
    const icon = cls === "done" ? "✓" : cls === "human" ? PERSON : cls === "blocked" ? "!" : "?";
    return `<li class="${cls}" data-stage="${esc(id)}"><span class="tl-step-icon" aria-hidden="true">${icon}</span><span>${esc(STEP_TEXT[id])}</span><small>${esc(STEP_RESULT[st])}</small></li>`;
  }).join("");

  const evAfter = evidence(report, afterStates, true);
  const evBefore = hasBefore ? evidence(beforeReport, beforeStates, false) : null;
  const shot = evAfter.screenshot ? dataUri(assetDir, evAfter.screenshot) : null;

  const panel = (ev, after) => `
    <div class="tl-evidence">
      <div class="tl-evidence-top"><span class="tl-mono">${after ? (hasBefore ? "PROPOSED FLOW + RETEST" : "WHERE THE TASK STANDS") : "WHERE THE TASK STOPS"}</span><span class="tl-status${ev.success ? " success" : ""}">${esc(ev.status)}</span></div>
      <h4>${esc(ev.heading)}</h4>
      <p>${esc(ev.description)}</p>
      ${ev.code ? `<pre><code>${esc(ev.code)}</code></pre>` : ""}
    </div>`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>alg demo: ${esc(host)}</title>
<style>
:root{--ink:#193126;--line:#dce3d8;--muted:#53645a;--sage:#eef3e9;--forest:#0f4d36;--bg:#f5f7f2}
*{box-sizing:border-box;margin:0}
html,body{background:var(--bg)}
body{color:var(--ink);font:14px/1.55 Satoshi,"Helvetica Neue",Arial,Helvetica,sans-serif;padding:32px 24px;min-height:100vh}
.tl-mono{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;letter-spacing:.09em;text-transform:uppercase;font-size:11px;color:var(--muted)}
.wrap{max-width:1160px;margin:0 auto}
.tl-demo{border:1px solid #cfd9c7;background:#fff;border-radius:11px;overflow:hidden;box-shadow:0 12px 30px -24px #17342366}
.tl-demo-header{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:17px 28px;background:#f2f5ed;border-bottom:1px solid var(--line);font-family:ui-monospace,monospace;font-size:11px;letter-spacing:.08em;text-transform:uppercase}
.tl-demo-task{display:flex;align-items:center;justify-content:space-between;gap:24px;padding:25px 28px;border-bottom:1px solid var(--line)}
.tl-demo-task h3{font-size:22px;font-weight:500;letter-spacing:-.01em;margin:6px 0 4px;max-width:34ch;text-wrap:balance}
.tl-demo-task p{font-size:12px;color:var(--muted)}
.tl-segment{display:flex;gap:2px;flex-shrink:0;padding:4px;border:1px solid var(--line);border-radius:5px;background:#f5f7f0}
.tl-segment button{border:0;background:transparent;padding:9px 14px;font:inherit;font-size:12px;color:var(--muted);border-radius:4px;cursor:pointer}
.tl-segment button[aria-pressed="true"]{background:#fff;color:var(--ink);font-weight:700;box-shadow:0 1px 2px #1a2f2222}
.tl-demo-body{display:grid;grid-template-columns:.85fr 1.15fr;min-height:320px}
.tl-steps{list-style:none;padding:20px 28px;border-right:1px solid var(--line);background:#fbfcf8}
.tl-steps li{position:relative;display:flex;align-items:center;gap:12px;min-height:62px;font-size:12px;opacity:1;transition:opacity .35s ease,transform .35s ease}
.tl-steps li small{margin-left:auto;color:var(--muted);font-size:11px;white-space:nowrap}
.tl-step-icon{width:29px;height:29px;border:1px solid #d4dfcb;border-radius:50%;background:#edf3e6;display:flex;align-items:center;justify-content:center;color:#44783e;flex-shrink:0;font-size:13px;font-weight:700}
.tl-steps li.human .tl-step-icon{background:#faf1df;border-color:#e4d5b4;color:#806126}
.tl-steps li.blocked .tl-step-icon{background:#faeee7;border-color:#e8c7b3;color:#9b5c39}
.tl-steps li.unknown .tl-step-icon{background:#f3f4f2;border-color:#d9ddd6;color:#7a847d}
.tl-evidence{padding:28px 30px;min-width:0}
.tl-evidence-top{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:14px}
.tl-evidence h4{font-size:24px;font-weight:500;line-height:1.25;letter-spacing:-.01em;max-width:30ch;text-wrap:balance}
.tl-evidence p{margin-top:12px;font-size:14px;color:var(--muted);max-width:60ch}
.tl-evidence pre{font-size:11px;line-height:1.8;white-space:pre-wrap;overflow-wrap:anywhere;margin:20px 0 0;padding:16px;background:#f5f7f1;border:1px solid #e0e6d9;border-radius:5px;color:#4d663f;font-family:ui-monospace,SFMono-Regular,Consolas,monospace}
.tl-status{font-size:11px;line-height:1.4;padding:4px 7px;border:1px solid #e5cdb7;border-radius:4px;color:#87512a;background:#fcf3e9}
.tl-status.success{border-color:#ccdebf;color:#426e3b;background:#eff6e8}
.tl-demo-bottom{display:flex;align-items:center;justify-content:space-between;gap:24px;padding:20px 28px;border-top:1px solid var(--line);background:#fbfcf8;font-size:13px}
.tl-demo-bottom strong{display:block;font-weight:700;margin-bottom:2px}
.tl-demo-bottom p{color:var(--muted);max-width:70ch}
.tl-demo-bottom p strong{color:var(--ink)}
.tl-text-link{background:none;border:0;font:inherit;font-size:13px;font-weight:700;color:var(--ink);cursor:pointer;white-space:nowrap}
.tl-demo-access{display:flex;align-items:center;justify-content:space-between;gap:24px;padding:28px;background:var(--sage);border-top:1px solid var(--line)}
.tl-demo-access h3{font-size:18px;font-weight:500}
.tl-demo-access p{font-size:13px;color:var(--muted);margin-top:4px}
.tl-btn{background:var(--forest);color:#fff;border:0;border-radius:6px;padding:14px 22px;font:inherit;font-size:14px;font-weight:600}
.shot{margin-top:18px;border:1px solid var(--line);border-radius:6px;max-width:100%;display:block}
.tl-demo.playing .tl-steps li{opacity:0;transform:translateY(6px)}
.tl-demo.playing .tl-steps li.shown{opacity:1;transform:none}
[hidden]{display:none!important}
@media (max-width:760px){.tl-demo-body{grid-template-columns:1fr}.tl-steps{border-right:0;border-bottom:1px solid var(--line)}.tl-demo-task{flex-direction:column;align-items:flex-start}}
</style>
</head>
<body>
<div class="wrap">
<div class="tl-demo" id="demo">
  <div class="tl-demo-header"><span>Inside a customer task</span><span>agent-ready · ${esc(host)} · ${esc(report.generatedAt.slice(0, 10))}</span></div>
  <div class="tl-demo-task">
    <div><span class="tl-mono">Customer goal</span><h3>${esc(report.task || "Sign up, get a key, and make one call.")}</h3><p>${esc(report.sources?.crash?.persona || "Autonomous agent")} · ${esc(report.providersRun.join(" + "))} · ${esc(report.maturity.label)}</p></div>
    ${hasBefore ? `<div class="tl-segment" role="group" aria-label="Compare before and after"><button type="button" id="btn-before" aria-pressed="true">Before</button><button type="button" id="btn-after" aria-pressed="false">After the change</button></div>` : ""}
  </div>
  ${hasBefore ? `<div class="tl-demo-body" id="view-before">
    <ol class="tl-steps">${stepsFor(beforeStates)}</ol>
    ${panel(evBefore, false)}
  </div>` : ""}
  <div class="tl-demo-body" id="view-after"${hasBefore ? " hidden" : ""}>
    <ol class="tl-steps">${stepsFor(afterStates)}</ol>
    <div class="tl-evidence">
      <div class="tl-evidence-top"><span class="tl-mono">${hasBefore ? "Proposed flow + retest" : "Where the task stands"}</span><span class="tl-status${evAfter.success ? " success" : ""}">${esc(evAfter.status)}</span></div>
      <h4>${esc(evAfter.heading)}</h4>
      <p>${esc(evAfter.description)}</p>
      ${evAfter.code ? `<pre><code>${esc(evAfter.code)}</code></pre>` : ""}
      ${shot ? `<img class="shot" alt="what the agent saw" src="${shot}">` : ""}
    </div>
  </div>
  <div class="tl-demo-bottom">
    <p><strong id="bottom-label">${hasBefore ? "Candidate change" : "What to verify"}</strong><span id="bottom-text">${esc(hasBefore ? evBefore.verify : evAfter.verify)}</span></p>
    ${hasBefore ? `<button type="button" class="tl-text-link" id="toggle">See the proposed fix</button>` : ""}
  </div>
  <div class="tl-demo-access"><div><h3>Want this for your product?</h3><p>Bring the workflow your customers ask their agents to complete.</p></div><button class="tl-btn" type="button">Request an evaluation</button></div>
</div>
</div>
<script>
(function(){
  var hasBefore = ${hasBefore ? "true" : "false"};
  var verifyBefore = ${JSON.stringify(hasBefore ? evBefore.verify : "")};
  var verifyAfter = ${JSON.stringify(evAfter.verify)};
  var demo = document.getElementById('demo');
  function show(after){
    if(!hasBefore) return;
    document.getElementById('view-before').hidden = after;
    document.getElementById('view-after').hidden = !after;
    document.getElementById('btn-before').setAttribute('aria-pressed', String(!after));
    document.getElementById('btn-after').setAttribute('aria-pressed', String(after));
    document.getElementById('bottom-label').textContent = after ? 'What to verify' : 'Candidate change';
    document.getElementById('bottom-text').textContent = after ? verifyAfter : verifyBefore;
    document.getElementById('toggle').textContent = after ? 'Compare with before' : 'See the proposed fix';
    demo.dataset.view = after ? 'after' : 'before';
  }
  if(hasBefore){
    document.getElementById('btn-before').onclick = function(){ show(false); };
    document.getElementById('btn-after').onclick = function(){ show(true); };
    document.getElementById('toggle').onclick = function(){ show(demo.dataset.view !== 'after'); };
    demo.dataset.view = 'before';
  }
  // Recording mode: reveal steps one by one, hold, flip to After, reveal again, hold.
  var params = new URLSearchParams(location.search);
  if(params.get('play')==='1'){
    demo.classList.add('playing');
    var stepMs = Number(params.get('step')||700), holdMs = Number(params.get('hold')||2200);
    function reveal(view, done){
      var items = view.querySelectorAll('.tl-steps li'); var i=0;
      (function next(){ if(i>=items.length){ setTimeout(done, holdMs); return; } items[i++].classList.add('shown'); setTimeout(next, stepMs); })();
    }
    var first = hasBefore ? document.getElementById('view-before') : document.getElementById('view-after');
    setTimeout(function(){
      reveal(first, function(){
        if(!hasBefore){ demo.dataset.done='1'; return; }
        show(true);
        reveal(document.getElementById('view-after'), function(){ demo.dataset.done='1'; });
      });
    }, 900);
  }
})();
</script>
</body>
</html>
`;
}
